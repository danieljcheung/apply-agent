import { AppService } from './appService.js';
import { AutomationQueue } from './queue.js';
import { DatabaseService, bootstrapVault } from './db.js';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';

export class AutomationWorker {
  private appService: AppService;
  private queue: AutomationQueue;
  private workerId: string;
  private running: boolean = false;
  private pollIntervalMs: number;
  private leaseDurationSec: number;

  constructor(
    appService: AppService,
    queue: AutomationQueue,
    options: {
      workerId?: string;
      pollIntervalMs?: number;
      leaseDurationSec?: number;
    } = {}
  ) {
    this.appService = appService;
    this.queue = queue;
    this.workerId = options.workerId || `worker-${crypto.randomUUID()}`;
    this.pollIntervalMs = options.pollIntervalMs || 5000;
    this.leaseDurationSec = options.leaseDurationSec || 300;
  }

  async start(): Promise<void> {
    this.running = true;
    console.log(`[Worker] Started worker ${this.workerId}`);
    while (this.running) {
      try {
        const processed = await this.processNextJob();
        if (!processed && this.running) {
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, this.pollIntervalMs);
          await promise;
        }
      } catch (err) {
        console.error(`[Worker] Error in polling loop:`, err);
        if (this.running) {
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, this.pollIntervalMs);
          await promise;
        }
      }
    }
  }

  stop(): void {
    this.running = false;
    console.log(`[Worker] Stopped worker ${this.workerId}`);
  }

  async processNextJob(): Promise<boolean> {
    const job = await this.queue.claim(this.workerId, this.leaseDurationSec);
    if (!job) {
      return false;
    }

    console.log(`[Worker] Claimed job ${job.id} for application ${job.application_id}`);
    try {
      const payload = job.payload;
      
      const rawMode = payload.mode;
      const mode = (rawMode === 'inspect_only' || rawMode === 'fill_review_only' || rawMode === 'submit_after_approval')
        ? rawMode
        : undefined;
      const isServerSideTestMode = process.env.NODE_ENV !== 'production' &&
        (process.env.TEST_MODE === 'true' || this.appService.options?.testMode === true);
      const workerTestMode = isServerSideTestMode ? payload.testMode : undefined;
      const result = await this.appService.approveSubmission(job.application_id, {
        approved: payload.approved,
        approvedBy: payload.approvedBy,
        reviewUrl: payload.reviewUrl,
        mode,
        testMode: workerTestMode,
        forceInline: true // Always execute inline on the worker itself!
      });

      if (result.success) {
        console.log(`[Worker] Successfully processed job ${job.id}`);
        await this.queue.complete(job.id);
      } else {
        const errorMsg = result.message || result.blocker || 'Unknown approval failure';
        console.error(`[Worker] Job ${job.id} returned unsuccessful result: ${errorMsg}`);
        await this.queue.fail(job.id, errorMsg);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Worker] Job ${job.id} failed with exception:`, err);
      await this.queue.fail(job.id, errorMsg);
    }
    return true;
  }
}

const isMain = () => {
  try {
    if (!process.argv[1]) return false;
    const modulePath = fileURLToPath(import.meta.url);
    const scriptPath = process.argv[1];
    return path.resolve(modulePath) === path.resolve(scriptPath) ||
           path.resolve(modulePath.replace(/\.ts$/, '.js')) === path.resolve(scriptPath);
  } catch {
    return false;
  }
};

async function main() {
  const dataDir = process.env.APPLY_AGENT_DATA_DIR || './data';
  const vaultPassword = process.env.VAULT_PASSWORD;
  
  if (!vaultPassword) {
    console.error('VAULT_PASSWORD is required to start the worker.');
    process.exit(1);
  }

  const db = new DatabaseService();
  await db.init();

  const appService = new AppService({
    dataDir,
    vaultPassword,
    db
  });

  const vaultPath = path.join(dataDir, 'vault.enc');
  try {
    await bootstrapVault(appService, vaultPassword, vaultPath);
    console.log('[Worker] Vault successfully bootstrapped');
  } catch (err) {
    console.error('[Worker] Failed to bootstrap vault:', err);
    process.exit(1);
  }

  const queue = new AutomationQueue(db);
  const worker = new AutomationWorker(appService, queue);

  process.on('SIGINT', () => {
    worker.stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    worker.stop();
    process.exit(0);
  });

  await worker.start();
}

if (isMain()) {
  main().catch(err => {
    console.error('[Worker] Fatal error on startup:', err);
    process.exit(1);
  });
}
