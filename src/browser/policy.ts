import type { AutomationRunMode } from './contract.js';
import { computeBlockerSnapshotHash, computeFieldSnapshotHash, type ApplicationRecord, type BlockerCode } from '../types.js';

export const defaultWorkdayAllowedDomains = ['myworkdayjobs.com'];
export interface BrowserPolicyOptions {
  allowedDomains?: string[];
}
export interface ChallengePolicyOptions {
  env?: Record<string, string | undefined>;
  nodeEnv?: string;
  challengeTestMode?: boolean | string;
}

export interface PolicyValidationResult {
  allowed: boolean;
  blocker?: BlockerCode;
  reason?: string;
}

export function validateAllowedDomain(urlStr: string, customDomains: string[] = defaultWorkdayAllowedDomains): PolicyValidationResult {
  if (!urlStr) {
    return {
      allowed: false,
      blocker: 'site_automation_disallowed',
      reason: 'Missing or empty URL for browser automation.'
    };
  }

  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname.toLowerCase();

    // Localhost and 127.0.0.1 fixture URLs for tests
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return { allowed: true };
    }

    // Real Workday domains.
    if (hostname === 'myworkdayjobs.com' || hostname.endsWith('.myworkdayjobs.com')) {
      return { allowed: true };
    }

    if (customDomains.some(domain => {
      const cleanDomain = domain.toLowerCase().replace(/^\*\./, '');
      return hostname === cleanDomain || hostname.endsWith('.' + cleanDomain);
    })) {
      return { allowed: true };
    }

    return {
      allowed: false,
      blocker: 'site_automation_disallowed',
      reason: `Domain ${hostname} is not allowed for browser automation under current policy.`
    };
  } catch {
    return {
      allowed: false,
      blocker: 'site_automation_disallowed',
      reason: `Invalid URL format: ${urlStr}`
    };
  }
}

export function validateSubmissionApproval(mode: AutomationRunMode | undefined, approved: boolean, app?: ApplicationRecord | null): PolicyValidationResult {
  if (mode === 'submit_after_approval') {
    if (!approved && !app?.approval) {
      return {
        allowed: false,
        blocker: 'llm_output_requires_review',
        reason: 'Explicit user approval is required for submit_after_approval mode.'
      };
    }
    const approval = app?.approval;
    if (!approval) {
      return {
        allowed: false,
        blocker: 'llm_output_requires_review',
        reason: 'No stored submission approval record found for application.'
      };
    }
    if (app) {
      const expectedFieldHash = computeFieldSnapshotHash(app);
      const expectedBlockerHash = computeBlockerSnapshotHash(app.blockers);
      if (approval.fieldSnapshotHash !== expectedFieldHash || approval.blockerSnapshotHash !== expectedBlockerHash) {
        return {
          allowed: false,
          blocker: 'llm_output_requires_review',
          reason: 'Stored submission approval snapshot is stale or mismatched with current application state.'
        };
      }
    }
  }
  return { allowed: true };
}

export function validateBrowserPolicy(urlStr: string, customDomains: string[] = defaultWorkdayAllowedDomains): PolicyValidationResult {
  return validateAllowedDomain(urlStr, customDomains);
}

export function validateSyntheticChallengePolicy(
  urlStr: string,
  options: ChallengePolicyOptions = {}
): PolicyValidationResult {
  if (!urlStr) {
    return {
      allowed: false,
      blocker: 'captcha_required',
      reason: 'Missing or empty URL for challenge policy validation.'
    };
  }

  const nodeEnv = options.nodeEnv ?? options.env?.NODE_ENV ?? process.env.NODE_ENV;
  if (nodeEnv === 'production') {
    return {
      allowed: false,
      blocker: 'captcha_required',
      reason: 'Synthetic challenge automation is strictly disabled in production environment.'
    };
  }

  const testModeVal = options.challengeTestMode ?? options.env?.CHALLENGE_TEST_MODE ?? process.env.CHALLENGE_TEST_MODE;
  const isTestModeEnabled =
    testModeVal === true ||
    (typeof testModeVal === 'string' && ['true', '1', 'yes'].includes(testModeVal.toLowerCase().trim()));

  if (!isTestModeEnabled) {
    return {
      allowed: false,
      blocker: 'captcha_required',
      reason: 'Synthetic challenge automation requires CHALLENGE_TEST_MODE to be explicitly enabled.'
    };
  }

  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname.toLowerCase();

    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return { allowed: true };
    }

    return {
      allowed: false,
      blocker: 'captcha_required',
      reason: `Synthetic challenge policy disallows host '${hostname}'. Only local fixture domains (localhost, 127.0.0.1) are permitted.`
    };
  } catch {
    return {
      allowed: false,
      blocker: 'captcha_required',
      reason: `Invalid URL format: ${urlStr}`
    };
  }
}

export function isSyntheticChallengeAllowed(
  urlStr: string,
  options: ChallengePolicyOptions = {}
): boolean {
  return validateSyntheticChallengePolicy(urlStr, options).allowed;
}

export class SyntheticChallengePolicy {
  private options: ChallengePolicyOptions;

  constructor(options: ChallengePolicyOptions = {}) {
    this.options = options;
  }

  validate(urlStr: string, overrideOptions?: ChallengePolicyOptions): PolicyValidationResult {
    return validateSyntheticChallengePolicy(urlStr, { ...this.options, ...overrideOptions });
  }

  isAllowed(urlStr: string, overrideOptions?: ChallengePolicyOptions): boolean {
    return isSyntheticChallengeAllowed(urlStr, { ...this.options, ...overrideOptions });
  }
}

export class BrowserAutomationPolicy {
  private allowedDomains: string[];

  constructor(options: BrowserPolicyOptions = {}) {
    this.allowedDomains = options.allowedDomains || [];
  }

  isDomainAllowed(urlStr: string): PolicyValidationResult {
    return validateAllowedDomain(urlStr, this.allowedDomains);
  }

  validate(urlStr: string): PolicyValidationResult {
    return this.isDomainAllowed(urlStr);
  }

  validateSubmissionApproval(mode: AutomationRunMode | undefined, approved: boolean, app?: ApplicationRecord | null): PolicyValidationResult {
    return validateSubmissionApproval(mode, approved, app);
  }

  validateSyntheticChallenge(urlStr: string, options?: ChallengePolicyOptions): PolicyValidationResult {
    return validateSyntheticChallengePolicy(urlStr, options);
  }

  isSyntheticChallengeAllowed(urlStr: string, options?: ChallengePolicyOptions): boolean {
    return isSyntheticChallengeAllowed(urlStr, options);
  }
}
