import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

import { startServer, stopServer, getAppService } from '../dist/server.js';

let activeToken = null;

function assertJobHuntStyleRender(html, candidateName, projectName) {
  assert.ok(html.includes('meta name="generator" content="Kami"'), 'Should contain meta generator Kami');
  assert.ok(html.includes(candidateName), `Should contain candidate name: ${candidateName}`);
  assert.ok(html.includes(projectName), `Should contain project name: ${projectName}`);
  assert.ok(html.includes('Technical Projects'), 'Should contain Technical Projects section');
  assert.ok(html.includes('Technical Skills'), 'Should contain Technical Skills section');
  assert.ok(html.includes('Newsreader'), 'Should use Newsreader font');
  assert.ok(html.includes('border-left') && html.includes('header'), 'Should contain left-border header CSS');
  assert.ok(!html.includes('{{'), 'Should not contain template placeholders');
  assert.ok(!html.includes('<div class="metrics">'), 'Should not contain metrics container');
  assert.ok(!html.includes('Matched reqs'), 'Should not contain Matched reqs metric');
  assert.ok(!html.includes('Core Skills'), 'Should not contain Core Skills section');
  assert.ok(!html.includes('JetBrains Mono'), 'Should not use JetBrains Mono font');
}

function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    let reqBody = body;
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };
    if (activeToken) {
      headers['Authorization'] = `Bearer ${activeToken}`;
    }

    if (body && typeof body === 'object') {
      reqBody = JSON.stringify(body);
    }
    if (reqBody) {
      headers['Content-Length'] = Buffer.byteLength(reqBody);
    }

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let parsed = data;
        if (res.headers['content-type']?.includes('application/json')) {
          try {
            parsed = JSON.parse(data);
          } catch {}
        }
        if (parsed && parsed.token) {
          activeToken = parsed.token;
        }
        if (parsedUrl.pathname === '/api/vault/lock') {
          activeToken = null;
        }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
      });
    });

    req.on('error', reject);
    if (reqBody) {
      req.write(reqBody);
    }
    req.end();
  });
}

function createFakeLlmServer() {
  let handler = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: JSON.stringify({
            html: '<html><body><h1>Jane Doe Tailored</h1></body></html>',
            evidenceMap: { 'React': ['claim-1'] },
            unsupported: []
          })
        }
      }],
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 }
    }));
  };
  const server = http.createServer((req, res) => handler(req, res));
  return {
    listen() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          resolve(`http://127.0.0.1:${addr.port}`);
        });
      });
    },
    setHandler(fn) {
      handler = fn;
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

test('LLM Provider & Resume Tailoring HTTP Endpoints & AppService Integration', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-app-test-'));
  const fakeLlm = createFakeLlmServer();
  const fakeLlmUrl = await fakeLlm.listen();

  let server;
  let baseUrl;

  try {
    server = await startServer(0, { dataDir: tmpDir, vaultPassword: 'test-vault-secret' });
    const address = server.address();
    const actualPort = typeof address === 'object' ? address.port : 0;
    baseUrl = `http://127.0.0.1:${actualPort}`;

    // 1. Bootstrap vault & profile
    const bootstrapRes = await request(`${baseUrl}/api/profile/bootstrap`, { method: 'POST' }, {
      password: 'test-vault-secret',
      resumeText: 'Jane Doe\njane@example.com\nSkills\nReact, TypeScript, Node.js\nProjects\nKubernetes Deploy Bot\nBuilt a Kubernetes deployment automation bot for release checks.'
    });
    assert.equal(bootstrapRes.statusCode, 200);
    assert.equal(bootstrapRes.body.success, true);

    // 1.5. Validate that invalid models and kinds are rejected with HTTP 400
    const invalidModelRes = await request(`${baseUrl}/api/settings/llm/providers`, { method: 'POST' }, {
      provider: {
        id: 'test-invalid-model',
        name: 'Invalid Model Provider',
        kind: 'openai-compatible',
        model: 'gpt-5.6',
        baseUrl: fakeLlmUrl,
        isActive: true
      },
      apiKey: 'sk-secret-key-12345'
    });
    assert.equal(invalidModelRes.statusCode, 400);
    assert.equal(invalidModelRes.body.success, false);
    assert.match(invalidModelRes.body.error, /Invalid model/);

    const invalidKindRes = await request(`${baseUrl}/api/settings/llm/providers`, { method: 'POST' }, {
      provider: {
        id: 'test-invalid-kind',
        name: 'Invalid Kind Provider',
        kind: 'invalid-kind',
        model: 'gpt-4o-mini',
        baseUrl: fakeLlmUrl,
        isActive: true
      },
      apiKey: 'sk-secret-key-12345'
    });
    assert.equal(invalidKindRes.statusCode, 400);
    assert.equal(invalidKindRes.body.success, false);
    assert.match(invalidKindRes.body.error, /Invalid provider kind/);

    // Verify that newer OpenAI-compatible models (gpt-5.4-mini, gpt-5.4, gpt-5.5) are accepted
    const gpt54Res = await request(`${baseUrl}/api/settings/llm/providers`, { method: 'POST' }, {
      provider: {
        id: 'test-gpt54-model',
        name: 'GPT 5.4 Provider',
        kind: 'openai-compatible',
        model: 'gpt-5.4',
        baseUrl: fakeLlmUrl,
        isActive: true
      },
      apiKey: 'sk-secret-key-12345'
    });
    assert.equal(gpt54Res.statusCode, 200);
    assert.equal(gpt54Res.body.success, true);


    const gpt54MiniRes = await request(`${baseUrl}/api/settings/llm/providers`, { method: 'POST' }, {
      provider: {
        id: 'test-gpt54-mini-model',
        name: 'GPT 5.4 Mini Provider',
        kind: 'openai-compatible',
        model: 'gpt-5.4-mini',
        baseUrl: fakeLlmUrl,
        isActive: true
      },
      apiKey: 'sk-secret-key-12345'
    });
    assert.equal(gpt54MiniRes.statusCode, 200);
    assert.equal(gpt54MiniRes.body.success, true);
    const gpt55Res = await request(`${baseUrl}/api/settings/llm/providers`, { method: 'POST' }, {
      provider: {
        id: 'test-gpt55-model',
        name: 'GPT 5.5 Provider',
        kind: 'openai-compatible',
        model: 'gpt-5.5',
        baseUrl: fakeLlmUrl,
        isActive: true
      },
      apiKey: 'sk-secret-key-12345'
    });
    assert.equal(gpt55Res.statusCode, 200);
    assert.equal(gpt55Res.body.success, true);

    // Clean up temporary validated models to not interfere with subsequent tests expecting 0 providers
    const appService = getAppService();
    assert.ok(appService);
    appService.state.llmProviders = [];
    appService.state.llmSecrets = {};
    await appService.saveVault();

    // Ensure they were not persisted
    const initialListRes = await request(`${baseUrl}/api/settings/llm/providers`, { method: 'GET' });
    assert.equal(initialListRes.statusCode, 200);
    assert.equal(initialListRes.body.success, true);
    assert.equal(initialListRes.body.providers.length, 0);

    // 2. Save LLM Provider via POST /api/settings/llm/providers
    const saveRes = await request(`${baseUrl}/api/settings/llm/providers`, { method: 'POST' }, {
      provider: {
        id: 'test-deepseek',
        name: 'Test DeepSeek',
        kind: 'deepseek',
        model: 'deepseek-chat',
        baseUrl: fakeLlmUrl,
        isActive: true
      },
      apiKey: 'sk-secret-key-12345'
    });
    assert.equal(saveRes.statusCode, 200);
    assert.equal(saveRes.body.success, true);
    assert.equal(saveRes.body.provider.id, 'test-deepseek');
    assert.equal(saveRes.body.provider.hasApiKey, true);
    assert.equal(saveRes.body.provider.apiKey, undefined, 'API key must NEVER be returned in response');

    // 3. GET /api/settings/llm/providers & GET /api/state verify key hiding
    const listRes = await request(`${baseUrl}/api/settings/llm/providers`, { method: 'GET' });
    assert.equal(listRes.statusCode, 200);
    assert.equal(listRes.body.success, true);
    assert.equal(listRes.body.providers.length, 1);
    assert.equal(listRes.body.providers[0].hasApiKey, true);
    assert.equal(listRes.body.providers[0].apiKey, undefined);

    const stateRes = await request(`${baseUrl}/api/state`, { method: 'GET' });
    assert.equal(stateRes.statusCode, 200);
    assert.equal(stateRes.body.llmProviders.length, 1);
    assert.equal(stateRes.body.llmProviders[0].hasApiKey, true);
    assert.equal(stateRes.body.llmProviders[0].apiKey, undefined);

    // 4. Test connection via POST /api/settings/llm/test
    const testRes = await request(`${baseUrl}/api/settings/llm/test`, { method: 'POST' }, {
      providerId: 'test-deepseek'
    });
    assert.equal(testRes.statusCode, 200);
    assert.equal(testRes.body.success, true);
    assert.ok(testRes.body.usage);

    // 5. Create application & test resume tailoring via POST /api/applications/tailor-resume
    const createAppRes = await request(`${baseUrl}/api/applications`, { method: 'POST' }, {
      url: 'https://tenant.myworkdayjobs.com/en-US/careers/job/123',
      jobDetails: {
        company: 'Acme Corp',
        title: 'Senior Frontend Engineer',
        requirements: ['React', 'TypeScript']
      }
    });
    assert.equal(createAppRes.statusCode, 200);
    const appId = createAppRes.body.application.id;

    const tailorRes = await request(`${baseUrl}/api/applications/tailor-resume`, { method: 'POST' }, {
      appId
    });
    assert.equal(tailorRes.statusCode, 200);
    assert.equal(tailorRes.body.success, true);
    assertJobHuntStyleRender(tailorRes.body.result.html, 'Jane Doe', 'Kubernetes Deploy Bot');
    assert.equal(tailorRes.body.result.record.type, 'resume_tailoring');
    assert.equal(tailorRes.body.result.record.status, 'completed');

  } finally {
    await stopServer();
    await fakeLlm.close();
  }
});
