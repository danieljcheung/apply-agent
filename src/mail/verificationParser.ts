export interface ParsedVerificationEmail {
  code: string | null;
  link: string | null;
  confirmationText: string | null;
  isWorkdayVerification: boolean;
}

/**
 * Extract a 6-digit verification code / OTP from email body text or HTML.
 */
export function extractVerificationCode(body: string): string | null {
  if (!body) return null;

  // Clean HTML tags for plain text search if HTML is provided
  const plainText = body.replace(/<[^>]+>/g, ' ');

  // 1. Match explicit phrase patterns: e.g. "code is 123456", "code: 123456", "passcode 123456"
  const explicitPatterns = [
    /(?:verification|security|auth|2fa|otp|login)?\s*(?:code|passcode|pin)\s*(?:is|:)?\s*(\d{6})\b/i,
    /(\d{6})\s*(?:is your|is the)?\s*(?:verification|security|auth|2fa|otp)?\s*(?:code|passcode|pin)/i,
    /code\s*(?:is|:)?\s*(\d{6})\b/i
  ];

  for (const pattern of explicitPatterns) {
    const match = plainText.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  // 2. Fallback to finding any standalone 6-digit sequence
  const standaloneMatch = plainText.match(/\b(\d{6})\b/);
  if (standaloneMatch && standaloneMatch[1]) {
    return standaloneMatch[1];
  }

  return null;
}

/**
 * Alias for extractVerificationCode
 */
export function extractOtp(body: string): string | null {
  return extractVerificationCode(body);
}

/**
 * Extract a verification or confirmation link from email body (HTML or text).
 */
export function extractVerificationLink(body: string): string | null {
  if (!body) return null;

  const urls: string[] = [];

  // Extract href attribute URLs from HTML
  const hrefRegex = /href=["']([^"']+)["']/gi;
  let hrefMatch: RegExpExecArray | null;
  while ((hrefMatch = hrefRegex.exec(body)) !== null) {
    if (hrefMatch[1]) {
      urls.push(hrefMatch[1]);
    }
  }

  // Extract raw HTTP/HTTPS URLs from plain text or HTML body
  const rawUrlRegex = /https?:\/\/[^\s"'<>\)]+/gi;
  let rawMatch: RegExpExecArray | null;
  while ((rawMatch = rawUrlRegex.exec(body)) !== null) {
    if (rawMatch[0]) {
      urls.push(rawMatch[0]);
    }
  }

  if (urls.length === 0) return null;

  // Prioritize URLs containing verification / confirmation keywords
  const keywords = ['verify', 'verification', 'confirm', 'confirmation', 'auth', 'token', 'validate'];
  for (const url of urls) {
    const lower = url.toLowerCase();
    if (keywords.some(kw => lower.includes(kw))) {
      return url;
    }
  }

  // Fallback to first URL found if any
  return urls[0] || null;
}

/**
 * Extract confirmation message or application submission acknowledgment text.
 */
export function extractConfirmationText(body: string): string | null {
  if (!body) return null;

  const plainText = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  const confirmationPatterns = [
    /(?:thank you for|thanks for)\s+[^.!?]*(?:application|submitting|applying)[^.!?]*[.!?]/i,
    /(?:your application|your profile|your account)\s+[^.!?]*(?:submitted|received|verified|confirmed)[^.!?]*[.!?]/i,
    /application has been (?:successfully )?(?:received|submitted)[^.!?]*[.!?]/i,
    /(?:email address|account) has been verified[^.!?]*[.!?]/i
  ];

  for (const pattern of confirmationPatterns) {
    const match = plainText.match(pattern);
    if (match && match[0]) {
      return match[0].trim();
    }
  }

  // Fallback check if the body general context is confirmation
  if (/thank you|received|submitted|verified/i.test(plainText)) {
    return plainText;
  }

  return null;
}

/**
 * Comprehensive parser for Workday verification emails.
 */
export function parseVerificationEmail(body: string): ParsedVerificationEmail {
  const code = extractVerificationCode(body);
  const link = extractVerificationLink(body);
  const confirmationText = extractConfirmationText(body);

  const lower = body ? body.toLowerCase() : '';
  const isWorkdayVerification =
    lower.includes('workday') ||
    lower.includes('verification') ||
    lower.includes('security code') ||
    code !== null ||
    link !== null;

  return {
    code,
    link,
    confirmationText,
    isWorkdayVerification
  };
}
