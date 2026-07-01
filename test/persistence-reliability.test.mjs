import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Vault, TrackerLedger, DatabaseService } from '../dist/src/index.js';

test('Vault Atomic Save and Load', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-test-'));
  const vaultPath = path.join(tmpDir, 'vault.enc');
  try {
    const vault = new Vault(vaultPath, 'secret-password');
    assert.equal(await vault.exists(), false);

    await vault.save({ testKey: 'testValue' });
    assert.equal(await vault.exists(), true);

    const loaded = await vault.load();
    assert.equal(loaded.testKey, 'testValue');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('TrackerLedger Atomic Save and Corrupt Load Protection', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-test-'));
  const ledgerPath = path.join(tmpDir, 'ledger.json');
  try {
    const ledger = new TrackerLedger(ledgerPath);
    await ledger.createApplication({
      company: 'Test Co',
      title: 'Engineer',
      url: 'https://example.com/job/1'
    });

    const apps = await ledger.getApplications();
    assert.equal(apps.length, 1);
    assert.equal(apps[0].company, 'Test Co');

    // Overwrite with corrupt JSON
    await fs.writeFile(ledgerPath, '{ invalid json ...', 'utf8');

    const corruptLedger = new TrackerLedger(ledgerPath);
    await assert.rejects(
      async () => {
        await corruptLedger.load();
      },
      (err) => {
        return err instanceof Error && err.message.includes('corrupt file or parse error');
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('DatabaseService and TrackerLedger Close paths and Transactions', async () => {
  const executedQueries = [];
  const mockExecutor = async (text, params = []) => {
    executedQueries.push(text.trim());
    if (text.includes('SELECT id, company')) return { rows: [] };
    if (text.includes('SELECT application_id')) return { rows: [] };
    return { rows: [] };
  };

  const db = new DatabaseService({ mockExecutor });
  const tracker = new TrackerLedger('/tmp/dummy-ledger.json', { db });

  // Test createApplication transaction flow
  await tracker.createApplication({
    company: 'Acme Corp',
    title: 'Developer',
    url: 'https://example.com/job/acme'
  });

  assert.ok(executedQueries.includes('BEGIN'));
  assert.ok(executedQueries.includes('COMMIT'));

  // Test close path
  await tracker.close();
  await db.close();
});
