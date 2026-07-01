import type { ApplicationRecord, MetricsSnapshot } from './types.js';

/**
 * Sanitizes and redacts metric label values to prevent exposing secrets,
 * emails, URLs, candidate names, or free-form text.
 */
export function sanitizeLabelValue(value: string | undefined | null): string {
  if (value === undefined || value === null) {
    return 'unknown';
  }

  const str = String(value).trim();
  if (str.length === 0) {
    return 'unknown';
  }

  // Reject anything containing secret/sensitive keywords
  const lower = str.toLowerCase();
  if (
    lower.includes('secret') ||
    lower.includes('password') ||
    lower.includes('passwd') ||
    lower.includes('token') ||
    lower.includes('bearer') ||
    lower.includes('credential') ||
    lower.includes('api_key') ||
    lower.includes('apikey') ||
    lower.includes('private_key') ||
    lower.includes('secret_key') ||
    lower.includes('access_token') ||
    lower.includes('authorization')
  ) {
    return 'redacted';
  }

  // Reject emails, URLs, or web protocols
  if (
    str.includes('@') ||
    str.includes('://') ||
    str.toLowerCase().includes('www.')
  ) {
    return 'redacted';
  }

  // Reject free-form text with spaces, punctuation (other than _ and -), or extreme length
  if (/\s/.test(str) || /[^\w-]/.test(str) || str.length > 64) {
    return 'redacted';
  }

  // Must match a strict identifier pattern (letters, numbers, underscores, hyphens)
  if (!/^[a-zA-Z0-9_-]+$/.test(str)) {
    return 'redacted';
  }

  return str;
}

/**
 * Calculates aggregate metric counts from an array of ApplicationRecord in memory.
 */
export function calculateMetricsSnapshot(applications: ApplicationRecord[] = []): MetricsSnapshot {
  const appStatusCounts: Record<string, number> = {};
  const runEventCounts: Record<string, number> = {};
  const blockerCounts: Record<string, number> = {};
  const browserRunCounts: Record<string, number> = {
    success: 0,
    failed: 0,
    blocked: 0
  };
  const llmActionCounts: Record<string, number> = {};

  for (const app of applications) {
    if (!app) continue;

    const status = sanitizeLabelValue(app.status);
    appStatusCounts[status] = (appStatusCounts[status] || 0) + 1;

    if (Array.isArray(app.events)) {
      for (const ev of app.events) {
        if (!ev) continue;
        const eventType = sanitizeLabelValue(ev.type);
        runEventCounts[eventType] = (runEventCounts[eventType] || 0) + 1;

        if (ev.type === 'EXEC_STEP_SUCCESS') {
          browserRunCounts['success'] = (browserRunCounts['success'] || 0) + 1;
        } else if (ev.type === 'EXEC_STEP_FAILED') {
          browserRunCounts['failed'] = (browserRunCounts['failed'] || 0) + 1;
        } else if (ev.type === 'EXEC_STEP_BLOCKED') {
          browserRunCounts['blocked'] = (browserRunCounts['blocked'] || 0) + 1;
        }
      }
    }

    if (Array.isArray(app.blockers)) {
      for (const b of app.blockers) {
        if (!b) continue;
        const code = sanitizeLabelValue(b.code);
        const severity = sanitizeLabelValue(b.severity || 'fatal');
        const key = `${code}|${severity}`;
        blockerCounts[key] = (blockerCounts[key] || 0) + 1;
      }
    }

    if (Array.isArray(app.llmActions)) {
      for (const act of app.llmActions) {
        if (!act) continue;
        const actionType = sanitizeLabelValue(act.type);
        const actStatus = sanitizeLabelValue(act.status);
        const key = `${actionType}|${actStatus}`;
        llmActionCounts[key] = (llmActionCounts[key] || 0) + 1;

        if (act.type === 'browser_action') {
          const bStatus = sanitizeLabelValue(act.status);
          browserRunCounts[bStatus] = (browserRunCounts[bStatus] || 0) + 1;
        }
      }
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

/**
 * Generates Prometheus text format metrics from an aggregated MetricsSnapshot.
 */
export function generatePrometheusMetricsFromSnapshot(snapshot: MetricsSnapshot): string {
  const lines: string[] = [];

  const appStatusCounts: Record<string, number> = {
    received_link: 0,
    blocked: 0,
    waiting_for_user: 0,
    reviewing_application: 0,
    ready_to_submit: 0,
    submitted: 0,
    rejected: 0,
    failed: 0,
    draft: 0,
    ...snapshot.appStatusCounts
  };

  const runEventCounts = snapshot.runEventCounts;
  const blockerCounts = snapshot.blockerCounts;
  const browserRunCounts: Record<string, number> = {
    success: 0,
    failed: 0,
    blocked: 0,
    ...snapshot.browserRunCounts
  };
  const llmActionCounts = snapshot.llmActionCounts;

  lines.push('# HELP apply_agent_applications_total Total count of job applications by status.');
  lines.push('# TYPE apply_agent_applications_total gauge');
  for (const [status, count] of Object.entries(appStatusCounts)) {
    lines.push(`apply_agent_applications_total{status="${status}"} ${count}`);
  }
  lines.push('');

  lines.push('# HELP apply_agent_run_events_total Total count of run events by event type.');
  lines.push('# TYPE apply_agent_run_events_total counter');
  for (const [eventType, count] of Object.entries(runEventCounts)) {
    lines.push(`apply_agent_run_events_total{event_type="${eventType}"} ${count}`);
  }
  lines.push('');

  lines.push('# HELP apply_agent_safety_blockers_total Total count of safety blockers by code and severity.');
  lines.push('# TYPE apply_agent_safety_blockers_total counter');
  for (const [key, count] of Object.entries(blockerCounts)) {
    const [code, severity] = key.split('|');
    lines.push(`apply_agent_safety_blockers_total{code="${code}",severity="${severity}"} ${count}`);
  }
  lines.push('');

  lines.push('# HELP apply_agent_browser_runs_total Total count of browser runs by status.');
  lines.push('# TYPE apply_agent_browser_runs_total counter');
  for (const [status, count] of Object.entries(browserRunCounts)) {
    lines.push(`apply_agent_browser_runs_total{status="${status}"} ${count}`);
  }
  lines.push('');

  lines.push('# HELP apply_agent_llm_actions_total Total count of LLM actions by action type and status.');
  lines.push('# TYPE apply_agent_llm_actions_total counter');
  for (const [key, count] of Object.entries(llmActionCounts)) {
    const [actionType, status] = key.split('|');
    lines.push(`apply_agent_llm_actions_total{action_type="${actionType}",status="${status}"} ${count}`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Generates Prometheus text format metrics from application records (legacy/in-memory fallback).
 */
export function generatePrometheusMetrics(applications: ApplicationRecord[] = []): string {
  const snapshot = calculateMetricsSnapshot(applications);
  return generatePrometheusMetricsFromSnapshot(snapshot);
}
