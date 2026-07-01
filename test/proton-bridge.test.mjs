import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ProtonBridgeConnector } from '../dist/src/protonBridge.js';

import {
  extractVerificationCode,
  extractOtp,
  extractVerificationLink,
  extractConfirmationText,
  parseVerificationEmail
} from '../dist/src/mail/verificationParser.js';
process.env.TEST_MODE = 'true';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, 'fixtures', 'mail');

test('1. Workday Mail Verification Parser - OTP / Code Extraction', async (t) => {
  const otpBody = await fs.readFile(path.join(fixturesDir, 'workday-otp.txt'), 'utf-8');
  const code = extractVerificationCode(otpBody);
  assert.equal(code, '884712', 'Should extract six-digit code 884712');

  const aliasCode = extractOtp(otpBody);
  assert.equal(aliasCode, '884712', 'extractOtp alias should extract code 884712');

  const fullVerificationBody = await fs.readFile(path.join(fixturesDir, 'workday-full-verification.html'), 'utf-8');
  const fullCode = extractVerificationCode(fullVerificationBody);
  assert.equal(fullCode, '654321', 'Should extract 2FA security code 654321 from HTML');
});

test('2. Workday Mail Verification Parser - Link Extraction', async (t) => {
  const linkBody = await fs.readFile(path.join(fixturesDir, 'workday-link.html'), 'utf-8');
  const link = extractVerificationLink(linkBody);
  assert.equal(link, 'https://myworkday.com/tenant/verify-email?token=abc123def456xyz');

  const fullBody = await fs.readFile(path.join(fixturesDir, 'workday-full-verification.html'), 'utf-8');
  const fullLink = extractVerificationLink(fullBody);
  assert.equal(fullLink, 'https://acme.workday.com/confirm?id=9988');
});

test('3. Workday Mail Verification Parser - Confirmation Text Extraction', async (t) => {
  const confirmBody = await fs.readFile(path.join(fixturesDir, 'workday-confirmation.txt'), 'utf-8');
  const confirmText = extractConfirmationText(confirmBody);
  assert.ok(confirmText, 'Confirmation text should be extracted');
  assert.ok(confirmText.toLowerCase().includes('thank you for your application'), 'Should contain thank you text');

  const parsed = parseVerificationEmail(confirmBody);
  assert.equal(parsed.isWorkdayVerification, true);
  assert.ok(parsed.confirmationText);
});

test('4. ProtonBridgeConnector - Invalid Config & Redacted Error Behavior', async (t) => {
  const invalidConnector = new ProtonBridgeConnector(null);
  assert.equal(invalidConnector.testConfig(null), false);
  const connResult = await invalidConnector.connect();
  assert.equal(connResult.connected, false);
  assert.equal(connResult.blocker, 'BRIDGE_CONFIG_INVALID');

  const incompleteConnector = new ProtonBridgeConnector({ host: '127.0.0.1' });
  assert.equal(incompleteConnector.testConfig({ host: '127.0.0.1' }), false);

  const secretConfig = {
    host: '127.0.0.1',
    port: 1143,
    username: 'secretuser@example.com',
    password: 'SuperSecretPassword123'
  };
  const secretConnector = new ProtonBridgeConnector(secretConfig);

  const errorWithSecrets = `Failed login for secretuser@example.com using password SuperSecretPassword123 at 127.0.0.1`;
  const redacted = secretConnector.redactError(errorWithSecrets);
  assert.ok(!redacted.includes('secretuser@example.com'), 'Username should be redacted');
  assert.ok(!redacted.includes('SuperSecretPassword123'), 'Password should be redacted');
  assert.ok(redacted.includes('[REDACTED]'), 'Redacted marker should be present');
});

test('5. ProtonBridgeConnector - Simulate Success Search', async (t) => {
  const simConnector = new ProtonBridgeConnector({
    host: '127.0.0.1',
    port: 1143,
    username: 'test@example.com',
    password: 'password',
    simulateSuccess: true
  });

  const connResult = await simConnector.connect();
  assert.equal(connResult.connected, true);

  const searchResult = await simConnector.search('Verification Code');
  assert.equal(searchResult.success, true);
  assert.ok(Array.isArray(searchResult.emails));
  assert.ok(searchResult.emails.length > 0);
  assert.equal(searchResult.emails[0].id, 1);
  assert.ok(searchResult.emails[0].body.includes('884712'));
});
