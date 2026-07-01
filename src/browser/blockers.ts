import type { BlockerCode, ProfileBundle } from '../types.js';

export interface FormControlInfo {
  type: string;
  name: string;
  id: string;
  label: string;
  required: boolean;
  options: string[];
  automationId?: string;
}

export interface BrowserBlockerDetail {
  code: BlockerCode;
  message: string;
  severity: 'fatal' | 'recoverable' | 'info';
}

export function blockerDetails(
  code: BlockerCode,
  message: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    blockers: [toBrowserBlockerDetail(code, message)],
    ...extra
  };
}

export function toBrowserBlockerDetail(code: BlockerCode, message: string): BrowserBlockerDetail {
  return {
    code,
    message,
    severity: code === 'captcha_required' ? 'fatal' : 'recoverable'
  };
}

export function detectBrowserBlocker(
  text: string,
  iframes: string[],
  formControls: FormControlInfo[],
  profile: ProfileBundle | null
): BlockerCode | null {
  const lowerText = text.toLowerCase();

  if (hasCaptcha(lowerText, iframes)) {
    return 'captcha_required';
  }
  if (hasEmailVerification(lowerText)) {
    return 'email_verification_required';
  }
  if (hasTwoFactor(lowerText)) {
    return 'two_factor_required';
  }
  if (hasUnknownRequiredField(formControls, profile)) {
    return 'unknown_required_answer';
  }
  return null;
}

function hasCaptcha(lowerText: string, iframes: string[]): boolean {
  const keywords = [
    'captcha',
    'recaptcha',
    'hcaptcha',
    'turnstile',
    'arkose',
    'security check',
    'prove you are human',
    'please solve the puzzle',
    'enter the characters you see'
  ];
  return keywords.some(keyword => lowerText.includes(keyword)) ||
    iframes.some(src => /recaptcha|hcaptcha|turnstile|arkose/i.test(src));
}

function hasEmailVerification(lowerText: string): boolean {
  const keywords = [
    'verify your email',
    'email verification',
    'check your inbox',
    'confirm your email',
    'sent a code to your email',
    'activation link'
  ];
  return keywords.some(keyword => lowerText.includes(keyword));
}

function hasTwoFactor(lowerText: string): boolean {
  const keywords = [
    'two-factor',
    '2fa',
    'verification code',
    'enter the code sent',
    'authenticator',
    'otp',
    'one-time password',
    'security code'
  ];
  return keywords.some(keyword => lowerText.includes(keyword));
}

function hasUnknownRequiredField(formControls: FormControlInfo[], profile: ProfileBundle | null): boolean {
  return formControls.some(field => field.required && !isKnownRequiredField(field, profile));
}

function isKnownRequiredField(field: FormControlInfo, profile: ProfileBundle | null): boolean {
  const label = field.label.toLowerCase();
  const name = field.name.toLowerCase();
  const autoId = (field.automationId || '').toLowerCase();

  const knownProfileField =
    field.type === 'file' ||
    label.includes('name') ||
    name.includes('name') ||
    autoId.includes('name') ||
    label.includes('email') ||
    name.includes('email') ||
    autoId.includes('email') ||
    label.includes('phone') ||
    name.includes('phone') ||
    autoId.includes('phone') ||
    label.includes('resume') ||
    name.includes('resume') ||
    autoId.includes('resume') ||
    label.includes('cv') ||
    name.includes('cv') ||
    autoId.includes('cv') ||
    label.includes('authorized') ||
    label.includes('authorization') ||
    name.includes('workauth') ||
    autoId.includes('work-auth') ||
    autoId.includes('workauth') ||
    label.includes('sponsorship') ||
    name.includes('sponsorship') ||
    autoId.includes('sponsorship');
  if (knownProfileField) {
    return true;
  }
  if (!profile) {
    return false;
  }

  const answers = profile.answerMemory || {};
  return Object.keys(answers).some(question => {
    const qLower = question.toLowerCase();
    return qLower.includes(label) || label.includes(qLower) ||
           (autoId && (qLower.includes(autoId) || autoId.includes(qLower))) ||
           (name && (qLower.includes(name) || name.includes(qLower)));
  });
}
