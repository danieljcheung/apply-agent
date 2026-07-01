import test from 'node:test';
import assert from 'node:assert/strict';

// Import compiled dist modules after build as specified in contract
import * as policyModule from '../dist/src/browser/policy.js';
import * as indexModule from '../dist/src/browser/index.js';

test('Focused Synthetic Challenge Policy Helper Tests', async (t) => {
  const validateSyntheticFn = policyModule.validateSyntheticChallengePolicy || indexModule.validateSyntheticChallengePolicy;
  const isSyntheticAllowedFn = policyModule.isSyntheticChallengeAllowed || indexModule.isSyntheticChallengeAllowed;
  const SyntheticPolicyClass = policyModule.SyntheticChallengePolicy || indexModule.SyntheticChallengePolicy;

  assert.ok(typeof validateSyntheticFn === 'function', 'validateSyntheticChallengePolicy must be exported from index and policy');
  assert.ok(typeof isSyntheticAllowedFn === 'function', 'isSyntheticChallengeAllowed must be exported from index and policy');
  assert.ok(typeof SyntheticPolicyClass === 'function', 'SyntheticChallengePolicy class must be exported from index and policy');

  await t.test('Local fixture URLs pass under non-production with CHALLENGE_TEST_MODE true', () => {
    const urls = [
      'http://localhost:3000/test-captcha',
      'http://127.0.0.1:8080/synthetic-challenge'
    ];
    for (const url of urls) {
      const res = validateSyntheticFn(url, { nodeEnv: 'development', challengeTestMode: 'true' });
      assert.equal(res.allowed, true, `Expected ${url} to be allowed`);
    }
  });

  await t.test('Workday domains and external domains are rejected for synthetic challenges', () => {
    const urls = [
      'https://company.myworkdayjobs.com/en-US/careers',
      'https://myworkdayjobs.com',
      'https://example.com'
    ];
    for (const url of urls) {
      const res = validateSyntheticFn(url, { nodeEnv: 'development', challengeTestMode: 'true' });
      assert.equal(res.allowed, false, `Expected ${url} to be rejected`);
      assert.equal(res.blocker, 'captcha_required');
    }
  });

  await t.test('Production environment strictly blocks synthetic challenges', () => {
    const res = validateSyntheticFn('http://localhost:3000/test-captcha', { nodeEnv: 'production', challengeTestMode: 'true' });
    assert.equal(res.allowed, false);
    assert.equal(res.blocker, 'captcha_required');
  });
});
