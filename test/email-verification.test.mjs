import test from 'node:test';
import assert from 'node:assert/strict';
import { AutomationExecutor } from '../dist/src/automation.js';
import { ProtonBridgeConnector } from '../dist/src/protonBridge.js';
import { WorkdayPlanner } from '../dist/src/workday.js';
process.env.TEST_MODE = 'true';


// Setup common helpers/objects
const planner = new WorkdayPlanner();
const executor = new AutomationExecutor();

const plan = planner.plan('https://acme.myworkdayjobs.com/job/1');

const createMockApp = () => ({
  id: 'test-app-id',
  url: 'https://acme.myworkdayjobs.com/job/1',
  company: 'Acme',
  title: 'Engineer',
  status: 'verifying_email',
  unresolvedChecks: { emailVerification: true },
  events: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
});

const automationDefaults = {
  credentials: null, // Tenant account creation: no pre-entered Workday credentials required
  profile: {
    candidateProfile: {
      name: 'Test User',
      email: 'test@example.com',
      phone: '555-0100',
      skills: ['TypeScript'],
      experience: [],
      education: []
    },
    claimBank: [],
    answerMemory: {}
  }
};

test('1. Email Verification - simulateSuccess success flow', async (t) => {
  const app = createMockApp();
  const options = {
    ...automationDefaults,
    protonConfig: {
      host: '127.0.0.1',
      port: 1143,
      username: 'test@example.com',
      password: 'password',
      simulateSuccess: true
    },
    testMode: true
  };

  const result = await executor.execute(plan, app, options);
  assert.equal(result.state, 'submitted');
  const emailStep = result.steps.find(s => s.id === 'email_verification');
  assert.ok(emailStep, 'email_verification step should exist');
  assert.equal(emailStep.status, 'success');
  assert.ok(result.events.some(e => e.type === 'EXEC_STEP_SUCCESS' && e.message.includes('Verified via Proton Bridge')));
});

test('2. Email Verification - missing protonConfig blocked', async (t) => {
  const app = createMockApp();
  const options = {
    ...automationDefaults,
    protonConfig: null,
    testMode: true
  };

  const result = await executor.execute(plan, app, options);
  assert.equal(result.state, 'blocked');
  assert.equal(result.reason, 'email_verification_required');
  const emailStep = result.steps.find(s => s.id === 'email_verification');
  assert.equal(emailStep.status, 'blocked');
  assert.ok(result.events.some(e => e.type === 'EXEC_STEP_BLOCKED' && e.message.includes('Proton Bridge configuration is missing')));
});

test('3. Email Verification - invalid protonConfig blocked', async (t) => {
  const app = createMockApp();
  const options = {
    ...automationDefaults,
    protonConfig: { host: '127.0.0.1' }, // Missing username, password, port
    testMode: true
  };

  const result = await executor.execute(plan, app, options);
  assert.equal(result.state, 'blocked');
  assert.equal(result.reason, 'email_verification_required');
  const emailStep = result.steps.find(s => s.id === 'email_verification');
  assert.equal(emailStep.status, 'blocked');
  assert.ok(result.events.some(e => e.type === 'EXEC_STEP_BLOCKED' && e.message.includes('Proton Bridge configuration is invalid')));
});

test('4. Email Verification - connection failure blocked without password leaks', async (t) => {
  const app = createMockApp();
  const secretPassword = 'SuperSecretProtonPassword123!';
  const options = {
    ...automationDefaults,
    protonConfig: {
      host: '127.0.0.1',
      port: 9999, // Unreachable port
      username: 'test-failure@example.com',
      password: secretPassword
    },
    testMode: true
  };

  const result = await executor.execute(plan, app, options);
  assert.equal(result.state, 'blocked');
  assert.equal(result.reason, 'email_verification_required');
  
  const emailStep = result.steps.find(s => s.id === 'email_verification');
  assert.equal(emailStep.status, 'blocked');
  
  // Verify no password leak in events or logs
  const eventsStr = JSON.stringify(result.events);
  assert.equal(eventsStr.includes(secretPassword), false, 'Secret password must not be leaked in events');
  assert.equal(JSON.stringify(result.reason || '').includes(secretPassword), false, 'Secret password must not be leaked in reason');
  
});

test('5. Email Verification - empty search results (no mail)', async (t) => {
  const app = createMockApp();
  const options = {
    ...automationDefaults,
    protonConfig: {
      host: '127.0.0.1',
      port: 1143,
      username: 'test@example.com',
      password: 'password',
      simulateSuccess: true
    },
    testMode: true
  };

  const originalSearch = ProtonBridgeConnector.prototype.search;
  try {
    ProtonBridgeConnector.prototype.search = async function(query) {
      return {
        success: true,
        emails: []
      };
    };

    const result = await executor.execute(plan, app, options);
    assert.equal(result.state, 'blocked');
    assert.equal(result.reason, 'email_verification_required');
    const emailStep = result.steps.find(s => s.id === 'email_verification');
    assert.equal(emailStep.status, 'blocked');
    assert.ok(result.events.some(e => e.type === 'EXEC_STEP_BLOCKED' && e.message.includes('No parseable verification code')));
  } finally {
    ProtonBridgeConnector.prototype.search = originalSearch;
  }
});

test('6. Email Verification - non-matching emails (unparseable body)', async (t) => {
  const app = createMockApp();
  const options = {
    ...automationDefaults,
    protonConfig: {
      host: '127.0.0.1',
      port: 1143,
      username: 'test@example.com',
      password: 'password',
      simulateSuccess: true
    },
    testMode: true
  };

  const originalSearch = ProtonBridgeConnector.prototype.search;
  try {
    ProtonBridgeConnector.prototype.search = async function(query) {
      return {
        success: true,
        emails: [
          { id: 10, subject: 'Newsletter', body: 'This is a newsletter. No verification code here.', from: 'newsletter@example.com' }
        ]
      };
    };

    const result = await executor.execute(plan, app, options);
    assert.equal(result.state, 'blocked');
    assert.equal(result.reason, 'email_verification_required');
    const emailStep = result.steps.find(s => s.id === 'email_verification');
    assert.equal(emailStep.status, 'blocked');
    assert.ok(result.events.some(e => e.type === 'EXEC_STEP_BLOCKED' && e.message.includes('No parseable verification code')));
  } finally {
    ProtonBridgeConnector.prototype.search = originalSearch;
  }
});
test('7. Email Verification - adapter.inspect returns email_verification_required, continues into Proton verification', async (t) => {
  const app = {
    ...createMockApp(),
    status: 'inspecting',
    unresolvedChecks: {}
  };
  const options = {
    ...automationDefaults,
    credentials: null, // Proving no stored Workday credentials required
    adapter: {
      runtime: 'playwright',
      async inspect() {
        return {
          success: false,
          state: 'blocked',
          blocker: 'email_verification_required',
          message: 'Blocked by safety policies: email_verification_required'
        };
      }
    },
    protonConfig: {
      host: '127.0.0.1',
      port: 1143,
      username: 'test@example.com',
      password: 'password',
      simulateSuccess: true
    },
    testMode: true
  };

  const result = await executor.execute(plan, app, options);
  const loginStep = result.steps.find(s => s.id === 'navigate_login');
  assert.ok(loginStep, 'navigate_login step should exist');
  assert.equal(loginStep.status, 'success', 'Login step should succeed and not fail generically when email verification required');

  const emailStep = result.steps.find(s => s.id === 'email_verification');
  assert.ok(emailStep, 'email_verification step should exist');
  assert.equal(emailStep.status, 'success', 'Email verification step should succeed via Proton Bridge');
  assert.ok(result.events.some(e => e.type === 'EXEC_STEP_SUCCESS' && e.message.includes('Verified via Proton Bridge')));
});

test('8. Email Verification - adapter.inspect returns email_verification_required, blocks at email step with clear reason if protonConfig missing', async (t) => {
  const app = {
    ...createMockApp(),
    status: 'inspecting',
    unresolvedChecks: {}
  };
  const options = {
    ...automationDefaults,
    credentials: null,
    adapter: {
      runtime: 'playwright',
      async inspect() {
        return {
          success: false,
          state: 'blocked',
          blocker: 'email_verification_required',
          message: 'Blocked by safety policies: email_verification_required'
        };
      }
    },
    protonConfig: null,
    testMode: true
  };

  const result = await executor.execute(plan, app, options);
  const loginStep = result.steps.find(s => s.id === 'navigate_login');
  assert.equal(loginStep.status, 'success', 'Login step should succeed and hand off to email verification');

  const emailStep = result.steps.find(s => s.id === 'email_verification');
  assert.equal(emailStep.status, 'blocked', 'Email step should be blocked');
  assert.equal(result.reason, 'email_verification_required', 'Result reason should clearly state email_verification_required');
});

test('9. Email Verification - adapter.inspect returns two_factor_required, keeps login step blocked', async (t) => {
  const app = {
    ...createMockApp(),
    status: 'inspecting',
    unresolvedChecks: {}
  };
  const options = {
    ...automationDefaults,
    credentials: null,
    adapter: {
      runtime: 'playwright',
      async inspect() {
        return {
          success: false,
          state: 'blocked',
          blocker: 'two_factor_required',
          message: 'Blocked by safety policies: two_factor_required'
        };
      }
    },
    testMode: true
  };

  const result = await executor.execute(plan, app, options);
  const loginStep = result.steps.find(s => s.id === 'navigate_login');
  assert.equal(loginStep.status, 'blocked', 'Login step should remain blocked for 2FA');
  assert.equal(result.reason, 'Blocked by safety policies: two_factor_required');
});
