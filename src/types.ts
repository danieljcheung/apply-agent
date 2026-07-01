import crypto from 'crypto';
export type CanonicalApplicationStatus =
  | 'received_link'
  | 'extracting_job'
  | 'job_extracted'
  | 'profile_matching'
  | 'blocked'
  | 'generating_resume'
  | 'creating_account'
  | 'verifying_email'
  | 'uploading_resume'
  | 'filling_identity'
  | 'filling_experience'
  | 'filling_education'
  | 'answering_questions'
  | 'waiting_for_user'
  | 'reviewing_application'
  | 'ready_to_submit'
  | 'submitting'
  | 'submitted'
  | 'confirmation_received'
  | 'rejected'
  | 'failed'
  | 'cancelled';

export type LegacyApplicationStatus =
  | 'draft'
  | 'planned'
  | 'ready_for_manual'
  | 'submitted_mock_for_test';

export type ApplicationStatus = CanonicalApplicationStatus | LegacyApplicationStatus;

export type BlockerCode =
  | 'unknown_required_answer'
  | 'unsupported_profile_claim'
  | 'salary_below_floor'
  | 'work_authorization_conflict'
  | 'sponsorship_ambiguity'
  | 'legal_certification_question'
  | 'eeo_policy_question'
  | 'captcha_required'
  | 'two_factor_required'
  | 'email_verification_required'
  | 'duplicate_application'
  | 'site_automation_disallowed'
  | 'low_match_confidence'
  | 'llm_output_requires_review'
  | 'missing_browser_credentials'
  | 'automation_not_configured'
  | 'missing_resume_artifact';

export type BlockerSeverity = 'fatal' | 'recoverable' | 'info';

export interface BlockerItem {
  code: BlockerCode;
  message: string;
  severity?: BlockerSeverity;
  source?: string;
  field?: string;
  details?: Record<string, unknown>;
  createdAt?: string;
}

export type AutomationMode =
  | 'auto'
  | 'semi_auto'
  | 'manual'
  | 'fill_and_review';

export type TrackerEventType = string;

export interface TrackerEvent {
  timestamp: string;
  type: TrackerEventType;
  message: string;
  status?: string;
  payload?: Record<string, unknown> | unknown;
  source?: string;
  actor?: string;
  applicationStatus?: ApplicationStatus;
}

export type ArtifactType =
  | 'resume_pdf'
  | 'resume_docx'
  | 'cover_letter'
  | 'screenshot'
  | 'dom_snapshot'
  | 'confirmation_receipt'
  | 'json_payload'
  | 'other';

export interface ArtifactProvenance {
  source: string;
  generator?: string;
  timestamp?: string;
  version?: string;
}

export interface ApplicationArtifact {
  id: string;
  type: ArtifactType;
  name: string;
  uri?: string;
  content?: string;
  mimeType?: string;
  hash?: string;
  createdAt: string;
  provenance?: ArtifactProvenance;
}
export interface ResumeArtifactMetadata {
  id: string;
  fileName: string;
  mimeType: string;
  hash: string;
  size: number;
  uploadedAt: string;
  path?: string;
  uri?: string;
}

export interface ResumeParseMetadata {
  parser: 'pdf-parse' | 'legacy-text-import';
  parserVersion: string;
  pageCount?: number;
  textHash: string;
  textLength: number;
  parsedAt: string;
}

export interface BaseResumeRecord extends ResumeArtifactMetadata {
  label: string;
  candidateProfile: CandidateProfile;
  claimBank: Claim[];
  parse: ResumeParseMetadata;
}

export interface BaseResumeSummary {
  id: string;
  fileName: string;
  label: string;
  mimeType: string;
  hash: string;
  size: number;
  uploadedAt: string;
  active: boolean;
  candidateName: string;
  candidateEmail: string;
  skillCount: number;
  claimCount: number;
  projectCount: number;
  parse: ResumeParseMetadata;
}

export type UploadedResumeInput = {
  fileName: string;
  contentBase64: string;
  mimeType: string;
  label?: string;
};

export interface VaultStatus {
  exists: boolean;
  initialized: boolean;
  locked: boolean;
}

export interface DataProvenance {
  source: string;
  extractedAt?: string;
  confidence?: number;
  author?: string;
  version?: string;
}

export interface FieldProvenance {
  field: string;
  source: string;
  confidence?: number;
  verifiedByHuman?: boolean;
}

export type LLMActionType =
  | 'job_extraction'
  | 'resume_tailoring'
  | 'question_answering'
  | 'profile_matching'
  | 'field_mapping'
  | 'browser_action';

export type LLMActionStatus =
  | 'pending'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'requires_human_review';

export interface LLMActionAudit {
  promptTokens?: number;
  completionTokens?: number;
  model?: string;
  latencyMs?: number;
  humanApproved?: boolean;
  reviewedBy?: string;
  reviewedAt?: string;
}

export interface LLMActionRecord {
  id: string;
  type: LLMActionType;
  status: LLMActionStatus;
  inputPayload?: unknown;
  outputPayload?: unknown;
  error?: string;
  audit?: LLMActionAudit;
  createdAt: string;
  completedAt?: string;
}

export interface SubmissionApproval {
  id: string;
  applicationId: string;
  approvedBy: string;
  approvedAt: string;
  fieldSnapshotHash: string;
  blockerSnapshotHash: string;
  reviewUrl?: string | null;
}

export function computeBlockerSnapshotHash(blockers?: BlockerItem[]): string {
  const normalized = (blockers || []).map(b => ({
    code: b.code || '',
    message: b.message || '',
    field: b.field || '',
    severity: b.severity || '',
    source: b.source || '',
    details: b.details ? JSON.stringify(b.details) : ''
  })).sort((a, b) => (a.code + a.field + a.message + a.source).localeCompare(b.code + b.field + b.message + b.source));
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function computeFieldSnapshotHash(app: Partial<ApplicationRecord>): string {
  const filledFields = [...(app.filledFields || [])].sort();
  const provenance = [...(app.provenance || [])].map(p => ({
    field: p.field || '',
    source: p.source || '',
    confidence: p.confidence ?? null,
    verifiedByHuman: p.verifiedByHuman ?? null
  })).sort((a, b) => (a.field + a.source).localeCompare(b.field + b.source));
  const artifacts = [...(app.artifacts || [])].map(a => ({
    id: a.id || '',
    type: a.type || '',
    name: a.name || '',
    hash: a.hash || '',
    uri: a.uri || '',
    mimeType: a.mimeType || ''
  })).sort((a, b) => (a.id + a.name + a.type).localeCompare(b.id + b.name + b.type));

  const normalized = {
    company: app.company || '',
    title: app.title || '',
    url: app.url || '',
    requiredFields: [...(app.requiredFields || [])].sort(),
    requirements: [...(app.requirements || [])].sort(),
    filledFields,
    provenance,
    artifacts
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export interface ApplicationRecord {
  id: string;
  url: string;
  company: string;
  title: string;
  status: ApplicationStatus | string;
  canonicalUrl?: string | null;
  ats?: string | null;
  location?: string | null;
  profileVersion?: string | null;
  resumeVersion?: string | null;
  answerSetVersion?: string | null;
  salary?: number | null;
  postingHash?: string | null;
  automationMode?: AutomationMode;
  blockers?: BlockerItem[];
  warnings?: string[];
  artifacts?: ApplicationArtifact[];
  llmActions?: LLMActionRecord[];
  approval?: SubmissionApproval | null;
  events: TrackerEvent[];
  createdAt: string;
  updatedAt: string;
  requirements?: string[];
  requiredFields?: string[];
  unresolvedChecks?: {
    captcha?: boolean;
    twoFactor?: boolean;
    emailVerification?: boolean;
  };
  filledFields?: string[];
  provenance?: FieldProvenance[];
}

export interface ExperienceEntry {
  title?: string;
  company?: string;
  description: string;
}

export interface EducationEntry {
  institution: string;
  details: string;
}

export interface ProjectEntry {
  id?: string;
  name?: string;
  title?: string;
  role?: string;
  description: string;
  technologies?: string[];
}

export interface CandidateProfile {
  name: string;
  email: string;
  phone?: string;
  skills: string[];
  experience: ExperienceEntry[];
  education: EducationEntry[];
  projects?: ProjectEntry[];
}

export interface Claim {
  id: string;
  text: string;
  category: string;
  value?: string;
  source?: string;
  approved?: boolean;
  context?: string;
  question?: string;
}

export interface AnswerMemory {
  [question: string]: string | { answer: string; scope?: string; source?: string };
}

export interface ProfileBundle {
  candidateProfile: CandidateProfile;
  claimBank: Claim[];
  answerMemory: AnswerMemory;
}

export interface ResumeEvidenceMapItem {
  requirement: string;
  supported: boolean;
  claims: Claim[];
}

export interface WorkdayPlanStep {
  id?: string;
  name: string;
  description: string;
  status?: string;
  blocker?: string;
  requiresCredentials?: boolean;
}

export interface WorkdayPlan {
  isWorkday?: boolean;
  tenant?: string | null;
  steps: WorkdayPlanStep[];
  blockedReasons?: string[];
  message?: string;
}

export interface SafetyGateResult {
  blocked: boolean;
  reasons: string[];
}

export interface ProtonBridgeConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  tls?: boolean;
  mailbox?: string;
  allowedRecipients?: string[];
}

const LEGACY_STATUS_MAP: Record<string, CanonicalApplicationStatus> = {
  draft: 'job_extracted',
  planned: 'ready_to_submit',
  ready_for_manual: 'reviewing_application',
  submitted_mock_for_test: 'submitted'
};

export const CANONICAL_STATUS_MAP: Record<string, true> = {
  received_link: true,
  extracting_job: true,
  job_extracted: true,
  profile_matching: true,
  blocked: true,
  generating_resume: true,
  creating_account: true,
  verifying_email: true,
  uploading_resume: true,
  filling_identity: true,
  filling_experience: true,
  filling_education: true,
  answering_questions: true,
  waiting_for_user: true,
  reviewing_application: true,
  ready_to_submit: true,
  submitting: true,
  submitted: true,
  confirmation_received: true,
  rejected: true,
  failed: true,
  cancelled: true
};

export const CANONICAL_APPLICATION_STATUSES: CanonicalApplicationStatus[] = Object.keys(CANONICAL_STATUS_MAP) as CanonicalApplicationStatus[];

export function isCanonicalApplicationStatus(status: string | null | undefined): status is CanonicalApplicationStatus {
  if (!status) return false;
  return status.trim().toLowerCase() in CANONICAL_STATUS_MAP;
}
export function normalizeApplicationStatus(status: string | null | undefined): CanonicalApplicationStatus {
  if (!status) return 'received_link';
  const clean = status.trim().toLowerCase();
  if (clean in CANONICAL_STATUS_MAP) {
    return clean as CanonicalApplicationStatus;
  }
  if (clean in LEGACY_STATUS_MAP) {
    return LEGACY_STATUS_MAP[clean];
  }
  return 'received_link';
}

const CANONICAL_BLOCKER_MAP: Record<string, true> = {
  unknown_required_answer: true,
  unsupported_profile_claim: true,
  salary_below_floor: true,
  work_authorization_conflict: true,
  sponsorship_ambiguity: true,
  legal_certification_question: true,
  eeo_policy_question: true,
  captcha_required: true,
  two_factor_required: true,
  email_verification_required: true,
  duplicate_application: true,
  site_automation_disallowed: true,
  low_match_confidence: true,
  llm_output_requires_review: true,
  missing_browser_credentials: true,
  automation_not_configured: true,
  missing_resume_artifact: true
};

export function normalizeBlockerCode(code: string | null | undefined): BlockerCode {
  if (!code) return 'unknown_required_answer';
  const clean = code.trim().toLowerCase();
  
  if (clean in CANONICAL_BLOCKER_MAP) {
    return clean as BlockerCode;
  }

  if (clean.includes('captcha') || clean.includes('unresolved_captcha')) {
    return 'captcha_required';
  }
  if (clean.includes('2fa') || clean.includes('twofactor') || clean.includes('unresolved_2fa')) {
    return 'two_factor_required';
  }
  if (clean.includes('email') || clean.includes('unresolved_email')) {
    return 'email_verification_required';
  }
  if (clean.includes('duplicate')) {
    return 'duplicate_application';
  }
  if (clean.includes('salary')) {
    return 'salary_below_floor';
  }
  if (clean.includes('unsupported') || clean.includes('missing_profile')) {
    return 'unsupported_profile_claim';
  }
  if (clean.includes('resume') || clean.includes('artifact')) {
    return 'missing_resume_artifact';
  }
  if (clean.includes('credentials')) {
    return 'missing_browser_credentials';
  }
  if (clean.includes('safety_gate') || clean.includes('sensitive')) {
    return 'llm_output_requires_review';
  }
  if (clean.includes('disallowed') || clean.includes('mock_not_allowed')) {
    return 'site_automation_disallowed';
  }
  if (clean.includes('invalid_workday') || clean.includes('bridge') || clean.includes('not_configured')) {
    return 'automation_not_configured';
  }
  if (clean.includes('auth') || clean.includes('authorization')) {
    return 'work_authorization_conflict';
  }
  if (clean.includes('sponsor') || clean.includes('sponsorship')) {
    return 'sponsorship_ambiguity';
  }
  if (clean.includes('legal') || clean.includes('certification')) {
    return 'legal_certification_question';
  }
  if (clean.includes('eeo')) {
    return 'eeo_policy_question';
  }
  if (clean.includes('confidence') || clean.includes('match')) {
    return 'low_match_confidence';
  }

  return 'unknown_required_answer';
}

export interface MetricsSnapshot {
  appStatusCounts: Record<string, number>;
  runEventCounts: Record<string, number>;
  blockerCounts: Record<string, number>;
  browserRunCounts: Record<string, number>;
  llmActionCounts: Record<string, number>;
}

export interface AutomationJob {
  id: string;
  application_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  payload: {
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
  locked_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

