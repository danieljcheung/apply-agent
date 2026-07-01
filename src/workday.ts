export class WorkdayPlanner {
  detectWorkdayUrl(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return parsed.hostname.endsWith('myworkdayjobs.com') || parsed.hostname.includes('.wd');
    } catch {
      return false;
    }
  }

  extractTenant(url) {
    if (!this.detectWorkdayUrl(url)) return null;
    try {
      const parsed = new URL(url);
      const host = parsed.hostname;
      const parts = host.split('.');
      if (parts[0]) {
        return parts[0];
      }
    } catch {}
    return 'unknown';
  }

  plan(url, credentials = null) {
    const isWorkday = this.detectWorkdayUrl(url);
    if (!isWorkday) {
      return {
        tenant: null,
        steps: [],
        blockedReasons: ['INVALID_WORKDAY_URL'],
        message: 'The URL is not a valid Workday jobs URL.'
      };
    }

    const tenant = this.extractTenant(url);
    const blockedReasons = [];

    const steps = [
      {
        id: 'detect_tenant',
        name: 'Detect Workday Tenant',
        status: 'pending',
        description: `Verify and extract Workday tenant subdomain. Detected: ${tenant}`
      },
      {
        id: 'navigate_login',
        name: 'Tenant Account Creation/Access',
        status: 'pending',
        description: `Navigate to myworkdayjobs portal for ${tenant} and create or access candidate account.`
      },
      {
        id: 'email_verification',
        name: 'Email/MFA Verification',
        status: 'pending',
        description: 'Verify account creation via Proton Bridge/IMAP for OTP if necessary.'
      },
      {
        id: 'upload_resume',
        name: 'Upload Resume File',
        status: 'pending',
        description: 'Upload the tailored PDF/HTML resume file to Workday parser.'
      },
      {
        id: 'fill_application',
        name: 'Auto-fill Application Form',
        status: 'pending',
        description: 'Populate fields (personal info, experience, education, work consent) based on candidate profile.'
      },
      {
        id: 'answer_prompts',
        name: 'Resolve Voluntary Disclosures & Custom Prompts',
        status: 'pending',
        description: 'Analyze custom application prompts, cross-referencing claimBank and answerMemory.'
      },
      {
        id: 'safety_gate_check',
        name: 'Perform Safety Gate Audit',
        status: 'pending',
        description: 'Run SafetyGate validator to check for unknown fields, unsupported claims, or legal alerts.'
      },
      {
        id: 'submit_application',
        name: 'Submit Application',
        status: 'pending',
        description: 'Final submission step. Cannot run live submission without browser credentials.',
        requiresCredentials: true
      }
    ];

    return {
      tenant,
      steps,
      blockedReasons,
      message: blockedReasons.length > 0 
        ? `Plan created with blockers: ${blockedReasons.join(', ')}` 
        : 'Plan successfully generated.'
    };
  }
}
