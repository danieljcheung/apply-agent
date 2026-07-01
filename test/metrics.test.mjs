import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

import { generatePrometheusMetrics, generatePrometheusMetricsFromSnapshot, sanitizeLabelValue } from '../dist/src/metrics.js';
import { startServer, stopServer } from '../dist/server.js';
import { DatabaseService } from '../dist/src/db.js';
function request(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET'
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

test('Metrics - sanitizeLabelValue unit tests', (t) => {
  assert.equal(sanitizeLabelValue('submitted'), 'submitted');
  assert.equal(sanitizeLabelValue('SAFETY_GATE_BLOCKED'), 'SAFETY_GATE_BLOCKED');
  assert.equal(sanitizeLabelValue('user@example.com'), 'redacted');
  assert.equal(sanitizeLabelValue('https://company.workday.com/job/123'), 'redacted');
  assert.equal(sanitizeLabelValue('My Freeform Message'), 'redacted');
  assert.equal(sanitizeLabelValue('secret_token_123'), 'redacted');
  assert.equal(sanitizeLabelValue('my_passwd_field'), 'redacted');
  assert.equal(sanitizeLabelValue('rsa_private_key'), 'redacted');
  assert.equal(sanitizeLabelValue('oauth_access_token'), 'redacted');
  assert.equal(sanitizeLabelValue('authorization_header'), 'redacted');
  assert.equal(sanitizeLabelValue(null), 'unknown');
  assert.equal(sanitizeLabelValue(undefined), 'unknown');
});

test('Metrics - generatePrometheusMetrics format and aggregation', (t) => {
  const sampleApps = [
    {
      id: 'app-1',
      url: 'https://example.com/job/1',
      company: 'Acme Corp',
      title: 'Engineer',
      status: 'submitted',
      events: [
        { timestamp: '2026-06-29T10:00:00Z', type: 'CREATED', message: 'Created' },
        { timestamp: '2026-06-29T10:01:00Z', type: 'EXEC_STEP_SUCCESS', message: 'Step 1' },
        { timestamp: '2026-06-29T10:01:30Z', type: 'CAPTCHA_SOLVER_SUCCESS', message: 'Captcha solver succeeded during fill using configured_llm for text_prompt.' }
      ],
      blockers: [],
      llmActions: [
        { id: 'llm-1', type: 'resume_tailoring', status: 'completed', createdAt: '2026-06-29T10:00:30Z' }
      ],
      createdAt: '2026-06-29T10:00:00Z',
      updatedAt: '2026-06-29T10:01:00Z'
    },
    {
      id: 'app-2',
      url: 'https://example.com/job/2',
      company: 'Beta Inc',
      title: 'Developer',
      status: 'blocked',
      events: [
        { timestamp: '2026-06-29T10:05:00Z', type: 'CREATED', message: 'Created' },
        { timestamp: '2026-06-29T10:06:00Z', type: 'EXEC_STEP_BLOCKED', message: 'Blocked' }
      ],
      blockers: [
        { code: 'captcha_required', message: 'Captcha required on page', severity: 'fatal' },
        { code: 'secret_leak_attempt@domain.com', message: 'Unsafe code', severity: 'info' }
      ],
      llmActions: [
        { id: 'llm-2', type: 'browser_action', status: 'failed', createdAt: '2026-06-29T10:05:30Z' }
      ],
      createdAt: '2026-06-29T10:05:00Z',
      updatedAt: '2026-06-29T10:06:00Z'
    }
  ];

  const output = generatePrometheusMetrics(sampleApps);

  assert.ok(output.includes('# HELP apply_agent_applications_total'));
  assert.ok(output.includes('# TYPE apply_agent_applications_total gauge'));
  assert.ok(output.includes('apply_agent_applications_total{status="submitted"} 1'));
  assert.ok(output.includes('apply_agent_applications_total{status="blocked"} 1'));

  assert.ok(output.includes('# HELP apply_agent_run_events_total'));
  assert.ok(output.includes('# TYPE apply_agent_run_events_total counter'));
  assert.ok(output.includes('apply_agent_run_events_total{event_type="CREATED"} 2'));
  assert.ok(output.includes('apply_agent_run_events_total{event_type="EXEC_STEP_SUCCESS"} 1'));
  assert.ok(output.includes('apply_agent_run_events_total{event_type="CAPTCHA_SOLVER_SUCCESS"} 1'));

  assert.ok(output.includes('# HELP apply_agent_safety_blockers_total'));
  assert.ok(output.includes('apply_agent_safety_blockers_total{code="captcha_required",severity="fatal"} 1'));
  assert.ok(output.includes('apply_agent_safety_blockers_total{code="redacted",severity="info"} 1'));

  assert.ok(output.includes('# HELP apply_agent_browser_runs_total'));
  assert.ok(output.includes('apply_agent_browser_runs_total{status="success"} 1'));
  assert.ok(output.includes('apply_agent_browser_runs_total{status="failed"} 1'));

  assert.ok(output.includes('# HELP apply_agent_llm_actions_total'));
  assert.ok(output.includes('apply_agent_llm_actions_total{action_type="resume_tailoring",status="completed"} 1'));
});

test('HTTP Server GET /metrics integration', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'metrics-server-test-'));
  let server;
  try {
    server = await startServer(0, { dataDir: tmpDir, vaultPassword: 'metrics-test-password' });
    const address = server.address();
    const actualPort = typeof address === 'object' ? address.port : 0;
    const url = `http://127.0.0.1:${actualPort}/metrics`;

    const res = await request(url);
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/plain'));
    assert.ok(res.body.includes('apply_agent_applications_total'));
    assert.ok(res.body.includes('apply_agent_run_events_total'));
    assert.ok(res.body.includes('apply_agent_safety_blockers_total'));

    // Create a vault, lock with the issued session token, and verify GET /metrics still succeeds without transient DB pool creation
    const createRes = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ password: 'metrics-test-password' });
      const req = http.request(
        `http://127.0.0.1:${actualPort}/api/vault/create`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          }
        },
        (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    assert.equal(createRes.statusCode, 200);
    const createData = JSON.parse(createRes.body);
    assert.ok(createData.token);
    const lockRes = await new Promise((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${actualPort}/api/vault/lock`,
        { method: 'POST', headers: { Authorization: `Bearer ${createData.token}` } },
        (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        }
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(lockRes.statusCode, 200);

    const lockedMetricsRes = await request(url);
    assert.equal(lockedMetricsRes.statusCode, 200);
    assert.ok(lockedMetricsRes.body.includes('apply_agent_applications_total'));
  } finally {
    await stopServer();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
test('Metrics - DatabaseService DB aggregate path metrics', async (t) => {
  const executedQueries = [];

  const mockExecutor = async (text, params = []) => {
    const trimmed = text.trim().replace(/\s+/g, ' ');
    executedQueries.push(trimmed);

    if (trimmed.includes('CREATE TABLE') || trimmed.includes('CREATE INDEX')) {
      return { rows: [] };
    }

    if (trimmed.includes('FROM applications GROUP BY status')) {
      return {
        rows: [
          { status: 'submitted', count: '5' },
          { status: 'failed', count: '2' }
        ]
      };
    }

    if (trimmed.includes('FROM run_events GROUP BY event_type')) {
      return {
        rows: [
          { event_type: 'CREATED', count: '10' },
          { event_type: 'EXEC_STEP_SUCCESS', count: '3' }
        ]
      };
    }

    if (trimmed.includes('metadata->\'blockers\'')) {
      return {
        rows: [
          { code: 'captcha_required', severity: 'fatal', count: '1' }
        ]
      };
    }

    if (trimmed.includes('metadata->\'llmActions\'')) {
      return {
        rows: [
          { type: 'resume_tailoring', status: 'completed', count: '4' }
        ]
      };
    }

    return { rows: [] };
  };

  const db = new DatabaseService({ mockExecutor });
  const snapshot = await db.getMetricsSnapshot();

  // Assert no full scan of applications was performed
  const hasFullScan = executedQueries.some(q => q.includes('SELECT *') || (q.includes('SELECT') && !q.includes('COUNT') && q.includes('FROM applications') && !q.includes('GROUP BY') && !q.includes('LATERAL')));
  assert.equal(hasFullScan, false, 'Should not perform full applications scan');

  // Verify the snapshot counts
  assert.equal(snapshot.appStatusCounts.submitted, 5);
  assert.equal(snapshot.appStatusCounts.failed, 2);
  assert.equal(snapshot.runEventCounts.CREATED, 10);
  assert.equal(snapshot.runEventCounts.EXEC_STEP_SUCCESS, 3);
  assert.equal(snapshot.blockerCounts['captcha_required|fatal'], 1);
  assert.equal(snapshot.llmActionCounts['resume_tailoring|completed'], 4);

  // Generate prometheus output
  const output = generatePrometheusMetricsFromSnapshot(snapshot);

  // Verify metric names and values
  assert.ok(output.includes('# HELP apply_agent_applications_total'));
  assert.ok(output.includes('apply_agent_applications_total{status="submitted"} 5'));
  assert.ok(output.includes('apply_agent_applications_total{status="failed"} 2'));
  assert.ok(output.includes('apply_agent_run_events_total{event_type="CREATED"} 10'));
  assert.ok(output.includes('apply_agent_run_events_total{event_type="EXEC_STEP_SUCCESS"} 3'));
  assert.ok(output.includes('apply_agent_safety_blockers_total{code="captcha_required",severity="fatal"} 1'));
  assert.ok(output.includes('apply_agent_llm_actions_total{action_type="resume_tailoring",status="completed"} 4'));
});

