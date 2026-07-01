export type SafetyGateOptions = {
  salaryFloor?: number;
  knownFields?: string[];
  sensitiveKeywords?: string[];
};

export type SafetyGateAppData = {
  requiredFields?: string[];
  unresolvedChecks?: {
    captcha?: boolean;
    twoFactor?: boolean;
    emailVerification?: boolean;
  };
  providedAnswers?: Record<string, unknown>;
  isDuplicate?: boolean;
  salary?: number | null;
};

export type SafetyGateResumeClaims = {
  unsupported?: string[];
};

type SafetyGateCheckResult = {
  blocked: boolean;
  reasons: string[];
};

export class SafetyGate {
  private readonly options: Required<SafetyGateOptions>;

  constructor(options: SafetyGateOptions = {}) {
    this.options = {
      salaryFloor: options.salaryFloor ?? 0,
      knownFields: options.knownFields ?? [
        'first_name', 'last_name', 'email', 'phone', 'resume',
        'experience', 'education', 'skills', 'salary_expectation',
        'authorized_to_work', 'requires_sponsorship', 'citizenship', 'gender'
      ],
      sensitiveKeywords: options.sensitiveKeywords ?? [
        'background check', 'drug test', 'credit check',
        'security clearance', 'nda', 'non-compete', 'arbitration'
      ]
    };
  }

  getSalaryFloor(): number {
    return this.options.salaryFloor;
  }

  check(
    appData: SafetyGateAppData = {},
    resumeClaims: SafetyGateResumeClaims = {},
    options: SafetyGateOptions = {}
  ): SafetyGateCheckResult {
    const activeOptions: Required<SafetyGateOptions> = {
      salaryFloor: options.salaryFloor ?? this.options.salaryFloor,
      knownFields: options.knownFields ?? this.options.knownFields,
      sensitiveKeywords: options.sensitiveKeywords ?? this.options.sensitiveKeywords
    };
    const reasons: string[] = [];
    let blocked = false;

    if (Array.isArray(appData.requiredFields)) {
      for (const field of appData.requiredFields) {
        if (!activeOptions.knownFields.includes(field)) {
          blocked = true;
          reasons.push(`UNKNOWN_REQUIRED_FIELD: Required field "${field}" is not in the list of known fields.`);
        }
      }
    }

    if (Array.isArray(resumeClaims.unsupported) && resumeClaims.unsupported.length > 0) {
      blocked = true;
      reasons.push(`UNSUPPORTED_CLAIMS: Resume does not support required claims: ${resumeClaims.unsupported.join(', ')}`);
    }

    if (appData.unresolvedChecks?.captcha) {
      blocked = true;
      reasons.push('UNRESOLVED_CAPTCHA: Application has unresolved CAPTCHA.');
    }
    if (appData.unresolvedChecks?.twoFactor) {
      blocked = true;
      reasons.push('UNRESOLVED_2FA: Application has unresolved 2FA verification.');
    }
    if (appData.unresolvedChecks?.emailVerification) {
      blocked = true;
      reasons.push('UNRESOLVED_EMAIL_VERIFICATION: Application has unresolved email verification.');
    }

    if (appData.providedAnswers) {
      for (const [field, val] of Object.entries(appData.providedAnswers)) {
        if (typeof val !== 'string') {
          continue;
        }
        const normalizedAnswer = val.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        for (const keyword of activeOptions.sensitiveKeywords) {
          const normalizedKeyword = keyword.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          const isMatched = normalizedKeyword.includes(' ')
            ? normalizedAnswer.includes(normalizedKeyword)
            : normalizedAnswer.split(/\s+/).includes(normalizedKeyword);
          if (isMatched) {
            blocked = true;
            reasons.push(`SENSITIVE_REVIEW_REQUIRED: Answer for "${field}" contains sensitive/legal term "${keyword}".`);
          }
        }
      }
    }

    if (appData.isDuplicate) {
      blocked = true;
      reasons.push('duplicate_application: Application already exists in the tracker ledger.');
    }

    if (typeof appData.salary === 'number' && appData.salary < activeOptions.salaryFloor) {
      blocked = true;
      reasons.push(`SALARY_BELOW_FLOOR: Offered salary ${appData.salary} is below floor threshold of ${activeOptions.salaryFloor}.`);
    }

    return { blocked, reasons };
  }
}
