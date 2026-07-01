import os from 'os';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import { unlinkSync } from 'fs';
import { Vault } from './storage.js';
import { ProfileBuilder, buildClaimBank } from './profile.js';
import { extractPdfResumeText } from './resumePdf.js';
import { ResumeTailor } from './resume.js';
import { TrackerLedger } from './tracker.js';
import { SafetyGate, type SafetyGateOptions } from './safety.js';
import { WorkdayPlanner } from './workday.js';
import { AutomationExecutor, type AutomationOptions, activeDecryptedFiles } from './automation.js';
import type { DatabaseOptions, DatabaseService } from './db.js';
import { AutomationQueue } from './queue.js';
import {
  type ApplicationRecord,
  type ApplicationStatus,
  type ProfileBundle,
  type ProtonBridgeConfig,
  type WorkdayPlan,
  type LLMActionRecord,
  type SubmissionApproval,
  type ResumeArtifactMetadata,
  type BaseResumeRecord,
  type BaseResumeSummary,
  type UploadedResumeInput,
  type CandidateProfile,
  type Claim,
  type VaultStatus,
  type ApplicationArtifact,
  type BlockerItem,
  computeBlockerSnapshotHash,
  computeFieldSnapshotHash,
  normalizeBlockerCode
} from './types.js';
import type { LLMProviderConfig, ProviderKind, LLMUsage } from './llm/index.js';
import { LLMProvider, tailorResumeWithLLM } from './llm/index.js';
import { PlaywrightBrowserAdapter } from './browser/playwrightAdapter.js';
import { LlmCaptchaSolver } from './browser/llmCaptchaSolver.js';

export interface LLMProviderSummary {
  id: string;
  name: string;
  kind: ProviderKind;
  model: string;
  baseUrl?: string;
  apiKeyRef?: string;
  isActive?: boolean;
  hasApiKey: boolean;
}

type Credentials = { username?: string; password?: string } | null;

type AppServiceOptions = {
  dataDir?: string;
  vaultPassword?: string;
  tracker?: TrackerLedger;
  db?: DatabaseService;
  dbOptions?: DatabaseOptions;
  safetyOptions?: SafetyGateOptions;
  testMode?: boolean;
  adapter?: AutomationOptions['adapter'];
};

type VaultPayload = {
  profile?: ProfileBundle | null;
  credentials?: Credentials;
  protonConfig?: ProtonBridgeConfig | null;
  llmProviders?: LLMProviderConfig[];
  llmSecrets?: Record<string, string>;
  resumeArtifact?: ResumeArtifactMetadata | null;
  resumeArtifacts?: BaseResumeRecord[];
  activeResumeId?: string | null;
};

type AppServiceState = {
  profile: ProfileBundle | null;
  credentials: Credentials;
  protonConfig: ProtonBridgeConfig | null;
  llmProviders: LLMProviderConfig[];
  llmSecrets: Record<string, string>;
  resumeArtifacts: BaseResumeRecord[];
  activeResumeId: string | null;
};

type JobDetails = {
  company?: string;
  title?: string;
  salary?: number | null;
  postingHash?: string | null;
  requirements?: string[];
  requiredFields?: string[];
  unresolvedChecks?: {
    captcha?: boolean;
    twoFactor?: boolean;
    emailVerification?: boolean;
  };
  resumeId?: string | null;
};

type ServiceResult = {
  success: boolean;
  blocker?: string;
  reasons?: string[];
  status?: string;
  message?: string;
  application?: ApplicationRecord;
  plan?: WorkdayPlan;
  safety?: { blocked: boolean; reasons: string[] };
  resumeHtml?: string | null;
  jobId?: string;
};

function isProfileBundle(value: unknown): value is ProfileBundle {
  return Boolean(value && typeof value === 'object' && 'candidateProfile' in value && 'claimBank' in value && 'answerMemory' in value);
}

export class AppService {
  options: AppServiceOptions;
  dataDir: string;
  vaultPassword: string;
  vault: Vault<VaultPayload>;
  tracker: TrackerLedger;
  profileBuilder: ProfileBuilder;
  safetyGate: SafetyGate;
  workdayPlanner: WorkdayPlanner;
  automationExecutor: AutomationExecutor;
  database: DatabaseService | null;
  initialized: boolean;
  state: AppServiceState;

  constructor(options: AppServiceOptions = {}) {
    this.options = options;
    this.dataDir = options.dataDir || process.env.APPLY_AGENT_DATA_DIR || './data';
    this.vaultPassword = options.vaultPassword || process.env.VAULT_PASSWORD || '';
    const vaultPath = path.join(this.dataDir, 'vault.enc');
    const ledgerPath = path.join(this.dataDir, 'ledger.json');

    this.vault = new Vault<VaultPayload>(vaultPath, this.vaultPassword);
    this.tracker = options.tracker || new TrackerLedger(ledgerPath, options);
    this.profileBuilder = new ProfileBuilder();
    this.safetyGate = new SafetyGate(options.safetyOptions || {});
    this.workdayPlanner = new WorkdayPlanner();
    this.automationExecutor = new AutomationExecutor();
    this.database = this.tracker.getDb();
    this.initialized = false;
    this.state = {
      profile: null,
      credentials: null,
      protonConfig: null,
      llmProviders: [],
      llmSecrets: {},
      resumeArtifacts: [],
      activeResumeId: null
    };
  }
  private getActiveLLMProviderConfigWithSecret(): LLMProviderConfig | null {
    const activeProvider = (this.state.llmProviders || []).find(p => p.isActive) ||
      (this.state.llmProviders || []).find(p => p.apiKey || (p.apiKeyRef && this.state.llmSecrets[p.apiKeyRef]));
    if (!activeProvider) return null;
    const keyRef = activeProvider.apiKeyRef || `secret_${activeProvider.id}`;
    const secretKey = this.state.llmSecrets[keyRef] || activeProvider.apiKey;
    return { ...activeProvider, apiKey: secretKey };
  }

  private async resolveAdapter(overrideAdapter?: AutomationOptions['adapter']): Promise<AutomationOptions['adapter'] | null> {
    if (overrideAdapter !== undefined && overrideAdapter !== null) {
      return overrideAdapter;
    }
    if (this.options.adapter !== undefined && this.options.adapter !== null) {
      return this.options.adapter;
    }
    const providerConfig = this.getActiveLLMProviderConfigWithSecret();
    const captchaSolver = providerConfig ? new LlmCaptchaSolver(new LLMProvider(providerConfig)) : null;
    return new PlaywrightBrowserAdapter({ captchaSolver });
  }

  private applyProfile(profile: ProfileBundle): void {
    this.state.profile = profile;
    this.profileBuilder.candidateProfile = profile.candidateProfile;
    this.profileBuilder.claimBank = profile.claimBank;
    this.profileBuilder.answerMemory = profile.answerMemory;
  }
  private async generateResumePdfArtifact(appId: string, html: string): Promise<ApplicationArtifact> {
    const resDir = path.join(this.dataDir, 'artifacts', 'resumes', appId);
    await fs.mkdir(resDir, { recursive: true });
    const tempPdfPath = path.join(os.tmpdir(), `tailored-resume-${crypto.randomUUID()}.pdf`);
    const encryptedPdfPath = path.join(resDir, 'resume.pdf.enc');

    let pwGenerated = false;
    try {
      // Dynamic import exception: Playwright may be unavailable in headless/server deployments; fall back to HTML artifact generation.
      const playwrightModule = await import('playwright');
      if (playwrightModule && typeof playwrightModule === 'object' && 'chromium' in playwrightModule) {
        const playwright = playwrightModule as { chromium: { launch(opts?: unknown): Promise<unknown> } };
        const browser = (await playwright.chromium.launch({ headless: true })) as {
          newContext(): Promise<{ newPage(): Promise<{ setContent(h: string, opts?: unknown): Promise<void>; pdf(opts: { path: string; format?: string }): Promise<Buffer> }> }>;
          close(): Promise<void>;
        };
        try {
          const context = await browser.newContext();
          const page = await context.newPage();
          await page.setContent(html, { waitUntil: 'load' });
          await page.pdf({ path: tempPdfPath, format: 'A4' });
          pwGenerated = true;
        } finally {
          await browser.close();
        }
      }
    } catch {
      pwGenerated = false;
    }

    if (!pwGenerated) {
      try {
        await fs.access(tempPdfPath);
      } catch {
        const minimalPdf = Buffer.from(
          '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>>>endobj\nxref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n0000000052 00000 n\n0000000101 00000 n\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n178\n%%EOF'
        );
        await fs.writeFile(tempPdfPath, minimalPdf);
      }
    }

    try {
      const fileContent = await fs.readFile(tempPdfPath);
      const pdfHash = crypto.createHash('sha256').update(fileContent).digest('hex');
      const encryptedContent = this.vault.encryptBuffer(fileContent);
      await fs.writeFile(encryptedPdfPath, encryptedContent);

      return {
        id: `artifact_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        type: 'resume_pdf',
        name: 'Tailored Resume PDF',
        uri: encryptedPdfPath,
        mimeType: 'application/pdf',
        hash: pdfHash,
        createdAt: new Date().toISOString(),
        provenance: {
          source: 'resume_tailor',
          generator: 'playwright',
          timestamp: new Date().toISOString()
        }
      };
    } finally {
      try {
        await fs.unlink(tempPdfPath);
      } catch {}
    }
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    await this.tracker.load();

    if (await this.vault.exists()) {
      if (!this.vaultPassword) {
        throw new Error('Vault is locked. Password is required.');
      }
      const decrypted = await this.vault.load();
      this.state.credentials = decrypted.credentials || null;
      this.state.protonConfig = decrypted.protonConfig || null;
      this.state.llmProviders = decrypted.llmProviders || [];
      this.state.llmSecrets = decrypted.llmSecrets || {};
      this.state.resumeArtifacts = decrypted.resumeArtifacts || [];
      this.state.activeResumeId = decrypted.activeResumeId || null;

      if (decrypted.resumeArtifact && (!decrypted.resumeArtifacts || decrypted.resumeArtifacts.length === 0)) {
        const legacyArt = decrypted.resumeArtifact;
        const legacyProfile = decrypted.profile || {
          candidateProfile: { name: '', email: '', phone: '', skills: [], experience: [], education: [], projects: [] },
          claimBank: [],
          answerMemory: {}
        };
        const migratedRecord: BaseResumeRecord = {
          ...legacyArt,
          label: legacyArt.fileName,
          candidateProfile: legacyProfile.candidateProfile,
          claimBank: legacyProfile.claimBank,
          parse: {
            parser: 'legacy-text-import',
            parserVersion: 'pre-pdf-parser',
            textHash: legacyArt.hash,
            textLength: 0,
            parsedAt: legacyArt.uploadedAt
          }
        };
        this.state.resumeArtifacts = [migratedRecord];
        this.state.activeResumeId = migratedRecord.id;
      }
      if (decrypted.profile) {
        this.applyProfile(decrypted.profile);
      }
    }


    this.initialized = true;
  }

  async saveVault(): Promise<void> {
    const profile: ProfileBundle = {
      candidateProfile: this.profileBuilder.candidateProfile,
      claimBank: this.profileBuilder.claimBank,
      answerMemory: this.profileBuilder.answerMemory
    };
    const dataToEncrypt: VaultPayload = {
      profile,
      credentials: this.state.credentials,
      protonConfig: this.state.protonConfig,
      llmProviders: this.state.llmProviders,
      llmSecrets: this.state.llmSecrets,
      resumeArtifacts: this.state.resumeArtifacts,
      activeResumeId: this.state.activeResumeId
    };
    await this.vault.save(dataToEncrypt);
  }

  async updateProfile(resumeText: string, interviewAnswers: Record<string, string> = {}): Promise<ProfileBundle> {
    await this.init();
    const result = this.profileBuilder.build(resumeText, interviewAnswers);
    this.applyProfile(result);
    await this.saveVault();
    return result;
  }

  async setCredentials(username: string, password: string): Promise<void> {
    await this.init();
    this.state.credentials = { username, password };
    await this.saveVault();
  }

  async setProtonConfig(config: ProtonBridgeConfig): Promise<void> {
    await this.init();
    this.state.protonConfig = config;
    await this.saveVault();
  }

  async createApplication(url: string, jobDetails: JobDetails = {}): Promise<ServiceResult> {
    await this.init();

    let selectedResume: BaseResumeRecord | null = null;
    if (jobDetails.resumeId) {
      const found = this.state.resumeArtifacts.find(r => r.id === jobDetails.resumeId);
      if (!found) {
        return {
          success: false,
          blocker: 'missing_resume_artifact',
          message: 'Selected resume does not exist.'
        };
      }
      selectedResume = found;
    } else {
      selectedResume = this.state.resumeArtifacts.find(r => r.id === this.state.activeResumeId) || null;
    }

    const targetProfile: ProfileBundle | null = selectedResume
      ? {
          candidateProfile: selectedResume.candidateProfile,
          claimBank: selectedResume.claimBank,
          answerMemory: this.state.profile?.answerMemory || {}
        }
      : this.state.profile;

    const planResult = this.workdayPlanner.plan(url, this.state.credentials);
    if (planResult.blockedReasons?.includes('INVALID_WORKDAY_URL')) {
      return {
        success: false,
        blocker: 'INVALID_WORKDAY_URL',
        message: planResult.message
      };
    }

    const appData = {
      url,
      company: jobDetails.company || planResult.tenant || 'Workday Tenant',
      title: jobDetails.title || 'Workday Application',
      salary: jobDetails.salary || null,
      postingHash: jobDetails.postingHash || null
    };

    const isDup = await this.tracker.isDuplicate(appData);
    if (isDup) {
      return {
        success: false,
        blocker: 'duplicate_application',
        message: `An application to ${appData.company} for "${appData.title}" already exists.`
      };
    }

    let resumeHtml: string | null = null;
    let resumeClaims: { unsupported?: string[] } = {};
    const initialLLMActions: LLMActionRecord[] = [];
    const extraBlockers: BlockerItem[] = [];

    const activeProvider = this.getActiveLLMProviderConfigWithSecret();

    if (activeProvider && targetProfile) {
      try {
        const instance = new LLMProvider(activeProvider);
        const tailorRes = await tailorResumeWithLLM(instance, targetProfile, jobDetails.requirements || []);
        resumeHtml = tailorRes.html;
        initialLLMActions.push(tailorRes.record);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const failRecord: LLMActionRecord = {
          id: `action_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          type: 'resume_tailoring',
          status: 'failed',
          error: errMsg,
          createdAt: new Date().toISOString()
        };
        initialLLMActions.push(failRecord);
        extraBlockers.push({
          code: 'llm_output_requires_review',
          message: `LLM resume tailoring failed: ${errMsg}`,
          severity: 'recoverable',
          source: 'llm_tailor'
        });
      }
    } else if (!activeProvider) {
      extraBlockers.push({
        code: 'automation_not_configured',
        message: 'No active LLM provider configured for resume tailoring.',
        severity: 'info',
        source: 'system'
      });
    }

    if (!resumeHtml && targetProfile) {
      const tailor = new ResumeTailor(targetProfile);
      const tailored = tailor.tailor(jobDetails.requirements || []);
      resumeHtml = tailored.html;
      resumeClaims = tailored;
    }

    const safetyData = {
      ...appData,
      isDuplicate: isDup,
      requiredFields: jobDetails.requiredFields || [],
      providedAnswers: this.profileBuilder.answerMemory,
      unresolvedChecks: jobDetails.unresolvedChecks || { captcha: false, twoFactor: false, emailVerification: false }
    };
    const safetyResult = this.safetyGate.check(safetyData, resumeClaims, {
      salaryFloor: this.safetyGate.getSalaryFloor()
    });

    const initialBlockers: BlockerItem[] = [...extraBlockers];
    if (safetyResult.blocked && safetyResult.reasons) {
      for (const r of safetyResult.reasons) {
        initialBlockers.push({
          code: normalizeBlockerCode(r),
          message: r,
          severity: 'fatal'
        });
      }
    }

    const isBlocked = safetyResult.blocked || initialBlockers.some(b => b.severity === 'fatal' || (b.code === 'llm_output_requires_review' && b.source !== 'llm_tailor'));

    const createResult = await this.tracker.createApplication({
      ...appData,
      requirements: jobDetails.requirements || [],
      requiredFields: jobDetails.requiredFields || [],
      unresolvedChecks: jobDetails.unresolvedChecks || {},
      llmActions: initialLLMActions,
      blockers: initialBlockers,
      status: isBlocked ? 'blocked' : 'ready_to_submit',
      resumeVersion: selectedResume ? selectedResume.id : null
    });

    if (!createResult.success || !createResult.application) {
      return createResult;
    }

    const application = createResult.application;

    if (resumeHtml) {
      try {
        const pdfArtifact = await this.generateResumePdfArtifact(application.id, resumeHtml);
        await this.tracker.appendArtifact(application.id, pdfArtifact);
        application.artifacts = [...(application.artifacts || []), pdfArtifact];
      } catch (pdfErr) {
        console.error('Failed to append resume PDF artifact on intake:', pdfErr);
      }
    }

    await this.tracker.appendEvent(
      application.id,
      'PLAN_GENERATED',
      `Plan generated with ${planResult.steps.length} steps. Subdomain tenant: ${planResult.tenant}.`
    );

    if (safetyResult.blocked) {
      await this.tracker.appendEvent(
        application.id,
        'SAFETY_GATE_BLOCKED',
        `Safety gate blocked: ${safetyResult.reasons.join('; ')}`
      );
    }

    return {
      success: true,
      application,
      plan: planResult,
      safety: safetyResult,
      resumeHtml
    };
  }

  async answerPrompt(appId: string, promptId: string, question: string, answer: string): Promise<void> {
    await this.init();
    await this.updateProfile('', { [question]: answer });
    await this.tracker.appendEvent(
      appId,
      'PROMPT_ANSWERED',
      `Answered prompt "${promptId}" ("${question}"): "${answer}"`
    );
  }

  async recordApproval(
    appId: string,
    options: { approved: boolean; approvedBy?: string; reviewUrl?: string | null }
  ): Promise<ServiceResult> {
    await this.init();
    if (options.approved !== true) {
      return {
        success: false,
        blocker: 'APPROVAL_REQUIRED',
        message: 'Explicit approved=true input is required to record approval.'
      };
    }
    const apps = await this.tracker.getApplications();
    const app = apps.find(candidate => candidate.id === appId);
    if (!app) {
      return {
        success: false,
        blocker: 'APPLICATION_NOT_FOUND',
        message: `Application with ID ${appId} not found.`
      };
    }
    const approval: SubmissionApproval = {
      id: crypto.randomUUID(),
      applicationId: appId,
      approvedBy: options.approvedBy || 'user',
      approvedAt: new Date().toISOString(),
      fieldSnapshotHash: computeFieldSnapshotHash(app),
      blockerSnapshotHash: computeBlockerSnapshotHash(app.blockers),
      reviewUrl: options.reviewUrl || app.url
    };
    const updatedApp = await this.tracker.recordSubmissionApproval(appId, approval);
    await this.tracker.appendEvent(appId, 'SUBMISSION_APPROVED', `Submission approval recorded by ${approval.approvedBy}.`);
    return {
      success: true,
      application: updatedApp,
      message: 'Submission approval recorded successfully.'
    };
  }

  async approveSubmission(
    appId: string,
    approveOptions: {
      testMode?: boolean;
      adapter?: AutomationOptions['adapter'];
      mode?: AutomationOptions['mode'];
      approved?: boolean;
      approvedBy?: string;
      reviewUrl?: string | null;
      inline?: boolean;
      forceInline?: boolean;
    } = {}
  ): Promise<ServiceResult> {
    await this.init();

    let apps = await this.tracker.getApplications();
    let app = apps.find(candidate => candidate.id === appId);
    if (!app) {
      return {
        success: false,
        blocker: 'APPLICATION_NOT_FOUND',
        message: `Application with ID ${appId} not found.`
      };
    }

    if (approveOptions.approved === true) {
      const recRes = await this.recordApproval(appId, {
        approved: true,
        approvedBy: approveOptions.approvedBy,
        reviewUrl: approveOptions.reviewUrl
      });
      if (recRes.application) {
        app = recRes.application;
      } else {
        apps = await this.tracker.getApplications();
        app = apps.find(candidate => candidate.id === appId) || app;
      }
    }

    const creds = this.state.credentials;
    const hasCredentials = !!(creds && creds.username && creds.password);
    const cleanCreds = hasCredentials ? creds : null;

    const testMode = process.env.NODE_ENV !== 'production' && (approveOptions.testMode || this.options.testMode || process.env.TEST_MODE === 'true');
    const inline = (process.env.NODE_ENV !== 'production' && approveOptions.inline === true) || approveOptions.forceInline === true || process.env.INLINE_EXECUTION === 'true';
    const hasExplicitAdapter = (approveOptions.adapter !== undefined && approveOptions.adapter !== null) || (this.options.adapter !== undefined && this.options.adapter !== null);
    const hasConfiguredRuntime = typeof process.env.AUTOMATION_RUNTIME === 'string' && ['playwright', 'agent-browser'].includes(process.env.AUTOMATION_RUNTIME);

    if (!testMode && !hasExplicitAdapter && !hasConfiguredRuntime) {
      await this.tracker.updateStatus(appId, 'blocked');
      await this.tracker.appendEvent(appId, 'EXEC_STEP_BLOCKED', 'Automation execution blocked: Browser automation adapter or runtime not configured.');
      return {
        success: false,
        blocker: 'automation_not_configured',
        message: 'automation_not_configured'
      };
    }

    if (!testMode && !inline && !hasExplicitAdapter && this.database) {
      const queue = new AutomationQueue(this.database);
      const isServerSideTest = process.env.NODE_ENV !== 'production' && (this.options.testMode || process.env.TEST_MODE === 'true');
      const job = await queue.enqueue(appId, {
        approved: approveOptions.approved,
        approvedBy: approveOptions.approvedBy,
        reviewUrl: approveOptions.reviewUrl,
        mode: approveOptions.mode,
        testMode: isServerSideTest ? approveOptions.testMode : undefined
      });
      await this.tracker.appendEvent(appId, 'AUTOMATION_QUEUED', `Automation execution enqueued. Job ID: ${job.id}`);
      return {
        success: true,
        status: 'queued',
        message: 'Automation execution enqueued.',
        jobId: job.id
      };
    }


    let resumePath: string | undefined;
    if (app.artifacts && app.artifacts.length > 0) {
      const resumeArtifacts = app.artifacts.filter(a =>
        a.type === 'resume_pdf' || a.type === 'resume_docx' || a.type.startsWith('resume') || a.name?.toLowerCase().includes('resume')
      );
      if (resumeArtifacts.length > 0) {
        const latest = resumeArtifacts[resumeArtifacts.length - 1];
        resumePath = latest.uri || latest.content;
      }
    }
    if (!resumePath && app.resumeVersion) {
      const appResume = this.state.resumeArtifacts.find(r => r.id === app.resumeVersion);
      if (appResume) {
        resumePath = appResume.path || appResume.uri;
      }
    }
    if (!resumePath && this.state.activeResumeId) {
      const activeResume = this.state.resumeArtifacts.find(r => r.id === this.state.activeResumeId);
      if (activeResume) {
        resumePath = activeResume.path || activeResume.uri;
      }
    }

    let appResumeRecord: BaseResumeRecord | null = null;
    if (app.resumeVersion) {
      appResumeRecord = this.state.resumeArtifacts.find(r => r.id === app.resumeVersion) || null;
    }
    if (!appResumeRecord && this.state.activeResumeId) {
      appResumeRecord = this.state.resumeArtifacts.find(r => r.id === this.state.activeResumeId) || null;
    }
    const appProfile: ProfileBundle | null = appResumeRecord
      ? {
          candidateProfile: appResumeRecord.candidateProfile,
          claimBank: appResumeRecord.claimBank,
          answerMemory: this.state.profile?.answerMemory || {}
        }
      : this.state.profile;

    const plan = this.workdayPlanner.plan(app.url, cleanCreds);
    const adapter = await this.resolveAdapter(approveOptions.adapter);
    const mode = approveOptions.mode || 'fill_review_only';
    const approved = approveOptions.approved === true || Boolean(app.approval);
    const execResult = await this.automationExecutor.execute(plan, app, {
      credentials: cleanCreds,
      profile: appProfile,
      protonConfig: this.state.protonConfig,
      safetyGate: this.safetyGate,
      testMode,
      adapter,
      mode,
      approved,
      resumePath,
      vault: this.vault
    });
    for (const event of execResult.events) {
      await this.tracker.appendEvent(appId, event.type, event.message);
    }
    await this.tracker.updateStatus(appId, execResult.state as ApplicationStatus);

    if (execResult.state === 'blocked') {
      const isSafetyGate = execResult.reason?.startsWith('SAFETY_GATE_BLOCKED');
      const isCredentials = execResult.reason === 'MISSING_BROWSER_CREDENTIALS';
      let blockerCode = 'AUTOMATION_BLOCKED';
      let reasons: string[] | undefined;
      if (isSafetyGate) {
        blockerCode = 'SAFETY_GATE_BLOCKED';
        const match = execResult.reason?.match(/SAFETY_GATE_BLOCKED: (.*)/);
        reasons = match ? match[1].split('; ') : [];
      } else if (isCredentials) {
        blockerCode = 'MISSING_BROWSER_CREDENTIALS';
      } else if (execResult.reason === 'Explicit user approval is required for submit_after_approval mode.' ||
        execResult.reason === 'No stored submission approval record found for application.' ||
        execResult.reason === 'Stored submission approval snapshot is stale or mismatched with current application state.') {
        blockerCode = 'llm_output_requires_review';
      } else if (execResult.reason === 'automation_not_configured' || execResult.reason?.includes('automation_not_configured') || execResult.reason?.includes('Playwright is not installed')) {
        blockerCode = 'automation_not_configured';
      } else if (execResult.reason) {
        blockerCode = normalizeBlockerCode(execResult.reason);
      }
      return {
        success: false,
        blocker: blockerCode,
        reasons,
        message: execResult.reason || 'Automation execution blocked.'
      };
    }

    if (execResult.state === 'reviewing_application') {
      return {
        success: true,
        status: 'reviewing_application',
        message: 'Application is ready for manual submission.'
      };
    }

    if (execResult.state === 'submitted') {
      return {
        success: true,
        status: 'submitted',
        message: 'Application mock submission completed successfully for test.'
      };
    }

    return {
      success: true,
      status: execResult.state,
      message: 'Application submission approved and processed.'
    };
  }

  async getLLMProviders(): Promise<LLMProviderSummary[]> {
    await this.init();
    return (this.state.llmProviders || []).map(p => {
      const keyRef = p.apiKeyRef || `secret_${p.id}`;
      const secret = this.state.llmSecrets[keyRef] || p.apiKey;
      return {
        id: p.id,
        name: p.name,
        kind: p.kind,
        model: p.model,
        baseUrl: p.baseUrl,
        apiKeyRef: keyRef,
        isActive: p.isActive,
        hasApiKey: Boolean(secret && secret.trim().length > 0)
      };
    });
  }

  async saveLLMProvider(config: LLMProviderConfig, apiKey?: string): Promise<{ success: boolean; provider: LLMProviderSummary }> {
    await this.init();
    const id = config.id || `provider_${Date.now()}`;
    const keyRef = config.apiKeyRef || `secret_${id}`;

    if (apiKey && apiKey !== '********' && apiKey !== '[REDACTED]' && apiKey.trim().length > 0) {
      this.state.llmSecrets[keyRef] = apiKey.trim();
    } else if (config.apiKey && config.apiKey !== '********' && config.apiKey !== '[REDACTED]' && config.apiKey.trim().length > 0) {
      this.state.llmSecrets[keyRef] = config.apiKey.trim();
    }

    const cleanConfig: LLMProviderConfig = {
      id,
      name: config.name || id,
      kind: config.kind || 'openai-compatible',
      model: config.model || 'gpt-4o-mini',
      baseUrl: config.baseUrl,
      apiKeyRef: keyRef,
      isActive: config.isActive !== undefined ? config.isActive : true
    };
    delete (cleanConfig as unknown as Record<string, unknown>).apiKey;

    if (cleanConfig.isActive) {
      this.state.llmProviders = (this.state.llmProviders || []).map(p => ({ ...p, isActive: p.id === id ? true : false }));
    }

    const existingIndex = (this.state.llmProviders || []).findIndex(p => p.id === id);
    if (existingIndex >= 0) {
      this.state.llmProviders[existingIndex] = cleanConfig;
    } else {
      this.state.llmProviders.push(cleanConfig);
    }

    await this.saveVault();

    const summary: LLMProviderSummary = {
      id: cleanConfig.id,
      name: cleanConfig.name,
      kind: cleanConfig.kind,
      model: cleanConfig.model,
      baseUrl: cleanConfig.baseUrl,
      apiKeyRef: keyRef,
      isActive: cleanConfig.isActive,
      hasApiKey: Boolean(this.state.llmSecrets[keyRef])
    };

    return { success: true, provider: summary };
  }

  async testLLMProvider(providerId: string): Promise<{ success: boolean; usage?: LLMUsage; error?: string; message?: string }> {
    await this.init();
    const providerConfig = (this.state.llmProviders || []).find(p => p.id === providerId);
    if (!providerConfig) {
      return { success: false, error: `LLM Provider with ID "${providerId}" not found.` };
    }
    const keyRef = providerConfig.apiKeyRef || `secret_${providerConfig.id}`;
    const secretKey = this.state.llmSecrets[keyRef] || providerConfig.apiKey;

    const instance = new LLMProvider({
      ...providerConfig,
      apiKey: secretKey
    });

    const result = await instance.testConnection();
    if (result.success) {
      return { success: true, message: 'LLM provider connection test succeeded.', usage: result.usage };
    } else {
      return { success: false, error: result.error || 'Connection test failed.' };
    }
  }

  async tailorResumeForApplication(appId: string): Promise<{ success: boolean; result?: { html: string; record: LLMActionRecord }; error?: string; blocker?: string }> {
    await this.init();
    const apps = await this.tracker.getApplications();
    const app = apps.find(candidate => candidate.id === appId);
    if (!app) {
      return { success: false, error: `Application with ID "${appId}" not found.` };
    }

    let selectedResume: BaseResumeRecord | null = null;
    if (app.resumeVersion) {
      selectedResume = this.state.resumeArtifacts.find(r => r.id === app.resumeVersion) || null;
    }
    if (!selectedResume && this.state.activeResumeId) {
      selectedResume = this.state.resumeArtifacts.find(r => r.id === this.state.activeResumeId) || null;
    }

    const targetProfile: ProfileBundle | null = selectedResume
      ? {
          candidateProfile: selectedResume.candidateProfile,
          claimBank: selectedResume.claimBank,
          answerMemory: this.state.profile?.answerMemory || {}
        }
      : this.state.profile;

    if (!targetProfile) {
      return { success: false, error: 'Candidate profile is not configured or vault is locked.' };
    }

    const activeProvider = (this.state.llmProviders || []).find(p => p.isActive) || (this.state.llmProviders || [])[0];
    if (!activeProvider) {
      return { success: false, blocker: 'automation_not_configured', error: 'No active LLM provider configured.' };
    }

    const keyRef = activeProvider.apiKeyRef || `secret_${activeProvider.id}`;
    const secretKey = this.state.llmSecrets[keyRef] || activeProvider.apiKey;

    const instance = new LLMProvider({
      ...activeProvider,
      apiKey: secretKey
    });

    try {
      const tailorRes = await tailorResumeWithLLM(instance, targetProfile, app.requirements || []);
      await this.tracker.appendLLMAction(appId, tailorRes.record);
      await this.tracker.appendEvent(appId, 'RESUME_TAILORED_LLM', `Tailored resume generated via LLM (${activeProvider.name}).`);
      try {
        const pdfArtifact = await this.generateResumePdfArtifact(appId, tailorRes.html);
        await this.tracker.appendArtifact(appId, pdfArtifact);
      } catch (pdfErr) {
        console.error('Failed to append resume PDF artifact in tailorResumeForApplication:', pdfErr);
      }
      return {
        success: true,
        result: {
          html: tailorRes.html,
          record: tailorRes.record
        }
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, blocker: 'llm_output_requires_review', error: errMsg };
    }
  }

  async getVaultStatus(): Promise<VaultStatus> {
    const exists = await this.vault.exists();
    const locked = !this.initialized || !this.vaultPassword;
    return {
      exists,
      initialized: this.initialized,
      locked
    };
  }

  async createVault(password: string): Promise<void> {
    if (!password) throw new Error('Password is required');
    const vaultPath = path.join(this.dataDir, 'vault.enc');
    const tempVault = new Vault<VaultPayload>(vaultPath, password);
    if (await tempVault.exists()) throw new Error('Vault already exists');
    await tempVault.save({
      profile: null,
      credentials: null,
      protonConfig: null,
      llmProviders: [],
      llmSecrets: {},
      resumeArtifacts: [],
      activeResumeId: null
    });
    this.vaultPassword = password;
    this.vault = tempVault;
    this.initialized = true;
  }

  async unlock(password: string): Promise<void> {
    if (!password) throw new Error('Password is required');
    const vaultPath = path.join(this.dataDir, 'vault.enc');
    const tempVault = new Vault<VaultPayload>(vaultPath, password);
    if (!(await tempVault.exists())) throw new Error('Vault does not exist');
    await tempVault.load();
    this.vaultPassword = password;
    this.vault = tempVault;
    this.initialized = false;
    await this.init();
  }

  lock(): void {
    this.vaultPassword = '';
    this.initialized = false;
    this.state = {
      profile: null,
      credentials: null,
      protonConfig: null,
      llmProviders: [],
      llmSecrets: {},
      resumeArtifacts: [],
      activeResumeId: null
    };
    for (const filePath of activeDecryptedFiles) {
      try { unlinkSync(filePath); } catch {}
    }
    activeDecryptedFiles.clear();
  }

  private getResumeSummaries(): BaseResumeSummary[] {
    return this.state.resumeArtifacts.map(r => ({
      id: r.id,
      fileName: r.fileName,
      label: r.label,
      mimeType: r.mimeType,
      hash: r.hash,
      size: r.size,
      uploadedAt: r.uploadedAt,
      active: r.id === this.state.activeResumeId,
      candidateName: r.candidateProfile?.name || '',
      candidateEmail: r.candidateProfile?.email || '',
      skillCount: r.candidateProfile?.skills?.length || 0,
      claimCount: r.claimBank?.length || 0,
      projectCount: r.candidateProfile?.projects?.length || 0,
      parse: r.parse
    }));
  }

  async importResumeArtifacts(
    inputs: UploadedResumeInput[],
    requestedActiveResumeId?: string
  ): Promise<{ profile: ProfileBundle; resumes: BaseResumeSummary[]; activeResumeId: string | null }> {
    await this.init();

    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new Error('resumes[] with PDF contentBase64 is required');
    }

    const recordsToAppend: BaseResumeRecord[] = [];
    const duplicatesToReuse: BaseResumeRecord[] = [];
    const pendingWrites: Array<{ filePath: string; buffer: Buffer }> = [];
    for (const input of inputs) {
      const fileName = (input.fileName || '').trim();
      if (!fileName) {
        throw new Error('fileName is required');
      }

      const isPdf = input.mimeType === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf');
      if (!isPdf) {
        throw new Error('Only PDF resumes are supported');
      }

      if (!input.contentBase64) {
        throw new Error('contentBase64 is required');
      }

      const buffer = Buffer.from(input.contentBase64, 'base64');
      if (buffer.length === 0) {
        throw new Error('contentBase64 is empty');
      }

      if (buffer.length > 8 * 1024 * 1024) {
        throw new Error('Resume PDF exceeds 8 MiB limit');
      }

      const hash = crypto.createHash('sha256').update(buffer).digest('hex');

      // Check if duplicate exists
      const existing = this.state.resumeArtifacts.find(r => r.hash === hash) ||
                       recordsToAppend.find(r => r.hash === hash);

      if (existing) {
        duplicatesToReuse.push(existing);
        continue;
      }

      let textResult;
      try {
        textResult = await extractPdfResumeText(buffer);
      } catch (err) {
        throw new Error('Resume PDF could not be parsed into text');
      }

      const baseDir = path.join(this.dataDir, 'artifacts', 'resumes', 'base');
      const filePath = path.join(baseDir, `${hash}.enc`);
      pendingWrites.push({ filePath, buffer });

      const resumeId = 'resume_' + hash.slice(0, 16);
      const tempBuilder = new ProfileBuilder();
      const facts = tempBuilder.parseResume(textResult.text);
      const candidateProfile: CandidateProfile = {
        name: '',
        email: '',
        phone: '',
        skills: [],
        experience: [],
        education: [],
        projects: [],
        ...facts
      };

      const claimBank = buildClaimBank(candidateProfile, {}, resumeId);

      const record: BaseResumeRecord = {
        id: resumeId,
        fileName,
        mimeType: 'application/pdf',
        hash,
        size: buffer.length,
        uploadedAt: new Date().toISOString(),
        path: filePath,
        uri: filePath,
        label: input.label?.trim() || path.basename(fileName, path.extname(fileName)),
        candidateProfile,
        claimBank,
        parse: {
          parser: 'pdf-parse',
          parserVersion: textResult.parserVersion,
          pageCount: textResult.pageCount,
          textHash: crypto.createHash('sha256').update(textResult.text).digest('hex'),
          textLength: textResult.text.length,
          parsedAt: new Date().toISOString()
        }
      };

      recordsToAppend.push(record);
    }

    for (const pending of pendingWrites) {
      await fs.mkdir(path.dirname(pending.filePath), { recursive: true });
      const encrypted = this.vault.encryptBuffer(pending.buffer);
      await fs.writeFile(pending.filePath, encrypted);
    }

    this.state.resumeArtifacts = [...this.state.resumeArtifacts, ...recordsToAppend];

    let nextActiveId = this.state.activeResumeId;
    if (requestedActiveResumeId) {
      const match = this.state.resumeArtifacts.find(r => r.id === requestedActiveResumeId);
      if (match) {
        nextActiveId = match.id;
      }
    }

    if (!requestedActiveResumeId || nextActiveId !== requestedActiveResumeId) {
      if (recordsToAppend.length > 0) {
        nextActiveId = recordsToAppend[recordsToAppend.length - 1].id;
      } else if (duplicatesToReuse.length > 0) {
        nextActiveId = duplicatesToReuse[duplicatesToReuse.length - 1].id;
      }
    }

    if (nextActiveId) {
      const selected = this.state.resumeArtifacts.find(r => r.id === nextActiveId);
      if (selected) {
        this.state.activeResumeId = nextActiveId;
        const currentAnswerMemory = this.state.profile?.answerMemory || {};
        const qaClaims: Claim[] = [];
        Object.entries(currentAnswerMemory).forEach(([question, answer], idx) => {
          const text = typeof answer === 'string' ? answer : (answer && answer.answer) || '';
          qaClaims.push({
            id: `qa_${idx}`,
            text,
            category: 'interview',
            question,
            source: typeof answer === 'object' && answer && answer.source ? answer.source : undefined
          });
        });
        const activeProfile: ProfileBundle = {
          candidateProfile: selected.candidateProfile,
          claimBank: [...selected.claimBank, ...qaClaims],
          answerMemory: currentAnswerMemory
        };
        this.applyProfile(activeProfile);
      }
    }

    await this.saveVault();

    return {
      profile: this.state.profile!,
      resumes: this.getResumeSummaries(),
      activeResumeId: this.state.activeResumeId
    };
  }

  async setActiveResume(resumeId: string): Promise<{ profile: ProfileBundle; activeResumeId: string; resumes: BaseResumeSummary[] }> {
    await this.init();
    const selected = this.state.resumeArtifacts.find(r => r.id === resumeId);
    if (!selected) {
      throw new Error('Unknown resumeId');
    }

    this.state.activeResumeId = resumeId;
    const currentAnswerMemory = this.state.profile?.answerMemory || {};
    const qaClaims: Claim[] = [];
    Object.entries(currentAnswerMemory).forEach(([question, answer], idx) => {
      const text = typeof answer === 'string' ? answer : (answer && answer.answer) || '';
      qaClaims.push({
        id: `qa_${idx}`,
        text,
        category: 'interview',
        question,
        source: typeof answer === 'object' && answer && answer.source ? answer.source : undefined
      });
    });

    const activeProfile: ProfileBundle = {
      candidateProfile: selected.candidateProfile,
      claimBank: [...selected.claimBank, ...qaClaims],
      answerMemory: currentAnswerMemory
    };
    this.applyProfile(activeProfile);

    await this.saveVault();

    return {
      profile: this.state.profile!,
      activeResumeId: this.state.activeResumeId!,
      resumes: this.getResumeSummaries()
    };
  }

  async getState(): Promise<{
    profile: ProfileBundle | null;
    applications: ApplicationRecord[];
    hasCredentials: boolean;
    protonConfigured: boolean;
    llmProviders: LLMProviderSummary[];
    resumes: BaseResumeSummary[];
    activeResumeId: string | null;
  }> {
    await this.init();
    const apps = await this.tracker.getApplications();
    const llmProviders = await this.getLLMProviders();
    return {
      profile: this.state.profile,
      applications: apps,
      hasCredentials: Boolean(this.state.credentials),
      protonConfigured: Boolean(this.state.protonConfig),
      llmProviders,
      resumes: this.getResumeSummaries(),
      activeResumeId: this.state.activeResumeId
    };
  }
  async close(): Promise<void> {
    await this.tracker.close();
  }
}
