import test from 'node:test';
import assert from 'node:assert/strict';

// Import compiled dist modules after build as specified in contract
import * as policyModule from '../dist/src/browser/policy.js';

test('Browser Policy - Allowed and Blocked Domains', async (t) => {
  const validateFn = policyModule.validateBrowserPolicy || policyModule.validateUrlPolicy || policyModule.default;
  assert.ok(typeof validateFn === 'function' || typeof policyModule.BrowserAutomationPolicy === 'function', 'Policy validation function or class must exist');

  const checkUrl = (url) => {
    if (typeof validateFn === 'function') {
      return validateFn(url);
    }
    if (policyModule.BrowserAutomationPolicy) {
      const policy = new policyModule.BrowserAutomationPolicy();
      return policy.validate(url);
    }
    return { allowed: false };
  };

  await t.test('Allowed Workday domains', () => {
    const allowedUrls = [
      'https://acme.myworkdayjobs.com/en-US/careers/job/123',
      'https://subdomain.wd5.myworkdayjobs.com/en-US/recruiting/job/456',
      'http://127.0.0.1:8080/fixtures/basic-application.html',
      'http://localhost:3000/fixtures/captcha.html',
    ];

    for (const url of allowedUrls) {
      const result = checkUrl(url);
      const isAllowed = typeof result === 'boolean' ? result : result?.allowed;
      assert.equal(isAllowed, true, `Expected URL to be allowed: ${url}`);
    }
  });

  await t.test('Blocked non-Workday external domains', () => {
    const blockedUrls = [
      'https://evil-phishing.com/workday',
      'https://myworkdayjobs.com.attacker.org/job',
      'https://google.com',
      'https://arbitrary-site.net/form',
    ];

    for (const url of blockedUrls) {
      const result = checkUrl(url);
      const isAllowed = typeof result === 'boolean' ? result : result?.allowed;
      assert.equal(isAllowed, false, `Expected URL to be blocked: ${url}`);
    }
  });

  await t.test('Default Workday allowed domain patterns exported', () => {
    const domains = policyModule.defaultWorkdayAllowedDomains || policyModule.WORKDAY_ALLOWED_DOMAINS;
    if (domains) {
      assert.ok(Array.isArray(domains) || domains instanceof Set, 'Allowed domains list should be array or set');
    }
  });
});
test('Synthetic Challenge Policy Gating', async (t) => {
  const validateSyntheticFn = policyModule.validateSyntheticChallengePolicy;
  const isSyntheticAllowedFn = policyModule.isSyntheticChallengeAllowed;
  const SyntheticPolicyClass = policyModule.SyntheticChallengePolicy;

  assert.ok(typeof validateSyntheticFn === 'function', 'validateSyntheticChallengePolicy must be exported');
  assert.ok(typeof isSyntheticAllowedFn === 'function', 'isSyntheticChallengeAllowed must be exported');
  assert.ok(typeof SyntheticPolicyClass === 'function', 'SyntheticChallengePolicy class must be exported');

  await t.test('Allowed local fixture domains pass in test mode', () => {
    const localUrls = [
      'http://localhost:3000/fixtures/captcha.html',
      'http://127.0.0.1:8080/fixtures/synthetic-challenge.html',
    ];
    const options = { nodeEnv: 'test', challengeTestMode: true };

    for (const url of localUrls) {
      const result = validateSyntheticFn(url, options);
      assert.equal(result.allowed, true, `Expected local URL to pass challenge policy: ${url}`);
      assert.equal(isSyntheticAllowedFn(url, options), true);
    }
  });

  await t.test('Workday and external domains fail synthetic challenge policy', () => {
    const externalUrls = [
      'https://acme.myworkdayjobs.com/en-US/careers/job/123',
      'https://subdomain.wd5.myworkdayjobs.com/recruiting/job/456',
      'https://google.com',
      'https://evil-phishing.com/captcha',
    ];
    const options = { nodeEnv: 'test', challengeTestMode: true };

    for (const url of externalUrls) {
      const result = validateSyntheticFn(url, options);
      assert.equal(result.allowed, false, `Expected external URL to fail challenge policy: ${url}`);
      assert.equal(result.blocker, 'captcha_required');
      assert.equal(isSyntheticAllowedFn(url, options), false);
    }
  });

  await t.test('Production mode fails synthetic challenge policy even for local domains', () => {
    const localUrl = 'http://localhost:3000/fixtures/captcha.html';
    const options = { nodeEnv: 'production', challengeTestMode: true };

    const result = validateSyntheticFn(localUrl, options);
    assert.equal(result.allowed, false, 'Production environment must strictly disallow synthetic challenges');
    assert.equal(result.blocker, 'captcha_required');
    assert.equal(isSyntheticAllowedFn(localUrl, options), false);
  });

  await t.test('Disabled test flag fails synthetic challenge policy', () => {
    const localUrl = 'http://localhost:3000/fixtures/captcha.html';
    const options = { nodeEnv: 'test', challengeTestMode: false };

    const result = validateSyntheticFn(localUrl, options);
    assert.equal(result.allowed, false, 'Disabled CHALLENGE_TEST_MODE must reject synthetic challenges');
    assert.equal(result.blocker, 'captcha_required');
    assert.equal(isSyntheticAllowedFn(localUrl, options), false);
  });

  await t.test('SyntheticChallengePolicy class instance operates correctly', () => {
    const policy = new SyntheticPolicyClass({ nodeEnv: 'test', challengeTestMode: true });
    assert.equal(policy.isAllowed('http://localhost:3000/captcha'), true);
    assert.equal(policy.isAllowed('https://acme.myworkdayjobs.com'), false);
  });
});
