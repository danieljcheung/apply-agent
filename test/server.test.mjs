import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

import { startServer, stopServer } from '../dist/server.js';
import { makeTextPdf } from './helpers/pdf-fixture.mjs';
import { getDbConfig, bootstrapVault } from '../dist/src/db.js';


process.env.TEST_MODE = 'true';
let activeToken = null;

function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const headers = { ...(options.headers || {}) };
    if (activeToken) {
      headers['Authorization'] = `Bearer ${activeToken}`;
    }
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers
    };

    if (body && typeof body === 'object') {
      body = JSON.stringify(body);
      reqOptions.headers['Content-Type'] = 'application/json';
    }
    if (body) {
      reqOptions.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsedData = data;
        if (res.headers['content-type']?.includes('application/json')) {
          try {
            parsedData = JSON.parse(data);
          } catch {}
        }
        if (parsedData && parsedData.token) {
          activeToken = parsedData.token;
        }
        if (parsedUrl.pathname === '/api/vault/lock') {
          activeToken = null;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: parsedData
        });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

test('HTTP Local Server Endpoints Integration', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-server-test-'));
  const port = 0; // Let OS pick a free port, or use 49152+ port range

  let server;
  let baseUrl;

  try {
    server = await startServer(0, { dataDir: tmpDir });
    const address = server.address();
    const actualPort = typeof address === 'object' ? address.port : 0;
    baseUrl = `http://127.0.0.1:${actualPort}`;

    await t.test('GET /api/health', async () => {
      const res = await request(`${baseUrl}/api/health`);
      assert.equal(res.statusCode, 200);
      assert.equal(res.data.status, 'ok');
      assert.ok(typeof res.data.time === 'number');
    });

    await t.test('GET /api/ready', async () => {
      const res = await request(`${baseUrl}/api/ready`);
      assert.equal(res.statusCode, 200);
      assert.equal(res.data.status, 'ok');
      assert.ok(typeof res.data.time === 'number');
    });

    await t.test('GET /api/state', async () => {
      const res = await request(`${baseUrl}/api/state`);
      assert.equal(res.statusCode, 200);
      assert.ok(res.data);
    });

    await t.test('POST /api/profile/bootstrap', async () => {
      const res = await request(`${baseUrl}/api/profile/bootstrap`, { method: 'POST' }, {
        password: 'server-test-secret',
        resumeText: 'Server Test Candidate\ntest@example.com\nSkills\nNode.js',
        interviewAnswers: { 'Preferred location': 'Remote' }
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.data.success, true);
      assert.equal(res.data.profile.answerMemory['Preferred location'], 'Remote');
    });

    await t.test('GET /api/vault/status', async () => {
      const res = await request(`${baseUrl}/api/vault/status`);
      assert.equal(res.statusCode, 200);
      assert.equal(res.data.success, true);
      assert.equal(res.data.exists, true);
      assert.equal(res.data.locked, false);
    });

    await t.test('POST /api/vault/lock & unlock wrong/right password', async () => {
      // Lock vault
      const lockRes = await request(`${baseUrl}/api/vault/lock`, { method: 'POST' });
      assert.equal(lockRes.statusCode, 200);
      assert.equal(lockRes.data.locked, true);

      // Verify protected endpoint fails when locked
      const stateRes = await request(`${baseUrl}/api/settings/credentials`, { method: 'POST' }, { username: 'a', password: 'b' });
      assert.equal(stateRes.statusCode, 401);

      // Unlock with wrong password
      const wrongRes = await request(`${baseUrl}/api/vault/unlock`, { method: 'POST' }, { password: 'wrong-password' });
      assert.equal(wrongRes.statusCode, 401);
      assert.equal(wrongRes.data.success, false);

      // Unlock with right password
      const rightRes = await request(`${baseUrl}/api/vault/unlock`, { method: 'POST' }, { password: 'server-test-secret' });
      assert.equal(rightRes.statusCode, 200);
      assert.equal(rightRes.data.success, true);
      assert.equal(rightRes.data.locked, false);
    });

    await t.test('POST /api/profile structured update', async () => {
      const res = await request(`${baseUrl}/api/profile`, { method: 'POST' }, {
        resumeText: 'Alex Rivera\nalex@example.com\nSkills\nTypeScript, Python',
        interviewAnswers: { 'Years of Experience': '5 years' }
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.data.success, true);
      assert.equal(res.data.profile.candidateProfile.name, 'Alex Rivera');
      assert.equal(res.data.answerMemory['Years of Experience'], '5 years');
    });

    await t.test('POST /api/profile/resume-upload (two PDFs)', async () => {
      const caseyPdf = makeTextPdf('Casey Morgan\ncasey@example.com\nSkills\nPython, SQL');
      const rileyPdf = makeTextPdf('Riley Chen\nriley@example.com\nSkills\nTypeScript, Kubernetes\nProjects\nKubernetes Deploy Bot\nBuilt a TypeScript service that automated Kubernetes release checks.');

      const res = await request(`${baseUrl}/api/profile/resume-upload`, { method: 'POST' }, {
        resumes: [
          {
            fileName: 'casey.pdf',
            contentBase64: caseyPdf.toString('base64'),
            mimeType: 'application/pdf'
          },
          {
            fileName: 'riley.pdf',
            contentBase64: rileyPdf.toString('base64'),
            mimeType: 'application/pdf'
          }
        ]
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.data.success, true);
      assert.equal(res.data.resumes.length, 2);
      assert.equal(res.data.profile.candidateProfile.name, 'Riley Chen');
      assert.equal(res.data.profile.candidateProfile.projects?.[0]?.name, 'Kubernetes Deploy Bot');
      assert.equal(res.data.resumes.find(r => r.candidateEmail === 'riley@example.com')?.projectCount, 1);

      const stateRes = await request(`${baseUrl}/api/state`);
      assert.equal(stateRes.statusCode, 200);
      assert.equal(stateRes.data.resumes.length, 2);
      assert.ok(stateRes.data.activeResumeId);
      assert.equal(stateRes.data.resumeArtifact, undefined);
      assert.equal(stateRes.data.profile.candidateProfile.projects?.[0]?.name, 'Kubernetes Deploy Bot');
    });

    await t.test('POST /api/profile/resume-upload (invalid non-PDF)', async () => {
      const res = await request(`${baseUrl}/api/profile/resume-upload`, { method: 'POST' }, {
        resumes: [
          {
            fileName: 'resume.txt',
            contentBase64: Buffer.from('hello').toString('base64'),
            mimeType: 'text/plain'
          }
        ]
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.data.success, false);
      assert.match(res.data.error, /Only PDF/i);
    });

    await t.test('POST /api/profile/resumes/select', async () => {
      const stateRes = await request(`${baseUrl}/api/state`);
      const resumes = stateRes.data.resumes;
      assert.equal(resumes.length, 2);
      const caseyResume = resumes.find(r => r.candidateEmail === 'casey@example.com');
      assert.ok(caseyResume);

      const selectRes = await request(`${baseUrl}/api/profile/resumes/select`, { method: 'POST' }, {
        resumeId: caseyResume.id
      });
      assert.equal(selectRes.statusCode, 200);
      assert.equal(selectRes.data.success, true);
      assert.equal(selectRes.data.activeResumeId, caseyResume.id);
      assert.equal(selectRes.data.profile.candidateProfile.name, 'Casey Morgan');

      const stateRes2 = await request(`${baseUrl}/api/state`);
      assert.equal(stateRes2.data.activeResumeId, caseyResume.id);
      assert.equal(stateRes2.data.profile.candidateProfile.name, 'Casey Morgan');
    });
    await t.test('POST /api/settings/credentials', async () => {
      const res = await request(`${baseUrl}/api/settings/credentials`, { method: 'POST' }, {
        username: 'testuser',
        password: 'testpassword'
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.data.success, true);
    });

    await t.test('POST /api/settings/proton-bridge', async () => {
      const res = await request(`${baseUrl}/api/settings/proton-bridge`, { method: 'POST' }, {
        config: { host: '127.0.0.1', port: 1143, username: 'user', password: 'pass', simulateSuccess: true }
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.data.success, true);
    });

    let createdAppId;
    await t.test('POST /api/applications', async () => {
      const res = await request(`${baseUrl}/api/applications`, { method: 'POST' }, {
        url: 'https://testco.myworkdayjobs.com/en-US/careers/job/123',
        jobDetails: {
          company: 'TestCo',
          title: 'Backend Engineer'
        }
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.data.success, true);
      assert.ok(res.data.application.id);
      createdAppId = res.data.application.id;
    });

    await t.test('POST /api/prompts/answer', async () => {
      assert.ok(createdAppId);
      const res = await request(`${baseUrl}/api/prompts/answer`, { method: 'POST' }, {
        appId: createdAppId,
        promptId: 'p_tech',
        question: 'What is HTTP?',
        answer: 'HyperText Transfer Protocol'
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.data.success, true);
    });

    await t.test('POST /api/applications/approve', async () => {
      assert.ok(createdAppId);
      const res = await request(`${baseUrl}/api/applications/approve`, { method: 'POST' }, {
        appId: createdAppId,
        approved: true,
        approvedBy: 'server-test-reviewer',
        mode: 'submit_after_approval'
      });
      if (res.statusCode !== 200) {
        console.log('Approve Failed Data:', res.data);
      }
      assert.equal(res.statusCode, 200);
      // Returns success status or result block
      assert.ok(res.data);
    });

    await t.test('POST /api/applications/reject', async () => {
      assert.ok(createdAppId);
      const res = await request(`${baseUrl}/api/applications/reject`, { method: 'POST' }, {
        appId: createdAppId
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.data.success, true);
    });
    await t.test('Tenant account creation application without stored credentials', async () => {
      const res = await request(`${baseUrl}/api/applications`, { method: 'POST' }, {
        url: 'https://nocreds.myworkdayjobs.com/en-US/careers/job/456',
        jobDetails: {
          company: 'NoCredsCo',
          title: 'Fullstack Engineer'
        }
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.data.success, true);
      assert.equal(res.data.application.status, 'ready_to_submit');
    });

    await t.test('External Origin POST to credentials/settings/applications is rejected', async () => {
      const res = await request(`${baseUrl}/api/settings/credentials`, {
        method: 'POST',
        headers: { 'Origin': 'http://malicious.com' }
      }, { username: 'foo', password: 'bar' });
      assert.equal(res.statusCode, 403);
    });

    await t.test('No wildcard CORS for API endpoints', async () => {
      const res = await request(`${baseUrl}/api/health`, {
        headers: { 'Origin': 'http://127.0.0.1:3000' }
      });
      assert.equal(res.headers['access-control-allow-origin'], 'http://127.0.0.1:3000');
      assert.notEqual(res.headers['access-control-allow-origin'], '*');
    });

    await t.test('GET /api/ready checks data directory and returns JSON', async () => {
      const res = await request(`${baseUrl}/api/ready`);
      assert.equal(res.statusCode, 200);
      assert.equal(res.data.status, 'ok');
      assert.equal(res.data.dataDir, true);
      assert.ok(typeof res.data.time === 'number');
    });

    await t.test('GET / serves Next.js control plane', async () => {
      const res = await request(`${baseUrl}/`);
      assert.equal(res.statusCode, 200);
      const contentType = res.headers['content-type'] || '';
      assert.ok(contentType.includes('text/html'));
      assert.ok(res.data.includes('Workday Auto-Apply Agent - OMP Control Plane'));
      assert.ok(res.data.includes('/_next/static/'));
    });

    await t.test('GET /any-non-existent-subpath serves Next.js control plane (SPA fallback)', async () => {
      const res = await request(`${baseUrl}/any-non-existent-subpath`);
      assert.equal(res.statusCode, 200);
      const contentType = res.headers['content-type'] || '';
      assert.ok(contentType.includes('text/html'));
      assert.ok(res.data.includes('Workday Auto-Apply Agent - OMP Control Plane'));
    });

    await t.test('GET /api/health does not fall back to static SPA page', async () => {
      const res = await request(`${baseUrl}/api/health`);
      assert.equal(res.statusCode, 200);
      const contentType = res.headers['content-type'] || '';
      assert.ok(contentType.includes('application/json'));
      assert.equal(res.data.status, 'ok');
    });
  } finally {
    await stopServer();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Explicit Vault Create Lifecycle', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-vault-create-test-'));
  let server;
  const originalActiveToken = activeToken;
  try {
    activeToken = null;
    server = await startServer(0, { dataDir: tmpDir });
    const address = server.address();
    const actualPort = typeof address === 'object' ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${actualPort}`;

    const status1 = await request(`${baseUrl}/api/vault/status`);
    assert.equal(status1.data.exists, false);

    const createRes = await request(`${baseUrl}/api/vault/create`, { method: 'POST' }, {
      password: 'my-brand-new-secret',
      resumeText: 'Jordan Lee\njordan@example.com'
    });
    assert.equal(createRes.statusCode, 200);
    assert.equal(createRes.data.success, true);
    assert.equal(createRes.data.profile.candidateProfile.name, 'Jordan Lee');

    const status2 = await request(`${baseUrl}/api/vault/status`);
    assert.equal(status2.data.exists, true);
    assert.equal(status2.data.locked, false);
  } finally {
    activeToken = originalActiveToken;
    await stopServer();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Harden localhost API and Token enforcement', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-token-harden-test-'));
  let server;
  try {
    server = await startServer(0, { dataDir: tmpDir });
    const address = server.address();
    const actualPort = typeof address === 'object' ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${actualPort}`;

    // 1. Initially, health and ready are public
    const healthRes = await request(`${baseUrl}/api/health`);
    assert.equal(healthRes.statusCode, 200);
    const readyRes = await request(`${baseUrl}/api/ready`);
    assert.equal(readyRes.statusCode, 200);

    // 2. Before vault creation, any other protected mutation route rejects with 401 (vault locked)
    // We send no token
    const profileRes = await request(`${baseUrl}/api/profile`, { method: 'POST' }, {
      resumeText: 'test'
    });
    assert.equal(profileRes.statusCode, 401);
    assert.equal(profileRes.data.success, false);

    // 3. Vault create succeeds without a token (since no token exists yet)
    // Note: the helper function `request` automatically captures the returned token in `activeToken`.
    // Let's clear any activeToken first to test tokenless creation.
    activeToken = null;
    const createRes = await request(`${baseUrl}/api/vault/create`, { method: 'POST' }, {
      password: 'token-test-secret-password-123',
      resumeText: 'Jordan Lee\njordan@example.com'
    });
    assert.equal(createRes.statusCode, 200);
    assert.equal(createRes.data.success, true);
    assert.ok(createRes.data.token);
    
    // Save the valid token returned
    const validToken = createRes.data.token;
    assert.equal(activeToken, validToken); // verify activeToken helper updated it

    // 4. Now that the token exists, mutation routes must reject if the token is missing or bad.
    // Try POST without token (temporarily override activeToken to null)
    activeToken = null;
    const noTokenRes = await request(`${baseUrl}/api/profile`, { method: 'POST' }, {
      resumeText: 'should fail'
    });
    assert.equal(noTokenRes.statusCode, 401);
    assert.equal(noTokenRes.data.success, false);
    assert.match(noTokenRes.data.error, /Unauthorized/);

    // Try POST with bad token
    activeToken = 'bad-token-xyz';
    const badTokenRes = await request(`${baseUrl}/api/profile`, { method: 'POST' }, {
      resumeText: 'should fail'
    });
    assert.equal(badTokenRes.statusCode, 401);
    assert.equal(badTokenRes.data.success, false);
    assert.match(badTokenRes.data.error, /Unauthorized/);

    // 5. Unlock and bootstrap succeed tokenlessly or with stale tokens on an existing vault when correct password is provided
    activeToken = 'stale-token-xyz';
    const badPasswordUnlock = await request(`${baseUrl}/api/vault/unlock`, { method: 'POST' }, {
      password: 'wrong-password'
    });
    assert.equal(badPasswordUnlock.statusCode, 401);
    assert.equal(badPasswordUnlock.data.error, 'Invalid password');

    activeToken = null;
    const noTokenUnlock = await request(`${baseUrl}/api/vault/unlock`, { method: 'POST' }, {
      password: 'token-test-secret-password-123'
    });
    assert.equal(noTokenUnlock.statusCode, 200);
    assert.equal(noTokenUnlock.data.success, true);
    assert.ok(noTokenUnlock.data.token);
    assert.notEqual(noTokenUnlock.data.token, validToken);
    let freshToken = noTokenUnlock.data.token;

    activeToken = 'stale-token-xyz';
    const badPasswordBootstrap = await request(`${baseUrl}/api/profile/bootstrap`, { method: 'POST' }, {
      password: 'wrong-password'
    });
    assert.equal(badPasswordBootstrap.statusCode, 401);
    assert.equal(badPasswordBootstrap.data.error, 'Invalid password');

    activeToken = null;
    const noTokenBootstrap = await request(`${baseUrl}/api/profile/bootstrap`, { method: 'POST' }, {
      password: 'token-test-secret-password-123',
      resumeText: 'Jordan Lee Updated'
    });
    assert.equal(noTokenBootstrap.statusCode, 200);
    assert.equal(noTokenBootstrap.data.success, true);
    assert.ok(noTokenBootstrap.data.token);
    freshToken = noTokenBootstrap.data.token;

    // 6. Public routes remain reachable even when token exists and we don't supply one
    activeToken = null;
    const healthRes2 = await request(`${baseUrl}/api/health`);
    assert.equal(healthRes2.statusCode, 200);
    const readyRes2 = await request(`${baseUrl}/api/ready`);
    assert.equal(readyRes2.statusCode, 200);

    // 7. Verify no raw secrets (like the token or passwords) in client-visible errors
    // We send a bad authorization header with the secret password, and expect it redacted
    activeToken = `bearer token-test-secret-password-123`;
    const checkRedactionRes = await request(`${baseUrl}/api/profile`, { method: 'POST' }, {
      resumeText: 'check'
    });
    assert.equal(checkRedactionRes.statusCode, 401);
    const responseErrorStr = JSON.stringify(checkRedactionRes.data);
    assert.ok(!responseErrorStr.includes('token-test-secret-password-123'), 'Secrets should be redacted');

    // 8. Mutation route with valid token succeeds
    activeToken = freshToken;
    const validRes = await request(`${baseUrl}/api/profile`, { method: 'POST' }, {
      resumeText: 'Valid Token Candidate\nSkills\nTesting',
      interviewAnswers: { 'Experience': 'Expert' }
    });
    assert.equal(validRes.statusCode, 200);
    assert.equal(validRes.data.success, true);

    // 9. Lock vault with valid token succeeds
    activeToken = freshToken;
    const lockRes = await request(`${baseUrl}/api/vault/lock`, { method: 'POST' });
    assert.equal(lockRes.statusCode, 200);
    assert.equal(lockRes.data.locked, true);
    assert.equal(activeToken, null); // Lock helper clears it

    // 10. After lock, the token is destroyed, so we can unlock again without token
    const unlockRes = await request(`${baseUrl}/api/vault/unlock`, { method: 'POST' }, {
      password: 'token-test-secret-password-123'
    });
    assert.equal(unlockRes.statusCode, 200);
    assert.equal(unlockRes.data.success, true);
    assert.ok(unlockRes.data.token);
  } finally {
    activeToken = null;
    await stopServer();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Vault/Session Token Recovery is Hardened and Does Not Work', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-token-recovery-hardened-test-'));
  let server;
  try {
    server = await startServer(0, { dataDir: tmpDir });
    const address = server.address();
    const actualPort = typeof address === 'object' ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${actualPort}`;

    // 1. Create vault (this also unlocks it and generates our first valid token)
    activeToken = null;
    const createRes = await request(`${baseUrl}/api/vault/create`, { method: 'POST' }, {
      password: 'recovery-test-password-123',
      resumeText: `Jordan Lee\njordan@example.com`
    });
    assert.equal(createRes.statusCode, 200);
    assert.equal(createRes.data.success, true);
    assert.ok(createRes.data.token);
    const token1 = createRes.data.token;
    assert.equal(activeToken, token1);

    // 2. Unauthenticated GET /api/state after unlock does not expose token and returns 401
    activeToken = null;
    const unauthRes = await request(`${baseUrl}/api/state`);
    assert.equal(unauthRes.statusCode, 401);

    // 3. Authenticated GET /api/state works but does not return token in body
    activeToken = token1;
    const authRes = await request(`${baseUrl}/api/state`);
    assert.equal(authRes.statusCode, 200);
    assert.equal(authRes.data.success, true);
    assert.equal(authRes.data.locked, false);
    assert.ok(!authRes.data.token);
  } finally {
    activeToken = null;
    await stopServer();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Vault/Session Invariant Enforcement on Stale-Token and Bad-Password Paths', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-token-invariants-test-'));
  let server;
  try {
    server = await startServer(0, { dataDir: tmpDir });
    const address = server.address();
    const actualPort = typeof address === 'object' ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${actualPort}`;

    // 1. Initially create a vault (this also unlocks it and generates a token)
    activeToken = null;
    const createRes = await request(`${baseUrl}/api/vault/create`, { method: 'POST' }, {
      password: 'invariant-password-123'
    });
    assert.equal(createRes.statusCode, 200);
    assert.ok(createRes.data.token);
    const token = createRes.data.token;
    assert.equal(activeToken, token);

    // 2. Try calling /api/vault/create again when currentToken is active (should fail with 400)
    const createAgainRes = await request(`${baseUrl}/api/vault/create`, { method: 'POST' }, {
      password: 'new-password'
    });
    assert.equal(createAgainRes.statusCode, 400);
    assert.equal(createAgainRes.data.success, false);
    assert.match(createAgainRes.data.error, /Vault session already active/);

    // 3. Perform a mutation to verify token is still valid
    const profileRes = await request(`${baseUrl}/api/profile`, { method: 'POST' }, {
      resumeText: 'test'
    });
    assert.equal(profileRes.statusCode, 200);

    // 4. Try unlocking with a bad password (should lock the vault and invalidate the token)
    activeToken = null;
    const badUnlockRes = await request(`${baseUrl}/api/vault/unlock`, { method: 'POST' }, {
      password: 'wrong-password'
    });
    assert.equal(badUnlockRes.statusCode, 401);
    assert.equal(badUnlockRes.data.success, false);
    assert.equal(badUnlockRes.data.error, 'Invalid password');

    // 5. Verify the vault is indeed locked
    const stateRes = await request(`${baseUrl}/api/state`);
    assert.equal(stateRes.statusCode, 200);
    assert.equal(stateRes.data.locked, true);
    assert.equal(stateRes.data.token, undefined);

    // 6. Verify subsequent mutation with the old token fails with 401 (stale/bad token)
    activeToken = token;
    const staleMutationRes = await request(`${baseUrl}/api/profile`, { method: 'POST' }, {
      resumeText: 'should fail'
    });
    assert.equal(staleMutationRes.statusCode, 401);
    assert.equal(staleMutationRes.data.success, false);

    // 7. Unlock with correct password (generates a new token)
    activeToken = null;
    const goodUnlockRes = await request(`${baseUrl}/api/vault/unlock`, { method: 'POST' }, {
      password: 'invariant-password-123'
    });
    assert.equal(goodUnlockRes.statusCode, 200);
    const newToken = goodUnlockRes.data.token;
    assert.ok(newToken);
    assert.notEqual(newToken, token);

    // 8. Try bootstrap with a bad password (should lock the vault and invalidate the token)
    activeToken = null;
    const badBootstrapRes = await request(`${baseUrl}/api/profile/bootstrap`, { method: 'POST' }, {
      password: 'wrong-password'
    });
    assert.equal(badBootstrapRes.statusCode, 401);
    assert.equal(badBootstrapRes.data.success, false);
    assert.equal(badBootstrapRes.data.error, 'Invalid password');

    // 9. Verify the vault is locked and new token is also invalidated
    activeToken = newToken;
    const staleMutationRes2 = await request(`${baseUrl}/api/profile`, { method: 'POST' }, {
      resumeText: 'should fail'
    });
    assert.equal(staleMutationRes2.statusCode, 401);
    assert.equal(staleMutationRes2.data.success, false);

  } finally {
    activeToken = null;
    await stopServer();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});


test('Request body limits: oversized body returns 413', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-body-limits-test-'));
  let server;
  try {
    server = await startServer(0, { dataDir: tmpDir });
    const address = server.address();
    const actualPort = typeof address === 'object' ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${actualPort}`;

    // Default limit is 64 KB. Let's send a body larger than 64 KB to a normal route, e.g. POST /api/vault/unlock
    const largePassword = 'a'.repeat(65 * 1024); // 65 KB
    const res = await request(`${baseUrl}/api/vault/unlock`, { method: 'POST' }, {
      password: largePassword
    });
    assert.equal(res.statusCode, 413);
    assert.equal(res.data.error, 'Payload Too Large');
  } finally {
    await stopServer();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('CORS: production environment rejects null and implicit localhost', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-cors-prod-test-'));
  const origNodeEnv = process.env.NODE_ENV;
  const origAllowedOrigins = process.env.APPLY_AGENT_ALLOWED_ORIGINS;
  let server;
  try {
    process.env.NODE_ENV = 'production';
    process.env.APPLY_AGENT_ALLOWED_ORIGINS = 'http://trusted-origin.com';

    server = await startServer(0, { dataDir: tmpDir });
    const address = server.address();
    const actualPort = typeof address === 'object' ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${actualPort}`;

    // 1. Rejects Origin: null
    const resNull = await request(`${baseUrl}/api/health`, {
      headers: { 'Origin': 'null' }
    });
    assert.equal(resNull.statusCode, 403);

    // 2. Rejects implicit localhost
    const resLocal = await request(`${baseUrl}/api/health`, {
      headers: { 'Origin': 'http://localhost:3000' }
    });
    assert.equal(resLocal.statusCode, 403);

    // 3. Accepts trusted allowed origin
    const resTrusted = await request(`${baseUrl}/api/health`, {
      headers: { 'Origin': 'http://trusted-origin.com' }
    });
    assert.equal(resTrusted.statusCode, 200);
    assert.equal(resTrusted.headers['access-control-allow-origin'], 'http://trusted-origin.com');
    assert.equal(resTrusted.headers['vary'], 'Origin');
  } finally {
    if (origNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = origNodeEnv;
    }
    if (origAllowedOrigins === undefined) {
      delete process.env.APPLY_AGENT_ALLOWED_ORIGINS;
    } else {
      process.env.APPLY_AGENT_ALLOWED_ORIGINS = origAllowedOrigins;
    }
    await stopServer();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Readiness: bad VAULT_PASSWORD makes readiness 503', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-readiness-fail-test-'));
  const origPasswordEnv = process.env.VAULT_PASSWORD;
  let server;
  try {
    // 1. Create a vault with some password
    server = await startServer(0, { dataDir: tmpDir });
    const address = server.address();
    let actualPort = typeof address === 'object' ? address.port : 0;
    let baseUrl = `http://127.0.0.1:${actualPort}`;

    const createRes = await request(`${baseUrl}/api/vault/create`, { method: 'POST' }, {
      password: 'correct-password-123'
    });
    assert.equal(createRes.statusCode, 200);
    await stopServer();

    // 2. Restart server with WRONG VAULT_PASSWORD in env
    process.env.VAULT_PASSWORD = 'wrong-password';
    server = await startServer(0, { dataDir: tmpDir });
    const newAddress = server.address();
    actualPort = typeof newAddress === 'object' ? newAddress.port : 0;
    baseUrl = `http://127.0.0.1:${actualPort}`;
    // 3. /api/ready must return 503 and indicate vaultReady is false
    const readyRes = await request(`${baseUrl}/api/ready`);
    assert.equal(readyRes.statusCode, 503);
    assert.equal(readyRes.data.status, 'not_ready');
    assert.equal(readyRes.data.vaultReady, false);
    // Ensure no secrets leaked in ready response
    const jsonStr = JSON.stringify(readyRes.data);
    assert.ok(!jsonStr.includes('correct-password-123'));
    assert.ok(!jsonStr.includes('wrong-password'));
  } finally {
    if (origPasswordEnv === undefined) {
      delete process.env.VAULT_PASSWORD;
    } else {
      process.env.VAULT_PASSWORD = origPasswordEnv;
    }
    await stopServer();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Host validation: pod-IP Host passes for health/ready/metrics, but fails for other routes', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-host-validation-test-'));
  let server;
  try {
    server = await startServer(0, { dataDir: tmpDir });
    const address = server.address();
    const actualPort = typeof address === 'object' ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${actualPort}`;

    // 1. Health endpoint with pod-IP Host header passes
    const healthRes = await request(`${baseUrl}/api/health`, {
      headers: { 'Host': `10.244.0.12:${actualPort}` }
    });
    assert.equal(healthRes.statusCode, 200);

    // 2. Ready endpoint with pod-IP Host header passes
    const readyRes = await request(`${baseUrl}/api/ready`, {
      headers: { 'Host': `10.244.0.12:${actualPort}` }
    });
    assert.equal(readyRes.statusCode, 200);

    // 3. Metrics endpoint with pod-IP Host header passes
    const metricsRes = await request(`${baseUrl}/metrics`, {
      headers: { 'Host': `10.244.0.12:${actualPort}` }
    });
    assert.equal(metricsRes.statusCode, 200);

    // 4. API routes (e.g. state) fail with 400 Bad Request
    const stateRes = await request(`${baseUrl}/api/state`, {
      headers: { 'Host': `10.244.0.12:${actualPort}` }
    });
    assert.equal(stateRes.statusCode, 400);

    // 5. Static routes fail with 400 Bad Request
    const staticRes = await request(`${baseUrl}/`, {
      headers: { 'Host': `10.244.0.12:${actualPort}` }
    });
    assert.equal(staticRes.statusCode, 400);
  } finally {
    await stopServer();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('HttpOnly Cookie Session Auth & Lifecycle', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-cookie-auth-test-'));
  let server;
  const originalActiveToken = activeToken;
  try {
    activeToken = null; // Clear global activeToken so we don't send Authorization header
    server = await startServer(0, { dataDir: tmpDir });
    const address = server.address();
    const actualPort = typeof address === 'object' ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${actualPort}`;

    // 1. Create vault and verify Set-Cookie header is returned
    const createRes = await request(`${baseUrl}/api/vault/create`, { method: 'POST' }, {
      password: 'cookie-test-pass-123'
    });
    assert.equal(createRes.statusCode, 200);
    assert.ok(createRes.headers['set-cookie']);
    
    const setCookieHeaders = createRes.headers['set-cookie'];
    const sessionCookie = setCookieHeaders.find(c => c.startsWith('apply_agent_session='));
    assert.ok(sessionCookie, 'Cookie apply_agent_session should be present');
    assert.match(sessionCookie, /HttpOnly/);
    assert.match(sessionCookie, /SameSite=Strict/);
    assert.match(sessionCookie, /Path=\//);
    assert.match(sessionCookie, /Max-Age=86400/);

    const tokenFromCookie = sessionCookie.split(';')[0].split('=')[1];
    assert.ok(tokenFromCookie, 'Token should be present in the cookie');

    // 2. Clear global activeToken so it won't be sent automatically by the request helper
    activeToken = null;

    // 3. Make request to protected API using the cookie instead of Bearer token
    const stateWithCookieRes = await request(`${baseUrl}/api/state`, {
      headers: { 'Cookie': `apply_agent_session=${tokenFromCookie}` }
    });
    assert.equal(stateWithCookieRes.statusCode, 200, 'Protected state API should succeed with valid session cookie');
    assert.equal(stateWithCookieRes.data.success, true);
    assert.equal(stateWithCookieRes.data.token, undefined, 'Raw token should be excluded from state response');

    // 4. Make request without cookie or header -> should fail with 401
    const stateNoAuthRes = await request(`${baseUrl}/api/state`);
    assert.equal(stateNoAuthRes.statusCode, 401, 'Request without authorization should be rejected');

    // 5. Lock vault and verify Set-Cookie clears the session cookie
    const lockRes = await request(`${baseUrl}/api/vault/lock`, {
      method: 'POST',
      headers: { 'Cookie': `apply_agent_session=${tokenFromCookie}` }
    });
    assert.equal(lockRes.statusCode, 200);
    assert.ok(lockRes.headers['set-cookie']);
    const lockSetCookie = lockRes.headers['set-cookie'].find(c => c.startsWith('apply_agent_session='));
    assert.ok(lockSetCookie);
    assert.match(lockSetCookie, /Max-Age=0/);

    // 6. Verify accessing protected endpoint is now locked
    const stateLockedRes = await request(`${baseUrl}/api/state`, {
      headers: { 'Cookie': `apply_agent_session=${tokenFromCookie}` }
    });
    assert.equal(stateLockedRes.statusCode, 401, 'Should fail after lock');
  } finally {
    activeToken = originalActiveToken;
    await stopServer();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Production Mode excludes raw token and sets Secure flag', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-prod-response-test-'));
  const origNodeEnv = process.env.NODE_ENV;
  const originalActiveToken = activeToken;
  let server;
  try {
    process.env.NODE_ENV = 'production';
    activeToken = null;
    server = await startServer(0, { dataDir: tmpDir });
    const address = server.address();
    const actualPort = typeof address === 'object' ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${actualPort}`;

    // 1. Create vault in production
    const createRes = await request(`${baseUrl}/api/vault/create`, { method: 'POST' }, {
      password: 'prod-test-pass-123'
    });
    assert.equal(createRes.statusCode, 200);
    assert.equal(createRes.data.token, undefined, 'Raw token should be excluded in production response');
    
    // Verify Set-Cookie has Secure attribute in production
    const setCookieHeaders = createRes.headers['set-cookie'];
    const sessionCookie = setCookieHeaders.find(c => c.startsWith('apply_agent_session='));
    assert.ok(sessionCookie);
    assert.match(sessionCookie, /Secure/, 'Cookie should have Secure attribute in production');

    const tokenFromCookie = sessionCookie.split(';')[0].split('=')[1];

    // 2. Lock vault
    const lockRes = await request(`${baseUrl}/api/vault/lock`, {
      method: 'POST',
      headers: { 'Cookie': `apply_agent_session=${tokenFromCookie}` }
    });
    assert.equal(lockRes.statusCode, 200);

    // 3. Unlock vault in production
    const unlockRes = await request(`${baseUrl}/api/vault/unlock`, { method: 'POST' }, {
      password: 'prod-test-pass-123'
    });
    assert.equal(unlockRes.statusCode, 200);
    assert.equal(unlockRes.data.token, undefined, 'Raw token should be excluded in production unlock response');

    // 4. Bootstrap vault in production
    // Lock it first
    await request(`${baseUrl}/api/vault/lock`, {
      method: 'POST',
      headers: { 'Cookie': `apply_agent_session=${tokenFromCookie}` }
    });

    const bootstrapRes = await request(`${baseUrl}/api/profile/bootstrap`, { method: 'POST' }, {
      password: 'prod-test-pass-123',
      resumeText: 'Bootstrap Resume text'
    });
    assert.equal(bootstrapRes.statusCode, 200);
    assert.equal(bootstrapRes.data.token, undefined, 'Raw token should be excluded in production bootstrap response');
  } finally {
    if (origNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = origNodeEnv;
    }
    activeToken = originalActiveToken;
    await stopServer();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});


test('POST /api/applications/approve ignores client-supplied testMode and inline in production mode', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-approve-prod-test-'));
  const originalTestMode = process.env.TEST_MODE;
  const originalActiveToken = activeToken;
  const origNodeEnv = process.env.NODE_ENV;
  let server;
  try {
    // Disable server-side test mode and set production mode
    delete process.env.TEST_MODE;
    process.env.NODE_ENV = 'production';
    activeToken = null;

    server = await startServer(0, { dataDir: tmpDir });
    const address = server.address();
    const actualPort = typeof address === 'object' ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${actualPort}`;

    // Bootstrap first to unlock vault and capture the production session cookie
    const bootRes = await request(`${baseUrl}/api/profile/bootstrap`, { method: 'POST' }, {
      password: 'prod-test-pass-approve',
      resumeText: 'Bootstrap Resume text'
    });
    assert.equal(bootRes.statusCode, 200);
    const sessionCookie = bootRes.headers['set-cookie']?.find(c => c.startsWith('apply_agent_session='))?.split(';')[0];
    assert.ok(sessionCookie, 'production bootstrap should set a session cookie');
    const prodAuth = { headers: { Cookie: sessionCookie } };

    // Create an application
    const createRes = await request(`${baseUrl}/api/applications`, { ...prodAuth, method: 'POST' }, {
      url: 'https://testco.myworkdayjobs.com/en-US/careers/job/123',
      jobDetails: {
        company: 'TestCo',
        title: 'Backend Engineer'
      }
    });
    const appId = createRes.data.application.id;
    assert.ok(appId);

    // Approve application with testMode: true and inline: true in request JSON
    const approveRes = await request(`${baseUrl}/api/applications/approve`, { ...prodAuth, method: 'POST' }, {
      appId,
      approved: true,
      approvedBy: 'production-reviewer',
      mode: 'submit_after_approval',
      testMode: true,
      inline: true
    });
    
    assert.equal(approveRes.statusCode, 400);
    // Client-supplied testMode/inline are ignored in production, so no inline test submission or queue job is created.
    assert.equal(approveRes.data.blocker, 'automation_not_configured');
    assert.equal(approveRes.data.jobId, undefined);

    const stateRes = await request(`${baseUrl}/api/state`, prodAuth);
    assert.equal(stateRes.statusCode, 200);
    const app = stateRes.data.applications.find(candidate => candidate.id === appId);
    assert.equal(app.status, 'blocked');
  } finally {
    if (originalTestMode !== undefined) {
      process.env.TEST_MODE = originalTestMode;
    } else {
      delete process.env.TEST_MODE;
    }
    if (origNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = origNodeEnv;
    }
    activeToken = originalActiveToken;
    await stopServer();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Database Production Configuration & Placeholder Rejection', () => {
  const dummyCa = '-----BEGIN CERTIFICATE-----\nMIIDXTCCAkWgAwIBAgIJAJ\n-----END CERTIFICATE-----';
  const baseEnv = {
    NODE_ENV: 'production',
    DB_HOST: 'localhost',
    DB_USER: 'prod_user',
    DB_PASSWORD: 'prod_password_123',
    DB_SSLMODE: 'require',
    DB_SSL_CA: dummyCa
  };
  // 1. Missing username
  assert.throws(() => {
    getDbConfig({ ...baseEnv, DB_USER: '' });
  }, /username is missing/);

  // 2. Missing password
  assert.throws(() => {
    getDbConfig({ ...baseEnv, DB_PASSWORD: '' });
  }, /password is missing/);

  // 3. Placeholder password 'change_me_in_production'
  assert.throws(() => {
    getDbConfig({ ...baseEnv, DB_PASSWORD: 'change_me_in_production' });
  }, /placeholder values/);

  // 4. Placeholder username 'change_me_in_production'
  assert.throws(() => {
    getDbConfig({ ...baseEnv, DB_USER: 'change_me_in_production' });
  }, /placeholder values/);

  // 5. DATABASE_URL with placeholder
  assert.throws(() => {
    getDbConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://user:change_me_in_production@localhost/db'
    });
  }, /placeholder values/);

  // 6. DATABASE_URL with missing credentials
  assert.throws(() => {
    getDbConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://localhost/db'
    });
  }, /missing/);

  // 7. DB_SSLMODE=require with an unreadable explicit CA path in production throws
  assert.throws(() => {
    getDbConfig({ ...baseEnv, DB_SSLMODE: 'require', DB_SSL_CA: undefined, DB_SSL_CA_PATH: '/definitely/missing/apply-agent-ca.pem' });
  }, /Failed to read database CA certificate/);

  // 8. DB_SSL_REJECT_UNAUTHORIZED=false in production throws
  assert.throws(() => {
    getDbConfig({ ...baseEnv, DB_SSLMODE: 'require', DB_SSL_REJECT_UNAUTHORIZED: 'false' });
  }, /not permitted/);

  // 9. DB_SSLMODE=require with raw CA in production succeeds and sets rejectUnauthorized: true
  const configWithCa = getDbConfig({
    ...baseEnv,
    DB_SSLMODE: 'require',
    DB_SSL_CA: dummyCa
  });
  assert.ok(configWithCa.ssl);
  assert.equal(configWithCa.ssl.rejectUnauthorized, true);
  assert.equal(configWithCa.ssl.ca, dummyCa);

  // 10. Local mode permits insecure flag DB_SSL_REJECT_UNAUTHORIZED=false
  const localConfig = getDbConfig({
    NODE_ENV: 'development',
    DB_HOST: 'localhost',
    DB_USER: 'dev_user',
    DB_PASSWORD: 'change_me_in_production', // permitted in dev
    DB_SSLMODE: 'require',
    DB_SSL_REJECT_UNAUTHORIZED: 'false'
  });
  assert.ok(localConfig.ssl);
  assert.equal(localConfig.ssl.rejectUnauthorized, false);
  // 11. Production without SSLMODE=require/DB_SSL=true throws
  assert.throws(() => {
    getDbConfig({ ...baseEnv, DB_SSLMODE: 'disable' });
  }, /SSL connection is required in production/);
});

test('Vault Bootstrap Race Handling', async () => {
  // Mock file check where vault doesn't exist initially
  let fileExists = false;

  // Case A: Create vault succeeds (no race)
  let createCalled = 0;
  let unlockCalled = 0;
  const appServiceOk = {
    async createVault(password) {
      createCalled++;
      await fs.writeFile(tmpFile, 'dummy content');
    },
    async unlock(password) {
      unlockCalled++;
    }
  };

  const tmpFile = path.join(os.tmpdir(), `vault-race-test-${Date.now()}`);
  
  try {
    // 1. Vault does not exist, create succeeds
    await bootstrapVault(appServiceOk, 'pass', tmpFile);
    assert.equal(createCalled, 1);
    assert.equal(unlockCalled, 0);

    // 2. Vault exists, unlock is called
    createCalled = 0;
    unlockCalled = 0;
    await bootstrapVault(appServiceOk, 'pass', tmpFile);
    assert.equal(createCalled, 0);
    assert.equal(unlockCalled, 1);
  } finally {
    try {
      await fs.unlink(tmpFile);
    } catch {}
  }

  // Case B: Create vault races (throws "already exists") -> retries unlock
  const tmpFileRace = path.join(os.tmpdir(), `vault-race-test-2-${Date.now()}`);
  let createRaceCalled = 0;
  let unlockRaceCalled = 0;
  
  const appServiceRace = {
    async createVault(password) {
      createRaceCalled++;
      // Simulate another writer wrote the file concurrently
      await fs.writeFile(tmpFileRace, 'dummy content');
      throw new Error('Vault already exists');
    },
    async unlock(password) {
      unlockRaceCalled++;
    }
  };

  try {
    await bootstrapVault(appServiceRace, 'pass', tmpFileRace);
    assert.equal(createRaceCalled, 1);
    assert.equal(unlockRaceCalled, 1, 'Should retry unlock on already exists error');
  } finally {
    try {
      await fs.unlink(tmpFileRace);
    } catch {}
  }
});

test('POST /api/settings/proton-bridge rejects simulateSuccess in production mode', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-proton-prod-test-'));
  const origNodeEnv = process.env.NODE_ENV;
  const originalActiveToken = activeToken;
  let server;
  try {
    process.env.NODE_ENV = 'production';
    activeToken = null;
    server = await startServer(0, { dataDir: tmpDir });
    const address = server.address();
    const actualPort = typeof address === 'object' ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${actualPort}`;

    // Bootstrap first to set up credentials/unlock and capture the production session cookie
    const bootRes = await request(`${baseUrl}/api/profile/bootstrap`, { method: 'POST' }, {
      password: 'prod-test-pass-123',
      resumeText: 'Bootstrap Resume text'
    });
    assert.equal(bootRes.statusCode, 200);
    const sessionCookie = bootRes.headers['set-cookie']?.find(c => c.startsWith('apply_agent_session='))?.split(';')[0];
    assert.ok(sessionCookie, 'production bootstrap should set a session cookie');

    // Try posting proton-bridge configuration with simulateSuccess: true.
    // In production mode, simulateSuccess is ignored, so it attempts an actual connection
    // to the (unreachable) host, failing and returning 400.
    const res = await request(`${baseUrl}/api/settings/proton-bridge`, { method: 'POST', headers: { Cookie: sessionCookie } }, {
      config: { host: '127.0.0.1', port: 1143, username: 'user', password: 'password', simulateSuccess: true }
    });
    assert.equal(res.statusCode, 400, 'simulateSuccess should be ignored in production, causing actual connection to fail');
    assert.ok(res.data.error, 'Should return error message');
    assert.notEqual(res.data.blocker, undefined);
  } finally {
    if (origNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = origNodeEnv;
    }
    activeToken = originalActiveToken;
    await stopServer();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

