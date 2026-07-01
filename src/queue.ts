import { DatabaseService } from './db.js';
import type { AutomationJob } from './types.js';

export class AutomationQueue {
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  async enqueue(
    appId: string,
    options: {
      approved?: boolean;
      approvedBy?: string;
      reviewUrl?: string | null;
      mode?: string;
      testMode?: boolean;
    }
  ): Promise<AutomationJob> {
    const payload = {
      appId,
      approved: options.approved,
      approvedBy: options.approvedBy,
      reviewUrl: options.reviewUrl,
      mode: options.mode,
      testMode: options.testMode
    } satisfies AutomationJob['payload'];

    return await this.db.enqueueJob(appId, payload);
  }

  async claim(workerId: string, leaseDurationSec: number = 300): Promise<AutomationJob | null> {
    return await this.db.claimJob(workerId, leaseDurationSec);
  }

  async complete(jobId: string): Promise<AutomationJob | null> {
    return await this.db.completeJob(jobId);
  }

  async fail(jobId: string, error: string): Promise<AutomationJob | null> {
    return await this.db.failJob(jobId, error);
  }

  async getJob(jobId: string): Promise<AutomationJob | null> {
    return await this.db.getJob(jobId);
  }
}
