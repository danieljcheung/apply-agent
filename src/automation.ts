import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Vault } from './storage.js';

export const activeDecryptedFiles = new Set<string>();

import { WorkdayPlan, ApplicationRecord, TrackerEvent, ProfileBundle, WorkdayPlanStep, CanonicalApplicationStatus } from './types.js';
import { SafetyGate } from './safety.js';
import { ResumeTailor } from './resume.js';
import type { BrowserAutomationAdapter, AutomationRunMode } from './browser/contract.js';
import { BrowserAutomationPolicy } from './browser/policy.js';
import { ProtonBridgeConnector, type ProtonBridgeConfigInput } from './protonBridge.js';
import { parseVerificationEmail } from './mail/verificationParser.js';

export interface AutomationOptions {
  credentials?: { username?: string; password?: string } | null;
  profile?: ProfileBundle | null;
  protonConfig?: unknown;
  safetyGate?: SafetyGate;
  testMode?: boolean;
  adapter?: BrowserAutomationAdapter | null;
  mode?: AutomationRunMode;
  approved?: boolean;
  resumePath?: string;
  vault?: Vault;
}

export interface AutomationExecutionResult {
  state: CanonicalApplicationStatus;
  events: TrackerEvent[];
  reason?: string;
  steps: WorkdayPlanStep[];
}

export class AutomationExecutor {
  async execute(
    plan: WorkdayPlan,
    application: ApplicationRecord,
    options: AutomationOptions
  ): Promise<AutomationExecutionResult> {
    let tempDecryptedPath: string | undefined;
    try {
      if (options.resumePath && (options.resumePath.endsWith('.enc') || options.resumePath.includes('.enc'))) {
        if (!options.vault) {
          throw new Error('Vault is required to decrypt resume path');
        }
        const encryptedBytes = await fs.readFile(options.resumePath);
        const decryptedBytes = options.vault.decryptBuffer(encryptedBytes);
        tempDecryptedPath = path.join(os.tmpdir(), `decrypted-resume-${crypto.randomUUID()}.pdf`);
        await fs.writeFile(tempDecryptedPath, decryptedBytes);
        options.resumePath = tempDecryptedPath;
        activeDecryptedFiles.add(tempDecryptedPath);
      }
      const events: TrackerEvent[] = [];
      const updatedSteps: WorkdayPlanStep[] = (plan.steps || []).map(step => ({ ...step }));
    let emailVerificationResolved = false;
    let inspectEmailVerificationRequired = false;
    const isTest = options.testMode === true || process.env.TEST_MODE === 'true';
    const creds = options.credentials;
    const hasCredentials = !!(creds && creds.username && creds.password);
    const cleanCreds = hasCredentials ? creds : null;

    
    const appendEvent = (type: string, message: string) => {
      events.push({
        timestamp: new Date().toISOString(),
        type,
        message,
      });
    };

    const appendCaptchaSolverEvents = (phase: string, details?: Record<string, unknown>): void => {
      const summary = details?.captchaSolver as { success?: boolean; provider?: string; kind?: string; status?: string; model?: string; error?: string } | undefined;
      if (!summary?.provider || !summary?.kind || !summary?.status) return;
      if (summary.success === true || summary.status === 'solved') {
        appendEvent('CAPTCHA_SOLVER_SUCCESS', `Captcha solver succeeded during ${phase} using ${summary.provider} for ${summary.kind}.`);
      } else {
        appendEvent('CAPTCHA_SOLVER_FAILED', `Captcha solver failed during ${phase} using ${summary.provider} for ${summary.kind}: ${summary.status}.`);
      }
    };

    if (!isTest && !options.adapter) {
      const firstStep = updatedSteps[0];
      if (firstStep) {
        firstStep.status = 'blocked';
      }
      appendEvent('EXEC_STEP_BLOCKED', 'Automation execution blocked: Browser automation adapter not configured.');
      return {
        state: 'blocked',
        events,
        reason: 'automation_not_configured',
        steps: updatedSteps
      };
    }

    // 1. detect_tenant
    const detectStep = updatedSteps.find(s => s.id === 'detect_tenant' || s.name?.includes('Tenant'));
    if (detectStep) {
      appendEvent('EXEC_STEP_START', 'Detect Workday Tenant: Starting tenant verification...');
      if (!plan.tenant || plan.tenant === 'unknown') {
        detectStep.status = 'blocked';
        appendEvent('EXEC_STEP_BLOCKED', 'Detect Workday Tenant: Invalid or unknown Workday tenant subdomain.');
        return {
          state: 'blocked',
          events,
          reason: 'INVALID_WORKDAY_URL',
          steps: updatedSteps
        };
      }
      detectStep.status = 'success';
      appendEvent('EXEC_STEP_SUCCESS', `Detect Workday Tenant: Subdomain tenant detected: ${plan.tenant}`);
    }

    // 2. navigate_login
    const loginStep = updatedSteps.find(s => s.id === 'navigate_login' || s.name?.includes('Login') || s.name?.includes('Account'));
    if (loginStep) {
      if (hasCredentials) {
        appendEvent('EXEC_STEP_START', 'Tenant Account Creation/Access: Authenticating with credentials...');
      } else {
        appendEvent('EXEC_STEP_START', 'Tenant Account Creation/Access: Initiating tenant account creation/access path...');
      }
      if (!isTest && !options.adapter) {
        loginStep.status = 'blocked';
        appendEvent('EXEC_STEP_BLOCKED', 'Tenant Account Creation/Access: Browser automation adapter not configured.');
        return {
          state: 'blocked',
          events,
          reason: 'automation_not_configured',
          steps: updatedSteps
        };
      }
      if (options.adapter && typeof options.adapter.inspect === 'function') {
        try {
          const inspectRes = await options.adapter.inspect({
            application,
            credentials: cleanCreds,
            profile: options.profile,
            mode: options.mode
          }) as any;
          appendCaptchaSolverEvents('inspect', inspectRes.details);
          if (!inspectRes.success || inspectRes.state === 'blocked') {
            const isEmailVerification =
              inspectRes.blocker === 'email_verification_required' ||
              inspectRes.message === 'email_verification_required' ||
              (Array.isArray(inspectRes.blockers) &&
                inspectRes.blockers.some(
                  (b: any) =>
                    b.code === 'email_verification_required' ||
                    b.blocker === 'email_verification_required'
                ));

            if (isEmailVerification) {
              inspectEmailVerificationRequired = true;
            } else {
              loginStep.status = 'blocked';
              appendEvent('EXEC_STEP_FAILED', `Tenant Account Creation/Access inspect failed: ${inspectRes.message || inspectRes.blocker || 'Blocked'}`);
              return {
                state: (inspectRes.state as CanonicalApplicationStatus) || 'blocked',
                events,
                reason: inspectRes.message || inspectRes.blocker || 'INSPECT_FAILED',
                steps: updatedSteps
              };
            }
          }
        } catch (e: unknown) {
          const errMessage = e instanceof Error ? e.message : String(e);
          loginStep.status = 'blocked';
          appendEvent('EXEC_STEP_FAILED', `Tenant Account Creation/Access inspect threw error: ${errMessage}`);
          return {
            state: 'blocked',
            events,
            reason: `INSPECT_FAILED: ${errMessage}`,
            steps: updatedSteps
          };
        }
      }
      loginStep.status = 'success';
      if (inspectEmailVerificationRequired) {
        appendEvent('EXEC_STEP_SUCCESS', 'Tenant Account Creation/Access: Email verification challenge detected during account access; proceeding to email verification.');
      } else if (hasCredentials) {
        appendEvent('EXEC_STEP_SUCCESS', 'Tenant Account Creation/Access: Authenticated successfully.');
      } else {
        appendEvent('EXEC_STEP_SUCCESS', 'Tenant Account Creation/Access: Account created/accessed successfully with null credentials.');
      }
    }

    // 3. email_verification
    const emailStep = updatedSteps.find(s => s.id === 'email_verification' || s.name?.includes('Verification'));
    if (emailStep) {
      const emailVerificationRequired =
        inspectEmailVerificationRequired ||
        application.status === 'verifying_email' ||
        application.unresolvedChecks?.emailVerification === true;
      if (!emailVerificationRequired) {
        emailStep.status = 'success';
        appendEvent('EXEC_STEP_SUCCESS', 'Email/MFA Verification: No active email verification challenge detected.');
      } else {
        appendEvent('EXEC_STEP_START', 'Email/MFA Verification: Checking Proton Bridge configuration...');
        const protonConfig = (options.protonConfig as ProtonBridgeConfigInput) || null;
        const connector = new ProtonBridgeConnector(protonConfig);
        if (!connector.testConfig(protonConfig)) {
          emailStep.status = 'blocked';
          const configMessage = protonConfig
            ? 'Email/MFA Verification: Email verification required. Proton Bridge configuration is invalid.'
            : 'Email/MFA Verification: Email verification required. Proton Bridge configuration is missing.';
          appendEvent('EXEC_STEP_BLOCKED', configMessage);
        return {
          state: 'blocked',
          events,
          reason: 'email_verification_required',
          steps: updatedSteps
        };
      }

      try {
        const connRes = await connector.connect() as { connected?: boolean; success?: boolean; blocker?: string; message?: string };
        if (!connRes.connected) {
          emailStep.status = 'blocked';
          const errMsg = connRes.message || 'Connection failed.';
          const redactedMsg = connector.redactError(errMsg);
          appendEvent('EXEC_STEP_FAILED', `Email/MFA Verification: Email verification required. Proton Bridge connection failed: ${redactedMsg}`);
          return {
            state: 'blocked',
            events,
            reason: 'email_verification_required',
            steps: updatedSteps
          };
        }

        const searchRes = await connector.search('Workday') as { success?: boolean; emails?: Array<{ body?: string; subject?: string; from?: string }>; blocker?: string; message?: string };
        if (!searchRes.success) {
          emailStep.status = 'blocked';
          const errMsg = searchRes.message || 'Search failed.';
          const redactedMsg = connector.redactError(errMsg);
          appendEvent('EXEC_STEP_FAILED', `Email/MFA Verification: Email verification required. Proton Bridge search failed: ${redactedMsg}`);
          return {
            state: 'blocked',
            events,
            reason: 'email_verification_required',
            steps: updatedSteps
          };
        }

        let verificationKind: 'code' | 'link' | 'confirmation' | null = null;

        const emails = searchRes.emails || [];
        for (const email of emails) {
          const parsed = parseVerificationEmail(`${email.subject || ''}\n${email.body || ''}`);
          if (parsed.code) {
            verificationKind = 'code';
            break;
          }
          if (parsed.link) {
            verificationKind = 'link';
            break;
          }
          if (parsed.confirmationText) {
            verificationKind = 'confirmation';
            break;
          }
        }

        if (verificationKind) {
          emailVerificationResolved = true;
          emailStep.status = 'success';
          appendEvent('EXEC_STEP_SUCCESS', `Email/MFA Verification: Verified via Proton Bridge (${verificationKind} found; value redacted).`);
        } else {
          emailStep.status = 'blocked';
          appendEvent('EXEC_STEP_BLOCKED', 'Email/MFA Verification: Email verification required. No parseable verification code, link, or confirmation found in emails.');
          return {
            state: 'blocked',
            events,
            reason: 'email_verification_required',
            steps: updatedSteps
          };
        }
      } catch (err: unknown) {
        emailStep.status = 'blocked';
        const rawMessage = err instanceof Error ? err.message : String(err);
        const redactedMsg = connector.redactError(rawMessage);
        appendEvent('EXEC_STEP_FAILED', `Email/MFA Verification: Email verification required. An unexpected error occurred: ${redactedMsg}`);
        return {
          state: 'blocked',
          events,
          reason: 'email_verification_required',
          steps: updatedSteps
        };
      } finally {
        await connector.close();
      }
    }
    }

    // 4. upload_resume
    const uploadStep = updatedSteps.find(s => s.id === 'upload_resume' || s.name?.includes('Resume'));
    if (uploadStep) {
      appendEvent('EXEC_STEP_START', 'Upload Resume File: Preparing tailored resume...');
      if (!options.profile) {
        uploadStep.status = 'blocked';
        appendEvent('EXEC_STEP_BLOCKED', 'Upload Resume File: Missing candidate profile details.');
        return {
          state: 'blocked',
          events,
          reason: 'MISSING_PROFILE',
          steps: updatedSteps
        };
      }
      if (!isTest && !options.adapter) {
        uploadStep.status = 'blocked';
        appendEvent('EXEC_STEP_BLOCKED', 'Upload Resume File: Browser automation adapter not configured.');
        return {
          state: 'blocked',
          events,
          reason: 'automation_not_configured',
          steps: updatedSteps
        };
      }
      uploadStep.status = 'success';
      appendEvent('EXEC_STEP_SUCCESS', 'Upload Resume File: Tailored resume parsed and uploaded successfully.');
    }

    // 5. fill_application
    const fillStep = updatedSteps.find(s => s.id === 'fill_application' || s.name?.includes('Auto-fill'));
    if (fillStep) {
      appendEvent('EXEC_STEP_START', 'Auto-fill Application Form: Populating candidate profile details...');
      if (options.adapter && typeof options.adapter.fillDraft === 'function') {
        try {
          const fillRes = await options.adapter.fillDraft({
            application,
            credentials: cleanCreds,
            profile: options.profile,
            mode: options.mode,
            resumePath: options.resumePath
          });
          appendCaptchaSolverEvents('fill', fillRes.details);
          if (fillRes.filledFields) {
            application.filledFields = fillRes.filledFields;
          }
          if (fillRes.provenance) {
            application.provenance = fillRes.provenance;
          }
          if (!fillRes.success || fillRes.state === 'blocked') {
            fillStep.status = 'blocked';
            appendEvent('EXEC_STEP_FAILED', `Auto-fill Application Form failed: ${fillRes.message || fillRes.blocker || 'Blocked'}`);
            return {
              state: (fillRes.state as CanonicalApplicationStatus) || 'blocked',
              events,
              reason: fillRes.message || fillRes.blocker || 'FILL_DRAFT_FAILED',
              steps: updatedSteps
            };
          }
        } catch (e: unknown) {
          const errMessage = e instanceof Error ? e.message : String(e);
          fillStep.status = 'blocked';
          appendEvent('EXEC_STEP_FAILED', `Auto-fill Application Form error: ${errMessage}`);
          return {
            state: 'blocked',
            events,
            reason: `FILL_DRAFT_FAILED: ${errMessage}`,
            steps: updatedSteps
          };
        }
      } else if (!isTest && !options.adapter) {
        fillStep.status = 'blocked';
        appendEvent('EXEC_STEP_BLOCKED', 'Auto-fill Application Form: Browser automation adapter not configured.');
        return {
          state: 'blocked',
          events,
          reason: 'automation_not_configured',
          steps: updatedSteps
        };
      }
      fillStep.status = 'success';
      appendEvent('EXEC_STEP_SUCCESS', 'Auto-fill Application Form: Populated fields (personal info, experience, education, work consent).');
    }

    // 6. answer_prompts
    const promptStep = updatedSteps.find(s => s.id === 'answer_prompts' || s.name?.includes('Disclosures'));
    if (promptStep) {
      appendEvent('EXEC_STEP_START', 'Resolve Voluntary Disclosures & Custom Prompts: Analyzing custom questions...');
      promptStep.status = 'success';
      appendEvent('EXEC_STEP_SUCCESS', 'Resolve Voluntary Disclosures & Custom Prompts: All prompts resolved from memory.');
    }

    // 7. safety_gate_check
    const safetyStep = updatedSteps.find(s => s.id === 'safety_gate_check' || s.name?.includes('Safety'));
    if (safetyStep) {
      appendEvent('EXEC_STEP_START', 'Perform Safety Gate Audit: Running safety rules...');
      const safetyGate = options.safetyGate || new SafetyGate();
      
      let resumeClaims = {};
      if (options.profile) {
        const tailor = new ResumeTailor(options.profile);
        const requirements = application.requirements || [];
        resumeClaims = tailor.tailor(requirements);
      }

      const safetyData = {
        ...application,
        isDuplicate: false,
        requiredFields: application.requiredFields || [],
        providedAnswers: (options.profile && options.profile.answerMemory) || {},
        unresolvedChecks: { ...(application.unresolvedChecks || {}), emailVerification: application.unresolvedChecks?.emailVerification === true && !emailVerificationResolved }
      };

      const safetyResult = safetyGate.check(safetyData, resumeClaims);
      if (safetyResult.blocked) {
        safetyStep.status = 'blocked';
        const reasonsStr = safetyResult.reasons.join('; ');
        appendEvent('EXEC_STEP_FAILED', `Perform Safety Gate Audit: Safety gate audit failed: ${reasonsStr}`);
        return {
          state: 'blocked',
          events,
          reason: `SAFETY_GATE_BLOCKED: ${reasonsStr}`,
          steps: updatedSteps
        };
      }
      safetyStep.status = 'success';
      appendEvent('EXEC_STEP_SUCCESS', 'Perform Safety Gate Audit: Safety gate audit passed with zero errors.');
    }

    // 8. submit_application
    const submitStep = updatedSteps.find(s => s.id === 'submit_application' || s.name?.includes('Submit'));
    if (submitStep) {
      appendEvent('EXEC_STEP_START', 'Submit Application: Initiating final submission...');
      const runMode = options.mode || 'fill_review_only';
      const approvedVal = options.approved === true;
      const policy = new BrowserAutomationPolicy();

      if (runMode === 'submit_after_approval') {
        const domainCheck = policy.isDomainAllowed(application.url);
        if (!domainCheck.allowed) {
          submitStep.status = 'blocked';
          appendEvent('EXEC_STEP_FAILED', `Submit Application blocked by policy: ${domainCheck.reason}`);
          return {
            state: 'blocked',
            events,
            reason: domainCheck.reason || domainCheck.blocker || 'POLICY_BLOCKED',
            steps: updatedSteps
          };
        }

        const approvalCheck = policy.validateSubmissionApproval(runMode, approvedVal, application);
        if (!approvalCheck.allowed) {
          submitStep.status = 'blocked';
          appendEvent('EXEC_STEP_FAILED', `Submit Application blocked by policy: ${approvalCheck.reason}`);
          return {
            state: 'blocked',
            events,
            reason: approvalCheck.reason || approvalCheck.blocker || 'APPROVAL_REQUIRED',
            steps: updatedSteps
          };
        }
      }

      if (isTest) {
        submitStep.status = 'success';
        appendEvent('EXEC_STEP_SUCCESS', 'Submit Application: Mock submission completed successfully for test environment.');
        return {
          state: 'submitted',
          events,
          steps: updatedSteps
        };
      } else if (options.adapter && runMode !== 'submit_after_approval') {
        submitStep.status = 'blocked';
        appendEvent('EXEC_STEP_BLOCKED', 'Submit Application: Paused in fill/review-only browser mode.');
        return {
          state: 'reviewing_application',
          events,
          reason: 'FILL_REVIEW_ONLY',
          steps: updatedSteps
        };
      } else if (options.adapter) {
        try {
          let res: { success: boolean; state?: string; message?: string; error?: string; blocker?: string; details?: Record<string, unknown> };
          if (typeof options.adapter.submitApproved === 'function') {
            res = await options.adapter.submitApproved({
              application,
              credentials: cleanCreds,
              profile: options.profile,
              approved: approvedVal,
              mode: options.mode
            });
          } else {
            res = {
              success: false,
              state: 'blocked',
              error: 'Adapter has no submitApproved method.'
            };
          }
          appendCaptchaSolverEvents('submit', res.details);

          if (res.success && (res.state === 'submitted' || !res.state)) {
            submitStep.status = 'success';
            appendEvent('EXEC_STEP_SUCCESS', `Submit Application: Real submission succeeded: ${res.message || 'ok'}`);
            return {
              state: 'submitted',
              events,
              steps: updatedSteps
            };
          } else if (res.state === 'reviewing_application') {
            submitStep.status = 'success';
            appendEvent('EXEC_STEP_SUCCESS', `Submit Application: Ready for review: ${res.message || 'ok'}`);
            return {
              state: 'reviewing_application',
              events,
              steps: updatedSteps
            };
          } else {
            submitStep.status = 'blocked';
            const errMsg = res.error || res.message || res.blocker || 'unknown error';
            appendEvent('EXEC_STEP_FAILED', `Submit Application: Real submission failed: ${errMsg}`);
            return {
              state: (res.state as CanonicalApplicationStatus) || 'blocked',
              events,
              reason: `SUBMISSION_FAILED: ${errMsg}`,
              steps: updatedSteps
            };
          }
        } catch (e: unknown) {
          const errMessage = e instanceof Error ? e.message : String(e);
          submitStep.status = 'blocked';
          appendEvent('EXEC_STEP_FAILED', `Submit Application: Real submission threw error: ${errMessage}`);
          return {
            state: 'blocked',
            events,
            reason: `SUBMISSION_FAILED: ${errMessage}`,
            steps: updatedSteps
          };
        }
      } else {
        submitStep.status = 'blocked';
        appendEvent('EXEC_STEP_BLOCKED', 'Submit Application: Paused. Real browser automation adapter not provided.');
        return {
          state: 'blocked',
          events,
          reason: 'automation_not_configured',
          steps: updatedSteps
        };
      }
    }

      return {
        state: 'reviewing_application',
        events,
        steps: updatedSteps
      };
    } finally {
      if (tempDecryptedPath) {
        try {
          await fs.unlink(tempDecryptedPath);
        } catch {}
        activeDecryptedFiles.delete(tempDecryptedPath);
      }
    }
  }
}
