import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseService, TrackerLedger, AppService } from '../dist/src/index.js';

test('DatabaseService Mock Integration & Operations', async (t) => {
  const tables = {
    applications: [],
    run_events: [],
    profiles: [],
    answer_memory: []
  };

  const mockExecutor = async (text, params = []) => {
    const trimmed = text.trim();
    if (trimmed.includes('CREATE TABLE')) {
      return { rows: [] };
    }
    if (trimmed.startsWith('SELECT id, company')) {
      return { rows: tables.applications };
    }
    if (trimmed.startsWith('SELECT application_id, event_type')) {
      return { rows: tables.run_events };
    }
    if (trimmed.startsWith('INSERT INTO applications')) {
      const [id, company, title, job_url, status, platform, applied_at, updated_at, metadataStr] = params;
      const metadata = typeof metadataStr === 'string' ? JSON.parse(metadataStr) : metadataStr;
      const postingHash = metadata.postingHash;
      const isDuplicateHash = tables.applications.some(app => {
        const appMeta = typeof app.metadata === 'string' ? JSON.parse(app.metadata) : app.metadata;
        return appMeta.postingHash === postingHash;
      });
      if (isDuplicateHash) {
        const err = new Error('duplicate key value violates unique constraint "idx_applications_metadata_posting_hash_unique"');
        err.code = '23505';
        throw err;
      }
      tables.applications.push({
        id, company, title, job_url, status, platform, applied_at, updated_at, metadata: metadataStr
      });
      return { rows: [] };
    }
    if (trimmed.startsWith('INSERT INTO run_events')) {
      const [id, run_id, application_id, event_type, status, message, payload, created_at] = params;
      tables.run_events.push({
        id, run_id, application_id, event_type, status, message, payload, created_at
      });
      return { rows: [] };
    }
    if (trimmed.startsWith('INSERT INTO profiles')) {
      const [id, name, email, phone, skills, preferences, created_at, updated_at] = params;
      const existing = tables.profiles.find(profile => profile.email === email);
      if (existing) {
        Object.assign(existing, { name, phone, skills, preferences, updated_at });
      } else {
        tables.profiles.push({ id, name, email, phone, skills, preferences, created_at, updated_at });
      }
      return { rows: [] };
    }
    if (trimmed.startsWith('INSERT INTO answer_memory')) {
      const [id, question_key, question_text, answer_text, tags, created_at, updated_at] = params;
      const existing = tables.answer_memory.find(answer => answer.question_key === question_key);
      if (existing) {
        Object.assign(existing, { question_text, answer_text, tags, updated_at });
      } else {
        tables.answer_memory.push({ id, question_key, question_text, answer_text, tags, created_at, updated_at });
      }
      return { rows: [] };
    }
    if (trimmed.startsWith('SELECT name, email')) {
      return { rows: tables.profiles.slice(-1) };
    }
    if (trimmed.startsWith('SELECT question_key, answer_text')) {
      return { rows: tables.answer_memory };
    }
    if (trimmed.startsWith('UPDATE applications SET updated_at = $1, metadata = $2 WHERE id = $3')) {
      const [updated_at, metadata, id] = params;
      const app = tables.applications.find(a => a.id === id);
      if (app) {
        app.updated_at = updated_at;
        app.metadata = metadata;
      }
      return { rows: [] };
    }
    if (trimmed.startsWith('UPDATE applications SET status = $1, updated_at = $2 WHERE id = $3')) {
      const [status, updated_at, id] = params;
      const app = tables.applications.find(a => a.id === id);
      if (app) {
        app.status = status;
        app.updated_at = updated_at;
      }
      return { rows: [] };
    }
    return { rows: [] };
  };

  const db = new DatabaseService({ mockExecutor });
  const tracker = new TrackerLedger('/tmp/dummy-ledger.json', { db });

  const appData = {
    url: 'https://example.com/job/1',
    company: 'Cluster Corp',
    title: 'Postgres Engineer'
  };

  const createRes = await tracker.createApplication(appData);
  assert.equal(createRes.success, true);
  assert.equal(createRes.application.company, 'Cluster Corp');
  assert.equal(tables.applications.length, 1);
  assert.equal(tables.run_events.length, 1);

  const isDup = await tracker.isDuplicate(appData);
  assert.equal(isDup, true);

  const dupCreateRes = await tracker.createApplication(appData);
  assert.equal(dupCreateRes.success, false);
  assert.equal(dupCreateRes.blocker, 'duplicate_application');
  const updated = await tracker.updateStatus(createRes.application.id, 'submitted');
  assert.equal(updated.status, 'submitted');

  const apps = await tracker.getApplications();
  assert.equal(apps.length, 1);
  assert.equal(apps[0].status, 'submitted');

  const profile = {
    candidateProfile: {
      name: 'Cluster Candidate',
      email: 'candidate@example.com',
      phone: '555-555-5555',
      skills: ['PostgreSQL', 'TypeScript'],
      experience: [],
      education: []
    },
    claimBank: [{ id: 'skill_0', text: 'Proficient in PostgreSQL.', category: 'skills', value: 'PostgreSQL' }],
    answerMemory: { sponsorship: 'No' }
  };

  await db.saveProfile(profile);
  const loadedProfile = await db.loadProfile();
  assert.equal(loadedProfile, null);
});
