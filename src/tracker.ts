import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { DatabaseService, isDbConfigured, type ApplicationInput } from './db.js';
import type { DatabaseOptions, DatabaseService as DatabaseServiceType } from './db.js';
import {
  normalizeApplicationStatus,
  normalizeBlockerCode,
  isCanonicalApplicationStatus,
  type ApplicationRecord,
  type TrackerEvent,
  type ApplicationStatus,
  type BlockerItem,
  type BlockerSeverity,
  type AutomationMode,
  type ApplicationArtifact,
  type LLMActionRecord,
  type SubmissionApproval,
  type FieldProvenance,
  type MetricsSnapshot
} from './types.js';
import { calculateMetricsSnapshot } from './metrics.js';

type TrackerOptions = { db?: DatabaseServiceType; dbOptions?: DatabaseOptions; skipDb?: boolean };
type CreateApplicationResult = { success: boolean; blocker?: string; message?: string; application?: ApplicationRecord };

function toApplicationArray(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object' || !('applications' in value)) {
    return [];
  }
  const applications = (value as Record<string, unknown>).applications;
  return Array.isArray(applications) ? (applications as Record<string, unknown>[]) : [];
}



function normalizeRecord(app: Partial<ApplicationRecord> & Record<string, unknown>): ApplicationRecord {
  const events: TrackerEvent[] = Array.isArray(app.events)
    ? app.events.map((e) => {
        const ev = e as Partial<TrackerEvent> & Record<string, unknown>;
        return {
          timestamp: typeof ev.timestamp === 'string' ? ev.timestamp : new Date().toISOString(),
          type: typeof ev.type === 'string' ? ev.type : 'UNKNOWN',
          message: typeof ev.message === 'string' ? ev.message : '',
          status: typeof ev.status === 'string' ? ev.status : undefined,
          payload: ev.payload,
          source: typeof ev.source === 'string' ? ev.source : undefined,
          actor: typeof ev.actor === 'string' ? ev.actor : undefined,
          applicationStatus: ev.applicationStatus ? normalizeApplicationStatus(String(ev.applicationStatus)) : undefined
        };
      })
    : [];

  const blockers = Array.isArray(app.blockers)
    ? app.blockers.map((b) => {
        if (typeof b === 'string') {
          return {
            code: normalizeBlockerCode(b),
            message: 'Blocked',
            severity: 'fatal' as const
          };
        }
        const bl = b as Partial<BlockerItem> & Record<string, unknown>;
        return {
          code: normalizeBlockerCode(bl.code),
          message: typeof bl.message === 'string' ? bl.message : 'Blocked',
          severity: typeof bl.severity === 'string' ? (bl.severity as BlockerSeverity) : undefined,
          source: typeof bl.source === 'string' ? bl.source : undefined,
          field: typeof bl.field === 'string' ? bl.field : undefined,
          details: bl.details && typeof bl.details === 'object' ? (bl.details as Record<string, unknown>) : undefined,
          createdAt: typeof bl.createdAt === 'string' ? bl.createdAt : undefined
        };
      })
    : [];

  const canonicalUrl = typeof app.canonicalUrl === 'string' ? app.canonicalUrl : (typeof app.url === 'string' ? app.url : null);
  const ats = typeof app.ats === 'string' ? app.ats : null;
  const location = typeof app.location === 'string' ? app.location : null;
  const profileVersion = typeof app.profileVersion === 'string' ? app.profileVersion : null;
  const resumeVersion = typeof app.resumeVersion === 'string' ? app.resumeVersion : null;
  const answerSetVersion = typeof app.answerSetVersion === 'string' ? app.answerSetVersion : null;
  const automationMode = typeof app.automationMode === 'string' ? (app.automationMode as AutomationMode) : 'fill_and_review';
  
  const warnings: string[] = Array.isArray(app.warnings) ? app.warnings.map(String) : [];
  const artifacts: ApplicationArtifact[] = Array.isArray(app.artifacts) ? app.artifacts as ApplicationArtifact[] : [];
  const llmActions: LLMActionRecord[] = Array.isArray(app.llmActions) ? app.llmActions as LLMActionRecord[] : [];
  const rawApproval = app.approval && typeof app.approval === 'object' ? (app.approval as unknown as Record<string, unknown>) : null;
  const approval: SubmissionApproval | null = rawApproval ? {
    id: typeof rawApproval.id === 'string' ? rawApproval.id : crypto.randomUUID(),
    applicationId: typeof rawApproval.applicationId === 'string' ? rawApproval.applicationId : (typeof app.id === 'string' ? app.id : ''),
    approvedBy: typeof rawApproval.approvedBy === 'string' ? rawApproval.approvedBy : 'user',
    approvedAt: typeof rawApproval.approvedAt === 'string' ? rawApproval.approvedAt : new Date().toISOString(),
    fieldSnapshotHash: typeof rawApproval.fieldSnapshotHash === 'string' ? rawApproval.fieldSnapshotHash : '',
    blockerSnapshotHash: typeof rawApproval.blockerSnapshotHash === 'string' ? rawApproval.blockerSnapshotHash : '',
    reviewUrl: typeof rawApproval.reviewUrl === 'string' ? rawApproval.reviewUrl : (rawApproval.reviewUrl === null ? null : (typeof app.url === 'string' ? app.url : null))
  } : null;
  const filledFields: string[] = Array.isArray(app.filledFields) ? app.filledFields.map(String) : [];
  const provenance: FieldProvenance[] = Array.isArray(app.provenance) ? (app.provenance as FieldProvenance[]) : [];

  return {
    ...app,
    id: typeof app.id === 'string' ? app.id : crypto.randomUUID(),
    url: typeof app.url === 'string' ? app.url : '',
    company: typeof app.company === 'string' ? app.company : 'Unknown Company',
    title: typeof app.title === 'string' ? app.title : 'Unknown Position',
    status: typeof app.status === 'string' ? normalizeApplicationStatus(app.status) : 'received_link',
    canonicalUrl,
    ats,
    location,
    profileVersion,
    resumeVersion,
    answerSetVersion,
    salary: typeof app.salary === 'number' ? app.salary : null,
    postingHash: typeof app.postingHash === 'string' ? app.postingHash : null,
    automationMode,
    blockers,
    warnings,
    artifacts,
    llmActions,
    approval,
    filledFields,
    provenance,
    events,
    createdAt: typeof app.createdAt === 'string' ? app.createdAt : new Date().toISOString(),
    updatedAt: typeof app.updatedAt === 'string' ? app.updatedAt : new Date().toISOString()
  } as ApplicationRecord;
}


export class TrackerLedger {
  private storagePath: string;
  private applications: ApplicationRecord[];
  private options: TrackerOptions;
  private db: DatabaseServiceType | null;

  constructor(storagePath: string, options: TrackerOptions = {}) {
    this.storagePath = storagePath;
    this.applications = [];
    this.options = options;
    if (options.skipDb) {
      this.db = null;
    } else if (options.db) {
      this.db = options.db;
    } else if (isDbConfigured()) {
      this.db = new DatabaseService(options.dbOptions || {});
    } else {
      this.db = null;
    }
  }

  getDb(): DatabaseServiceType | null {
    if (this.options.skipDb) return null;
    if (this.db) return this.db;
    if (this.options.db) {
      this.db = this.options.db;
      return this.db;
    }
    if (isDbConfigured()) {
      this.db = new DatabaseService(this.options.dbOptions || {});
      return this.db;
    }
    return null;
  }

  async load(): Promise<ApplicationRecord[]> {
    const db = this.getDb();
    if (db) {
      this.applications = await db.getApplications();
      return this.applications;
    }
    try {
      const data = await fs.readFile(this.storagePath, 'utf8');
      const rawApps = toApplicationArray(JSON.parse(data));
      this.applications = rawApps.map(app => normalizeRecord(app));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.applications = [];
      } else {
        throw new Error(`Failed to load ledger from ${this.storagePath}: corrupt file or parse error (${(err as Error).message})`);
      }
    }
    return this.applications;
  }

  async save(): Promise<void> {
    const db = this.getDb();
    if (db) {
      return;
    }
    const dir = path.dirname(this.storagePath);
    await fs.mkdir(dir, { recursive: true });
    const tempPath = path.join(dir, `.${path.basename(this.storagePath)}.${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(tempPath, 'w');
      try {
        await handle.writeFile(JSON.stringify({ applications: this.applications }, null, 2), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tempPath, this.storagePath);
    } catch (err) {
      try {
        await fs.unlink(tempPath);
      } catch {}
      throw err;
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }

  generatePostingHash(company?: string, title?: string, url?: string): string {
    const cleanCompany = (company || '').toLowerCase().trim();
    const cleanTitle = (title || '').toLowerCase().trim();
    const cleanUrl = (url || '').toLowerCase().trim();
    return crypto.createHash('sha256')
      .update(`${cleanCompany}|${cleanTitle}|${cleanUrl}`)
      .digest('hex');
  }

  async isDuplicate(appData: ApplicationInput): Promise<boolean> {
    const db = this.getDb();
    if (db) {
      return await db.isDuplicate(appData);
    }
    await this.load();
    const cleanUrl = appData.url ? appData.url.toLowerCase().trim() : null;
    const cleanCompany = appData.company ? appData.company.toLowerCase().trim() : null;
    const cleanTitle = appData.title ? appData.title.toLowerCase().trim() : null;
    const targetHash = appData.postingHash || this.generatePostingHash(appData.company, appData.title, appData.url);

    return this.applications.some(app => {
      if (cleanUrl && app.url && app.url.toLowerCase().trim() === cleanUrl) {
        return true;
      }
      if (cleanCompany && cleanTitle && app.company && app.title &&
          app.company.toLowerCase().trim() === cleanCompany &&
          app.title.toLowerCase().trim() === cleanTitle) {
        return true;
      }
      const existingHash = app.postingHash || this.generatePostingHash(app.company, app.title, app.url);
      return targetHash === existingHash;
    });
  }

  async createApplication(appData: ApplicationInput): Promise<CreateApplicationResult> {
    const db = this.getDb();
    if (db) {
      return await db.createApplication(appData);
    }
    await this.load();

    const isDup = await this.isDuplicate(appData);
    if (isDup) {
      return {
        success: false,
        blocker: 'duplicate_application',
        message: `Application to ${appData.company} for "${appData.title}" already exists.`
      };
    }

    const id = crypto.randomUUID();
    const postingHash = appData.postingHash || this.generatePostingHash(appData.company, appData.title, appData.url);
    const now = new Date().toISOString();
    
    const suppliedStatus = appData.status;
    let initialStatus: ApplicationStatus = 'received_link';
    if (suppliedStatus && isCanonicalApplicationStatus(suppliedStatus)) {
      initialStatus = suppliedStatus.trim().toLowerCase() as ApplicationStatus;
    }

    const initialEvent: TrackerEvent = {
      timestamp: now,
      type: 'CREATED',
      message: 'Application entry created in ledger.',
      applicationStatus: initialStatus
    };

    const newAppRaw = {
      id,
      url: appData.url || '',
      company: appData.company || 'Unknown Company',
      title: appData.title || 'Unknown Position',
      status: initialStatus,
      postingHash,
      salary: appData.salary || null,
      profileVersion: appData.profileVersion || null,
      resumeVersion: appData.resumeVersion || null,
      answerSetVersion: appData.answerSetVersion || null,
      blockers: appData.blockers || [],
      warnings: appData.warnings || [],
      artifacts: appData.artifacts || [],
      llmActions: appData.llmActions || [],
      requirements: appData.requirements || [],
      requiredFields: appData.requiredFields || [],
      unresolvedChecks: appData.unresolvedChecks || {},
      events: [initialEvent],
      createdAt: now,
      updatedAt: now
    };

    const newApp = normalizeRecord(newAppRaw);

    this.applications.push(newApp);
    await this.save();
    return {
      success: true,
      application: newApp
    };
  }

  async appendEvent(appId: string, eventType: string, message: string): Promise<ApplicationRecord> {
    const db = this.getDb();
    if (db) {
      return await db.appendEvent(appId, eventType, message);
    }
    await this.load();
    const app = this.applications.find(candidate => candidate.id === appId);
    if (!app) {
      throw new Error(`Application with ID ${appId} not found.`);
    }

    const now = new Date().toISOString();
    const currentStatus = normalizeApplicationStatus(app.status);
    app.events.push({
      timestamp: now,
      type: eventType,
      message,
      applicationStatus: currentStatus
    });
    app.updatedAt = now;
    await this.save();
    return app;
  }

  async updateStatus(appId: string, status: ApplicationStatus): Promise<ApplicationRecord> {
    const db = this.getDb();
    if (db) {
      return await db.updateStatus(appId, status);
    }
    await this.load();
    const app = this.applications.find(candidate => candidate.id === appId);
    if (!app) {
      throw new Error(`Application with ID ${appId} not found.`);
    }

    const oldStatus = app.status;
    const canonicalStatus = normalizeApplicationStatus(status);
    const now = new Date().toISOString();
    app.status = canonicalStatus;
    app.updatedAt = now;
    app.events.push({
      timestamp: now,
      type: 'STATUS_CHANGED',
      message: `Status changed from ${oldStatus} to ${canonicalStatus}.`,
      status,
      applicationStatus: canonicalStatus
    });
    await this.save();
    return app;
  }
  async appendLLMAction(appId: string, record: LLMActionRecord): Promise<ApplicationRecord> {
    const db = this.getDb();
    if (db) {
      return await db.appendLLMAction(appId, record);
    }
    await this.load();
    const app = this.applications.find(candidate => candidate.id === appId);
    if (!app) {
      throw new Error(`Application with ID ${appId} not found.`);
    }
    if (!app.llmActions) {
      app.llmActions = [];
    }
    app.llmActions.push(record);
    app.updatedAt = new Date().toISOString();
    await this.save();
    return app;
  }
  async appendArtifact(appId: string, artifact: ApplicationArtifact): Promise<ApplicationRecord> {
    const db = this.getDb();
    if (db) {
      return await db.appendArtifact(appId, artifact);
    }
    await this.load();
    const app = this.applications.find(candidate => candidate.id === appId);
    if (!app) {
      throw new Error(`Application with ID ${appId} not found.`);
    }
    if (!app.artifacts) {
      app.artifacts = [];
    }
    app.artifacts.push(artifact);
    app.updatedAt = new Date().toISOString();
    await this.save();
    return app;
  }

  async recordSubmissionApproval(appId: string, approval: SubmissionApproval): Promise<ApplicationRecord> {
    const db = this.getDb();
    if (db) {
      return await db.recordSubmissionApproval(appId, approval);
    }
    await this.load();
    const app = this.applications.find(candidate => candidate.id === appId);
    if (!app) {
      throw new Error(`Application with ID ${appId} not found.`);
    }
    app.approval = approval;
    app.updatedAt = new Date().toISOString();
    await this.save();
    return app;
  }

  async getApplications(): Promise<ApplicationRecord[]> {
    const db = this.getDb();
    if (db) {
      return await db.getApplications();
    }
    await this.load();
    return this.applications;
  }
  async getMetricsSnapshot(): Promise<MetricsSnapshot> {
    const db = this.getDb();
    if (db) {
      return await db.getMetricsSnapshot();
    }
    await this.load();
    return calculateMetricsSnapshot(this.applications);
  }
}
