import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { Vault } from '../dist/src/storage.js';
import { ProfileBuilder } from '../dist/src/profile.js';
import { ResumeTailor } from '../dist/src/resume.js';
import { SafetyGate } from '../dist/src/safety.js';
import { WorkdayPlanner } from '../dist/src/workday.js';
import { TrackerLedger } from '../dist/src/tracker.js';
import { AppService } from '../dist/src/appService.js';
import { DatabaseService } from '../dist/src/db.js';
import { makeTextPdf } from './helpers/pdf-fixture.mjs';

function assertJobHuntStyleRender(html, candidateName, projectName) {
  assert.ok(html.includes('meta name="generator" content="Kami"'), 'Should contain meta generator Kami');
  assert.ok(html.includes(candidateName), `Should contain candidate name: ${candidateName}`);
  assert.ok(html.includes(projectName), `Should contain project name: ${projectName}`);
  assert.ok(html.includes('Technical Projects'), 'Should contain Technical Projects section');
  assert.ok(html.includes('Technical Skills'), 'Should contain Technical Skills section');
  assert.ok(html.includes('Newsreader'), 'Should use Newsreader font');
  assert.ok(html.includes('border-left') && html.includes('header'), 'Should contain left-border header CSS');
  assert.ok(!html.includes('{{'), 'Should not contain template placeholders');
  assert.ok(!html.includes('<div class="metrics">'), 'Should not contain metrics container');
  assert.ok(!html.includes('Matched reqs'), 'Should not contain Matched reqs metric');
  assert.ok(!html.includes('Core Skills'), 'Should not contain Core Skills section');
  assert.ok(!html.includes('JetBrains Mono'), 'Should not use JetBrains Mono font');
}

test('1. Encrypted Storage Roundtrip', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-storage-test-'));
  const vaultPath = path.join(tmpDir, 'test-vault.enc');
  const password = 'test-secret-password-123';

  try {
    const vault = new Vault(vaultPath, password);
    assert.equal(await vault.exists(), false);

    const sampleData = {
      credentials: { username: 'user@example.com', password: 'secretpassword' },
      settings: { theme: 'monochrome-glass' }
    };

    await vault.save(sampleData);
    assert.equal(await vault.exists(), true);

    const loadedData = await vault.load();
    assert.deepEqual(loadedData, sampleData);

    const updated = await vault.update(async (data) => {
      return { ...data, updated: true };
    });
    assert.equal(updated.updated, true);
    
    const reloaded = await vault.load();
    assert.equal(reloaded.updated, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('2. Profile Bootstrap & Parsing', (t) => {
  const builder = new ProfileBuilder();
  const sampleResume = `
Jane Doe
jane.doe@example.com
(555) 123-4567

Skills
JavaScript, Node.js, Next.js, Automated Testing

Experience
Senior Software Engineer - TechCorp
Developed web application control planes and automated workflows. Leading a team of developers.

Education
B.S. Computer Science - University of Science
Graduated with honors in Software Engineering.
  `.trim();

  const result = builder.build(sampleResume, {
    'Why do you want to work here?': 'I love building high quality web software.'
  });

  assert.equal(result.candidateProfile.name, 'Jane Doe');
  assert.equal(result.candidateProfile.email, 'jane.doe@example.com');
  assert.equal(result.candidateProfile.phone, '(555) 123-4567');
  assert.ok(result.candidateProfile.skills.includes('JavaScript'));
  assert.ok(result.candidateProfile.skills.includes('Node.js'));
  assert.ok(result.claimBank.length > 0);
  assert.equal(result.answerMemory['Why do you want to work here?'], 'I love building high quality web software.');
});

test('3. Resume Evidence Map', (t) => {
  const builder = new ProfileBuilder();
  const profile = builder.build(`
John Smith
john@example.com

Skills
JavaScript, React, Node.js

Experience
Frontend Engineer - WebCo
Built interactive web applications using React and JavaScript.

Projects
Kubernetes Deploy Bot
Built a Kubernetes deployment automation bot for release checks.
  `, {
    'Years of experience': '5 years'
  });

  const tailor = new ResumeTailor(profile);
  const requirements = ['JavaScript', 'React', 'Python'];
  const tailored = tailor.tailor(requirements);

  assertJobHuntStyleRender(tailored.html, 'John Smith', 'Kubernetes Deploy Bot');
  assert.ok(tailored.evidenceMap['JavaScript']);
  assert.ok(tailored.evidenceMap['React']);
  assert.ok(tailored.unsupported.includes('Python'));
});

test('4. Safety Gate Blockers', (t) => {
  const safety = new SafetyGate({ salaryFloor: 120000 });

  // Test unknown required fields
  const res1 = safety.check({ requiredFields: ['unknown_custom_field'] });
  assert.equal(res1.blocked, true);
  assert.ok(res1.reasons.some(r => r.includes('UNKNOWN_REQUIRED_FIELD')));

  // Test unsupported resume claims
  const res2 = safety.check({}, { unsupported: ['Kubernetes'] });
  assert.equal(res2.blocked, true);
  assert.ok(res2.reasons.some(r => r.includes('UNSUPPORTED_CLAIMS')));

  // Test CAPTCHA / 2FA unresolved checks
  const res3 = safety.check({ unresolvedChecks: { captcha: true, twoFactor: false, emailVerification: false } });
  assert.equal(res3.blocked, true);
  assert.ok(res3.reasons.some(r => r.includes('UNRESOLVED_CAPTCHA')));

  // Test sensitive/legal terms
  const res4 = safety.check({ providedAnswers: { q1: 'Requires background check and drug test.' } });
  assert.equal(res4.blocked, true);
  assert.ok(res4.reasons.some(r => r.includes('SENSITIVE_REVIEW_REQUIRED')));

  // Test duplicate application check
  const res5 = safety.check({ isDuplicate: true });
  assert.equal(res5.blocked, true);
  assert.ok(res5.reasons.some(r => r.includes('duplicate_application')));

  // Test salary floor threshold
  const res6 = safety.check({ salary: 90000 });
  assert.equal(res6.blocked, true);
  assert.ok(res6.reasons.some(r => r.includes('SALARY_BELOW_FLOOR')));

  // Test passed audit
  const resClean = safety.check({
    requiredFields: ['first_name', 'email'],
    salary: 130000,
    providedAnswers: { q1: 'Standard work experience.' }
  });
  assert.equal(resClean.blocked, false);
  assert.equal(resClean.reasons.length, 0);
});

test('5. Workday URL Detection & Planning', (t) => {
  const planner = new WorkdayPlanner();
  const validUrl = 'https://company.myworkdayjobs.com/en-US/Careers/job/Engineer_R1234';
  const invalidUrl = 'https://example.com/careers';

  assert.equal(planner.detectWorkdayUrl(validUrl), true);
  assert.equal(planner.detectWorkdayUrl(invalidUrl), false);
  assert.equal(planner.extractTenant(validUrl), 'company');

  const planNoCreds = planner.plan(validUrl);
  assert.equal(planNoCreds.tenant, 'company');
  assert.equal(planNoCreds.blockedReasons.includes('MISSING_BROWSER_CREDENTIALS'), false);
  assert.ok(planNoCreds.steps.length > 0);
  const accountStep = planNoCreds.steps.find(s => s.id === 'navigate_login');
  assert.ok(accountStep);

  const planWithCreds = planner.plan(validUrl, { username: 'admin', password: 'pass' });
  assert.equal(planWithCreds.blockedReasons.length, 0);
});

test('6. Tracker Duplicate Detection', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-tracker-test-'));
  const storagePath = path.join(tmpDir, 'ledger.json');

  try {
    const tracker = new TrackerLedger(storagePath);
    const appData = {
      url: 'https://acme.myworkdayjobs.com/job/1',
      company: 'Acme Corp',
      title: 'Software Engineer'
    };

    assert.equal(await tracker.isDuplicate(appData), false);

    const created = await tracker.createApplication(appData);
    assert.equal(created.success, true);
    assert.equal(created.application.company, 'Acme Corp');

    assert.equal(await tracker.isDuplicate(appData), true);

    const dupResult = await tracker.createApplication(appData);
    assert.equal(dupResult.success, false);
    assert.equal(dupResult.blocker, 'duplicate_application');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('7. AppService createApplication & answerPrompt', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-service-test-'));

  try {
    const appService = new AppService({
      dataDir: tmpDir,
      vaultPassword: 'test-secret-key'
    });

    await appService.updateProfile('Alice Smith\nalice@example.com\nSkills\nNode.js');

    const createRes = await appService.createApplication('https://tech.myworkdayjobs.com/job/dev', {
      company: 'Tech Solutions',
      title: 'Node Developer',
      requirements: ['Node.js']
    });

    assert.equal(createRes.success, true);
    assert.ok(createRes.application.id);
    assert.equal(createRes.application.company, 'Tech Solutions');

    await appService.answerPrompt(createRes.application.id, 'p1', 'Do you know Node.js?', 'Yes, 3 years experience.');

    const state = await appService.getState();
    assert.equal(state.profile.answerMemory['Do you know Node.js?'], 'Yes, 3 years experience.');

    const dupRes = await appService.createApplication('https://tech.myworkdayjobs.com/job/dev', {
      company: 'Tech Solutions',
      title: 'Node Developer'
    });
    assert.equal(dupRes.success, false);
    assert.equal(dupRes.blocker, 'duplicate_application');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('8. Workday Automation Execution State Machine', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-automation-test-'));

  try {
    const appService = new AppService({
      dataDir: tmpDir,
      vaultPassword: 'test-secret-key'
    });

    await appService.updateProfile('Alice Smith\nalice@example.com\nSkills\nNode.js');

    // 1. Create application - should start as canonical ready_to_submit
    const createRes = await appService.createApplication('https://tech.myworkdayjobs.com/job/dev', {
      company: 'Tech Solutions',
      title: 'Node Developer',
      requirements: ['Node.js']
    });

    assert.equal(createRes.success, true);
    assert.equal(createRes.application.status, 'ready_to_submit');

    // 2. Approve submission without adapter or explicit approval - should block with automation_not_configured
    const blockRes = await appService.approveSubmission(createRes.application.id);
    assert.equal(blockRes.success, false);
    assert.equal(blockRes.blocker, 'automation_not_configured');

    const successAdapter = {
      runtime: 'playwright',
      async inspect() { return { success: true, state: 'success' }; },
      async fillDraft() { return { success: true, state: 'reviewing_application' }; },
      async submitApproved() { return { success: true, state: 'submitted', message: 'Submitted via test adapter' }; }
    };
    // 3. Submit in test mode after explicit approval without stored Workday credentials (tenant account creation flow)
    const mockRes = await appService.approveSubmission(createRes.application.id, { testMode: true, approved: true, approvedBy: 'test-reviewer', mode: 'submit_after_approval', adapter: successAdapter });
    assert.equal(mockRes.success, true);
    assert.equal(mockRes.status, 'submitted');

    // Verify events recorded in the tracker
    const apps = await appService.tracker.getApplications();
    const app = apps.find(a => a.id === createRes.application.id);
    assert.ok(app);
    assert.equal(app.status, 'submitted');
    
    const stepSuccessEvents = app.events.filter(e => e.type === 'EXEC_STEP_SUCCESS');
    assert.ok(stepSuccessEvents.length > 0);

    // 4. Reset status to ready_to_submit and approve in production mode without adapter - should fail closed with automation_not_configured
    await appService.tracker.updateStatus(app.id, 'ready_to_submit');
    const manualRes = await appService.approveSubmission(app.id, { testMode: false });
    assert.equal(manualRes.success, false);
    assert.equal(manualRes.blocker, 'automation_not_configured');

    // 4b. Approve programmatically with testMode: true but no adapter - should fail to run real playwright and return unsuccessful result (fail closed)
    try {
      const prodTestRes = await appService.approveSubmission(app.id, { testMode: true });
      assert.equal(prodTestRes.success, false, 'Should fail without explicit adapter or server-side test mode config');
    } catch (err) {
      // It is acceptable if it throws when trying to run the real PlaywrightBrowserAdapter in a test env
      assert.ok(err);
    }
    const updatedApps = await appService.tracker.getApplications();
    const updatedApp = updatedApps.find(a => a.id === app.id);
    assert.equal(updatedApp.status, 'blocked');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
test('9. Submission Approval Gate (Slice 5)', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-approval-test-'));

  try {
    const appService = new AppService({
      dataDir: tmpDir,
      vaultPassword: 'test-secret-key'
    });

    await appService.updateProfile('Alice Smith\nalice@example.com\nSkills\nNode.js');
    await appService.setCredentials('testuser', 'testpass');

    const createRes = await appService.createApplication('https://tech.myworkdayjobs.com/job/dev5', {
      company: 'Gate Solutions',
      title: 'Approval Dev',
      requirements: ['Node.js']
    });

    assert.equal(createRes.success, true);
    const appId = createRes.application.id;

    const mockAdapter = {
      runtime: 'playwright',
      async inspect() { return { success: true, state: 'reviewing_application' }; },
      async fillDraft() { return { success: true, state: 'reviewing_application' }; },
      async submitApproved(input) {
        if (!input.approved) {
          return { success: false, state: 'blocked', blocker: 'APPROVAL_REQUIRED' };
        }
        return { success: true, state: 'submitted', message: 'Submitted via mock adapter' };
      }
    };

    // 1. No approval blocks submit_after_approval
    const noApprovalRes = await appService.approveSubmission(appId, {
      mode: 'submit_after_approval',
      adapter: mockAdapter,
      testMode: false
    });
    assert.equal(noApprovalRes.success, false);
    assert.equal(noApprovalRes.blocker, 'llm_output_requires_review');

    // 2. Record a valid approval
    const recordRes = await appService.recordApproval(appId, { approved: true, approvedBy: 'auditor' });
    assert.equal(recordRes.success, true);
    assert.ok(recordRes.application.approval);
    assert.equal(recordRes.application.approval.approvedBy, 'auditor');

    // 3. Stale / mismatched approval blocks when snapshot hash is invalid
    const appToMutate = (await appService.tracker.getApplications()).find(a => a.id === appId);
    appToMutate.approval.fieldSnapshotHash = 'invalid_stale_hash';
    await appService.tracker.save();

    const staleRes = await appService.approveSubmission(appId, {
      mode: 'submit_after_approval',
      adapter: mockAdapter,
      testMode: false
    });
    assert.equal(staleRes.success, false);
    assert.equal(staleRes.blocker, 'llm_output_requires_review');

    // 3b. Mutating filledFields invalidates approval
    await appService.recordApproval(appId, { approved: true, approvedBy: 'auditor' });
    const appFields = (await appService.tracker.getApplications()).find(a => a.id === appId);
    appFields.filledFields = ['firstName', 'lastName'];
    await appService.tracker.save();
    const staleFieldsRes = await appService.approveSubmission(appId, {
      mode: 'submit_after_approval',
      adapter: mockAdapter,
      testMode: false
    });
    assert.equal(staleFieldsRes.success, false);
    assert.equal(staleFieldsRes.blocker, 'llm_output_requires_review');

    // 3c. Mutating provenance invalidates approval
    await appService.recordApproval(appId, { approved: true, approvedBy: 'auditor' });
    const appProv = (await appService.tracker.getApplications()).find(a => a.id === appId);
    appProv.provenance = [{ field: 'firstName', source: 'profile' }];
    await appService.tracker.save();
    const staleProvRes = await appService.approveSubmission(appId, {
      mode: 'submit_after_approval',
      adapter: mockAdapter,
      testMode: false
    });
    assert.equal(staleProvRes.success, false);
    assert.equal(staleProvRes.blocker, 'llm_output_requires_review');

    // 3d. Mutating artifacts invalidates approval
    await appService.recordApproval(appId, { approved: true, approvedBy: 'auditor' });
    const appArt = (await appService.tracker.getApplications()).find(a => a.id === appId);
    appArt.artifacts = [{ id: 'art1', type: 'resume_pdf', name: 'resume.pdf', createdAt: new Date().toISOString() }];
    await appService.tracker.save();
    const staleArtRes = await appService.approveSubmission(appId, {
      mode: 'submit_after_approval',
      adapter: mockAdapter,
      testMode: false
    });
    assert.equal(staleArtRes.success, false);
    assert.equal(staleArtRes.blocker, 'llm_output_requires_review');

    // 3e. Mutating blockers invalidates approval
    await appService.recordApproval(appId, { approved: true, approvedBy: 'auditor' });
    const appBlock = (await appService.tracker.getApplications()).find(a => a.id === appId);
    appBlock.blockers = [{ code: 'unknown_required_answer', message: 'Unknown question' }];
    await appService.tracker.save();
    const staleBlockRes = await appService.approveSubmission(appId, {
      mode: 'submit_after_approval',
      adapter: mockAdapter,
      testMode: false
    });
    assert.equal(staleBlockRes.success, false);
    assert.equal(staleBlockRes.blocker, 'llm_output_requires_review');
    // 4. Valid approval (providing explicit approved: true) lets flow reach adapter.submitApproved
    const validRes = await appService.approveSubmission(appId, {
      mode: 'submit_after_approval',
      approved: true,
      adapter: mockAdapter,
      testMode: false
    });
    assert.equal(validRes.success, true);
    assert.equal(validRes.status, 'submitted');

    // 5. testMode and review-only compatibility
    await appService.tracker.updateStatus(appId, 'ready_to_submit');
    const reviewOnlyRes = await appService.approveSubmission(appId, {
      mode: 'fill_review_only',
      adapter: mockAdapter,
      testMode: false
    });
    assert.equal(reviewOnlyRes.success, true);
    assert.equal(reviewOnlyRes.status, 'reviewing_application');

  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
test('10. AppService Vault Lifecycle & Resume Artifact Import', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-vault-unit-test-'));

  try {
    const appService = new AppService({ dataDir: tmpDir });
    const initialStatus = await appService.getVaultStatus();
    assert.equal(initialStatus.exists, false);
    assert.equal(initialStatus.locked, true);

    // Create vault
    await appService.createVault('unit-test-pass');
    const statusAfterCreate = await appService.getVaultStatus();
    assert.equal(statusAfterCreate.exists, true);
    assert.equal(statusAfterCreate.locked, false);

    // Lock vault
    appService.lock();
    const statusAfterLock = await appService.getVaultStatus();
    assert.equal(statusAfterLock.locked, true);

    // Unlock with wrong password
    const wrongAppService = new AppService({ dataDir: tmpDir });
    await assert.rejects(async () => {
      await wrongAppService.unlock('wrong-pass');
    }, /Invalid vault password/);

    // Unlock with correct password
    const rightAppService = new AppService({ dataDir: tmpDir });
    await rightAppService.unlock('unit-test-pass');
    const statusAfterUnlock = await rightAppService.getVaultStatus();
    assert.equal(statusAfterUnlock.locked, false);

    // Import two PDF resumes
    const caseyPdf = makeTextPdf('Casey Morgan\ncasey@example.com\nSkills\nPython, SQL');
    const rileyPdf = makeTextPdf('Riley Chen\nriley@example.com\nSkills\nTypeScript, Kubernetes\nProjects\nKubernetes Deploy Bot\nBuilt a TypeScript service that automated Kubernetes release checks.');

    const importRes = await rightAppService.importResumeArtifacts([
      {
        fileName: 'casey.pdf',
        contentBase64: caseyPdf.toString('base64'),
        mimeType: 'application/pdf'
      },
      {
        fileName: 'riley.pdf',
        contentBase64: rileyPdf.toString('base64'),
        mimeType: 'application/pdf'
      }
    ]);
    assert.equal(importRes.resumes.length, 2);
    assert.ok(importRes.activeResumeId);
    assert.equal(importRes.profile.candidateProfile.name, 'Riley Chen');
    assert.equal(importRes.profile.candidateProfile.projects?.[0]?.name, 'Kubernetes Deploy Bot');
    assert.ok(importRes.profile.claimBank.some(c => c.category === 'projects' && c.text.includes('automated Kubernetes release checks')));

    for (const r of importRes.resumes) {
      assert.equal(r.parse.parser, 'pdf-parse');
    }

    const emails = importRes.resumes.map(r => r.candidateEmail);
    assert.ok(emails.includes('casey@example.com'));
    assert.ok(emails.includes('riley@example.com'));
    const rileySummary = importRes.resumes.find(r => r.candidateEmail === 'riley@example.com');
    assert.equal(rileySummary?.projectCount, 1);

    const state = await rightAppService.getState();
    assert.equal(state.resumes.length, 2);
    assert.equal(state.activeResumeId, importRes.activeResumeId);

    // Call updateProfile with blank resumeText and new interviewAnswers (blank answer-memory regression)
    await rightAppService.updateProfile('', { 'Preferred location': 'Remote' });
    const updatedState = await rightAppService.getState();
    assert.equal(updatedState.profile.candidateProfile.name, 'Riley Chen');
    assert.equal(updatedState.profile.candidateProfile.email, 'riley@example.com');

    // Resume-derived skill claims should remain
    const skills = updatedState.profile.claimBank.filter(c => c.category === 'skills');
    assert.ok(skills.some(c => c.text.includes('TypeScript')));
    const projectClaims = updatedState.profile.claimBank.filter(c => c.category === 'projects');
    assert.ok(projectClaims.some(c => c.text.includes('Kubernetes release checks')));
    assert.equal(updatedState.profile.candidateProfile.projects?.[0]?.name, 'Kubernetes Deploy Bot');
    // And updated interview answer is in answerMemory
    assert.equal(updatedState.profile.answerMemory['Preferred location'], 'Remote');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
test('11. Unreachable/Fake LLM Provider Resume Tailoring Fallback', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-llm-fallback-test-'));

  try {
    const appService = new AppService({
      dataDir: tmpDir,
      vaultPassword: 'test-secret-key'
    });

    await appService.updateProfile('Alice Smith\nalice@example.com\nSkills\nNode.js\nPostgreSQL');

    // Configure a fake unreachable LLM provider
    await appService.saveLLMProvider({
      id: 'fake-unreachable-llm',
      name: 'Fake Unreachable Provider',
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:59999/v1',
      model: 'fake-model',
      isActive: true
    }, 'fake-api-key');

    // Create application with requirements
    const createRes = await appService.createApplication('https://tech.myworkdayjobs.com/job/fallback-dev', {
      company: 'Fallback Solutions',
      title: 'Backend Developer',
      requirements: ['Node.js', 'PostgreSQL']
    });

    assert.equal(createRes.success, true);
    assert.ok(createRes.application);
    // Deterministic fallback should produce valid tailored resume without blocking application status
    assert.equal(createRes.application.status, 'ready_to_submit');

    // Verify application event ledger recorded audit info without blocking application status
    const apps = await appService.tracker.getApplications();
    const app = apps.find(a => a.id === createRes.application.id);
    assert.ok(app);
    assert.equal(app.status, 'ready_to_submit');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
test('12. CAPTCHA Solver Event Logging with Mock Adapter', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-captcha-event-test-'));

  try {
    const appService = new AppService({
      dataDir: tmpDir,
      vaultPassword: 'test-secret-key'
    });

    await appService.updateProfile('Alice Smith\nalice@example.com\nSkills\nNode.js');
    await appService.setCredentials('testuser', 'testpass');

    const createRes = await appService.createApplication('https://tech.myworkdayjobs.com/job/captcha-dev', {
      company: 'Captcha Solutions',
      title: 'Captcha Dev',
      requirements: ['Node.js']
    });

    assert.equal(createRes.success, true);
    const appId = createRes.application.id;

    const mockAdapter = {
      runtime: 'playwright',
      async inspect() {
        return {
          success: true,
          state: 'reviewing_application',
          details: {
            captchaSolver: {
              success: true,
              provider: 'configured_llm',
              kind: 'text_prompt',
              status: 'solved'
            }
          }
        };
      },
      async fillDraft() {
        return {
          success: true,
          state: 'reviewing_application',
          details: {
            captchaSolver: {
              success: true,
              provider: 'configured_llm',
              kind: 'text_prompt',
              status: 'solved'
            }
          }
        };
      },
      async submitApproved(input) {
        if (!input.approved) {
          return { success: false, state: 'blocked', blocker: 'APPROVAL_REQUIRED' };
        }
        return {
          success: true,
          state: 'submitted',
          message: 'Submitted via mock adapter',
          details: {
            captchaSolver: {
              success: true,
              provider: 'configured_llm',
              kind: 'text_prompt',
              status: 'solved'
            }
          }
        };
      }
    };

    // Record approval so it matches policy.validateSubmissionApproval and doesn't get blocked
    const recordRes = await appService.recordApproval(appId, { approved: true, approvedBy: 'auditor' });
    assert.equal(recordRes.success, true);

    const validRes = await appService.approveSubmission(appId, {
      mode: 'submit_after_approval',
      approved: true,
      adapter: mockAdapter,
      testMode: false
    });
    assert.equal(validRes.success, true);
    assert.equal(validRes.status, 'submitted');

    // Verify events recorded in the tracker contain CAPTCHA_SOLVER_SUCCESS
    const apps = await appService.tracker.getApplications();
    const app = apps.find(a => a.id === appId);
    assert.ok(app);

    const captchaSuccessEvents = app.events.filter(e => e.type === 'CAPTCHA_SOLVER_SUCCESS');
    assert.ok(captchaSuccessEvents.length > 0, 'Should have recorded CAPTCHA_SOLVER_SUCCESS events');

    // Verify details format in one of the event messages
    const hasProvider = captchaSuccessEvents.some(e => e.message.includes('configured_llm'));
    const hasKind = captchaSuccessEvents.some(e => e.message.includes('text_prompt'));
    assert.ok(hasProvider, 'Events should contain provider info');
    assert.ok(hasKind, 'Events should contain kind info');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
test('13. AppService Vault Profile Isolation (No DB mirroring)', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-vault-profile-isolation-test-'));

  const tables = {
    profiles: [],
    answer_memory: []
  };

  const mockExecutor = async (text, params = []) => {
    const trimmed = text.trim();
    if (trimmed.startsWith('INSERT INTO profiles')) {
      tables.profiles.push(params);
    }
    if (trimmed.startsWith('INSERT INTO answer_memory')) {
      tables.answer_memory.push(params);
    }
    return { rows: [] };
  };

  const db = new DatabaseService({ mockExecutor });

  try {
    const appService = new AppService({
      dataDir: tmpDir,
      vaultPassword: 'test-secret-key',
      db
    });

    // Initialize/unlock vault
    await appService.createVault('test-secret-key');

    // Save profile
    await appService.updateProfile('Alex Smith\nalex@example.com\nSkills\nRust', { 'Sponsorship': 'No' });

    // Verify it was NOT written to the database (profiles and answer_memory tables are empty)
    assert.equal(tables.profiles.length, 0, 'Profiles should not be mirrored to DB');
    assert.equal(tables.answer_memory.length, 0, 'Answer memory should not be mirrored to DB');

    // Create a new AppService instance to load from the same dataDir (representing a reload/restart)
    const reloadedAppService = new AppService({
      dataDir: tmpDir,
      vaultPassword: 'test-secret-key',
      db
    });

    await reloadedAppService.unlock('test-secret-key');
    const state = await reloadedAppService.getState();

    // Verify profile state is successfully loaded from the vault
    assert.ok(state.profile);
    assert.equal(state.profile.candidateProfile.name, 'Alex Smith');
    assert.equal(state.profile.candidateProfile.email, 'alex@example.com');
    assert.equal(state.profile.answerMemory.Sponsorship, 'No');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('14. Proton Bridge Production Security and Verification Rules', async (t) => {
  const { ProtonBridgeConnector, resolveProtonBridgeConfig } = await import('../dist/src/protonBridge.js');
  const origNodeEnv = process.env.NODE_ENV;
  const origTestMode = process.env.TEST_MODE;
  const origUser = process.env.PROTON_BRIDGE_USERNAME;
  const origPass = process.env.PROTON_BRIDGE_PASSWORD;
  const origSimulate = process.env.PROTON_BRIDGE_SIMULATE;
  const origSecure = process.env.PROTON_BRIDGE_SECURE;
  const origReject = process.env.PROTON_BRIDGE_REJECT_UNAUTHORIZED;

  const restore = () => {
    if (origNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = origNodeEnv;
    if (origTestMode === undefined) delete process.env.TEST_MODE; else process.env.TEST_MODE = origTestMode;
    if (origUser === undefined) delete process.env.PROTON_BRIDGE_USERNAME; else process.env.PROTON_BRIDGE_USERNAME = origUser;
    if (origPass === undefined) delete process.env.PROTON_BRIDGE_PASSWORD; else process.env.PROTON_BRIDGE_PASSWORD = origPass;
    if (origSimulate === undefined) delete process.env.PROTON_BRIDGE_SIMULATE; else process.env.PROTON_BRIDGE_SIMULATE = origSimulate;
    if (origSecure === undefined) delete process.env.PROTON_BRIDGE_SECURE; else process.env.PROTON_BRIDGE_SECURE = origSecure;
    if (origReject === undefined) delete process.env.PROTON_BRIDGE_REJECT_UNAUTHORIZED; else process.env.PROTON_BRIDGE_REJECT_UNAUTHORIZED = origReject;
  };

  try {
    // 1. Env-only Proton credentials are considered configured
    process.env.TEST_MODE = 'true';
    delete process.env.NODE_ENV;
    process.env.PROTON_BRIDGE_USERNAME = 'envuser';
    process.env.PROTON_BRIDGE_PASSWORD = 'envpassword';
    delete process.env.PROTON_BRIDGE_SIMULATE;
    delete process.env.PROTON_BRIDGE_SECURE;
    delete process.env.PROTON_BRIDGE_REJECT_UNAUTHORIZED;

    const connector = new ProtonBridgeConnector(null);
    assert.equal(connector.testConfig(null), true, 'Env-only credentials should pass configuration validation');

    // If no credentials, it fails
    delete process.env.PROTON_BRIDGE_USERNAME;
    delete process.env.PROTON_BRIDGE_PASSWORD;
    assert.equal(connector.testConfig(null), false, 'Empty configuration/env should fail validation');

    // Restore env user/pass for simulation tests
    process.env.PROTON_BRIDGE_USERNAME = 'envuser';
    process.env.PROTON_BRIDGE_PASSWORD = 'envpassword';

    // 2. Reject or ignore simulateSuccess in production and non-test runtime
    // Under explicit test mode, allow simulateSuccess
    process.env.TEST_MODE = 'true';
    delete process.env.NODE_ENV;
    const testConfigSim = resolveProtonBridgeConfig({ simulateSuccess: true });
    assert.equal(testConfigSim.simulateSuccess, true, 'Test mode should allow simulateSuccess');

    // Production environment
    process.env.NODE_ENV = 'production';
    process.env.TEST_MODE = 'true';
    const prodConfigSim = resolveProtonBridgeConfig({ simulateSuccess: true });
    assert.equal(prodConfigSim.simulateSuccess, false, 'Production mode should reject simulateSuccess');

    // Non-test runtime (TEST_MODE not 'true')
    delete process.env.NODE_ENV;
    process.env.TEST_MODE = 'false';
    const nonTestConfigSim = resolveProtonBridgeConfig({ simulateSuccess: true });
    assert.equal(nonTestConfigSim.simulateSuccess, false, 'Non-test mode should reject simulateSuccess');

    // 3. Restrict plaintext IMAP (secure: false) to loopback/sidecar hosts only
    process.env.TEST_MODE = 'true';
    delete process.env.NODE_ENV;

    // Loopback allows secure: false / rejectUnauthorized: false (either default or explicit)
    const loopbackConnector = new ProtonBridgeConnector({
      host: '127.0.0.1',
      port: 1143,
      username: 'user',
      password: 'pwd',
      secure: false,
      rejectUnauthorized: false
    });
    assert.equal(loopbackConnector.testConfig(loopbackConnector.config), true, 'Loopback should allow plaintext/unverified secure configuration');

    // Non-loopback with secure: false fails config validation
    const nonLoopbackPlaintext = new ProtonBridgeConnector({
      host: 'imap.protonmail.ch',
      port: 993,
      username: 'user',
      password: 'pwd',
      secure: false,
      rejectUnauthorized: true
    });
    assert.equal(nonLoopbackPlaintext.testConfig(nonLoopbackPlaintext.config), false, 'Non-loopback with secure: false should fail validation');

    // Non-loopback with rejectUnauthorized: false fails config validation
    const nonLoopbackUnverified = new ProtonBridgeConnector({
      host: 'imap.protonmail.ch',
      port: 993,
      username: 'user',
      password: 'pwd',
      secure: true,
      rejectUnauthorized: false
    });
    assert.equal(nonLoopbackUnverified.testConfig(nonLoopbackUnverified.config), false, 'Non-loopback with rejectUnauthorized: false should fail validation');

    // Non-loopback defaults to secure: true, rejectUnauthorized: true, and passes validation
    const nonLoopbackDefault = new ProtonBridgeConnector({
      host: 'imap.protonmail.ch',
      port: 993,
      username: 'user',
      password: 'pwd'
    });
    assert.equal(nonLoopbackDefault.testConfig(nonLoopbackDefault.config), true, 'Non-loopback should default to secure: true and pass validation');
    assert.equal(nonLoopbackDefault.config.secure, true);
    assert.equal(nonLoopbackDefault.config.rejectUnauthorized, true);

  } finally {
    restore();
  }
});


test('15. Encrypted Artifacts and Decryption in Automation', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-encrypted-artifact-test-'));
  const password = 'test-secret-key-123';

  try {
    const appService = new AppService({
      dataDir: tmpDir,
      vaultPassword: password
    });

    await appService.init();

    // 1. Import a base PDF resume
    const caseyPdf = makeTextPdf('Casey Morgan\ncasey@example.com\nSkills\nPython, SQL');
    const importRes = await appService.importResumeArtifacts([
      {
        fileName: 'casey.pdf',
        contentBase64: caseyPdf.toString('base64'),
        mimeType: 'application/pdf'
      }
    ]);

    assert.equal(importRes.resumes.length, 1);
    const resumeRecord = appService.state.resumeArtifacts[0];
    assert.ok(resumeRecord);
    assert.ok(resumeRecord.uri.endsWith('.enc'), 'Base resume path should end with .enc');
    assert.ok(!resumeRecord.uri.includes('casey.pdf'), 'Base resume path should not include original filename');

    // Read the file directly from disk and verify it's encrypted
    const encryptedBytes = await fs.readFile(resumeRecord.uri);
    assert.ok(!encryptedBytes.toString().startsWith('%PDF'), 'Encrypted file should not start with %PDF');

    // Decrypt the file using Vault and verify it recovers the PDF
    const decryptedBytes = appService.vault.decryptBuffer(encryptedBytes);
    assert.ok(decryptedBytes.toString().startsWith('%PDF'), 'Decrypted bytes should start with %PDF');
    assert.ok(decryptedBytes.toString().includes('Casey Morgan'), 'Decrypted bytes should contain original content');

    // 2. Create an application with tailored resume PDF
    const createRes = await appService.createApplication('https://tech.myworkdayjobs.com/job/dev', {
      company: 'Tech Solutions',
      title: 'Node Developer',
      requirements: ['Python']
    });

    assert.equal(createRes.success, true);
    const appRecord = (await appService.tracker.getApplications()).find(a => a.id === createRes.application.id);
    assert.ok(appRecord);
    const resumeArtifact = appRecord.artifacts.find(a => a.type === 'resume_pdf');
    assert.ok(resumeArtifact);
    assert.ok(resumeArtifact.uri.endsWith('.enc'), 'Tailored resume path should end with .enc');

    // Read tailored resume from disk and verify it's encrypted
    const encryptedTailoredBytes = await fs.readFile(resumeArtifact.uri);
    assert.ok(!encryptedTailoredBytes.toString().startsWith('%PDF'), 'Tailored encrypted file should not start with %PDF');

    // Decrypt tailored resume and verify
    const decryptedTailoredBytes = appService.vault.decryptBuffer(encryptedTailoredBytes);
    assert.ok(decryptedTailoredBytes.toString().startsWith('%PDF'), 'Decrypted tailored bytes should start with %PDF');

    // 3. Test decryption during automation execution
    const { activeDecryptedFiles } = await import('../dist/src/automation.js');
    assert.equal(activeDecryptedFiles.size, 0, 'Should start with 0 active decrypted files');

    let checkedDecryptedFile = false;
    const successAdapter = {
      runtime: 'playwright',
      async inspect() { return { success: true, state: 'success' }; },
      async fillDraft(page, plan, options) {
        // Assert that the file is currently decrypted under tmpdir during execution
        assert.equal(activeDecryptedFiles.size, 1, 'Should have exactly 1 active decrypted file during execution');
        const tempPaths = Array.from(activeDecryptedFiles);
        const tempPath = tempPaths[0];
        assert.ok(tempPath.includes(os.tmpdir()), 'Temp path should be in os.tmpdir()');
        assert.ok(tempPath.endsWith('.pdf'), 'Temp path should end with .pdf');

        const tempBytes = await fs.readFile(tempPath);
        assert.ok(tempBytes.toString().startsWith('%PDF'), 'Temp file should be decrypted PDF');

        checkedDecryptedFile = true;
        return { success: true, state: 'reviewing_application' };
      },
      async submitApproved() { return { success: true, state: 'submitted' }; }
    };

    const approveRes = await appService.approveSubmission(createRes.application.id, {
      testMode: true,
      approved: true,
      approvedBy: 'test-reviewer',
      mode: 'submit_after_approval',
      adapter: successAdapter
    });

    assert.equal(approveRes.success, true);
    assert.equal(checkedDecryptedFile, true, 'Should have checked decrypted file during execution');
    assert.equal(activeDecryptedFiles.size, 0, 'Active decrypted files should be cleaned up after execution');

    // 4. Test app lock clears tracked files
    const strayFile = path.join(tmpDir, 'stray-decrypted-resume.pdf');
    activeDecryptedFiles.add(strayFile);
    await fs.writeFile(strayFile, 'fake pdf data');
    assert.equal(activeDecryptedFiles.size, 1);

    appService.lock();
    assert.equal(activeDecryptedFiles.size, 0, 'Locking should clear activeDecryptedFiles registry');
    await assert.rejects(async () => {
      await fs.access(strayFile);
    }, 'Locking should delete stray decrypted files on disk');

  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('16. Failed unlock/bootstrap must not invalidate an existing active session', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-failed-unlock-session-'));
  try {
    const appService = new AppService({ dataDir: tmpDir });
    
    // Create vault and establish a session
    await appService.createVault('session-pass-123');
    const firstStatus = await appService.getVaultStatus();
    assert.equal(firstStatus.locked, false, 'Vault should be unlocked initially');
    
    // Failed unlock with wrong password on the SAME active instance
    await assert.rejects(async () => {
      await appService.unlock('wrong-pass');
    }, /Invalid vault password/);
    
    // The existing active session must NOT be invalidated
    const secondStatus = await appService.getVaultStatus();
    assert.equal(secondStatus.locked, false, 'Failed unlock must not lock or invalidate the active session');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
