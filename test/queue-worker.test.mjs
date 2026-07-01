import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { DatabaseService, AutomationQueue, AutomationWorker } from '../dist/src/index.js';

test('Queue Operations - Enqueue, Claim, Lease, Complete, Fail', async (t) => {
  const fallbackPath = path.join('./data', 'test_jobs.json');
  try {
    await fs.unlink(fallbackPath);
  } catch {}

  const db = new DatabaseService({
    useFallback: true,
    fallbackJobsFilePath: fallbackPath
  });

  const queue = new AutomationQueue(db);
  const appId = '11111111-1111-1111-1111-111111111111';

  // 1. Enqueue
  const job = await queue.enqueue(appId, {
    approved: true,
    approvedBy: 'user@example.com',
    reviewUrl: 'http://example.com/review',
    mode: 'submit_immediately',
    testMode: true
  });

  assert.ok(job.id);
  assert.equal(job.application_id, appId);
  assert.equal(job.status, 'pending');
  assert.equal(job.payload.approved, true);
  assert.equal(job.payload.approvedBy, 'user@example.com');
  assert.equal(job.payload.reviewUrl, 'http://example.com/review');
  assert.equal(job.payload.mode, 'submit_immediately');
  assert.equal(job.payload.testMode, true);

  // 2. Claim (Lease)
  const claimed = await queue.claim('worker-1', 300);
  assert.ok(claimed);
  assert.equal(claimed.id, job.id);
  assert.equal(claimed.status, 'processing');
  assert.equal(claimed.locked_by, 'worker-1');
  assert.ok(claimed.locked_at);
  assert.equal(claimed.attempts, 1);

  // Try claiming again (should be locked and return null)
  const claimedAgain = await queue.claim('worker-2', 300);
  assert.equal(claimedAgain, null);

  // 3. Complete
  const completed = await queue.complete(job.id);
  assert.ok(completed);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.locked_by, null);
  assert.equal(completed.locked_at, null);
  assert.ok(completed.finished_at);

  // 4. Fail and Retry logic
  const job2 = await queue.enqueue(appId, {
    approved: true,
    approvedBy: 'user2@example.com',
    testMode: true
  });

  // Claim to increment attempts
  const claimed2 = await queue.claim('worker-1', 300);
  assert.equal(claimed2.attempts, 1);

  // Fail (should go back to pending because attempts = 1 < max_attempts = 3)
  const failedRetry = await queue.fail(job2.id, 'Connection timeout');
  assert.ok(failedRetry);
  assert.equal(failedRetry.status, 'pending');
  assert.equal(failedRetry.error_message, 'Connection timeout');

  // Claim 2nd time
  await queue.claim('worker-1', 300);
  // Fail again
  await queue.fail(job2.id, 'Connection timeout 2');

  // Claim 3rd time (max_attempts = 3)
  const claimedFinal = await queue.claim('worker-1', 300);
  assert.equal(claimedFinal.attempts, 3);
  // Fail final time -> status should be 'failed'
  const failedFinal = await queue.fail(job2.id, 'Fatal crash');
  assert.equal(failedFinal.status, 'failed');
  assert.ok(failedFinal.finished_at);

  // Clean up
  try {
    await fs.unlink(fallbackPath);
  } catch {}
});

test('Worker processing a queued approved submission', async (t) => {
  const fallbackPath = path.join('./data', 'test_worker_jobs.json');
  try {
    await fs.unlink(fallbackPath);
  } catch {}

  const db = new DatabaseService({
    useFallback: true,
    fallbackJobsFilePath: fallbackPath
  });
  const queue = new AutomationQueue(db);
  const appId = '22222222-2222-2222-2222-222222222222';

  // Enqueue approved submission
  const job = await queue.enqueue(appId, {
    approved: true,
    approvedBy: 'approver@example.com',
    testMode: true
  });

  // Mock AppService
  let approveSubmissionCalledWith = null;
  const mockAppService = {
    approveSubmission: async (id, options) => {
      approveSubmissionCalledWith = { id, options };
      return {
        success: true,
        status: 'submitted',
        message: 'Mock approval processed successfully.'
      };
    }
  };

  const worker = new AutomationWorker(mockAppService, queue, {
    workerId: 'mock-worker',
    pollIntervalMs: 100,
    leaseDurationSec: 60
  });

  // Process next job
  const processed = await worker.processNextJob();
  assert.equal(processed, true);

  // Verify AppService was called with correct parameters
  assert.ok(approveSubmissionCalledWith);
  assert.equal(approveSubmissionCalledWith.id, appId);
  assert.equal(approveSubmissionCalledWith.options.approved, true);
  assert.equal(approveSubmissionCalledWith.options.approvedBy, 'approver@example.com');
  assert.equal(approveSubmissionCalledWith.options.forceInline, true);

  // Verify job is marked completed in the queue
  const updatedJob = await queue.getJob(job.id);
  assert.equal(updatedJob.status, 'completed');

  // Clean up
  try {
    await fs.unlink(fallbackPath);
  } catch {}
});
