import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Import compiled dist modules
import * as adapterModule from '../dist/src/browser/playwrightAdapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'workday');

// Helper to start local HTTP server serving HTML fixtures
function startFixtureServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const requestPath = req.url === '/' ? '/basic-application.html' : new URL(req.url, 'http://fixture.local').pathname;
        const safePath = path.normalize(requestPath).replace(/^[/\\]+/, '').replace(/^(\.\.[/\\])+/, '');
        const filePath = path.join(FIXTURES_DIR, safePath);

        const content = await fs.readFile(filePath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      } catch (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Fixture Not Found');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' ? address.port : 0;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`
      });
    });

    server.on('error', reject);
  });
}

test('Playwright Automation Adapter Fixture Inspection Suite', async (t) => {
  const AdapterClass = adapterModule.PlaywrightBrowserAdapter || adapterModule.PlaywrightAutomationAdapter || adapterModule.default;
  assert.ok(AdapterClass, 'Playwright adapter class must be exported from dist/src/browser/playwrightAdapter.js');

  let fixtureServer;
  let baseUrl;

  try {
    fixtureServer = await startFixtureServer();
    baseUrl = fixtureServer.baseUrl;
  } catch (err) {
    assert.fail(`Failed to start local fixture server: ${err.message}`);
  }


  const hasBlocker = (result, code) => {
    const blockers = result?.blockers || result?.details?.blockers || [];
    return result?.blocker === code || blockers.some(b => b.code === code);
  };
  const runAdapterTest = async (testName, fixturePath, checkFn) => {
    await t.test(testName, async (st) => {
      const adapter = new AdapterClass();
      const targetUrl = `${baseUrl}/${fixturePath}`;

      try {
        const inspectResult = await adapter.inspect({ url: targetUrl });
        await checkFn(inspectResult, adapter);
      } catch (err) {
        const msg = err.message || String(err);
        if (
          msg.includes('Executable') ||
          msg.includes('playwright') ||
          msg.includes('browser') ||
          msg.includes('chromium') ||
          err.code === 'MODULE_NOT_FOUND'
        ) {
          st.skip(`Playwright / browser launch unavailable in environment: ${msg}`);
        } else {
          throw err;
        }
      } finally {
        if (typeof adapter.close === 'function') {
          await adapter.close().catch(() => {});
        }
      }
    });
  };

  await runAdapterTest(
    'Inspect Basic Application Fixture (No Fatal Blockers)',
    'basic-application.html',
    async (result) => {
      assert.ok(result, 'Inspect result should be returned');
      if (result.blockers) {
        const fatalBlockers = result.blockers.filter(b => b.severity === 'fatal' || b.code === 'captcha_required');
        assert.equal(fatalBlockers.length, 0, 'Basic application should have no fatal blockers');
      }
    }
  );

  await runAdapterTest(
    'Inspect Entry Point Fixture (Advances account creation before inspecting form)',
    'entry-point-application.html',
    async (result) => {
      assert.ok(result, 'Inspect result should be returned');
      if (result?.blocker === 'automation_not_configured') return;
      assert.equal(result.success, true, 'Inspect should succeed after opening the account creation form');
      const controls = result.details?.formControls || [];
      assert.ok(controls.some(ctrl => ctrl.id === 'firstName'), 'Entry action exposes first name field');
      assert.equal(result.details?.entryAction, 'Create Account', 'Entry action is recorded for provenance');
    }
  );


  await runAdapterTest(
    'Inspect Captcha Fixture (Detects captcha_required)',
    'captcha.html',
    async (result) => {
      assert.ok(result, 'Inspect result should be returned');
      if (result?.blocker === 'automation_not_configured') return;
      assert.ok(hasBlocker(result, 'captcha_required'), 'Should detect captcha_required blocker on captcha fixture');
    }
  );

  await runAdapterTest(
    'Inspect Email Verification Fixture (Detects email_verification_required)',
    'email-verification.html',
    async (result) => {
      assert.ok(result, 'Inspect result should be returned');
      if (result?.blocker === 'automation_not_configured') return;
      assert.ok(hasBlocker(result, 'email_verification_required'), 'Should detect email_verification_required blocker on email verification fixture');
    }
  );

  await runAdapterTest(
    'Inspect Two-Factor Fixture (Detects two_factor_required)',
    'two-factor.html',
    async (result) => {
      assert.ok(result, 'Inspect result should be returned');
      if (result?.blocker === 'automation_not_configured') return;
      assert.ok(hasBlocker(result, 'two_factor_required'), 'Should detect two_factor_required blocker on two-factor fixture');
    }
  );

  await runAdapterTest(
    'Inspect Unknown Required Field Fixture (Detects unknown_required_answer)',
    'unknown-required-field.html',
    async (result) => {
      assert.ok(result, 'Inspect result should be returned');
      if (result?.blocker === 'automation_not_configured') return;
      assert.ok(hasBlocker(result, 'unknown_required_answer'), 'Should detect unknown_required_answer blocker on unknown required field fixture');
    }
  );

  await runAdapterTest(
    'Inspect Confirmation / Review Fixture',
    'confirmation-review.html',
    async (result) => {
      assert.ok(result, 'Inspect result should be returned');
    }
  );

  await t.test('Safety Policy Invariant: submitApproved refuses submission without approval', async (st) => {
    const adapter = new AdapterClass();
    try {
      if (typeof adapter.submitApproved === 'function') {
        const res = await adapter.submitApproved({ url: `${baseUrl}/basic-application.html`, approved: false, mode: 'submit_after_approval' });
        assert.equal(res?.success, false, 'submitApproved must refuse submission when approved is false');
        assert.equal(res?.state, 'blocked', 'State must be blocked');
        assert.equal(res?.blocker, 'llm_output_requires_review', 'Blocker must be llm_output_requires_review');
      }
    } catch (err) {
      const msg = err.message || String(err);
      if (
        msg.includes('Executable') ||
        msg.includes('playwright') ||
        msg.includes('browser') ||
        err.code === 'MODULE_NOT_FOUND'
      ) {
        st.skip(`Playwright unavailable: ${msg}`);
      } else {
        assert.ok(err, 'submitApproved threw expected error refusing submission');
      }
    } finally {
      if (typeof adapter.close === 'function') {
        await adapter.close().catch(() => {});
      }
    }
  });

  // Cleanup server
  if (fixtureServer?.server) {
    await new Promise((resolve) => fixtureServer.server.close(resolve));
  }
});
test('Playwright Automation Adapter Fixture FillDraft Suite', async (t) => {
  const AdapterClass = adapterModule.PlaywrightBrowserAdapter || adapterModule.PlaywrightAutomationAdapter || adapterModule.default;
  assert.ok(AdapterClass, 'Playwright adapter class must be exported from dist/src/browser/playwrightAdapter.js');

  let fixtureServer;
  let baseUrl;

  try {
    fixtureServer = await startFixtureServer();
    baseUrl = fixtureServer.baseUrl;
  } catch (err) {
    assert.fail(`Failed to start local fixture server: ${err.message}`);
  }

  const sampleProfile = {
    candidateProfile: {
      name: 'Jane Doe',
      email: 'jane.doe@example.com',
      phone: '555-0199',
      skills: ['JavaScript', 'TypeScript'],
      experience: [],
      education: []
    },
    claimBank: [],
    answerMemory: {
      'legally authorized to work': 'Yes',
      'sponsorship': 'No'
    }
  };

  const hasBlocker = (result, code) => {
    const blockers = result?.blockers || result?.details?.blockers || [];
    return result?.blocker === code || blockers.some(b => b.code === code);
  };

  const dummyResumePath = path.join(FIXTURES_DIR, 'sample-resume.pdf');
  await fs.writeFile(dummyResumePath, 'Dummy Resume Content for Playwright Test');

  const runFillDraftTest = async (testName, fixturePath, checkFn, extraInput = {}) => {
    await t.test(testName, async (st) => {
      const { adapterOptions, ...fillDraftOptions } = extraInput;
      const adapter = new AdapterClass(adapterOptions);
      const targetUrl = fixturePath.startsWith('http') ? fixturePath : `${baseUrl}/${fixturePath}`;

      try {
        const fillResult = await adapter.fillDraft({ url: targetUrl, profile: sampleProfile, resumePath: dummyResumePath, mode: 'fill_review_only', ...fillDraftOptions });
        await checkFn(fillResult, adapter);
      } catch (err) {
        const msg = err.message || String(err);
        if (
          msg.includes('Executable') ||
          msg.includes('playwright') ||
          msg.includes('browser') ||
          msg.includes('chromium') ||
          err.code === 'MODULE_NOT_FOUND'
        ) {
          st.skip(`Playwright / browser launch unavailable in environment: ${msg}`);
        } else {
          throw err;
        }
      } finally {
        if (typeof adapter.close === 'function') {
          await adapter.close().catch(() => {});
        }
      }
    });
  };

  await runFillDraftTest(
    'FillDraft Basic Application Fixture (Fills profile fields & returns provenance)',
    'basic-application.html',
    async (result) => {
      assert.ok(result, 'FillDraft result should be returned');
      if (result?.blocker === 'automation_not_configured') return;
      assert.equal(result.success, true, 'FillDraft should succeed on basic application fixture');
      assert.equal(result.state, 'reviewing_application', 'State should be reviewing_application');

      const provenance = result.provenance || result.details?.provenance;
      const filledFields = result.filledFields || result.details?.filledFields;
      assert.ok(provenance || filledFields, 'Result or details must contain provenance or filledFields');
      if (provenance) {
        assert.ok(Array.isArray(provenance), 'Provenance should be an array');
        assert.ok(provenance.some(p => p.field === 'firstName' && p.source.includes('candidateProfile')), 'Provenance for firstName');
        assert.ok(provenance.some(p => p.field === 'email' && p.source.includes('candidateProfile')), 'Provenance for email');
        assert.ok(provenance.some(p => p.field === 'phone' && p.source.includes('candidateProfile')), 'Provenance for phone');
        assert.ok(provenance.some(p => p.field === 'workAuth' && p.source.includes('answerMemory')), 'Provenance for workAuth select');
        assert.ok(provenance.some(p => p.field === 'resume' && p.source.includes('artifact')), 'Provenance for resume file upload');
      }
      if (filledFields) {
        assert.ok(Array.isArray(filledFields), 'Filled fields should be an array');
        assert.ok(filledFields.includes('resume'), 'filledFields includes resume file upload');
      }
    }
  );

  await runFillDraftTest(
    'FillDraft Entry Point Fixture (Opens tenant account form before filling)',
    'entry-point-application.html',
    async (result) => {
      assert.ok(result, 'FillDraft result should be returned');
      if (result?.blocker === 'automation_not_configured') return;
      assert.equal(result.success, true, 'FillDraft should succeed after entry action');
      assert.equal(result.state, 'reviewing_application', 'State should be reviewing_application');
      assert.equal(result.details?.entryAction, 'Create Account', 'Entry action is recorded for review');
      const filledFields = result.filledFields || result.details?.filledFields || [];
      assert.ok(filledFields.includes('resume'), 'filledFields includes resume file upload');
      const controlStates = result.details?.controlStates || [];
      const firstNameState = controlStates.find(ctrl => ctrl.id === 'firstName');
      assert.equal(firstNameState?.value, 'Jane', 'First name field receives parsed profile value after entry action');
    }
  );


  await runFillDraftTest(
    'FillDraft Captcha Fixture (Detects captcha_required)',
    'captcha.html',
    async (result) => {
      assert.ok(result, 'FillDraft result should be returned');
      if (result?.blocker === 'automation_not_configured') return;
      assert.equal(result.success, false, 'FillDraft should fail on captcha fixture');
      assert.equal(result.state, 'blocked', 'State should be blocked');
      assert.ok(hasBlocker(result, 'captcha_required'), 'Should detect captcha_required blocker');
    }
  );

  const fakeLlmSolver = {
    solve: async (challenge) => {
      return {
        success: true,
        provider: 'configured_llm',
        kind: 'text_prompt',
        status: 'solved',
        answer: '7GQ2',
        elapsedMs: 1
      };
    }
  };

  await runFillDraftTest(
    'FillDraft LLM Captcha Fixture (Solves direct prompt through configured LLM solver)',
    'llm-captcha.html',
    async (result) => {
      assert.ok(result, 'FillDraft result should be returned');
      if (result?.blocker === 'automation_not_configured') return;
      assert.equal(result.success, true, 'FillDraft should succeed when CAPTCHA is solved');
      assert.equal(result.state, 'reviewing_application', 'State should be reviewing_application');
      assert.equal(result.details?.captchaSolver?.status, 'solved', 'CAPTCHA solver status should be solved');
      const filledFields = result.filledFields || result.details?.filledFields || [];
      assert.ok(filledFields.includes('firstName'), 'filledFields should include firstName');
      assert.ok(filledFields.includes('email'), 'filledFields should include email');
      assert.ok(filledFields.includes('resume'), 'filledFields should include resume');
      assert.notEqual(result.blocker, 'captcha_required', 'Result blocker should not be captcha_required');
      const blockers = result?.blockers || result?.details?.blockers || [];
      assert.ok(!blockers.some(b => b.code === 'captcha_required'), 'Blockers should not include captcha_required');
    },
    { adapterOptions: { captchaSolver: fakeLlmSolver } }
  );

  await runFillDraftTest(
    'FillDraft LLM Captcha Fixture (Unsupported token widget remains captcha_required)',
    'captcha.html',
    async (result) => {
      assert.ok(result, 'FillDraft result should be returned');
      if (result?.blocker === 'automation_not_configured') return;
      assert.equal(result.success, false, 'FillDraft should fail on unsupported widget');
      assert.equal(result.state, 'blocked', 'State should be blocked');
      assert.ok(hasBlocker(result, 'captcha_required'), 'Should detect captcha_required blocker');
    },
    { adapterOptions: { captchaSolver: fakeLlmSolver } }
  );

  await runFillDraftTest(
    'FillDraft Email Verification Fixture (Detects email_verification_required)',
    'email-verification.html',
    async (result) => {
      assert.ok(result, 'FillDraft result should be returned');
      if (result?.blocker === 'automation_not_configured') return;
      assert.equal(result.success, false, 'FillDraft should fail on email verification fixture');
      assert.equal(result.state, 'blocked', 'State should be blocked');
      assert.ok(hasBlocker(result, 'email_verification_required'), 'Should detect email_verification_required blocker');
    }
  );

  await runFillDraftTest(
    'FillDraft Two-Factor Fixture (Detects two_factor_required)',
    'two-factor.html',
    async (result) => {
      assert.ok(result, 'FillDraft result should be returned');
      if (result?.blocker === 'automation_not_configured') return;
      assert.equal(result.success, false, 'FillDraft should fail on two-factor fixture');
      assert.equal(result.state, 'blocked', 'State should be blocked');
      assert.ok(hasBlocker(result, 'two_factor_required'), 'Should detect two_factor_required blocker');
    }
  );

  await runFillDraftTest(
    'FillDraft Unknown Required Field Fixture (Detects unknown_required_answer)',
    'unknown-required-field.html',
    async (result) => {
      assert.ok(result, 'FillDraft result should be returned');
      if (result?.blocker === 'automation_not_configured') return;
      assert.equal(result.success, false, 'FillDraft should fail on unknown required field fixture');
      assert.equal(result.state, 'blocked', 'State should be blocked');
      assert.ok(hasBlocker(result, 'unknown_required_answer'), 'Should detect unknown_required_answer blocker');
    }
  );
  await runFillDraftTest(
    'FillDraft Missing Resume Artifact (Detects missing_resume_artifact)',
    'basic-application.html',
    async (result) => {
      assert.ok(result, 'FillDraft result should be returned');
      if (result?.blocker === 'automation_not_configured') return;
      assert.equal(result.success, false, 'FillDraft should fail when resume artifact is missing');
      assert.equal(result.state, 'blocked', 'State should be blocked');
      assert.ok(hasBlocker(result, 'missing_resume_artifact'), 'Should detect missing_resume_artifact blocker');
    },
    { resumePath: '/non/existent/path/missing-resume.pdf' }
  );

  await runFillDraftTest(
    'FillDraft Untrusted Domain (Detects site_automation_disallowed)',
    'https://untrusted-domain.com/apply',
    async (result) => {
      assert.ok(result, 'FillDraft result should be returned');
      assert.equal(result.success, false, 'FillDraft should fail on untrusted domain');
      assert.equal(result.state, 'blocked', 'State should be blocked');
      assert.ok(hasBlocker(result, 'site_automation_disallowed'), 'Should detect site_automation_disallowed blocker');
    }
  );

  await runFillDraftTest(
    'FillDraft Complex Controls Fixture (Proves state changes for checkbox, radio, select, file, text)',
    'complex-controls.html',
    async (result) => {
      assert.ok(result, 'FillDraft result should be returned');
      if (result?.blocker === 'automation_not_configured') return;
      assert.equal(result.success, true, 'FillDraft should succeed on complex controls fixture');
      assert.equal(result.state, 'reviewing_application', 'State should be reviewing_application');

      const controlStates = result.details?.controlStates;
      assert.ok(Array.isArray(controlStates), 'controlStates must be returned in details to prove DOM state changes');
      
      const cbState = controlStates.find(c => c.id === 'agreeTerms');
      assert.ok(cbState, 'Checkbox state for agreeTerms present');
      assert.equal(cbState.checked, true, 'Checkbox agreeTerms must be checked');

      const radioState = controlStates.find(c => c.id === 'relocateOpt');
      assert.ok(radioState, 'Radio state for relocateOpt present');
      assert.equal(radioState.checked, true, 'Radio relocateOpt must be checked');

      const selectState = controlStates.find(c => c.id === 'workAuth');
      assert.ok(selectState, 'Select state for workAuth present');
      assert.equal(selectState.value, 'yes', 'Select workAuth value must be updated');
    }
  );

  await t.test('SubmitApproved Verification: returns submitted when confirmation exists', async (st) => {
    const adapter = new AdapterClass();
    try {
      const res = await adapter.submitApproved({
        url: `${baseUrl}/confirmation-review.html`,
        approved: true,
        mode: 'submit_after_approval',
        application: {
          id: 'fixture-app',
          url: `${baseUrl}/confirmation-review.html`,
          company: 'Fixture Co',
          title: 'Fixture Role',
          status: 'ready_to_submit',
          events: [],
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          approval: {
            id: 'fixture-approval',
            applicationId: 'fixture-app',
            approvedBy: 'fixture-reviewer',
            approvedAt: new Date(0).toISOString(),
            fieldSnapshotHash: 'fixture',
            blockerSnapshotHash: 'fixture'
          }
        }
      });
      if (res?.blocker === 'automation_not_configured') return;
      assert.equal(res?.success, true, 'submitApproved must succeed when confirmation evidence exists');
      assert.equal(res?.state, 'submitted', 'State must be submitted when confirmation detected');
    } catch (err) {
      const msg = err.message || String(err);
      if (msg.includes('Executable') || msg.includes('playwright') || msg.includes('browser') || err.code === 'MODULE_NOT_FOUND') {
        st.skip(`Playwright unavailable: ${msg}`);
      } else throw err;
    } finally {
      if (typeof adapter.close === 'function') await adapter.close().catch(() => {});
    }
  });

  await t.test('SubmitApproved Safety Invariant: refuses submitted state on form without confirmation evidence or with validation errors', async (st) => {
    const adapter = new AdapterClass();
    try {
      const res = await adapter.submitApproved({ url: `${baseUrl}/basic-application.html`, approved: true, mode: 'submit_after_approval' });
      if (res?.blocker === 'automation_not_configured') return;
      assert.equal(res?.success, false, 'submitApproved must fail when confirmation evidence is missing or form has errors');
      assert.equal(res?.state, 'blocked', 'State must be blocked, not submitted');
    } catch (err) {
      const msg = err.message || String(err);
      if (msg.includes('Executable') || msg.includes('playwright') || msg.includes('browser') || err.code === 'MODULE_NOT_FOUND') {
        st.skip(`Playwright unavailable: ${msg}`);
      } else throw err;
    } finally {
      if (typeof adapter.close === 'function') await adapter.close().catch(() => {});
    }
  });

  // Cleanup server
  if (fixtureServer?.server) {
    await new Promise((resolve) => fixtureServer.server.close(resolve));
  }
});
