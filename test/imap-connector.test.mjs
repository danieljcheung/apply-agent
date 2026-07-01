import test from 'node:test';
import assert from 'node:assert/strict';
import { ProtonBridgeConnector } from '../dist/src/protonBridge.js';
process.env.TEST_MODE = 'true';


test('ProtonBridgeConnector - simulateSuccess behavior', async () => {
  const connector = new ProtonBridgeConnector({
    host: '127.0.0.1',
    port: 1143,
    username: 'testuser',
    password: 'secretpassword123',
    simulateSuccess: true
  });

  const connResult = await connector.connect();
  assert.equal(connResult.connected, true);

  const searchResult = await connector.search('Workday');
  assert.equal(searchResult.success, true);
  assert.ok(Array.isArray(searchResult.emails));
  assert.ok(searchResult.emails.length > 0);
  assert.ok(searchResult.emails.some(e => e.subject.includes('Workday')));
});

test('ProtonBridgeConnector - search fails gracefully when disconnected', async () => {
  const connector = new ProtonBridgeConnector({
    host: '127.0.0.1',
    port: 1143,
    username: 'testuser',
    password: 'secretpassword123'
  });

  const searchResult = await connector.search('test');
  assert.equal(searchResult.success, false);
  assert.equal(searchResult.blocker, 'BRIDGE_NOT_CONNECTED');
  assert.ok(searchResult.message.includes('not connected'));
});

test('ProtonBridgeConnector - non-simulated connect attempt & credential redaction', async () => {
  const secretPass = 'SuperSecretPass987!';
  const connector = new ProtonBridgeConnector({
    host: '127.0.0.1',
    port: 19999, // Unreachable port
    username: 'myuser@domain.local',
    password: secretPass
  });

  const connResult = await connector.connect();
  assert.equal(connResult.connected, false);
  assert.equal(connResult.blocker, 'BRIDGE_UNAVAILABLE');
  assert.ok(typeof connResult.message === 'string');
  assert.equal(connResult.message.includes(secretPass), false, 'Password must not appear in error message');

  const redacted = connector.redactError(`Connection failed for password=${secretPass}`);
  assert.equal(redacted.includes(secretPass), false);
  assert.ok(redacted.includes('[REDACTED]'));
});
