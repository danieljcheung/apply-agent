import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { LLMProvider } from '../dist/src/llm/index.js';
import { LlmCaptchaSolver } from '../dist/src/browser/llmCaptchaSolver.js';

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
          choices: [{ message: { role: 'assistant', content: '{"answer":"Default"}' } }],
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

test('1. LLM Captcha Solver - Text Prompt Success', async () => {
  const fakeServer = createFakeLlmServer();
  const baseUrl = await fakeServer.listen();

  fakeServer.setResponseHandler((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '{"answer":"7GQ2"}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }));
  });

  try {
    const provider = new LLMProvider({
      id: 'test-llm',
      name: 'Test LLM',
      kind: 'openai-compatible',
      model: 'gpt-4o',
      baseUrl,
      apiKey: 'api-key-sentinel-123456'
    });

    const solver = new LlmCaptchaSolver(provider);

    const challenge = {
      kind: 'text_prompt',
      pageUrl: 'https://example.com/workday',
      promptText: '  Please enter characters from the image   \n ',
      inputSelector: '#captcha-input'
    };

    const result = await solver.solve(challenge);

    // Verify solver result
    assert.deepEqual(result, {
      success: true,
      provider: 'configured_llm',
      kind: 'text_prompt',
      status: 'solved',
      answer: '7GQ2',
      model: 'gpt-4o',
      elapsedMs: result.elapsedMs,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    });

    assert.ok(typeof result.elapsedMs === 'number');

    // Verify request payload was correct
    assert.equal(fakeServer.requestLog.length, 1);
    const request = fakeServer.requestLog[0];
    assert.equal(request.method, 'POST');
    assert.deepEqual(request.body.response_format, { type: 'json_object' });
    assert.equal(request.body.temperature, 1);
    assert.equal(request.body.max_tokens, 64);
    assert.equal(request.body.messages.length, 2);
    assert.equal(request.body.messages[0].role, 'system');
    assert.ok(request.body.messages[0].content.includes('You solve only site-owner-authorized job-application CAPTCHA prompts'));
    assert.equal(request.body.messages[1].role, 'user');
    assert.equal(request.body.messages[1].content, 'Challenge text:\nPlease enter characters from the image');
  } finally {
    await fakeServer.close();
  }
});

test('2. LLM Captcha Solver - Image Prompt Success', async () => {
  const fakeServer = createFakeLlmServer();
  const baseUrl = await fakeServer.listen();

  fakeServer.setResponseHandler((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '{"answer":"42"}' } }]
    }));
  });

  try {
    const provider = new LLMProvider({
      id: 'test-llm-image',
      name: 'Test LLM Image',
      kind: 'openai-compatible',
      model: 'gpt-4o',
      baseUrl,
      apiKey: 'api-key-sentinel-123456'
    });

    const solver = new LlmCaptchaSolver(provider);

    const challenge = {
      kind: 'image_prompt',
      pageUrl: 'https://example.com/workday',
      promptText: 'What is the sum?',
      inputSelector: '#captcha-input',
      imageDataUrl: 'data:image/png;base64,iVBORw0KGgo='
    };

    const result = await solver.solve(challenge);

    assert.equal(result.success, true);
    assert.equal(result.status, 'solved');
    assert.equal(result.answer, '42');

    assert.equal(fakeServer.requestLog.length, 1);
    const request = fakeServer.requestLog[0];
    assert.equal(request.body.messages.length, 2);
    assert.equal(request.body.messages[1].role, 'user');
    assert.deepEqual(request.body.messages[1].content, [
      { type: 'text', text: 'What is the sum?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }
    ]);
  } finally {
    await fakeServer.close();
  }
});

test('3. LLM Captcha Solver - Error Cases (Invalid JSON, Empty, Overlong, HTTP 400)', async () => {
  const fakeServer = createFakeLlmServer();
  const baseUrl = await fakeServer.listen();
  const apiKeySentinel = 'api-key-sentinel-123456';

  try {
    const provider = new LLMProvider({
      id: 'test-llm-errors',
      name: 'Test LLM Errors',
      kind: 'openai-compatible',
      model: 'gpt-4o',
      baseUrl,
      apiKey: apiKeySentinel
    });
    const solver = new LlmCaptchaSolver(provider);

    const challenge = {
      kind: 'text_prompt',
      pageUrl: 'https://example.com/workday',
      promptText: 'Please enter details',
      inputSelector: '#captcha-input'
    };

    // Case A: Invalid JSON response
    fakeServer.setResponseHandler((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'invalid-json{answer:' } }]
      }));
    });

    const resultInvalidJson = await solver.solve(challenge);
    assert.equal(resultInvalidJson.success, false);
    assert.equal(resultInvalidJson.status, 'failed');
    assert.ok(resultInvalidJson.error);
    assert.ok(!resultInvalidJson.error.includes(apiKeySentinel), 'Error leaks API key sentinel');

    // Case B: Empty answer response
    fakeServer.setResponseHandler((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '{"answer": "   "}' } }]
      }));
    });

    const resultEmpty = await solver.solve(challenge);
    assert.equal(resultEmpty.success, false);
    assert.equal(resultEmpty.status, 'failed');
    assert.ok(resultEmpty.error);
    assert.ok(resultEmpty.error.includes('empty') || resultEmpty.error.includes('Answer is empty'), `Error message: ${resultEmpty.error}`);
    assert.ok(!resultEmpty.error.includes(apiKeySentinel), 'Error leaks API key sentinel');

    // Case C: Overlong answer response
    const longAnswer = 'a'.repeat(129);
    fakeServer.setResponseHandler((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify({ answer: longAnswer }) } }]
      }));
    });

    const resultOverlong = await solver.solve(challenge);
    assert.equal(resultOverlong.success, false);
    assert.equal(resultOverlong.status, 'failed');
    assert.ok(resultOverlong.error);
    assert.ok(resultOverlong.error.includes('exceeds') || resultOverlong.error.includes('length') || resultOverlong.error.includes('maximum'), `Error message: ${resultOverlong.error}`);
    assert.ok(!resultOverlong.error.includes(apiKeySentinel), 'Error leaks API key sentinel');

    // Case D: HTTP 400 error from provider containing apiKeySentinel
    fakeServer.setResponseHandler((req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: `Bad request using API key: ${apiKeySentinel}`
        }
      }));
    });

    const resultHttpError = await solver.solve(challenge);
    assert.equal(resultHttpError.success, false);
    assert.equal(resultHttpError.status, 'failed');
    assert.ok(resultHttpError.error);
    assert.ok(!resultHttpError.error.includes(apiKeySentinel), `Error leaked API key: ${resultHttpError.error}`);
    assert.ok(resultHttpError.error.includes('[REDACTED]'), `Error not redacted: ${resultHttpError.error}`);
  } finally {
    await fakeServer.close();
  }
});