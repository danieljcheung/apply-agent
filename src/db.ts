import pg, { type Pool, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';
import crypto from 'crypto';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import type {
  ProfileBundle,
  ApplicationRecord,
  TrackerEvent,
  BlockerItem,
  ApplicationArtifact,
  LLMActionRecord,
  SubmissionApproval,
  AutomationMode,
  FieldProvenance,
  MetricsSnapshot,
  AutomationJob
} from './types.js';
import { normalizeApplicationStatus } from './types.js';
import { sanitizeLabelValue } from './metrics.js';

export type ApplicationInput = {
  url?: string;
  company?: string;
  title?: string;
  status?: string;
  salary?: number | null;
  postingHash?: string;
  canonicalUrl?: string | null;
  ats?: string | null;
  location?: string | null;
  profileVersion?: string | null;
  resumeVersion?: string | null;
  answerSetVersion?: string | null;
  blockers?: BlockerItem[];
  warnings?: string[];
  artifacts?: ApplicationArtifact[];
  llmActions?: LLMActionRecord[];
  approval?: SubmissionApproval | null;
  automationMode?: AutomationMode;
  requirements?: string[];
  requiredFields?: string[];
  unresolvedChecks?: {
    captcha?: boolean;
    twoFactor?: boolean;
    emailVerification?: boolean;
  };
  filledFields?: string[];
  provenance?: FieldProvenance[];
};

type ApplicationMetadata = {
  salary?: number | null;
  postingHash?: string;
  events?: TrackerEvent[];
  canonicalUrl?: string | null;
  ats?: string | null;
  location?: string | null;
  profileVersion?: string | null;
  resumeVersion?: string | null;
  answerSetVersion?: string | null;
  blockers?: BlockerItem[];
  warnings?: string[];
  artifacts?: ApplicationArtifact[];
  llmActions?: LLMActionRecord[];
  approval?: SubmissionApproval | null;
  automationMode?: AutomationMode;
  requirements?: string[];
  requiredFields?: string[];
  unresolvedChecks?: {
    captcha?: boolean;
    twoFactor?: boolean;
    emailVerification?: boolean;
  };
  filledFields?: string[];
  provenance?: FieldProvenance[];
};

type ApplicationRow = QueryResultRow & {
  id: string;
  company: string;
  title: string;
  job_url: string;
  status: string;
  platform: string;
  applied_at: Date | string;
  updated_at: Date | string;
  metadata: ApplicationMetadata | string | null;
};

type EventRow = QueryResultRow & {
  application_id: string | null;
  event_type: string;
  message: string;
  created_at: Date | string;
};

type ProfileRow = QueryResultRow & {
  name: string;
  email: string;
  phone: string | null;
  skills: string[] | string | null;
  preferences: { candidateProfile?: ProfileBundle['candidateProfile']; claimBank?: ProfileBundle['claimBank'] } | string | null;
};

type AnswerMemoryRow = QueryResultRow & {
  question_key: string;
  answer_text: string;
};

type QueryExecutor = (text: string, params?: unknown[]) => Promise<{ rows: QueryResultRow[] }>;

export type DatabaseOptions = { pool?: Pool; config?: PoolConfig; mockExecutor?: QueryExecutor; useFallback?: boolean; fallbackJobsFilePath?: string };

function getSslConfig(env: NodeJS.ProcessEnv, isProd: boolean): any {
  const sslModeRequire = env.DB_SSLMODE === 'require' || env.DB_SSL === 'true';
  if (!sslModeRequire) {
    if (isProd) {
      throw new Error('Database SSL connection is required in production.');
    }
    return false;
  }

  if (!isProd && env.DB_SSL_REJECT_UNAUTHORIZED === 'false') {
    return { rejectUnauthorized: false };
  }

  if (isProd && env.DB_SSL_REJECT_UNAUTHORIZED === 'false') {
    throw new Error('Insecure DB SSL connections (DB_SSL_REJECT_UNAUTHORIZED=false) are not permitted in production.');
  }

  let caContent: string | Buffer | undefined;

  if (env.DB_SSL_CA) {
    if (env.DB_SSL_CA.includes('-----BEGIN CERTIFICATE-----')) {
      caContent = env.DB_SSL_CA;
    } else {
      try {
        caContent = fsSync.readFileSync(env.DB_SSL_CA, 'utf8');
      } catch (err: any) {
        throw new Error(`Failed to read database CA certificate from path specified in DB_SSL_CA: ${err.message}`);
      }
    }
  } else if (env.DB_SSL_CA_PATH) {
    try {
      caContent = fsSync.readFileSync(env.DB_SSL_CA_PATH, 'utf8');
    } catch (err: any) {
      throw new Error(`Failed to read database CA certificate from DB_SSL_CA_PATH: ${err.message}`);
    }
  } else {
    const commonCaPaths = [
      '/etc/ssl/certs/ca-certificates.crt',
      '/etc/pki/tls/certs/ca-bundle.crt',
      '/etc/ssl/ca-bundle.pem',
      '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
      '/etc/ssl/cert.pem'
    ];
    for (const caPath of commonCaPaths) {
      if (fsSync.existsSync(caPath)) {
        try {
          caContent = fsSync.readFileSync(caPath, 'utf8');
          break;
        } catch {}
      }
    }
  }

  if (!caContent) {
    throw new Error('Database SSL connection requires verification material (DB_SSL_CA or system CA path) in production.');
  }

  return {
    rejectUnauthorized: true,
    ca: caContent
  };
}

export function getDbConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig | null {
  const connectionString = env.DATABASE_URL || env.DB_URL;
  const isProd = env.NODE_ENV === 'production';

  if (connectionString) {
    if (isProd) {
      if (connectionString.includes('change_me_in_production')) {
        throw new Error('Database credentials cannot use placeholder values in production.');
      }
      try {
        if (connectionString.startsWith('postgres://') || connectionString.startsWith('postgresql://')) {
          const parsed = new URL(connectionString);
          if (!parsed.username || !parsed.password) {
            throw new Error('Database credentials (username/password) are missing from DATABASE_URL in production.');
          }
          if (parsed.username === 'change_me_in_production' || parsed.password === 'change_me_in_production') {
            throw new Error('Database credentials cannot use placeholder values in production.');
          }
        }
      } catch (err: any) {
        if (err.message.includes('missing') || err.message.includes('placeholder')) {
          throw err;
        }
      }
    }
    const sslModeRequire = env.DB_SSLMODE === 'require' || env.DB_SSL === 'true';
    if (sslModeRequire || isProd) {
      const ssl = getSslConfig(env, isProd);
      return { connectionString, ssl };
    }
    return { connectionString };
  }

  if (env.DB_HOST) {
    const host = env.DB_HOST;
    const port = parseInt(env.DB_PORT || '5432', 10);
    const database = env.DB_NAME || env.DB_DATABASE || 'apply_agent_db';
    const user = env.DB_USER || env.DB_USERNAME || 'apply_user';
    const password = env.DB_PASSWORD || env.DB_PASS || 'change_me_in_production';

    if (isProd) {
      const rawUser = env.DB_USER || env.DB_USERNAME;
      const rawPassword = env.DB_PASSWORD || env.DB_PASS;
      if (!rawUser) {
        throw new Error('Database username is missing in production.');
      }
      if (!rawPassword) {
        throw new Error('Database password is missing in production.');
      }
      if (rawUser === 'change_me_in_production' || user === 'change_me_in_production') {
        throw new Error('Database username cannot use placeholder values in production.');
      }
      if (rawPassword === 'change_me_in_production' || password === 'change_me_in_production') {
        throw new Error('Database password cannot use placeholder values in production.');
      }
    }

    const ssl = getSslConfig(env, isProd);
    return { host, port, database, user, password, ssl };
  }

  return null;
}

export function isDbConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(getDbConfig(env));
}

export async function bootstrapVault(
  appService: {
    createVault(password: string): Promise<void>;
    unlock(password: string): Promise<void>;
  },
  password: string,
  vaultPath: string
): Promise<void> {
  const checkExists = async () => {
    try {
      await fs.access(vaultPath);
      return true;
    } catch {
      return false;
    }
  };

  if (await checkExists()) {
    await appService.unlock(password);
  } else {
    try {
      await appService.createVault(password);
    } catch (err: any) {
      if (err && (err instanceof Error || (typeof err === 'object' && typeof err.message === 'string')) && err.message.includes('already exists')) {
        await appService.unlock(password);
      } else {
        throw err;
      }
    }
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

interface AutomationJobRow extends QueryResultRow {
  id: string;
  application_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  payload: string | {
    appId: string;
    approved?: boolean;
    approvedBy?: string;
    reviewUrl?: string | null;
    mode?: string;
    testMode?: boolean;
  };
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  locked_at: string | Date | null;
  error_message: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  finished_at: string | Date | null;
}

function parsePayload(payload: unknown): AutomationJob['payload'] {
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload) as AutomationJob['payload'];
    } catch {
      return { appId: '' };
    }
  }
  if (payload && typeof payload === 'object') {
    return payload as AutomationJob['payload'];
  }
  return { appId: '' };
}

function rowToJob(row: AutomationJobRow): AutomationJob {
  return {
    id: row.id,
    application_id: row.application_id,
    status: row.status,
    payload: parsePayload(row.payload),
    attempts: Number(row.attempts),
    max_attempts: Number(row.max_attempts),
    locked_by: row.locked_by,
    locked_at: row.locked_at ? toIso(row.locked_at) : null,
    error_message: row.error_message,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    finished_at: row.finished_at ? toIso(row.finished_at) : null
  };
}

function parseMetadata(value: ApplicationRow['metadata']): ApplicationMetadata {
  if (!value) return {};
  return typeof value === 'string' ? JSON.parse(value) as ApplicationMetadata : value;
}

function parsePreferences(value: ProfileRow['preferences']): { candidateProfile?: ProfileBundle['candidateProfile']; claimBank?: ProfileBundle['claimBank'] } {
  if (!value) return {};
  return typeof value === 'string' ? JSON.parse(value) as { candidateProfile?: ProfileBundle['candidateProfile']; claimBank?: ProfileBundle['claimBank'] } : value;
}

function parseSkills(value: ProfileRow['skills']): string[] {
  if (!value) return [];
  return typeof value === 'string' ? JSON.parse(value) as string[] : value;
}

function answerText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'answer' in value) {
    const answer = value.answer;
    return typeof answer === 'string' ? answer : '';
  }
  return '';
}

export class DatabaseService {
  private options: DatabaseOptions;
  private pool: Pool | null;
  private mockExecutor: QueryExecutor | null;
  private initialized: boolean;

  constructor(options: DatabaseOptions = {}) {
    this.options = options;
    this.pool = options.pool || null;
    this.mockExecutor = options.mockExecutor || null;
    this.initialized = false;
  }

  async getPool(): Promise<Pool | null> {
    if (this.mockExecutor) {
      return null;
    }
    if (!this.pool) {
      const config = this.options.config || getDbConfig();
      if (!config) {
        throw new Error('Database configuration not found in environment or options.');
      }
      const { Pool } = pg;
      this.pool = new Pool(config);
    }
    return this.pool;
  }

  async query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<QueryResult<T> | { rows: T[] }> {
    if (this.mockExecutor) {
      const result = await this.mockExecutor(text, params);
      return { rows: result.rows as T[] };
    }
    const pool = await this.getPool();
    if (!pool) {
      return { rows: [] as T[] };
    }
    return await pool.query<T>(text, params);
  }

  async withTransaction<T>(fn: (executor: QueryExecutor) => Promise<T>): Promise<T> {
    if (this.mockExecutor) {
      await this.mockExecutor('BEGIN');
      try {
        const result = await fn(this.mockExecutor);
        await this.mockExecutor('COMMIT');
        return result;
      } catch (err) {
        await this.mockExecutor('ROLLBACK');
        throw err;
      }
    }

    const pool = await this.getPool();
    if (!pool) {
      return await fn(async (text, params) => ({ rows: [] }));
    }

    const client = await pool.connect();
    const executor: QueryExecutor = async (text, params) => {
      const result = await client.query(text, params);
      return { rows: result.rows };
    };

    try {
      await client.query('BEGIN');
      const result = await fn(executor);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.ensureSchema();
    this.initialized = true;
  }

  async ensureSchema(): Promise<void> {
    const schemaSql = `
      CREATE TABLE IF NOT EXISTS applications (
          id UUID PRIMARY KEY,
          company VARCHAR(255) NOT NULL,
          title VARCHAR(255) NOT NULL,
          job_url TEXT NOT NULL,
          status VARCHAR(50) NOT NULL DEFAULT 'draft',
          platform VARCHAR(50) DEFAULT 'workday',
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          metadata JSONB DEFAULT '{}'::jsonb
      );

      CREATE TABLE IF NOT EXISTS profiles (
          id UUID PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          email VARCHAR(255) NOT NULL UNIQUE,
          phone VARCHAR(50),
          resume_url TEXT,
          skills JSONB DEFAULT '[]'::jsonb,
          preferences JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS answer_memory (
          id UUID PRIMARY KEY,
          question_key VARCHAR(255) NOT NULL UNIQUE,
          question_text TEXT NOT NULL,
          answer_text TEXT NOT NULL,
          tags JSONB DEFAULT '[]'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS run_events (
          id UUID PRIMARY KEY,
          run_id UUID NOT NULL,
          application_id UUID REFERENCES applications(id) ON DELETE SET NULL,
          event_type VARCHAR(100) NOT NULL,
          status VARCHAR(50) NOT NULL,
          message TEXT,
          payload JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS automation_jobs (
          id UUID PRIMARY KEY,
          application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
          status VARCHAR(50) NOT NULL DEFAULT 'pending',
          payload JSONB DEFAULT '{}'::jsonb,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          locked_by VARCHAR(255),
          locked_at TIMESTAMPTZ,
          error_message TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          finished_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_applications_metadata ON applications USING gin (metadata);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_metadata_posting_hash_unique ON applications ((metadata->>'postingHash'));
      CREATE INDEX IF NOT EXISTS idx_applications_metadata_ats ON applications ((metadata->>'ats'));
      CREATE INDEX IF NOT EXISTS idx_applications_metadata_automation_mode ON applications ((metadata->>'automationMode'));
      CREATE INDEX IF NOT EXISTS idx_automation_jobs_application_id ON automation_jobs(application_id);
      CREATE INDEX IF NOT EXISTS idx_automation_jobs_status ON automation_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_automation_jobs_locked_at ON automation_jobs(locked_at);
      CREATE INDEX IF NOT EXISTS idx_automation_jobs_created_at ON automation_jobs(created_at);
    `;
    await this.query(schemaSql);
  }

  generatePostingHash(company?: string, title?: string, url?: string): string {
    const cleanCompany = (company || '').toLowerCase().trim();
    const cleanTitle = (title || '').toLowerCase().trim();
    const cleanUrl = (url || '').toLowerCase().trim();
    return crypto.createHash('sha256')
      .update(`${cleanCompany}|${cleanTitle}|${cleanUrl}`)
      .digest('hex');
  }

  /**
   * @deprecated Profile storage in database is deprecated for data privacy and security.
   * This method is now a no-op and does not write PII to the database.
   */
  async saveProfile(profile: ProfileBundle): Promise<void> {
    console.warn('DatabaseService.saveProfile is deprecated and does not write to the database.');
  }

  /**
   * @deprecated Profile storage in database is deprecated for data privacy and security.
   * This method now always returns null.
   */
  async loadProfile(): Promise<ProfileBundle | null> {
    console.warn('DatabaseService.loadProfile is deprecated and always returns null.');
    return null;
  }

  async getApplications(): Promise<ApplicationRecord[]> {
    await this.init();
    const appRes = await this.query<ApplicationRow>(
      `SELECT id, company, title, job_url, status, platform, applied_at, updated_at, metadata FROM applications ORDER BY applied_at DESC`
    );
    const rows = appRes.rows;

    const eventRes = await this.query<EventRow>(
      `SELECT application_id, event_type, message, created_at FROM run_events ORDER BY created_at ASC`
    );
    const eventsByApp: Record<string, TrackerEvent[]> = {};
    for (const er of eventRes.rows) {
      if (!er.application_id) continue;
      eventsByApp[er.application_id] = eventsByApp[er.application_id] || [];
      eventsByApp[er.application_id].push({
        timestamp: toIso(er.created_at),
        type: er.event_type,
        message: er.message
      });
    }

    return rows.map(row => {
      const meta = parseMetadata(row.metadata);
      const appEvents = eventsByApp[row.id] || meta.events || [];
      return {
        id: row.id,
        url: row.job_url,
        company: row.company,
        title: row.title,
        status: normalizeApplicationStatus(row.status),
        canonicalUrl: meta.canonicalUrl ?? null,
        ats: meta.ats ?? null,
        location: meta.location ?? null,
        profileVersion: meta.profileVersion ?? null,
        resumeVersion: meta.resumeVersion ?? null,
        answerSetVersion: meta.answerSetVersion ?? null,
        salary: meta.salary ?? null,
        postingHash: meta.postingHash || this.generatePostingHash(row.company, row.title, row.job_url),
        automationMode: meta.automationMode,
        blockers: meta.blockers || [],
        warnings: meta.warnings || [],
        artifacts: meta.artifacts || [],
        llmActions: meta.llmActions || [],
        approval: meta.approval ? {
          id: typeof meta.approval.id === 'string' ? meta.approval.id : crypto.randomUUID(),
          applicationId: typeof meta.approval.applicationId === 'string' ? meta.approval.applicationId : row.id,
          approvedBy: typeof meta.approval.approvedBy === 'string' ? meta.approval.approvedBy : 'user',
          approvedAt: typeof meta.approval.approvedAt === 'string' ? meta.approval.approvedAt : new Date().toISOString(),
          fieldSnapshotHash: typeof meta.approval.fieldSnapshotHash === 'string' ? meta.approval.fieldSnapshotHash : '',
          blockerSnapshotHash: typeof meta.approval.blockerSnapshotHash === 'string' ? meta.approval.blockerSnapshotHash : '',
          reviewUrl: typeof meta.approval.reviewUrl === 'string' ? meta.approval.reviewUrl : (meta.approval.reviewUrl === null ? null : row.job_url)
        } : null,
        events: appEvents,
        createdAt: toIso(row.applied_at),
        updatedAt: toIso(row.updated_at),
        requirements: meta.requirements || [],
        requiredFields: meta.requiredFields || [],
        unresolvedChecks: meta.unresolvedChecks || {},
        filledFields: meta.filledFields || [],
        provenance: meta.provenance || []
      };
    });
  }

  async isDuplicate(appData: ApplicationInput): Promise<boolean> {
    const apps = await this.getApplications();
    const cleanUrl = appData.url ? appData.url.toLowerCase().trim() : null;
    const cleanCompany = appData.company ? appData.company.toLowerCase().trim() : null;
    const cleanTitle = appData.title ? appData.title.toLowerCase().trim() : null;
    const targetHash = appData.postingHash || this.generatePostingHash(appData.company, appData.title, appData.url);

    return apps.some(app => {
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

  async createApplication(appData: ApplicationInput): Promise<{ success: boolean; blocker?: string; message?: string; application?: ApplicationRecord }> {
    await this.init();

    const id = crypto.randomUUID();
    const postingHash = appData.postingHash || this.generatePostingHash(appData.company, appData.title, appData.url);
    const nowIso = new Date().toISOString();
    const now = new Date(nowIso);

    const initialEvent: TrackerEvent = {
      timestamp: nowIso,
      type: 'CREATED',
      message: 'Application entry created in ledger.'
    };

    const status = normalizeApplicationStatus(appData.status || 'draft');

    const metadata: ApplicationMetadata = {
      salary: appData.salary ?? null,
      postingHash,
      events: [initialEvent],
      canonicalUrl: appData.canonicalUrl ?? null,
      ats: appData.ats ?? null,
      location: appData.location ?? null,
      profileVersion: appData.profileVersion ?? null,
      resumeVersion: appData.resumeVersion ?? null,
      answerSetVersion: appData.answerSetVersion ?? null,
      blockers: appData.blockers || [],
      warnings: appData.warnings || [],
      artifacts: appData.artifacts || [],
      llmActions: appData.llmActions || [],
      approval: appData.approval ?? null,
      automationMode: appData.automationMode,
      requirements: appData.requirements || [],
      requiredFields: appData.requiredFields || [],
      unresolvedChecks: appData.unresolvedChecks || {}
    };

    const company = appData.company || 'Unknown Company';
    const title = appData.title || 'Unknown Position';
    const jobUrl = appData.url || '';

    try {
      await this.withTransaction(async (exec) => {
        await exec(
          `INSERT INTO applications (id, company, title, job_url, status, platform, applied_at, updated_at, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [id, company, title, jobUrl, status, 'workday', now, now, JSON.stringify(metadata)]
        );

        await exec(
          `INSERT INTO run_events (id, run_id, application_id, event_type, status, message, payload, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [crypto.randomUUID(), crypto.randomUUID(), id, 'CREATED', status, 'Application entry created in ledger.', JSON.stringify({ timestamp: nowIso }), now]
        );
      });
    } catch (err: any) {
      if (err.code === '23505' || err.message?.includes('duplicate key') || err.message?.includes('unique constraint')) {
        return {
          success: false,
          blocker: 'duplicate_application',
          message: `Application to ${company} for "${title}" already exists.`
        };
      }
      throw err;
    }

    const application: ApplicationRecord = {
      id,
      url: jobUrl,
      company,
      title,
      status,
      canonicalUrl: metadata.canonicalUrl,
      ats: metadata.ats,
      location: metadata.location,
      profileVersion: metadata.profileVersion,
      resumeVersion: metadata.resumeVersion,
      answerSetVersion: metadata.answerSetVersion,
      postingHash,
      salary: metadata.salary,
      automationMode: metadata.automationMode,
      blockers: metadata.blockers,
      warnings: metadata.warnings,
      artifacts: metadata.artifacts,
      llmActions: metadata.llmActions,
      events: [initialEvent],
      createdAt: nowIso,
      updatedAt: nowIso,
      requirements: metadata.requirements,
      requiredFields: metadata.requiredFields,
      unresolvedChecks: metadata.unresolvedChecks
    };

    return { success: true, application };
  }

  async appendEvent(appId: string, eventType: string, message: string, executor?: QueryExecutor): Promise<ApplicationRecord> {
    await this.init();
    const apps = await this.getApplications();
    const app = apps.find(candidate => candidate.id === appId);
    if (!app) {
      throw new Error(`Application with ID ${appId} not found.`);
    }

    const nowIso = new Date().toISOString();
    const now = new Date(nowIso);
    const newEvent: TrackerEvent = { timestamp: nowIso, type: eventType, message };

    app.events.push(newEvent);
    app.updatedAt = nowIso;

    const metadata: ApplicationMetadata = {
      salary: app.salary ?? null,
      postingHash: app.postingHash ?? undefined,
      events: app.events,
      canonicalUrl: app.canonicalUrl ?? null,
      ats: app.ats ?? null,
      location: app.location ?? null,
      profileVersion: app.profileVersion ?? null,
      resumeVersion: app.resumeVersion ?? null,
      answerSetVersion: app.answerSetVersion ?? null,
      blockers: app.blockers || [],
      warnings: app.warnings || [],
      artifacts: app.artifacts || [],
      llmActions: app.llmActions || [],
      approval: app.approval ?? null,
      automationMode: app.automationMode,
      requirements: app.requirements || [],
      requiredFields: app.requiredFields || [],
      unresolvedChecks: app.unresolvedChecks || {},
      filledFields: app.filledFields || [],
      provenance: app.provenance || []
    };

    const runOperation = async (exec: QueryExecutor) => {
      await exec(
        `UPDATE applications SET updated_at = $1, metadata = $2 WHERE id = $3`,
        [now, JSON.stringify(metadata), appId]
      );

      await exec(
        `INSERT INTO run_events (id, run_id, application_id, event_type, status, message, payload, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [crypto.randomUUID(), crypto.randomUUID(), appId, eventType, app.status, message, JSON.stringify({ timestamp: nowIso }), now]
      );
    };

    if (executor) {
      await runOperation(executor);
    } else {
      await this.withTransaction(runOperation);
    }

    return app;
  }

  async updateStatus(appId: string, status: string): Promise<ApplicationRecord> {
    await this.init();
    const apps = await this.getApplications();
    const app = apps.find(candidate => candidate.id === appId);
    if (!app) {
      throw new Error(`Application with ID ${appId} not found.`);
    }
    const oldStatus = app.status;
    const normalizedStatus = normalizeApplicationStatus(status);
    return await this.withTransaction(async (exec) => {
      await exec(
        `UPDATE applications SET status = $1, updated_at = $2 WHERE id = $3`,
        [normalizedStatus, new Date(), appId]
      );
      app.status = normalizedStatus;
      return await this.appendEvent(appId, 'STATUS_CHANGED', `Status changed from ${oldStatus} to ${normalizedStatus}.`, exec);
    });
  }
  async appendLLMAction(appId: string, record: LLMActionRecord): Promise<ApplicationRecord> {
    await this.init();
    const apps = await this.getApplications();
    const app = apps.find(candidate => candidate.id === appId);
    if (!app) {
      throw new Error(`Application with ID ${appId} not found.`);
    }
    if (!app.llmActions) {
      app.llmActions = [];
    }
    app.llmActions.push(record);
    const nowIso = new Date().toISOString();
    const now = new Date(nowIso);
    app.updatedAt = nowIso;
    const metadata: ApplicationMetadata = {
      salary: app.salary ?? null,
      postingHash: app.postingHash ?? undefined,
      events: app.events,
      canonicalUrl: app.canonicalUrl ?? null,
      ats: app.ats ?? null,
      location: app.location ?? null,
      profileVersion: app.profileVersion ?? null,
      resumeVersion: app.resumeVersion ?? null,
      answerSetVersion: app.answerSetVersion ?? null,
      blockers: app.blockers || [],
      warnings: app.warnings || [],
      artifacts: app.artifacts || [],
      llmActions: app.llmActions,
      approval: app.approval ?? null,
      automationMode: app.automationMode,
      requirements: app.requirements || [],
      requiredFields: app.requiredFields || [],
      unresolvedChecks: app.unresolvedChecks || {},
      filledFields: app.filledFields || [],
      provenance: app.provenance || []
    };
    await this.withTransaction(async (exec) => {
      await exec(
        `UPDATE applications SET updated_at = $1, metadata = $2 WHERE id = $3`,
        [now, JSON.stringify(metadata), appId]
      );
    });
    return app;
  }
  async appendArtifact(appId: string, artifact: ApplicationArtifact): Promise<ApplicationRecord> {
    await this.init();
    const apps = await this.getApplications();
    const app = apps.find(candidate => candidate.id === appId);
    if (!app) {
      throw new Error(`Application with ID ${appId} not found.`);
    }
    if (!app.artifacts) {
      app.artifacts = [];
    }
    app.artifacts.push(artifact);
    const nowIso = new Date().toISOString();
    const now = new Date(nowIso);
    app.updatedAt = nowIso;
    const metadata: ApplicationMetadata = {
      salary: app.salary ?? null,
      postingHash: app.postingHash ?? undefined,
      events: app.events,
      canonicalUrl: app.canonicalUrl ?? null,
      ats: app.ats ?? null,
      location: app.location ?? null,
      profileVersion: app.profileVersion ?? null,
      resumeVersion: app.resumeVersion ?? null,
      answerSetVersion: app.answerSetVersion ?? null,
      blockers: app.blockers || [],
      warnings: app.warnings || [],
      artifacts: app.artifacts,
      llmActions: app.llmActions || [],
      approval: app.approval ?? null,
      automationMode: app.automationMode,
      requirements: app.requirements || [],
      requiredFields: app.requiredFields || [],
      unresolvedChecks: app.unresolvedChecks || {},
      filledFields: app.filledFields || [],
      provenance: app.provenance || []
    };
    await this.withTransaction(async (exec) => {
      await exec(
        `UPDATE applications SET updated_at = $1, metadata = $2 WHERE id = $3`,
        [now, JSON.stringify(metadata), appId]
      );
    });
    return app;
  }

  async recordSubmissionApproval(appId: string, approval: SubmissionApproval): Promise<ApplicationRecord> {
    await this.init();
    const apps = await this.getApplications();
    const app = apps.find(candidate => candidate.id === appId);
    if (!app) {
      throw new Error(`Application with ID ${appId} not found.`);
    }
    app.approval = approval;
    const nowIso = new Date().toISOString();
    const now = new Date(nowIso);
    app.updatedAt = nowIso;
    const metadata: ApplicationMetadata = {
      salary: app.salary ?? null,
      postingHash: app.postingHash ?? undefined,
      events: app.events,
      canonicalUrl: app.canonicalUrl ?? null,
      ats: app.ats ?? null,
      location: app.location ?? null,
      profileVersion: app.profileVersion ?? null,
      resumeVersion: app.resumeVersion ?? null,
      answerSetVersion: app.answerSetVersion ?? null,
      blockers: app.blockers || [],
      warnings: app.warnings || [],
      artifacts: app.artifacts || [],
      llmActions: app.llmActions || [],
      approval: app.approval ?? null,
      automationMode: app.automationMode,
      requirements: app.requirements || [],
      requiredFields: app.requiredFields || [],
      unresolvedChecks: app.unresolvedChecks || {},
      filledFields: app.filledFields || [],
      provenance: app.provenance || []
    };
    await this.withTransaction(async (exec) => {
      await exec(
        `UPDATE applications SET updated_at = $1, metadata = $2 WHERE id = $3`,
        [now, JSON.stringify(metadata), appId]
      );
    });
    return app;
  }

  async getMetricsSnapshot(): Promise<MetricsSnapshot> {
    await this.init();

    const appStatusCounts: Record<string, number> = {};
    const runEventCounts: Record<string, number> = {};
    const blockerCounts: Record<string, number> = {};
    const browserRunCounts: Record<string, number> = {
      success: 0,
      failed: 0,
      blocked: 0
    };
    const llmActionCounts: Record<string, number> = {};

    // 1. Query application status counts
    const statusRes = await this.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*) as count FROM applications GROUP BY status`
    );
    for (const row of statusRes.rows) {
      const status = sanitizeLabelValue(row.status);
      appStatusCounts[status] = (appStatusCounts[status] || 0) + parseInt(row.count, 10);
    }

    // 2. Query run events from the run_events table
    const eventRes = await this.query<{ event_type: string; count: string }>(
      `SELECT event_type, COUNT(*) as count FROM run_events GROUP BY event_type`
    );
    for (const row of eventRes.rows) {
      const eventType = sanitizeLabelValue(row.event_type);
      const count = parseInt(row.count, 10);
      runEventCounts[eventType] = (runEventCounts[eventType] || 0) + count;

      if (row.event_type === 'EXEC_STEP_SUCCESS') {
        browserRunCounts['success'] = (browserRunCounts['success'] || 0) + count;
      } else if (row.event_type === 'EXEC_STEP_FAILED') {
        browserRunCounts['failed'] = (browserRunCounts['failed'] || 0) + count;
      } else if (row.event_type === 'EXEC_STEP_BLOCKED') {
        browserRunCounts['blocked'] = (browserRunCounts['blocked'] || 0) + count;
      }
    }

    // 3. Query blockers from metadata JSONB array
    const blockerRes = await this.query<{ code: string; severity: string; count: string }>(
      `SELECT 
         elem->>'code' AS code, 
         COALESCE(elem->>'severity', 'fatal') AS severity, 
         COUNT(*) AS count
       FROM applications,
       LATERAL (
         SELECT elem FROM jsonb_array_elements(
           CASE 
             WHEN jsonb_typeof(metadata->'blockers') = 'array' THEN metadata->'blockers' 
             ELSE '[]'::jsonb 
           END
         ) AS elem
       ) AS sub
       GROUP BY code, severity`
    );
    for (const row of blockerRes.rows) {
      const code = sanitizeLabelValue(row.code);
      const severity = sanitizeLabelValue(row.severity);
      const count = parseInt(row.count, 10);
      const key = `${code}|${severity}`;
      blockerCounts[key] = (blockerCounts[key] || 0) + count;
    }

    // 4. Query llmActions from metadata JSONB array
    const llmRes = await this.query<{ type: string; status: string; count: string }>(
      `SELECT 
         elem->>'type' AS type, 
         elem->>'status' AS status, 
         COUNT(*) AS count
       FROM applications,
       LATERAL (
         SELECT elem FROM jsonb_array_elements(
           CASE 
             WHEN jsonb_typeof(metadata->'llmActions') = 'array' THEN metadata->'llmActions' 
             ELSE '[]'::jsonb 
           END
         ) AS elem
       ) AS sub
       GROUP BY type, status`
    );
    for (const row of llmRes.rows) {
      const type = sanitizeLabelValue(row.type);
      const status = sanitizeLabelValue(row.status);
      const count = parseInt(row.count, 10);
      const key = `${type}|${status}`;
      llmActionCounts[key] = (llmActionCounts[key] || 0) + count;

      if (row.type === 'browser_action') {
        browserRunCounts[status] = (browserRunCounts[status] || 0) + count;
      }
    }

    return {
      appStatusCounts,
      runEventCounts,
      blockerCounts,
      browserRunCounts,
      llmActionCounts
    };
  }

  private fallbackJobs: AutomationJob[] = [];

  private shouldUseFallback(): boolean {
    if (this.options.useFallback) return true;
    if (this.mockExecutor) return false;
    return !isDbConfigured() && !this.pool;
  }

  private async loadFallbackJobs(): Promise<AutomationJob[]> {
    const filePath = this.options.fallbackJobsFilePath || (process.env.APPLY_AGENT_DATA_DIR ? path.join(process.env.APPLY_AGENT_DATA_DIR, 'automation_jobs.json') : './data/automation_jobs.json');
    try {
      const data = await fs.readFile(filePath, 'utf8');
      this.fallbackJobs = JSON.parse(data) as AutomationJob[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.fallbackJobs = [];
      }
    }
    return this.fallbackJobs;
  }

  private async saveFallbackJobs(): Promise<void> {
    const filePath = this.options.fallbackJobsFilePath || (process.env.APPLY_AGENT_DATA_DIR ? path.join(process.env.APPLY_AGENT_DATA_DIR, 'automation_jobs.json') : './data/automation_jobs.json');
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(this.fallbackJobs, null, 2), 'utf8');
  }

  async enqueueJob(
    applicationId: string,
    payload: AutomationJob['payload'],
    maxAttempts: number = 3
  ): Promise<AutomationJob> {
    const id = crypto.randomUUID();
    const status = 'pending';
    const attempts = 0;
    
    if (this.shouldUseFallback()) {
      await this.loadFallbackJobs();
      const job: AutomationJob = {
        id,
        application_id: applicationId,
        status,
        payload,
        attempts,
        max_attempts: maxAttempts,
        locked_by: null,
        locked_at: null,
        error_message: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        finished_at: null
      };
      this.fallbackJobs.push(job);
      await this.saveFallbackJobs();
      return job;
    }

    const queryText = `
      INSERT INTO automation_jobs (id, application_id, status, payload, attempts, max_attempts, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      RETURNING *
    `;
    const res = await this.query<AutomationJobRow>(queryText, [id, applicationId, status, JSON.stringify(payload), attempts, maxAttempts]);
    const row = res.rows[0];
    if (!row) {
      throw new Error('Failed to insert automation job');
    }
    return rowToJob(row);
  }

  async claimJob(
    workerId: string,
    leaseDurationSec: number
  ): Promise<AutomationJob | null> {
    if (this.shouldUseFallback()) {
      await this.loadFallbackJobs();
      const now = new Date();
      const job = this.fallbackJobs.find(j => {
        if (j.attempts >= j.max_attempts) return false;
        if (j.status === 'pending') return true;
        if (j.status === 'processing' && j.locked_at) {
          const lockedTime = new Date(j.locked_at);
          const elapsed = (now.getTime() - lockedTime.getTime()) / 1000;
          return elapsed > leaseDurationSec;
        }
        return false;
      });

      if (!job) return null;
      job.status = 'processing';
      job.locked_by = workerId;
      job.locked_at = now.toISOString();
      job.attempts += 1;
      job.updated_at = now.toISOString();
      await this.saveFallbackJobs();
      return { ...job };
    }

    const queryText = `
      UPDATE automation_jobs
      SET status = 'processing',
          locked_by = $1,
          locked_at = NOW(),
          attempts = attempts + 1,
          updated_at = NOW()
      WHERE id = (
        SELECT id FROM automation_jobs
        WHERE (status = 'pending' OR (status = 'processing' AND locked_at < NOW() - $2 * INTERVAL '1 second'))
          AND attempts < max_attempts
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `;
    const res = await this.query<AutomationJobRow>(queryText, [workerId, leaseDurationSec]);
    if (!res.rows || res.rows.length === 0) return null;
    return rowToJob(res.rows[0]);
  }

  async completeJob(jobId: string): Promise<AutomationJob | null> {
    if (this.shouldUseFallback()) {
      await this.loadFallbackJobs();
      const job = this.fallbackJobs.find(j => j.id === jobId);
      if (!job) return null;
      const now = new Date().toISOString();
      job.status = 'completed';
      job.locked_by = null;
      job.locked_at = null;
      job.finished_at = now;
      job.updated_at = now;
      await this.saveFallbackJobs();
      return { ...job };
    }

    const queryText = `
      UPDATE automation_jobs
      SET status = 'completed',
          locked_by = NULL,
          locked_at = NULL,
          finished_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `;
    const res = await this.query<AutomationJobRow>(queryText, [jobId]);
    if (!res.rows || res.rows.length === 0) return null;
    return rowToJob(res.rows[0]);
  }

  async failJob(jobId: string, errorMsg: string): Promise<AutomationJob | null> {
    if (this.shouldUseFallback()) {
      await this.loadFallbackJobs();
      const job = this.fallbackJobs.find(j => j.id === jobId);
      if (!job) return null;
      const now = new Date().toISOString();
      job.status = job.attempts >= job.max_attempts ? 'failed' : 'pending';
      job.locked_by = null;
      job.locked_at = null;
      job.error_message = errorMsg;
      job.updated_at = now;
      if (job.status === 'failed') {
        job.finished_at = now;
      }
      await this.saveFallbackJobs();
      return { ...job };
    }

    const queryText = `
      UPDATE automation_jobs
      SET status = CASE WHEN attempts >= max_attempts THEN 'failed'::varchar ELSE 'pending'::varchar END,
          locked_by = NULL,
          locked_at = NULL,
          error_message = $2,
          updated_at = NOW(),
          finished_at = CASE WHEN attempts >= max_attempts THEN NOW() ELSE finished_at END
      WHERE id = $1
      RETURNING *
    `;
    const res = await this.query<AutomationJobRow>(queryText, [jobId, errorMsg]);
    if (!res.rows || res.rows.length === 0) return null;
    return rowToJob(res.rows[0]);
  }

  async getJob(jobId: string): Promise<AutomationJob | null> {
    if (this.shouldUseFallback()) {
      await this.loadFallbackJobs();
      const job = this.fallbackJobs.find(j => j.id === jobId);
      if (!job) return null;
      return { ...job };
    }

    const queryText = `
      SELECT * FROM automation_jobs WHERE id = $1
    `;
    const res = await this.query<AutomationJobRow>(queryText, [jobId]);
    if (!res.rows || res.rows.length === 0) return null;
    return rowToJob(res.rows[0]);
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    this.initialized = false;
  }
}
