import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  LLMProvider,
  OpenAICompatibleProvider,
  redactLLMSecrets,
  redactLlmSecret,
  redactProviderConfig,
  getLLMProviders,
  saveLLMProvider,
  tailorResumeWithLLM
} from '../dist/src/llm/index.js';

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

function createFakeLlmServer() {
  let requestLog = [];
  let responseHandler = null;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let jsonBody = null;
      try {
        jsonBody = body ? JSON.parse(body) : null;
      } catch {}
      
      requestLog.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: jsonBody,
        rawBody: body
      });

      if (responseHandler) {
        responseHandler(req, res, jsonBody);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Default fake response' } }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
        }));
      }
    });
  });

  return {
    server,
    requestLog,
    setResponseHandler(fn) { responseHandler = fn; },
    listen() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const port = server.address().port;
          resolve(`http://127.0.0.1:${port}`);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

test('1. Successful Fake OpenAI-Compatible Provider Response & Usage', async () => {
  const fakeServer = createFakeLlmServer();
  const baseUrl = await fakeServer.listen();

  fakeServer.setResponseHandler((req, res, body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'Hello from fake LLM!' } }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }
    }));
  });

  try {
    const ProviderClass = OpenAICompatibleProvider || LLMProvider;
    const provider = new ProviderClass({
      id: 'test-provider',
      name: 'Test Provider',
      kind: 'openai-compatible',
      model: 'test-model',
      baseUrl: baseUrl,
      apiKey: 'test-secret-key-12345'
    });

    const response = await provider.execute({
      messages: [{ role: 'user', content: 'Hi' }]
    });

    assert.equal(response.content, 'Hello from fake LLM!');
    assert.equal(response.usage?.promptTokens, 12);
    assert.equal(response.usage?.completionTokens, 8);
    assert.equal(response.usage?.totalTokens, 20);

    const testConn = await provider.testConnection();
    assert.equal(testConn.success, true);
    assert.equal(testConn.usage?.promptTokens, 12);

    assert.equal(fakeServer.requestLog.length, 2);
    assert.equal(fakeServer.requestLog[0].headers.authorization, 'Bearer test-secret-key-12345');
  } finally {
    await fakeServer.close();
  }
});

test('2. Failed Provider Call Redaction & No Key Leakage', async () => {
  const fakeServer = createFakeLlmServer();
  const baseUrl = await fakeServer.listen();
  const secretKey = 'super-secret-api-key-9999';

  fakeServer.setResponseHandler((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: `Internal Server Error with key ${secretKey} and Bearer ${secretKey}`
    }));
  });

  try {
    const provider = new LLMProvider({
      id: 'fail-provider',
      name: 'Fail Provider',
      kind: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: baseUrl,
      apiKey: secretKey
    });

    await assert.rejects(
      async () => {
        await provider.execute({ messages: [{ role: 'user', content: 'Test' }] });
      },
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(!err.message.includes(secretKey), `Error message leaked secret key: ${err.message}`);
        assert.ok(err.message.includes('[REDACTED]'), `Error message missing [REDACTED]: ${err.message}`);
        return true;
      }
    );

    const testConn = await provider.testConnection();
    assert.equal(testConn.success, false);
    assert.ok(testConn.error);
    assert.ok(!testConn.error.includes(secretKey), `testConnection error leaked key: ${testConn.error}`);
    assert.ok(testConn.error.includes('[REDACTED]'), `testConnection error missing [REDACTED]: ${testConn.error}`);
  } finally {
    await fakeServer.close();
  }
});

test('3. Direct Redactor Secret Sanitization', () => {
  const redactorFn = redactLlmSecret || redactLLMSecrets;
  const secret = 'sk-proj-1234567890abcdef';
  const text = `Failed request with Bearer ${secret} and api_key=${secret} in payload`;

  const sanitized = redactorFn(text, [secret]);
  assert.ok(!sanitized.includes(secret), `Sanitized text still contains secret: ${sanitized}`);
  assert.ok(sanitized.includes('[REDACTED]'));
});

test('4. Settings Key Hiding & Vault Registry Redaction', () => {
  const rawConfig = {
    id: 'prov-1',
    name: 'Kimi Provider',
    kind: 'kimi',
    model: 'moonshot-v1',
    apiKey: 'kimi-secret-token-abcdef'
  };

  const redacted = redactProviderConfig(rawConfig);
  assert.equal(redacted.apiKey, '********');
  assert.equal(redacted.id, 'prov-1');

  const emptyVault = {};
  const updatedVault = saveLLMProvider(emptyVault, rawConfig);
  const providers = getLLMProviders(updatedVault);
  assert.equal(providers.length, 1);
  assert.equal(providers[0].apiKey, undefined);
  assert.equal(updatedVault.llmProviders[0].apiKey, undefined);
  assert.equal(updatedVault.llmProviders[0].apiKeyRef, 'secret_prov-1');
  assert.equal(updatedVault.llmSecrets['secret_prov-1'], 'kimi-secret-token-abcdef');
});

test('5. Audited Resume Tailoring from Existing Claims', async () => {
  const fakeServer = createFakeLlmServer();
  const baseUrl = await fakeServer.listen();

  fakeServer.setResponseHandler((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: JSON.stringify({
            summary: 'Extensive experience in Node.js backend architecture and microservices.',
            evidenceMap: {
              'Node.js': ['exp_0_0'],
              'Kubernetes automation': ['project_0_0']
            },
            unsupported: []
          })
        }
      }],
      usage: { prompt_tokens: 150, completion_tokens: 45, total_tokens: 195 }
    }));
  });

  try {
    const provider = new LLMProvider({
      id: 'tailor-prov',
      name: 'Tailor Provider',
      kind: 'openai-compatible',
      model: 'gpt-4o',
      baseUrl: baseUrl,
      apiKey: 'tailor-secret-key'
    });

    const mockProfile = {
      candidateProfile: {
        name: 'Jane Doe',
        email: 'jane@example.com',
        phone: '555-0199',
        skills: ['Node.js', 'TypeScript'],
        experience: [{ title: 'Senior Software Engineer', company: 'Tech Corp', description: 'Led Node.js microservices migration handling 10M req/day.' }],
        education: [],
        projects: [{ id: 'project_0', name: 'Kubernetes Deploy Bot', description: 'Built a Kubernetes deployment automation bot for release checks.' }]
      },
      claimBank: [
        { id: 'exp_0_0', text: 'Led Node.js microservices migration handling 10M req/day.', category: 'experience', context: 'Senior Software Engineer' },
        { id: 'project_0_0', text: 'Built a Kubernetes deployment automation bot for release checks.', category: 'projects', context: 'Kubernetes Deploy Bot' }
      ],
      answerMemory: {}
    };

    const result = await tailorResumeWithLLM(provider, mockProfile, ['Node.js backend architecture', 'Kubernetes automation']);

    assertJobHuntStyleRender(result.html, 'Jane Doe', 'Kubernetes Deploy Bot');
    assert.ok(result.record);
    assert.equal(result.record.type, 'resume_tailoring');
    assert.equal(result.record.status, 'completed');
    assert.equal(result.record.audit?.promptTokens, 150);
    assert.equal(result.record.audit?.completionTokens, 45);
    assert.equal(result.record.audit?.model, 'gpt-4o');

    assert.ok(result.record.outputPayload);
    assert.ok(result.record.outputPayload.htmlHash);
    assert.ok(!result.record.outputPayload.html);
    assert.ok(!result.record.outputPayload.rawHtml);
  } finally {
    await fakeServer.close();
  }
});

test('6. OpenAI-Compatible Provider Model max_completion_tokens Regression Coverage', async () => {
  const fakeServer = createFakeLlmServer();
  const baseUrl = await fakeServer.listen();

  fakeServer.setResponseHandler((req, res, body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'Regression test response' } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
    }));
  });

  try {
    // 1. OpenAI-compatible newer model (gpt-5.5) -> should send max_completion_tokens and omit max_tokens
    const gpt5Provider = new LLMProvider({
      id: 'gpt5-provider',
      name: 'GPT-5 Provider',
      kind: 'openai-compatible',
      model: 'gpt-5.5',
      baseUrl: baseUrl,
      apiKey: 'test-key'
    });

    await gpt5Provider.execute({
      messages: [{ role: 'user', content: 'Hello Newer' }],
      maxTokens: 150
    });

    const gpt5Req = fakeServer.requestLog[fakeServer.requestLog.length - 1];
    assert.ok(gpt5Req, 'Should have captured gpt-5.5 request');
    assert.equal(gpt5Req.body.max_completion_tokens, 150);
    assert.equal(gpt5Req.body.max_tokens, undefined);
    assert.ok(!('max_tokens' in gpt5Req.body), 'max_tokens should be omitted for gpt-5.5');
    assert.equal(gpt5Req.body.temperature, undefined);
    assert.ok(!('temperature' in gpt5Req.body), 'temperature should be omitted for gpt-5.5 because only default sampling is supported');

    // 2. OpenAI-compatible newer model (o4-mini) -> should send max_completion_tokens and omit max_tokens
    const oSeriesProvider = new LLMProvider({
      id: 'o-series-provider',
      name: 'O-Series Provider',
      kind: 'openai-compatible',
      model: 'o4-mini',
      baseUrl: baseUrl,
      apiKey: 'test-key'
    });

    await oSeriesProvider.execute({
      messages: [{ role: 'user', content: 'Hello O-Series' }],
      maxTokens: 250
    });

    const oSeriesReq = fakeServer.requestLog[fakeServer.requestLog.length - 1];
    assert.ok(oSeriesReq, 'Should have captured o-series request');
    assert.equal(oSeriesReq.body.max_completion_tokens, 250);
    assert.equal(oSeriesReq.body.max_tokens, undefined);
    assert.ok(!('max_tokens' in oSeriesReq.body), 'max_tokens should be omitted for o-series');

    // 3. OpenAI-compatible legacy model (gpt-4o) -> should send max_tokens and omit max_completion_tokens
    const legacyProvider = new LLMProvider({
      id: 'legacy-provider',
      name: 'Legacy Provider',
      kind: 'openai-compatible',
      model: 'gpt-4o',
      baseUrl: baseUrl,
      apiKey: 'test-key'
    });

    await legacyProvider.execute({
      messages: [{ role: 'user', content: 'Hello Legacy' }],
      maxTokens: 100
    });

    const legacyReq = fakeServer.requestLog[fakeServer.requestLog.length - 1];
    assert.ok(legacyReq, 'Should have captured legacy request');
    assert.equal(legacyReq.body.max_tokens, 100);
    assert.equal(legacyReq.body.max_completion_tokens, undefined);
    assert.ok(!('max_completion_tokens' in legacyReq.body), 'max_completion_tokens should be omitted for gpt-4o');
    assert.equal(legacyReq.body.temperature, 0.7);

    // 4. Non-OpenAI-compatible provider with brand matching model name (e.g. kind: 'deepseek', model: 'gpt-5') -> should send max_tokens and omit max_completion_tokens
    const deepseekGpt5Provider = new LLMProvider({
      id: 'ds-gpt5-provider',
      name: 'DeepSeek GPT-5 Provider',
      kind: 'deepseek',
      model: 'gpt-5',
      baseUrl: baseUrl,
      apiKey: 'test-key'
    });

    await deepseekGpt5Provider.execute({
      messages: [{ role: 'user', content: 'Hello DS' }],
      maxTokens: 300
    });

    const dsReq = fakeServer.requestLog[fakeServer.requestLog.length - 1];
    assert.ok(dsReq, 'Should have captured DeepSeek request');
    assert.equal(dsReq.body.max_tokens, 300);
    assert.equal(dsReq.body.max_completion_tokens, undefined);
    assert.ok(!('max_completion_tokens' in dsReq.body), 'max_completion_tokens should be omitted for non-OpenAI-compatible providers');

    // 5. Model with maxTokens undefined -> should omit both max_tokens and max_completion_tokens
    await legacyProvider.execute({
      messages: [{ role: 'user', content: 'Hello No Tokens' }]
    });

    const noTokensReq = fakeServer.requestLog[fakeServer.requestLog.length - 1];
    assert.ok(noTokensReq, 'Should have captured request without tokens');
    assert.equal(noTokensReq.body.max_tokens, undefined);
    assert.equal(noTokensReq.body.max_completion_tokens, undefined);
    assert.ok(!('max_tokens' in noTokensReq.body), 'max_tokens should be omitted when not provided');
    assert.ok(!('max_completion_tokens' in noTokensReq.body), 'max_completion_tokens should be omitted when not provided');

  } finally {
    await fakeServer.close();
  }
});

test('7. OpenAI-Compatible Provider max_tokens unsupported_parameter Retry Regression & Unrelated 400 Non-retry', async () => {
  const fakeServer = createFakeLlmServer();
  const baseUrl = await fakeServer.listen();

  let requestCount = 0;

  fakeServer.setResponseHandler((req, res, body) => {
    requestCount++;
    if (requestCount === 1) {
      // First request should fail with unsupported_parameter error if it uses max_tokens
      assert.equal(body.max_tokens, 150);
      assert.equal(body.max_completion_tokens, undefined);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          code: 'unsupported_parameter',
          message: 'The parameter max_tokens is not supported. Use max_completion_tokens instead.',
          param: 'max_tokens'
        }
      }));
    } else if (requestCount === 2) {
      // Second request should use max_completion_tokens instead of max_tokens
      assert.equal(body.max_completion_tokens, 150);
      assert.equal(body.max_tokens, undefined);
      assert.ok(!('max_tokens' in body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Success on retry' } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
      }));
    } else if (requestCount === 3) {
      // Third request (for the unrelated 400 test) fails with an unrelated error
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          code: 'invalid_request_error',
          message: 'Some other bad request error.',
          param: 'messages'
        }
      }));
    } else {
      res.writeHead(500);
      res.end('Unexpected request');
    }
  });

  try {
    const provider = new LLMProvider({
      id: 'retry-provider',
      name: 'Retry Provider',
      kind: 'openai-compatible',
      model: 'gpt-4o', // a legacy-looking model that defaults to max_tokens
      baseUrl: baseUrl,
      apiKey: 'test-key'
    });

    // 1. Verify successful retry on unsupported_parameter
    const response = await provider.execute({
      messages: [{ role: 'user', content: 'Retry test' }],
      maxTokens: 150
    });

    assert.equal(response.content, 'Success on retry');
    assert.equal(requestCount, 2);

    // 2. Verify unrelated HTTP 400 is NOT retried (should throw immediately)
    await assert.rejects(
      async () => {
        await provider.execute({
          messages: [{ role: 'user', content: 'Unrelated error test' }],
          maxTokens: 150
        });
      },
      (err) => {
        assert.ok(err.message.includes('HTTP error 400'));
        assert.ok(err.message.includes('invalid_request_error'));
        return true;
      }
    );

    // Verify that the unrelated error request did not retry (requestCount should be exactly 3)
    assert.equal(requestCount, 3);
  } finally {
    await fakeServer.close();
  }
});

test('8. OpenAI-Compatible Provider unsupported temperature Retry Regression', async () => {
  const fakeServer = createFakeLlmServer();
  const baseUrl = await fakeServer.listen();

  let requestCount = 0;

  fakeServer.setResponseHandler((req, res, body) => {
    requestCount++;
    if (requestCount === 1) {
      assert.equal(body.temperature, 0.7);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          code: 'unsupported_value',
          message: "Unsupported value: 'temperature' does not support 0.7 with this model. Only the default (1) value is supported.",
          param: 'temperature'
        }
      }));
    } else if (requestCount === 2) {
      assert.equal(body.temperature, undefined);
      assert.ok(!('temperature' in body), 'temperature should be omitted on retry');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Success without temperature' } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
      }));
    } else {
      res.writeHead(500);
      res.end('Unexpected retry');
    }
  });

  try {
    const provider = new LLMProvider({
      id: 'temperature-retry-provider',
      name: 'Temperature Retry Provider',
      kind: 'openai-compatible',
      model: 'gpt-4o',
      baseUrl,
      apiKey: 'test-key'
    });

    const response = await provider.execute({
      messages: [{ role: 'user', content: 'Retry temperature test' }]
    });

    assert.equal(response.content, 'Success without temperature');
    assert.equal(requestCount, 2);
  } finally {
    await fakeServer.close();
  }
});

test('9. OpenAI-Compatible Provider Multimodal Message Content Support', async () => {
  const fakeServer = createFakeLlmServer();
  const baseUrl = await fakeServer.listen();

  fakeServer.setResponseHandler((req, res, body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'Success parsing image' } }],
      usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 }
    }));
  });

  try {
    const provider = new LLMProvider({
      id: 'multimodal-provider',
      name: 'Multimodal Provider',
      kind: 'openai-compatible',
      model: 'gpt-4o',
      baseUrl,
      apiKey: 'test-key-multimodal'
    });

    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this image?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }
        ]
      }
    ];

    const response = await provider.execute({ messages });

    assert.equal(response.content, 'Success parsing image');
    assert.equal(fakeServer.requestLog.length, 1);
    const lastRequest = fakeServer.requestLog[0];
    assert.deepEqual(lastRequest.body.messages, messages);
  } finally {
    await fakeServer.close();
  }
});
