import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { AppService } from './src/appService.js';
import { ProtonBridgeConnector, resolveProtonBridgeConfig, type ProtonBridgeConfigInput } from './src/protonBridge.js';
import type { ApplicationRecord, ProtonBridgeConfig } from './src/types.js';
import { TrackerLedger } from './src/tracker.js';
import { generatePrometheusMetrics, generatePrometheusMetricsFromSnapshot } from './src/metrics.js';
import { isDbConfigured, DatabaseService, bootstrapVault } from './src/db.js';
import { AutomationQueue } from './src/queue.js';
import type { AutomationRunMode } from './src/browser/contract.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type StartOptions = ConstructorParameters<typeof AppService>[0];
type RequestBody = Record<string, unknown>;

let server: Server | null = null;
let appServiceInstance: AppService | null = null;
let currentDataDir = './data';
let currentToken: string | null = null;
let startupAutoUnlockFailed = false;
const PROVIDER_MODELS: Record<string, string[]> = {
  'deepseek': ['deepseek-chat', 'deepseek-reasoner'],
  'openai-compatible': ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'o4-mini'],
  'kimi': ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  'local': ['llama3.1', 'qwen2.5', 'mistral', 'codellama']
};

function isRecord(value: unknown): value is RequestBody {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function jobDetailsValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function protonConfigValue(value: unknown): ProtonBridgeConfigInput | null {
  if (!isRecord(value)) return null;
  return {
    host: stringValue(value.host) || undefined,
    port: typeof value.port === 'number' || typeof value.port === 'string' ? value.port : undefined,
    username: stringValue(value.username) || undefined,
    password: stringValue(value.password) || undefined,
    simulateSuccess: typeof value.simulateSuccess === 'boolean' ? value.simulateSuccess : undefined,
    secure: typeof value.secure === 'boolean' ? value.secure : undefined,
    rejectUnauthorized: typeof value.rejectUnauthorized === 'boolean' ? value.rejectUnauthorized : undefined
  };
}

function getAllowedHosts(): string[] {
  const envVal = process.env.APPLY_AGENT_ALLOWED_HOSTS;
  if (!envVal) return [];
  return envVal.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}

function getAllowedOrigins(): string[] {
  const envVal = process.env.APPLY_AGENT_ALLOWED_ORIGINS;
  if (!envVal) return [];
  return envVal.split(',').map((o) => o.trim().toLowerCase()).filter(Boolean);
}

function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  let host = hostHeader.toLowerCase().trim();
  if (host.startsWith('[')) {
    const closingBracket = host.indexOf(']');
    if (closingBracket !== -1) {
      host = host.slice(0, closingBracket + 1);
    }
  } else {
    host = host.split(':')[0];
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') {
    return true;
  }
  const allowed = getAllowedHosts();
  return allowed.includes(host);
}

function isAllowedOrigin(originHeader: string | undefined): boolean {
  if (!originHeader) return true;
  const isProd = process.env.NODE_ENV === 'production';
  if (originHeader === 'null') {
    return !isProd;
  }
  try {
    const parsed = new URL(originHeader);
    const hostname = parsed.hostname.toLowerCase();
    if (!isProd) {
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1') {
        return true;
      }
    }
    const originLower = originHeader.toLowerCase();
    const allowed = getAllowedOrigins();
    return allowed.some((a) => a === hostname || a === originLower || a === parsed.origin.toLowerCase());
  } catch {
    return false;
  }
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const list: Record<string, string> = {};
  if (!cookieHeader) return list;
  for (const part of cookieHeader.split(';')) {
    const [key, ...valueParts] = part.split('=');
    const value = valueParts.join('=');
    if (key) {
      list[key.trim()] = value.trim();
    }
  }
  return list;
}

function getSessionCookieHeader(token: string | null): string {
  const isProd = process.env.NODE_ENV === 'production';
  if (token === null) {
    const parts = [
      'apply_agent_session=',
      'HttpOnly',
      'Path=/',
      'Max-Age=0',
      'SameSite=Strict'
    ];
    if (isProd) {
      parts.push('Secure');
    }
    return parts.join('; ');
  } else {
    const parts = [
      `apply_agent_session=${token}`,
      'HttpOnly',
      'Path=/',
      'Max-Age=86400',
      'SameSite=Strict'
    ];
    if (isProd) {
      parts.push('Secure');
    }
    return parts.join('; ');
  }
}

function getRequestToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth) {
    if (auth.toLowerCase().startsWith('bearer ')) {
      return auth.slice(7).trim();
    }
    return auth.trim();
  }
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const cookies = parseCookies(cookieHeader);
    if (cookies['apply_agent_session']) {
      return cookies['apply_agent_session'];
    }
  }
  return null;
}

function redactSecrets(text: string): string {
  if (!text) return '';
  let sanitized = String(text);
  if (currentToken) {
    sanitized = sanitized.split(currentToken).join('[REDACTED]');
  }
  sanitized = sanitized.replace(/(password|pass|token|secret|key|authorization|bearer|apikey|api_key)\s*[=:]\s*([^\s&",'}]+)/gi, '$1=[REDACTED]');
  sanitized = sanitized.replace(/bearer\s+([a-zA-Z0-9_\-\.]+)/gi, 'Bearer [REDACTED]');
  sanitized = sanitized.replace(/(postgres:\/\/[\w\-]+:)([^@]+)(@)/g, '$1[REDACTED]$3');
  return sanitized;
}

function sendJSON(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    if (statusCode >= 400 || obj.success === false) {
      const redactedObj = { ...obj };
      if (typeof redactedObj.error === 'string') {
        redactedObj.error = redactSecrets(redactedObj.error);
      }
      if (typeof redactedObj.message === 'string') {
        redactedObj.message = redactSecrets(redactedObj.message);
      }
      res.end(JSON.stringify(redactedObj));
      return;
    }
  }
  res.end(JSON.stringify(data));
}

function getLimitForRoute(urlPath: string | undefined): number {
  if (!urlPath) return 64 * 1024; // 64 KB default
  const pathname = urlPath.split('?')[0];
  if (
    pathname === '/api/profile/resume-upload' ||
    pathname === '/api/profile/upload-resume' ||
    pathname === '/api/resume/upload' ||
    pathname === '/api/profile/bootstrap' ||
    pathname === '/api/vault/create'
  ) {
    return 10 * 1024 * 1024; // 10 MB for resume upload/bootstrap/create
  }
  return 64 * 1024; // 64 KB default for all other routes
}

function getBody(req: IncomingMessage): Promise<RequestBody> {
  const { promise, resolve, reject } = Promise.withResolvers<RequestBody>();
  const urlPath = req.url;
  const limit = getLimitForRoute(urlPath);
  let body = '';
  let bytesReceived = 0;

  const onData = (chunk: Buffer) => {
    bytesReceived += chunk.length;
    if (bytesReceived > limit) {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      const err = new Error('Payload Too Large') as Error & { statusCode?: number };
      err.statusCode = 413;
      reject(err);
      return;
    }
    body += chunk.toString();
  };

  const onEnd = () => {
    try {
      const parsed = JSON.parse(body || '{}');
      resolve(isRecord(parsed) ? parsed : {});
    } catch {
      resolve({});
    }
  };

  const onError = (err: Error) => {
    reject(err);
  };

  req.on('data', onData);
  req.on('end', onEnd);
  req.on('error', onError);

  return promise;
}

async function handleMetrics(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  try {
    let snapshot;
    if (appServiceInstance) {
      snapshot = await appServiceInstance.tracker.getMetricsSnapshot();
    } else {
      const tracker = new TrackerLedger(path.join(currentDataDir, 'ledger.json'), { skipDb: true });
      try {
        snapshot = await tracker.getMetricsSnapshot();
      } finally {
        await tracker.close();
      }
    }
    const metricsOutput = generatePrometheusMetricsFromSnapshot(snapshot);
    res.writeHead(200);
    res.end(metricsOutput);
  } catch (err) {
    console.error('Error generating metrics:', err);
    res.writeHead(500);
    res.end('# Error generating metrics\n');
  }
}

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  res.setHeader('Content-Type', 'application/json');

  try {
    if (pathname === '/api/health' && req.method === 'GET') {
      sendJSON(res, 200, { status: 'ok', time: Date.now() });
      return;
    }

    if (pathname === '/api/ready' && req.method === 'GET') {
      let dataDirOk = false;
      try {
        await fs.access(currentDataDir, fs.constants.R_OK | fs.constants.W_OK);
        dataDirOk = true;
      } catch {}

      let dbOk: boolean | null = null;
      if (isDbConfigured()) {
        dbOk = false;
        try {
          if (appServiceInstance?.database) {
            await appServiceInstance.database.query('SELECT 1');
            dbOk = true;
          } else {
            const tempDb = new DatabaseService();
            try {
              await tempDb.query('SELECT 1');
              dbOk = true;
            } finally {
              await tempDb.close();
            }
          }
        } catch {
          dbOk = false;
        }
      }

      const isReady = dataDirOk && (dbOk === null || dbOk === true) && !startupAutoUnlockFailed;
      sendJSON(res, isReady ? 200 : 503, {
        status: isReady ? 'ok' : 'not_ready',
        dataDir: dataDirOk,
        database: dbOk,
        vaultReady: !startupAutoUnlockFailed,
        time: Date.now()
      });
      return;
    }

    const isHealthOrReady = pathname === '/api/health' || pathname === '/api/ready';
    const isAuthBootstrapRoute = pathname === '/api/vault/create' || pathname === '/api/vault/unlock' || pathname === '/api/profile/bootstrap';

    if (!isHealthOrReady && !isAuthBootstrapRoute) {
      if (pathname === '/api/state' || pathname === '/api/vault/status') {
        const reqToken = getRequestToken(req);
        if (currentToken) {
          if (!reqToken || reqToken !== currentToken) {
            sendJSON(res, 401, { success: false, error: 'Unauthorized: Invalid token' });
            return;
          }
        } else if (reqToken) {
          sendJSON(res, 401, { success: false, error: 'Unauthorized: Invalid token' });
          return;
        }
      } else {
        if (!currentToken) {
          sendJSON(res, 401, { success: false, error: 'Unauthorized: Vault session token required' });
          return;
        }
        const reqToken = getRequestToken(req);
        if (!reqToken || reqToken !== currentToken) {
          sendJSON(res, 401, { success: false, error: 'Unauthorized: Invalid token' });
          return;
        }
      }
    }

    if ((pathname === '/api/state' || pathname === '/api/vault/status') && req.method === 'GET') {
      const vaultPath = path.join(currentDataDir, 'vault.enc');
      let vaultExists = false;
      try {
        await fs.access(vaultPath);
        vaultExists = true;
      } catch {}

      if (!appServiceInstance) {
        sendJSON(res, 200, {
          success: true,
          exists: vaultExists,
          initialized: false,
          locked: vaultExists
        });
        return;
      }

      const vaultStatus = await appServiceInstance.getVaultStatus();
      if (vaultStatus.locked) {
        sendJSON(res, 200, {
          success: true,
          ...vaultStatus
        });
        return;
      }

      const state = await appServiceInstance.getState();
      const stateResponse = {
        success: true,
        ...vaultStatus,
        ...state
      };
      delete (stateResponse as Record<string, unknown>).token;
      sendJSON(res, 200, stateResponse);
      return;
    }

    if (pathname === '/api/vault/create' && req.method === 'POST') {
      const body = await getBody(req);
      const password = stringValue(body.password);
      const resumeText = stringValue(body.resumeText) || '';
      const interviewAnswers = isRecord(body.interviewAnswers) ? body.interviewAnswers as Record<string, string> : {};

      if (!password) {
        sendJSON(res, 400, { success: false, error: 'Password is required' });
        return;
      }

      if (currentToken) {
        sendJSON(res, 400, { success: false, error: 'Vault session already active' });
        return;
      }

      const vaultPath = path.join(currentDataDir, 'vault.enc');
      try {
        await fs.access(vaultPath);
        sendJSON(res, 400, { success: false, error: 'Vault already exists' });
        return;
      } catch {}

      appServiceInstance = new AppService({
        dataDir: currentDataDir,
        vaultPassword: password,
        adapter: (process.env.NODE_ENV !== 'production' && process.env.TEST_MODE === 'true') ? null : undefined
      });

      try {
        await appServiceInstance.createVault(password);

        if (resumeText || Object.keys(interviewAnswers).length > 0) {
          await appServiceInstance.updateProfile(resumeText, interviewAnswers);
        }
      } catch (err) {
        appServiceInstance = null;
        currentToken = null;
        throw err;
      }

      currentToken = crypto.randomUUID();
      const state = await appServiceInstance.getState();
      res.setHeader('Set-Cookie', getSessionCookieHeader(currentToken));
      const resObj: Record<string, unknown> = {
        success: true,
        message: 'Vault created successfully',
        ...state
      };
      if (process.env.NODE_ENV !== 'production') {
        resObj.token = currentToken;
      }
      sendJSON(res, 200, resObj);
      return;
    }

    if (pathname === '/api/vault/unlock' && req.method === 'POST') {
      const body = await getBody(req);
      const password = stringValue(body.password);
      if (!password) {
        sendJSON(res, 400, { success: false, error: 'Password is required' });
        return;
      }

      const vaultPath = path.join(currentDataDir, 'vault.enc');
      try {
        await fs.access(vaultPath);
      } catch {
        sendJSON(res, 400, { success: false, error: 'Vault does not exist' });
        return;
      }

      appServiceInstance = new AppService({
        dataDir: currentDataDir,
        vaultPassword: password,
        adapter: (process.env.NODE_ENV !== 'production' && process.env.TEST_MODE === 'true') ? null : undefined
      });

      try {
        await appServiceInstance.unlock(password);
      } catch (err) {
        appServiceInstance = null;
        currentToken = null;
        sendJSON(res, 401, { success: false, error: 'Invalid password' });
        return;
      }

      currentToken = crypto.randomUUID();
      const state = await appServiceInstance.getState();
      res.setHeader('Set-Cookie', getSessionCookieHeader(currentToken));
      const resObj: Record<string, unknown> = {
        success: true,
        exists: true,
        locked: false,
        message: 'Vault unlocked successfully',
        ...state
      };
      if (process.env.NODE_ENV !== 'production') {
        resObj.token = currentToken;
      }
      sendJSON(res, 200, resObj);
      return;
    }

    if (pathname === '/api/vault/lock' && req.method === 'POST') {
      if (appServiceInstance) {
        await appServiceInstance.close();
        appServiceInstance.lock();
        appServiceInstance = null;
      }
      currentToken = null;
      res.setHeader('Set-Cookie', getSessionCookieHeader(null));
      sendJSON(res, 200, { success: true, locked: true, message: 'Vault locked successfully' });
      return;
    }

    if (pathname === '/api/profile/bootstrap' && req.method === 'POST') {
      const body = await getBody(req);
      const password = stringValue(body.password);
      const resumeText = stringValue(body.resumeText) || '';
      const interviewAnswers = isRecord(body.interviewAnswers) ? body.interviewAnswers as Record<string, string> : {};

      if (!password) {
        sendJSON(res, 400, { success: false, error: 'Password is required' });
        return;
      }

      const vaultPath = path.join(currentDataDir, 'vault.enc');
      let vaultExists = false;
      try {
        await fs.access(vaultPath);
        vaultExists = true;
      } catch {}

      appServiceInstance = new AppService({
        dataDir: currentDataDir,
        vaultPassword: password,
        adapter: (process.env.NODE_ENV !== 'production' && process.env.TEST_MODE === 'true') ? null : undefined
      });

      if (!vaultExists) {
        try {
          await appServiceInstance.createVault(password);
        } catch (err) {
          appServiceInstance = null;
          currentToken = null;
          throw err;
        }
      } else {
        try {
          await appServiceInstance.unlock(password);
        } catch (err) {
          appServiceInstance = null;
          currentToken = null;
          sendJSON(res, 401, { success: false, error: 'Invalid password' });
          return;
        }
      }

      if (resumeText || Object.keys(interviewAnswers).length > 0) {
        try {
          await appServiceInstance.updateProfile(resumeText, interviewAnswers);
        } catch (err) {
          appServiceInstance = null;
          currentToken = null;
          throw err;
        }
      }

      currentToken = crypto.randomUUID();
      const state = await appServiceInstance.getState();
      res.setHeader('Set-Cookie', getSessionCookieHeader(currentToken));
      const resObj: Record<string, unknown> = {
        success: true,
        initialized: true,
        locked: false,
        ...state
      };
      if (process.env.NODE_ENV !== 'production') {
        resObj.token = currentToken;
      }
      sendJSON(res, 200, resObj);
      return;
    }

    if (!appServiceInstance || (await appServiceInstance.getVaultStatus()).locked) {
      sendJSON(res, 401, { success: false, error: 'Vault is locked. Bootstrap or unlock first.' });
      return;
    }

    if ((pathname === '/api/profile' || pathname === '/api/profile/update') && (req.method === 'POST' || req.method === 'PUT')) {
      const body = await getBody(req);
      const resumeText = stringValue(body.resumeText) || '';
      const interviewAnswers = isRecord(body.interviewAnswers) ? body.interviewAnswers as Record<string, string> : {};

      const profile = await appServiceInstance.updateProfile(resumeText, interviewAnswers);
      sendJSON(res, 200, { success: true, profile, answerMemory: profile.answerMemory });
      return;
    }

    if ((pathname === '/api/profile/resume-upload' || pathname === '/api/profile/upload-resume' || pathname === '/api/resume/upload') && req.method === 'POST') {
      const body = await getBody(req);
      if (!body || !isRecord(body) || !('resumes' in body) || !Array.isArray(body.resumes) || body.resumes.length === 0) {
        sendJSON(res, 400, { success: false, error: 'resumes[] with PDF contentBase64 is required' });
        return;
      }

      try {
        const activeResumeId = 'activeResumeId' in body && typeof body.activeResumeId === 'string' ? body.activeResumeId : undefined;
        const rawResumes = body.resumes as unknown[];
        const inputs = rawResumes.map((r) => {
          if (r && typeof r === 'object') {
            return {
              fileName: 'fileName' in r && typeof r.fileName === 'string' ? r.fileName : '',
              contentBase64: 'contentBase64' in r && typeof r.contentBase64 === 'string' ? r.contentBase64 : '',
              mimeType: 'mimeType' in r && typeof r.mimeType === 'string' ? r.mimeType : '',
              label: 'label' in r && typeof r.label === 'string' ? r.label : undefined
            };
          }
          return { fileName: '', contentBase64: '', mimeType: '' };
        });

        const imported = await appServiceInstance.importResumeArtifacts(inputs, activeResumeId);
        sendJSON(res, 200, { success: true, resumes: imported.resumes, activeResumeId: imported.activeResumeId, profile: imported.profile });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to import resumes';
        sendJSON(res, 400, { success: false, error: message });
      }
      return;
    }

    if (pathname === '/api/profile/resumes/select' && req.method === 'POST') {
      const body = await getBody(req);
      const resumeId = stringValue(body.resumeId);
      if (!resumeId) {
        sendJSON(res, 400, { success: false, error: 'Unknown resumeId' });
        return;
      }
      try {
        const result = await appServiceInstance.setActiveResume(resumeId);
        sendJSON(res, 200, {
          success: true,
          activeResumeId: result.activeResumeId,
          resumes: result.resumes,
          profile: result.profile
        });
      } catch (err) {
        sendJSON(res, 400, { success: false, error: 'Unknown resumeId' });
      }
      return;
    }

    if (pathname === '/api/applications' && req.method === 'POST') {
      const body = await getBody(req);
      const url = stringValue(body.url);
      if (!url) {
        sendJSON(res, 400, { success: false, error: 'URL is required' });
        return;
      }
      const result = await appServiceInstance.createApplication(url, jobDetailsValue(body.jobDetails));
      sendJSON(res, result.success ? 200 : 400, result);
      return;
    }

    if (pathname === '/api/prompts/answer' && req.method === 'POST') {
      const body = await getBody(req);
      const appId = stringValue(body.appId);
      const promptId = stringValue(body.promptId);
      const question = stringValue(body.question);
      const answer = typeof body.answer === 'string' ? body.answer : null;
      if (!appId || !promptId || !question || answer === null) {
        sendJSON(res, 400, { success: false, error: 'appId, promptId, question, and answer are required' });
        return;
      }
      await appServiceInstance.answerPrompt(appId, promptId, question, answer);
      sendJSON(res, 200, { success: true, message: 'Prompt answered successfully.' });
      return;
    }

    if (pathname === '/api/applications/approve' && req.method === 'POST') {
      const body = await getBody(req);
      const appId = stringValue(body.appId);
      if (!appId) {
        sendJSON(res, 400, { success: false, error: 'appId is required' });
        return;
      }
      const approved = typeof body.approved === 'boolean' ? body.approved : undefined;
      const approvedBy = stringValue(body.approvedBy) || undefined;
      const reviewUrl = stringValue(body.reviewUrl) || undefined;
      const isServerSideTestMode =
        process.env.NODE_ENV !== 'production' &&
        (process.env.TEST_MODE === 'true' ||
         appServiceInstance?.options?.testMode === true ||
         appServiceInstance?.options?.adapter !== undefined);

      const mode = typeof body.mode === 'string' ? (body.mode as AutomationRunMode) : undefined;
      const testMode = isServerSideTestMode && typeof body.testMode === 'boolean' ? body.testMode : undefined;
      const inline = isServerSideTestMode && typeof body.inline === 'boolean' ? body.inline : undefined;

      const adapterOverride = (process.env.NODE_ENV !== 'production' && process.env.TEST_MODE === 'true') ? {
        runtime: 'playwright' as const,
        inspect: async () => ({ success: true, state: 'success' as const }),
        fillDraft: async () => ({ success: true, state: 'reviewing_application' as const }),
        submitApproved: async () => ({ success: true, state: 'submitted' as const, message: 'Submitted via test adapter' })
      } as unknown as NonNullable<Parameters<AppService['approveSubmission']>[1]>['adapter'] : undefined;

      const result = await appServiceInstance.approveSubmission(appId, {
        approved,
        approvedBy,
        reviewUrl,
        mode,
        testMode,
        inline,
        adapter: adapterOverride
      });
      sendJSON(res, result.success ? 200 : 400, result);
      return;
    }

    if (pathname === '/api/jobs/status' && req.method === 'GET') {
      const parsedUrl = new URL(req.url || '', 'http://localhost');
      const jobId = parsedUrl.searchParams.get('id');
      if (!jobId) {
        sendJSON(res, 400, { success: false, error: 'Job ID is required' });
        return;
      }
      if (!appServiceInstance?.database) {
        sendJSON(res, 500, { success: false, error: 'Database service is not initialized' });
        return;
      }
      const queue = new AutomationQueue(appServiceInstance.database);
      const job = await queue.getJob(jobId);
      if (!job) {
        sendJSON(res, 404, { success: false, error: 'Job not found' });
        return;
      }
      sendJSON(res, 200, {
        success: true,
        job: {
          id: job.id,
          application_id: job.application_id,
          status: job.status,
          attempts: job.attempts,
          max_attempts: job.max_attempts,
          locked_by: job.locked_by,
          locked_at: job.locked_at,
          error_message: job.error_message,
          created_at: job.created_at,
          updated_at: job.updated_at,
          finished_at: job.finished_at,
          payload: job.payload
        }
      });
      return;
    }

    if (pathname === '/api/applications/reject' && req.method === 'POST') {
      const body = await getBody(req);
      const appId = stringValue(body.appId);
      if (!appId) {
        sendJSON(res, 400, { success: false, error: 'appId is required' });
        return;
      }
      await appServiceInstance.tracker.updateStatus(appId, 'rejected');
      await appServiceInstance.tracker.appendEvent(appId, 'USER_REJECTED', 'User rejected the application plan.');
      sendJSON(res, 200, { success: true, message: 'Application plan rejected by user.' });
      return;
    }

    if (pathname === '/api/settings/proton-bridge' && req.method === 'POST') {
      const body = await getBody(req);
      const config = protonConfigValue(body.config);
      if (!config) {
        sendJSON(res, 400, { success: false, error: 'Proton configuration is required' });
        return;
      }

      const resolvedConfig = resolveProtonBridgeConfig(config);
      const connector = new ProtonBridgeConnector(resolvedConfig);
      if (!connector.testConfig(resolvedConfig)) {
        sendJSON(res, 400, { success: false, error: 'Invalid configuration keys (host, port, username, password are required)' });
        return;
      }

      if (!resolvedConfig || resolvedConfig.simulateSuccess === false) {
        try {
          const conn = (await connector.connect()) as { connected?: boolean; success?: boolean; blocker?: string; message?: string } | null;
          if (conn && (conn.connected === false || conn.success === false)) {
            sendJSON(res, 400, {
              success: false,
              error: conn.message || `Failed to connect to Proton Bridge at ${resolvedConfig.host}:${resolvedConfig.port}.`,
              blocker: conn.blocker || 'BRIDGE_UNAVAILABLE'
            });
            return;
          }
        } catch (err) {
          sendJSON(res, 400, {
            success: false,
            error: connector.redactError(err instanceof Error ? err.message : String(err)),
            blocker: 'BRIDGE_UNAVAILABLE'
          });
          return;
        } finally {
          await connector.close();
        }
      }

      await appServiceInstance.setProtonConfig(resolvedConfig as ProtonBridgeConfig);
      sendJSON(res, 200, { success: true, message: 'Proton Bridge configuration updated successfully.' });
      return;
    }

    if (pathname === '/api/settings/credentials' && req.method === 'POST') {
      const body = await getBody(req);
      const username = stringValue(body.username);
      const password = stringValue(body.password);
      if (!username || !password) {
        sendJSON(res, 400, { success: false, error: 'username and password are required' });
        return;
      }
      await appServiceInstance.setCredentials(username, password);
      sendJSON(res, 200, { success: true, message: 'Workday credentials updated successfully.' });
      return;
    }
    if (pathname === '/api/settings/llm/providers' && req.method === 'GET') {
      const providers = await appServiceInstance.getLLMProviders();
      sendJSON(res, 200, { success: true, providers });
      return;
    }

    if (pathname === '/api/settings/llm/providers' && req.method === 'POST') {
      const body = await getBody(req);
      const providerObj = isRecord(body.provider) ? body.provider : body;
      const id = stringValue(providerObj.id) || `provider_${Date.now()}`;
      const name = stringValue(providerObj.name) || id;
      const kind = (stringValue(providerObj.kind) || 'openai-compatible') as any;
      const model = stringValue(providerObj.model) || 'gpt-4o-mini';
      const baseUrl = stringValue(providerObj.baseUrl) || undefined;
      const apiKeyRef = stringValue(providerObj.apiKeyRef) || undefined;
      const isActive = typeof providerObj.isActive === 'boolean' ? providerObj.isActive : true;
      const apiKey = stringValue(body.apiKey) || stringValue(providerObj.apiKey) || undefined;

      if (!(kind in PROVIDER_MODELS)) {
        sendJSON(res, 400, {
          success: false,
          error: `Invalid provider kind: ${kind}`
        });
        return;
      }
      if (!PROVIDER_MODELS[kind].includes(model)) {
        sendJSON(res, 400, {
          success: false,
          error: `Invalid model: "${model}" is not supported for provider kind "${kind}".`
        });
        return;
      }

      const result = await appServiceInstance.saveLLMProvider(
        { id, name, kind, model, baseUrl, apiKeyRef, isActive },
        apiKey
      );
      sendJSON(res, 200, result);
      return;
    }

    if (pathname === '/api/settings/llm/test' && req.method === 'POST') {
      const body = await getBody(req);
      const providerId = stringValue(body.providerId) || stringValue(body.id);
      if (!providerId) {
        sendJSON(res, 400, { success: false, error: 'providerId is required' });
        return;
      }
      const result = await appServiceInstance.testLLMProvider(providerId);
      sendJSON(res, result.success ? 200 : 400, result);
      return;
    }

    if (pathname === '/api/applications/tailor-resume' && req.method === 'POST') {
      const body = await getBody(req);
      const appId = stringValue(body.appId) || stringValue(body.id);
      if (!appId) {
        sendJSON(res, 400, { success: false, error: 'appId is required' });
        return;
      }
      const result = await appServiceInstance.tailorResumeForApplication(appId);
      sendJSON(res, result.success ? 200 : 400, result);
      return;
    }

    sendJSON(res, 404, { error: `Not Found: ${pathname}` });
  } catch (err) {
    console.error('API Error:', err);
    const statusCode = (err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number') ? err.statusCode : 500;
    const errorMsg = statusCode === 413 ? 'Payload Too Large' : 'Internal Server Error';
    sendJSON(res, statusCode, { error: errorMsg, message: err instanceof Error ? err.message : String(err) });
    if (statusCode === 413) {
      res.on('finish', () => {
        req.destroy();
      });
    }
  }
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  const relative = path.relative(path.join(__dirname, 'public'), filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const stats = await fs.stat(filePath);
    if (stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
  } catch {
    filePath = path.join(__dirname, 'public', 'index.html');
  }

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    let contentType = 'text/html';
    if (ext === '.css') contentType = 'text/css';
    else if (ext === '.js') contentType = 'application/javascript';
    else if (ext === '.json') contentType = 'application/json';
    else if (ext === '.png') contentType = 'image/png';
    else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
    else if (ext === '.svg') contentType = 'image/svg+xml';
    else if (ext === '.ico') contentType = 'image/x-icon';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

export async function startServer(port = 3010, options: StartOptions = {}): Promise<Server> {
  if (server) {
    return server;
  }

  startupAutoUnlockFailed = false;

  const dataDir = options.dataDir || process.env.APPLY_AGENT_DATA_DIR || './data';
  currentDataDir = dataDir;

  const vaultPath = path.join(dataDir, 'vault.enc');
  let vaultExists = false;
  try {
    await fs.access(vaultPath);
    vaultExists = true;
  } catch {}

  const envVaultPassword = process.env.VAULT_PASSWORD;
  if (envVaultPassword) {
    if (!appServiceInstance) {
      appServiceInstance = new AppService({
        ...options,
        dataDir,
        vaultPassword: envVaultPassword,
        adapter: process.env.TEST_MODE === 'true' ? null : options.adapter
      });
    }
    try {
      await bootstrapVault(appServiceInstance, envVaultPassword, vaultPath);
      currentToken = crypto.randomUUID();
      startupAutoUnlockFailed = false;
    } catch (err) {
      console.error('Failed auto-bootstrapping vault with VAULT_PASSWORD:', err);
      appServiceInstance = null;
      currentToken = null;
      startupAutoUnlockFailed = true;
    }
  } else if (!vaultExists) {
    appServiceInstance = new AppService({
      ...options,
      dataDir,
      adapter: process.env.TEST_MODE === 'true' ? null : options.adapter
    });
  }

  server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const isOperationalEndpoint = pathname === '/api/health' || pathname === '/api/ready' || pathname === '/metrics';

    // 1. Host validation (DNS Rebinding protection)
    if (!isOperationalEndpoint) {
      const host = req.headers.host;
      if (!isAllowedHost(host)) {
        res.writeHead(400);
        res.end('Invalid Host');
        return;
      }
    }

    // 2. Origin validation and CORS headers (no wildcard CORS)
    const origin = req.headers.origin;
    if (origin) {
      const isAllowed = isAllowedOrigin(origin);

      if (!isAllowed) {
        res.writeHead(403);
        res.end('Forbidden Origin');
        return;
      }

      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/metrics' && req.method === 'GET') {
      await handleMetrics(req, res);
      return;
    }
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
      return;
    }
    await serveStatic(pathname, res);
  });

  const { promise, resolve } = Promise.withResolvers<Server>();
  server.listen(port, () => {
    if (!server) {
      throw new Error('Server closed before listen callback completed.');
    }
    console.log(`Server running at http://localhost:${port}/`);
    resolve(server);
  });
  return promise;
}

export async function stopServer(): Promise<void> {
  if (!server) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(async () => {
    const service = appServiceInstance;
    server = null;
    appServiceInstance = null;
    currentToken = null;
    startupAutoUnlockFailed = false;
    if (service) {
      await service.close();
    }
    resolve();
  });
  return promise;
}

export function getAppService(): AppService | null {
  return appServiceInstance;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.APPLY_AGENT_PORT || process.env.PORT || 3010);
  const dataDir = process.env.APPLY_AGENT_DATA_DIR || './data';
  startServer(port, { dataDir }).catch((error) => {
    console.error('Failed to start Apply Agent server:', error);
    process.exit(1);
  });
}
