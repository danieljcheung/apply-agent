import type { ApplicationRecord, BlockerCode, ProfileBundle, FieldProvenance } from '../types.js';

export type AutomationRuntime = 'playwright' | 'agent-browser';
export type AutomationRunMode = 'inspect_only' | 'fill_review_only' | 'submit_after_approval';

export interface BrowserCredentials {
  username?: string;
  password?: string;
}

export interface BrowserBlockerFinding {
  code: BlockerCode | string;
  message: string;
  severity?: 'fatal' | 'recoverable' | 'info';
}

export interface InspectInput {
  application?: ApplicationRecord;
  url?: string;
  credentials?: BrowserCredentials | null;
  profile?: ProfileBundle | null;
  mode?: AutomationRunMode;
  artifactDir?: string;
  resumePath?: string;
}

export interface InspectOutput {
  success: boolean;
  state?: 'inspecting' | 'reviewing_application' | 'blocked';
  blocker?: BlockerCode | string;
  message?: string;
  details?: Record<string, unknown>;
  blockers?: BrowserBlockerFinding[];
}

export interface FillDraftInput {
  application?: ApplicationRecord;
  url?: string;
  credentials?: BrowserCredentials | null;
  profile?: ProfileBundle | null;
  mode?: AutomationRunMode;
  artifactDir?: string;
  resumePath?: string;
}

export interface FillDraftOutput {
  success: boolean;
  state?: 'reviewing_application' | 'blocked';
  blocker?: BlockerCode | string;
  message?: string;
  filledFields?: string[];
  provenance?: FieldProvenance[];
  details?: Record<string, unknown>;
  blockers?: BrowserBlockerFinding[];
}

export interface SubmitApprovedInput {
  application?: ApplicationRecord;
  url?: string;
  credentials?: BrowserCredentials | null;
  profile?: ProfileBundle | null;
  approved: boolean;
  mode?: AutomationRunMode;
  artifactDir?: string;
  resumePath?: string;
}

export interface SubmitApprovedOutput {
  success: boolean;
  state?: 'submitted' | 'blocked' | 'reviewing_application';
  blocker?: BlockerCode | string;
  message?: string;
  error?: string;
  details?: Record<string, unknown>;
  blockers?: BrowserBlockerFinding[];
}

export interface BrowserAutomationAdapter {
  runtime?: AutomationRuntime;
  inspect(input: InspectInput): Promise<InspectOutput>;
  fillDraft(input: FillDraftInput): Promise<FillDraftOutput>;
  submitApproved(input: SubmitApprovedInput): Promise<SubmitApprovedOutput>;
  close?(): Promise<void>;
}
