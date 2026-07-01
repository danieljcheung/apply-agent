'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch, setApiToken } from './api';

interface BlockerItem {
  code: string;
  message: string;
}

interface ApplicationArtifact {
  id: string;
  type: string;
  name: string;
  uri: string;
  hash?: string;
  mimeType?: string;
  content?: string;
  createdAt: string;
}

interface LLMActionRecord {
  id: string;
  type: string;
  status: string;
  inputPayload?: unknown;
  outputPayload?: unknown;
  error?: string;
  createdAt: string;
}

interface TrackerEvent {
  id: string;
  type: string;
  message: string;
  timestamp: string;
}

interface SubmissionApproval {
  approved: boolean;
  approvedBy: string;
  approvedAt: string;
  fieldSnapshotHash: string;
  blockerSnapshotHash: string;
}

interface ApplicationRecord {
  id: string;
  url: string;
  company: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  blockers?: BlockerItem[];
  unresolvedChecks?: Record<string, boolean>;
  approval?: SubmissionApproval;
  artifacts?: ApplicationArtifact[];
  llmActions?: LLMActionRecord[];
  events?: TrackerEvent[];
}

interface LLMProviderSummary {
  id: string;
  name: string;
  kind: string;
  model: string;
  baseUrl?: string;
  isActive: boolean;
  apiKey?: string;
}

interface ResumeDetails {
  id: string;
  label: string;
  fileName: string;
  size: number;
  candidateName: string;
  candidateEmail: string;
  skillCount: number;
  claimCount: number;
  projectCount?: number;
  uploadedAt?: string;
  parse?: {
    parsedAt: string;
    parser: string;
  };
}

interface AppState {
  locked: boolean;
  exists: boolean;
  resumes?: ResumeDetails[];
  activeResumeId?: string | null;
  profile?: {
    claimBank?: Array<{
      category: string;
      claims: string[];
    }>;
    interviewAnswers?: Record<string, string>;
  };
  protonConfigured?: boolean;
  hasCredentials?: boolean;
  applications?: ApplicationRecord[];
  llmProviders?: LLMProviderSummary[];
}

interface PendingPlanResult {
  success: boolean;
  application: ApplicationRecord;
  safety?: {
    blocked: boolean;
    reasons: string[];
  };
  plan?: {
    steps: Array<{
      name: string;
      description: string;
    }>;
  };
}

const PROVIDER_MODELS: Record<string, string[]> = {
  'deepseek': ['deepseek-chat', 'deepseek-reasoner'],
  'openai-compatible': ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'o4-mini'],
  'kimi': ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  'local': ['llama3.1', 'qwen2.5', 'mistral', 'codellama']
};

export default function ControlPlane() {
  // Navigation & UI States
  const [activeView, setActiveView] = useState<string>('dashboard');
  const [connected, setConnected] = useState<boolean>(false);
  const [systemTime, setSystemTime] = useState<string>('--:--:--');
  const [auditLogs, setAuditLogs] = useState<Array<{ time: string; source: string; msg: string }>>([
    { time: new Date().toLocaleTimeString(), source: 'System', msg: 'Next.js Operator UI initialized. Ready.' }
  ]);

  // App Master States
  const [appState, setAppState] = useState<AppState>({
    locked: true,
    exists: false
  });

  // Selected Application for Review Console
  const [selectedReviewAppId, setSelectedReviewAppId] = useState<string | null>(null);

  // Vault Management Forms
  const [vaultPassword, setVaultPassword] = useState<string>('');

  // Link Intake Forms
  const [intakeUrl, setIntakeUrl] = useState<string>('');
  const [intakeResumeId, setIntakeResumeId] = useState<string>('');
  const [intakeCompany, setIntakeCompany] = useState<string>('');
  const [intakeTitle, setIntakeTitle] = useState<string>('');
  const [intakeSalary, setIntakeSalary] = useState<string>('');
  const [intakeRequirements, setIntakeRequirements] = useState<string>('');
  const [simCaptcha, setSimCaptcha] = useState<boolean>(false);
  const [sim2fa, setSim2fa] = useState<boolean>(false);
  const [simEmail, setSimEmail] = useState<boolean>(false);
  const [pendingPlan, setPendingPlan] = useState<PendingPlanResult | null>(null);

  // Proton Mail Form
  const [protonHost, setProtonHost] = useState<string>('127.0.0.1');
  const [protonPort, setProtonPort] = useState<number>(1143);
  const [protonUsername, setProtonUsername] = useState<string>('');
  const [protonPassword, setProtonPassword] = useState<string>('');
  const [protonSimulate, setProtonSimulate] = useState<boolean>(true);
  const [protonTestFeedback, setProtonTestFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Portal Credentials Form
  const [workdayUsername, setWorkdayUsername] = useState<string>('');
  const [workdayPassword, setWorkdayPassword] = useState<string>('');

  // LLM Providers Registry Forms
  const [llmId, setLlmId] = useState<string>('');
  const [llmName, setLlmName] = useState<string>('');
  const [llmKind, setLlmKind] = useState<string>('deepseek');
  const [llmModel, setLlmModel] = useState<string>('deepseek-chat');
  const [llmBaseUrl, setLlmBaseUrl] = useState<string>('');
  const [llmApiKey, setLlmApiKey] = useState<string>('');
  const [llmLiveActive, setLlmLiveActive] = useState<boolean>(true);
  const [llmTestFeedback, setLlmTestFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Prompt Resolution Modal/Form
  const [promptAnswer, setPromptAnswer] = useState<string>('');

  // Onboarding Wizard Stepper
  const [onboardingStep, setOnboardingStep] = useState<number>(1);
  const [onboardingVaultPass, setOnboardingVaultPass] = useState<string>('');
  const [onboardingFiles, setOnboardingFiles] = useState<FileList | null>(null);
  const [interviewAnswers, setInterviewAnswers] = useState<Record<string, string>>({
    title: '',
    salary: '',
    relocate: 'Yes',
    auth: 'No'
  });

  // Review Console Gates
  const [reviewChecked, setReviewChecked] = useState<boolean>(false);

  // Metrics Dashboard State
  const [metricsDisplay, setMetricsDisplay] = useState<{
    draftPlanned: number;
    submitted: number;
    blocked: number;
    llmTailoring: number;
    browserSuccess: number;
    browserFailed: number;
  }>({
    draftPlanned: 0,
    submitted: 0,
    blocked: 0,
    llmTailoring: 0,
    browserSuccess: 0,
    browserFailed: 0
  });

  // Helper: append to client audit stream
  const addAuditEntry = useCallback((source: string, msg: string) => {
    setAuditLogs(prev => [
      ...prev,
      { time: new Date().toLocaleTimeString(), source, msg }
    ]);
  }, []);

  // API State reloader
  const reloadAppState = useCallback(async () => {
    try {
      const state = (await apiFetch('/api/state')) as AppState;
      setAppState(state);
      setConnected(true);

      // Prepopulate forms if unpopulated
      if (state.profile?.interviewAnswers) {
        setInterviewAnswers(prev => ({
          ...prev,
          ...state.profile?.interviewAnswers
        }));
      }

      // If active resume is set, select it in intake
      if (state.activeResumeId) {
        setIntakeResumeId(state.activeResumeId);
      } else if (state.resumes && state.resumes.length > 0) {
        setIntakeResumeId(state.resumes[0].id);
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      if (errorMsg === 'Unauthorized') {
        // Handled by custom unauthorized event
      } else {
        setConnected(false);
      }
    }
  }, []);

  // System time ticker
  useEffect(() => {
    const timer = setInterval(() => {
      setSystemTime(new Date().toLocaleTimeString());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Poll state every 5 seconds
  useEffect(() => {
    reloadAppState();
    const interval = setInterval(reloadAppState, 5000);
    return () => clearInterval(interval);
  }, [reloadAppState]);

  // Listen for unauthorized/lock changes
  useEffect(() => {
    const handleUnauthorized = () => {
      setAppState(prev => ({ ...prev, locked: true }));
      addAuditEntry('Vault', 'Vault is locked. Session terminated.');
    };
    window.addEventListener('unauthorized', handleUnauthorized);
    return () => window.removeEventListener('unauthorized', handleUnauthorized);
  }, [addAuditEntry]);

  // Prometheus Metrics fetching & parsing
  const reloadMetrics = useCallback(async () => {
    try {
      const res = (await apiFetch('/metrics')) as string;
      const lines = res.split('\n');
      const metrics: Record<string, number> = {};
      
      for (const line of lines) {
        if (line.startsWith('#') || !line.trim()) continue;
        const match = line.match(/^([a-zA-Z0-9_]+)({[^}]+})?\s+([0-9.]+)/);
        if (match) {
          const metricName = match[1];
          const labelsStr = match[2] || '';
          const val = parseFloat(match[3]);
          
          if (labelsStr) {
            const labelRegex = /([a-zA-Z0-9_]+)="([^"]+)"/g;
            let lMatch;
            let keySuffix = '';
            while ((lMatch = labelRegex.exec(labelsStr)) !== null) {
              keySuffix += `_${lMatch[1]}_${lMatch[2]}`;
            }
            metrics[`${metricName}${keySuffix}`] = val;
          } else {
            metrics[metricName] = val;
          }
        }
      }

      const appDraft = metrics['apply_agent_applications_total_status_draft'] || 0;
      const appPlanned = metrics['apply_agent_applications_total_status_planned'] || 0;
      const appSubmitted = metrics['apply_agent_applications_total_status_submitted'] || 0;
      const appBlocked = metrics['apply_agent_applications_total_status_blocked'] || 0;
      
      const llmTailoring = metrics['apply_agent_llm_actions_total_action_type_resume_tailoring_status_completed'] || 0;
      const browserSuccess = metrics['apply_agent_browser_runs_total_status_success'] || 0;
      const browserFailed = metrics['apply_agent_browser_runs_total_status_failed'] || 0;

      setMetricsDisplay({
        draftPlanned: appDraft + appPlanned,
        submitted: appSubmitted,
        blocked: appBlocked,
        llmTailoring,
        browserSuccess,
        browserFailed
      });
      addAuditEntry('Metrics', 'System telemetry metrics updated.');
    } catch (err: unknown) {
      console.error('Failed to parse Prometheus metrics:', err);
    }
  }, [addAuditEntry]);

  useEffect(() => {
    if (activeView === 'dashboard') {
      reloadMetrics();
    }
  }, [activeView, reloadMetrics]);

  // Format status labels
  const formatStatusLabel = (status: string) => {
    return status.replace(/_/g, ' ').toUpperCase();
  };

  // Base64 helper using Promise.withResolvers
  const readFileAsBase64 = (file: File): Promise<string> => {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.substring(result.indexOf(',') + 1);
      resolve(base64);
    };
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
    return promise;
  };

  // API Call: Unlock / Create Vault
  const handleVaultSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!vaultPassword.trim()) {
      // Lock vault
      try {
        addAuditEntry('Vault', 'Locking master vault...');
        const res = (await apiFetch('/api/vault/lock', { method: 'POST' })) as { success: boolean };
        if (res.success) {
          setApiToken(null);
          setVaultPassword('');
          addAuditEntry('Vault', 'Vault successfully locked.');
          await reloadAppState();
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        alert(`Lock failed: ${errorMsg}`);
      }
      return;
    }

    try {
      addAuditEntry('Vault', 'Unlocking local master vault...');
      let res = (await apiFetch('/api/vault/unlock', {
        method: 'POST',
        body: JSON.stringify({ password: vaultPassword })
      }).catch(async (err: Error) => {
        if (err.message.includes('does not exist')) {
          addAuditEntry('Vault', 'Vault does not exist. Initializing new vault...');
          return (await apiFetch('/api/vault/create', {
            method: 'POST',
            body: JSON.stringify({ password: vaultPassword })
          })) as { success: boolean; token: string };
        }
        throw err;
      })) as { success: boolean; token: string };

      if (res.success && res.token) {
        setApiToken(res.token);
        addAuditEntry('Vault', 'Vault successfully unlocked and authenticated.');
        await reloadAppState();
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      alert(`Unlock failed: ${errorMsg}`);
      addAuditEntry('Vault', `Authentication failed: ${errorMsg}`);
    }
  };

  // API Call: Onboarding bootstrap vault
  const handleOnboardingVault = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      addAuditEntry('Onboarding', 'Initializing master vault...');
      let res = (await apiFetch('/api/vault/create', {
        method: 'POST',
        body: JSON.stringify({ password: onboardingVaultPass })
      }).catch(async () => (await apiFetch('/api/vault/unlock', {
        method: 'POST',
        body: JSON.stringify({ password: onboardingVaultPass })
      })) as { success: boolean; token: string })) as { success: boolean; token: string };

      if (res.success && res.token) {
        setApiToken(res.token);
        addAuditEntry('Onboarding', 'Vault initialized and unlocked.');
        await reloadAppState();
        setOnboardingStep(2);
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      alert(`Vault setup failed: ${errorMsg}`);
    }
  };

  // API Call: File Resume upload
  const handleResumeUpload = async (e: React.FormEvent, inputFiles: FileList | null) => {
    e.preventDefault();
    if (!inputFiles || inputFiles.length === 0) {
      alert('Please select at least one PDF resume.');
      return;
    }

    try {
      addAuditEntry('Profile', 'Uploading PDF resumes...');
      const resumes = [];
      for (let i = 0; i < inputFiles.length; i++) {
        const file = inputFiles[i];
        if (!file.name.toLowerCase().endsWith('.pdf')) {
          throw new Error('Only PDF resumes are supported.');
        }
        if (file.size > 8 * 1024 * 1024) {
          throw new Error('PDF file exceeds 8MB limit.');
        }
        const contentBase64 = await readFileAsBase64(file);
        resumes.push({
          fileName: file.name,
          contentBase64,
          mimeType: file.type || 'application/pdf',
          label: file.name.replace(/\.pdf$/i, '')
        });
      }

      const res = (await apiFetch('/api/profile/resume-upload', {
        method: 'POST',
        body: JSON.stringify({ resumes })
      })) as { success: boolean; error?: string };

      if (res.success) {
        addAuditEntry('Profile', 'Resumes uploaded and parsed successfully.');
        await reloadAppState();
        if (activeView === 'onboarding') {
          setOnboardingStep(3);
        }
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      alert(`Resume upload failed: ${errorMsg}`);
    }
  };

  // API Call: Switch active resume
  const handleSelectResume = async (resumeId: string) => {
    try {
      addAuditEntry('Resume Library', `Switching active resume to: ${resumeId}...`);
      const res = (await apiFetch('/api/profile/resumes/select', {
        method: 'POST',
        body: JSON.stringify({ resumeId })
      })) as { success: boolean };
      if (res.success) {
        addAuditEntry('Resume Library', 'Active resume selected.');
        await reloadAppState();
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      alert(`Failed to select active resume: ${errorMsg}`);
    }
  };

  // API Call: Save Interview preferences
  const handleSaveInterview = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      addAuditEntry('Profile', 'Saving candidate interview preferences...');
      await apiFetch('/api/profile', {
        method: 'POST',
        body: JSON.stringify({ interviewAnswers })
      });
      addAuditEntry('Profile', 'Interview preferences saved.');
      await reloadAppState();
      if (activeView === 'onboarding') {
        setOnboardingStep(4);
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      alert(`Failed to save interview preferences: ${errorMsg}`);
    }
  };

  // API Call: Save Proton bridge
  const handleProtonConfig = async (e: React.FormEvent, testOnly = false) => {
    e.preventDefault();
    setProtonTestFeedback(null);
    const config = {
      host: protonHost,
      port: protonPort,
      username: protonUsername,
      password: protonPassword,
      simulateSuccess: protonSimulate
    };

    const modeDesc = protonSimulate ? 'simulated offline mode' : 'real local Proton Bridge (127.0.0.1)';
    addAuditEntry('Proton', `Testing IMAP connection (${modeDesc})...`);
    if (testOnly) {
      setProtonTestFeedback({ type: 'success', text: `⏳ Testing IMAP connectivity (${modeDesc})...` });
    }

    try {
      const res = (await apiFetch('/api/settings/proton-bridge', {
        method: 'POST',
        body: JSON.stringify({ config })
      })) as { success: boolean };
      if (res.success) {
        const msg = `Connection successful! Proton Bridge verified (${protonSimulate ? 'Simulated Offline' : 'Real Local'}).`;
        setProtonTestFeedback({ type: 'success', text: `✓ ${msg}` });
        addAuditEntry('Proton', 'Proton Bridge config saved and verified.');
        await reloadAppState();
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      setProtonTestFeedback({ type: 'error', text: `⚠️ Connection failed: ${errorMsg}` });
      addAuditEntry('Proton', `Bridge test failed: ${errorMsg}`);
    }
  };

  // API Call: Save Web Credentials
  const handleSaveCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      addAuditEntry('Settings', 'Saving Workday portal credentials...');
      const res = (await apiFetch('/api/settings/credentials', {
        method: 'POST',
        body: JSON.stringify({ username: workdayUsername, password: workdayPassword })
      })) as { success: boolean };
      if (res.success) {
        addAuditEntry('Settings', 'Portal credentials saved successfully.');
        setWorkdayUsername('');
        setWorkdayPassword('');
        await reloadAppState();
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      alert(`Credentials save failed: ${errorMsg}`);
    }
  };

  // API Call: Save LLM Provider
  const handleSaveLlmProvider = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const id = llmId || `${llmKind}-${Date.now()}`;
      addAuditEntry('Settings', `Saving LLM provider configuration for ${llmName}...`);
      const res = (await apiFetch('/api/settings/llm/providers', {
        method: 'POST',
        body: JSON.stringify({
          provider: {
            id,
            name: llmName,
            kind: llmKind,
            model: llmModel,
            baseUrl: llmBaseUrl || undefined,
            isActive: llmLiveActive,
            apiKey: llmApiKey || undefined
          }
        })
      })) as { success: boolean };
      if (res.success) {
        addAuditEntry('Settings', `LLM provider ${llmName} saved.`);
        // Reset form
        setLlmId('');
        setLlmName('');
        setLlmKind('deepseek');
        setLlmModel('deepseek-chat');
        setLlmBaseUrl('');
        setLlmApiKey('');
        setLlmLiveActive(true);
        await reloadAppState();
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      alert(`LLM provider save failed: ${errorMsg}`);
    }
  };

  // API Call: Select LLM provider to edit
  const handleEditLlmProvider = (p: LLMProviderSummary) => {
    setLlmId(p.id);
    setLlmName(p.name);
    setLlmKind(p.kind);
    setLlmModel(p.model);
    setLlmBaseUrl(p.baseUrl || '');
    setLlmApiKey(''); // Secret key not populated
    setLlmLiveActive(p.isActive);
  };

  // API Call: Test LLM provider
  const handleTestLlmProvider = async (providerId: string) => {
    setLlmTestFeedback({ type: 'success', text: '⏳ Testing LLM connectivity...' });
    try {
      const res = (await apiFetch('/api/settings/llm/test', {
        method: 'POST',
        body: JSON.stringify({ providerId })
      })) as { success: boolean; model: string; elapsedMs: number };
      if (res.success) {
        setLlmTestFeedback({ type: 'success', text: `✓ LLM Connection verified: ${res.model} responded in ${res.elapsedMs}ms.` });
        addAuditEntry('Settings', `LLM Provider ${providerId} tested successfully.`);
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      setLlmTestFeedback({ type: 'error', text: `⚠️ LLM connectivity failed: ${errorMsg}` });
    }
  };

  // API Call: Link Intake Url Submit & Analysis
  const handleLinkIntake = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!intakeUrl.trim()) return;
    const salary = intakeSalary ? parseInt(intakeSalary, 10) : null;
    const requirements = intakeRequirements ? intakeRequirements.split(',').map(r => r.trim()).filter(Boolean) : [];

    const jobDetails = {
      company: intakeCompany || undefined,
      title: intakeTitle || undefined,
      salary,
      requirements,
      resumeId: intakeResumeId || undefined,
      simBlock: simCaptcha || sim2fa || simEmail,
      unresolvedChecks: {
        captcha: simCaptcha,
        twoFactor: sim2fa,
        emailVerification: simEmail
      }
    };

    try {
      addAuditEntry('Intake', `Intaking posting URL: ${intakeUrl}...`);
      const res = (await apiFetch('/api/applications', {
        method: 'POST',
        body: JSON.stringify({ url: intakeUrl, jobDetails })
      })) as PendingPlanResult;
      if (res.success) {
        setPendingPlan(res);
        addAuditEntry('Intake', `Plan generated for ${res.application.company}. Ready for review.`);
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      alert(`Intake failed: ${errorMsg}`);
    }
  };

  // API Call: Approve Generated Plan
  const handleApprovePlan = async () => {
    if (!pendingPlan) return;
    try {
      const appId = pendingPlan.application.id;
      addAuditEntry('Planner', `Approving application plan for ID: ${appId}...`);

      if (pendingPlan.safety?.blocked) {
        addAuditEntry('Planner', 'Plan approved but blocked by Safety Gate. Needs manual resolution.');
      } else {
        await apiFetch('/api/applications/approve', {
          method: 'POST',
          body: JSON.stringify({
            appId,
            approved: true,
            approvedBy: 'Human Reviewer',
            reviewUrl: pendingPlan.application.url,
            mode: 'fill_review_only'
          })
        });
        addAuditEntry('Planner', 'Application approval recorded. Ready for human click signature in review console.');
      }

      setPendingPlan(null);
      setIntakeUrl('');
      setIntakeCompany('');
      setIntakeTitle('');
      setIntakeSalary('');
      setIntakeRequirements('');
      setSimCaptcha(false);
      setSim2fa(false);
      setSimEmail(false);
      await reloadAppState();
      setActiveView('dashboard');
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      alert(`Approve failed: ${errorMsg}`);
    }
  };

  // API Call: Reject Generated Plan
  const handleRejectPlan = async () => {
    if (!pendingPlan) return;
    if (!confirm('Are you sure you want to discard this generated plan?')) return;
    try {
      const appId = pendingPlan.application.id;
      await apiFetch('/api/applications/reject', {
        method: 'POST',
        body: JSON.stringify({ appId })
      });
      addAuditEntry('Planner', 'Plan discarded by user.');
      setPendingPlan(null);
      await reloadAppState();
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      alert(`Reject failed: ${errorMsg}`);
    }
  };

  // API Call: Tailor resume for app
  const handleTailorResume = async (appId: string) => {
    try {
      addAuditEntry('LLM', `Tailoring resume for application ID: ${appId}...`);
      await apiFetch('/api/applications/tailor-resume', {
        method: 'POST',
        body: JSON.stringify({ appId })
      });
      addAuditEntry('LLM', 'Resume tailored and updated.');
      await reloadAppState();
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      alert(`Tailoring failed: ${errorMsg}`);
    }
  };

  // API Call: Record human approval signature
  const handleRecordApproval = async (appId: string) => {
    try {
      addAuditEntry('System', `Recording manual approval for application ID: ${appId}...`);
      await apiFetch('/api/applications/approve', {
        method: 'POST',
        body: JSON.stringify({
          appId,
          approved: true,
          approvedBy: 'Human Reviewer',
          mode: 'fill_review_only'
        })
      });
      addAuditEntry('System', 'Manual approval recorded.');
      setReviewChecked(false);
      await reloadAppState();
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      alert(`Approval recording failed: ${errorMsg}`);
    }
  };

  // API Call: Submit approved application
  const handleSubmitApproved = async (appId: string) => {
    try {
      addAuditEntry('System', `Executing automated submission for approved application ID: ${appId}...`);
      await apiFetch('/api/applications/approve', {
        method: 'POST',
        body: JSON.stringify({
          appId,
          approved: true,
          approvedBy: 'Human Reviewer',
          mode: 'submit_approved'
        })
      });
      addAuditEntry('System', 'Automated submission job dispatched.');
      await reloadAppState();
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      alert(`Submission failed: ${errorMsg}`);
    }
  };

  // API Call: Discard application
  const handleDiscardApplication = async (appId: string) => {
    if (!confirm('Are you sure you want to discard this application?')) return;
    try {
      await apiFetch('/api/applications/reject', {
        method: 'POST',
        body: JSON.stringify({ appId })
      });
      addAuditEntry('System', `Application ${appId} discarded.`);
      await reloadAppState();
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      alert(`Discard failed: ${errorMsg}`);
    }
  };

  // API Call: Submit Prompt answer
  const handlePromptAnswerSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const blockedApp = (appState.applications || []).find(a => a.status === 'blocked');
    if (!blockedApp) return;

    // Detect prompt properties matching the UI helper
    const unresolved = blockedApp.unresolvedChecks || {};
    const blockers = blockedApp.blockers || [];
    const firstBlocker = blockers[0] || null;
    const blockerCode = firstBlocker ? firstBlocker.code : null;
    const blockerMsg = firstBlocker ? firstBlocker.message : '';

    let promptId = 'UNKNOWN_BLOCKER';
    let promptQuestion = 'Resolve Blocker';

    const isCaptcha = (unresolved.captcha === true) || 
                      (blockerCode === 'captcha_required') || 
                      (blockerCode === 'captcha') || 
                      (blockerCode && blockerCode.toLowerCase().includes('captcha'));
    const isEmail = (unresolved.emailVerification === true) || 
                    (blockerCode === 'email_verification_required') || 
                    (blockerCode === 'email_verification') || 
                    (blockerCode && blockerCode.toLowerCase().includes('email'));
    const isResume = (blockerCode === 'missing_resume_artifact') || 
                     (blockerCode && blockerCode.toLowerCase().includes('resume'));
    const isCredentials = (blockerCode === 'missing_browser_credentials') || 
                          (blockerCode && blockerCode.toLowerCase().includes('credentials'));

    if (isCaptcha) {
      promptId = 'CAPTCHA_RESOLVER';
      promptQuestion = 'Solve CAPTCHA';
    } else if (isEmail) {
      promptId = 'EMAIL_VERIFICATION';
      promptQuestion = 'Enter Verification Code';
    } else if (isResume) {
      promptId = 'MISSING_RESUME_ARTIFACT';
      promptQuestion = 'Resume Upload / Configuration';
    } else if (isCredentials) {
      promptId = 'MISSING_CREDENTIALS';
      promptQuestion = 'Browser Credentials';
    } else {
      promptId = blockerCode || 'UNKNOWN_BLOCKER';
      promptQuestion = blockerMsg || 'Resolve Blocker';
    }

    try {
      addAuditEntry('Prompt', `Submitting answer for alert: "${promptAnswer}"...`);
      await apiFetch('/api/prompts/answer', {
        method: 'POST',
        body: JSON.stringify({ appId: blockedApp.id, promptId, question: promptQuestion, answer: promptAnswer })
      });
      addAuditEntry('Prompt', 'Prompt resolved. Resuming runner.');
      setPromptAnswer('');
      await reloadAppState();
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      alert(`Failed to submit answer: ${errorMsg}`);
    }
  };

  // Find currently blocked app requiring interactive prompt
  const blockedAppPendingPrompt = (appState.applications || []).find(a => a.status === 'blocked');

  // Review console selected application reference
  const reviewApp = (appState.applications || []).find(a => a.id === (selectedReviewAppId || ''));

  return (
    <div className="app-wrapper">
      {/* Side Navigation */}
      <aside className="sidebar" aria-label="Control Plane Sidebar">
        <div className="sidebar-brand">
          <span className="brand-icon" aria-hidden="true">✦</span>
          <span className="brand-text">Workday Agent</span>
        </div>

        <nav className="sidebar-nav" aria-label="Main Navigation">
          <button
            className={`nav-item ${activeView === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveView('dashboard')}
          >
            <span className="nav-icon" aria-hidden="true">◳</span> Dashboard
          </button>
          <button
            className={`nav-item ${activeView === 'onboarding' ? 'active' : ''}`}
            onClick={() => setActiveView('onboarding')}
          >
            <span className="nav-icon" aria-hidden="true">✦</span> Onboarding Wizard
          </button>
          <button
            className={`nav-item ${activeView === 'review' ? 'active' : ''}`}
            onClick={() => {
              setActiveView('review');
              if (!selectedReviewAppId && appState.applications && appState.applications.length > 0) {
                setSelectedReviewAppId(appState.applications[0].id);
              }
            }}
          >
            <span className="nav-icon" aria-hidden="true">⚖</span> Review Console
          </button>
          <button
            className={`nav-item ${activeView === 'profile' ? 'active' : ''}`}
            onClick={() => setActiveView('profile')}
          >
            <span className="nav-icon" aria-hidden="true">⚿</span> Profile & Vault
          </button>
          <button
            className={`nav-item ${activeView === 'intake' ? 'active' : ''}`}
            onClick={() => setActiveView('intake')}
          >
            <span className="nav-icon" aria-hidden="true">➔</span> Link Intake
          </button>
          <button
            className={`nav-item ${activeView === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveView('settings')}
          >
            <span className="nav-icon" aria-hidden="true">⚙</span> Settings
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-status-title">Local Runtime</div>
          <div className={`badge ${connected ? 'badge-online' : 'badge-offline'}`}>
            {connected ? 'API Online' : 'API Offline'}
          </div>
          <div className={`badge ${appState.locked ? 'badge-locked' : 'badge-unlocked'}`}>
            {appState.locked ? 'Locked' : 'Unlocked'}
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="main-container">
        {/* Top Header */}
        <header className="top-header">
          <h1 id="page-title">{activeView.charAt(0).toUpperCase() + activeView.slice(1)}</h1>
          <div className="system-time">{systemTime}</div>
        </header>

        {/* Views Container */}
        <div className="views-wrapper">
          
          {/* View: Dashboard */}
          {activeView === 'dashboard' && (
            <section className="view-panel active" style={{ display: 'flex', flexDirection: 'column' }}>
              {/* Welcome Banner */}
              {(!appState.applications || appState.applications.length === 0) && (
                <div className="glass-card mb-20 panel-info">
                  <div className="card-body flex-between align-center p-20">
                    <div>
                      <h3 className="mb-5 font-weight-600"><span aria-hidden="true">✦</span> Welcome to Workday Agent Control Plane</h3>
                      <p className="text-muted text-small mb-0">Initialize your encrypted master vault in Onboarding, or submit Workday job posting URLs in Link Intake to start automated workflows.</p>
                    </div>
                    <button type="button" className="btn btn-primary btn-small ml-10" onClick={() => setActiveView('onboarding')}>
                      Launch Onboarding <span aria-hidden="true">➔</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Vault Locked Banner */}
              {appState.locked && (
                <div className="glass-card mb-20 panel-warning">
                  <div className="card-body flex-between align-center p-20">
                    <div>
                      <h3 className="mb-5 font-weight-600"><span aria-hidden="true">⚿</span> Encrypted Vault is Locked</h3>
                      <p className="text-muted text-small mb-0">Credentials, parsed resume PDFs, and automation keys are encrypted and inaccessible. Unlock your vault to run background agents and process job application intakes.</p>
                    </div>
                    <button type="button" className="btn btn-primary btn-small ml-10" onClick={() => setActiveView('profile')}>
                      Unlock Vault <span aria-hidden="true">➔</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Overview Cards */}
              <div className="dashboard-summary">
                <div className="summary-card">
                  <div className="card-label">Active Applications</div>
                  <div className="card-value">
                    {(appState.applications || []).filter(a => ['draft', 'planned', 'blocked', 'ready_for_manual', 'reviewing_application'].includes(a.status)).length}
                  </div>
                </div>
                <div className="summary-card">
                  <div className="card-label">Submitted Applications</div>
                  <div className="card-value">
                    {(appState.applications || []).filter(a => ['submitted', 'submitted_mock_for_test'].includes(a.status)).length}
                  </div>
                </div>
                <div className="summary-card">
                  <div className="card-label">Blocked Applications</div>
                  <div className="card-value text-error">
                    {(appState.applications || []).filter(a => a.status === 'blocked').length}
                  </div>
                </div>
              </div>

              <div className="dashboard-grid">
                {/* Left Side: Ledger */}
                <div className="grid-col main-col">
                  <div className="glass-card">
                    <div className="card-header">
                      <h2>Application Tracker Ledger</h2>
                    </div>
                    <div className="table-container" tabIndex={0} role="region" aria-label="Application tracker ledger">
                      <table>
                        <thead>
                          <tr>
                            <th>Company & Role</th>
                            <th>Status</th>
                            <th>Created</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(!appState.applications || appState.applications.length === 0) ? (
                            <tr>
                              <td colSpan={4} className="empty-tracker-cell">
                                <div className="empty-tracker-container">
                                  <div className="empty-tracker-icon" aria-hidden="true">✦</div>
                                  <div className="empty-tracker-title">No Applications Tracked Yet</div>
                                  <div className="empty-tracker-desc">Import Workday job posting URLs via Link Intake to generate automation plans, tailor resumes, and track submission statuses.</div>
                                  <button type="button" className="btn btn-secondary btn-small" onClick={() => setActiveView('intake')}>
                                    Go to Link Intake <span aria-hidden="true">➔</span>
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ) : (
                            appState.applications.map(app => {
                              const llmActionCount = (app.llmActions || []).length;
                              const artifactCount = (app.artifacts || []).length;
                              const blockersText = app.blockers && app.blockers.length > 0
                                ? app.blockers.map(b => b.message).join(', ')
                                : 'None';

                              const isSubmitted = app.status === 'submitted' || app.status === 'submitted_mock_for_test';
                              const isRejected = app.status === 'rejected';

                              const resumeArt = (app.artifacts || []).find(art =>
                                art.type === 'resume_pdf' || art.type === 'resume_docx' || art.type?.startsWith('resume') || art.name?.toLowerCase().includes('resume')
                              );

                              const tailoringAction = (app.llmActions || [])
                                .filter(act => act.type === 'resume_tailoring')
                                .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
                              const tailoringStatus = tailoringAction ? tailoringAction.status : 'none';

                              return (
                                <tr key={app.id}>
                                  <td>
                                    <div className="tracker-company">{app.company}</div>
                                    <div className="tracker-title">{app.title}</div>
                                    <div className="tracker-details-box">
                                      <div>LLM Actions: <strong className="tracker-details-val">{llmActionCount}</strong> | Artifacts: <strong className="tracker-details-val">{artifactCount}</strong></div>
                                      <div>Approval: <strong className="tracker-details-val">{app.approval ? <span className="badge-pill-sm status-pill status-submitted">Approved ({app.approval.approvedBy || 'User'})</span> : <span className="badge-pill-sm status-pill status-draft">Awaiting Approval</span>}</strong></div>
                                      <div>Blockers: <span className={blockersText !== 'None' ? 'tracker-blockers-active' : 'tracker-blockers-none'}>{blockersText}</span></div>
                                      <div className="mt-5">
                                        <span>Automatic-Tailoring Status:</span>{' '}
                                        {tailoringStatus === 'completed' && <span className="badge-pill-sm status-pill status-submitted">Tailored</span>}
                                        {tailoringStatus === 'executing' && <span className="badge-pill-sm status-pill status-planned">Tailoring...</span>}
                                        {tailoringStatus === 'failed' && <span className="badge-pill-sm status-pill status-blocked">Tailoring Failed</span>}
                                        {tailoringStatus === 'none' && <span className="badge-pill-sm status-pill status-draft">Not Tailored</span>}
                                      </div>
                                      {resumeArt ? (
                                        <div className="mt-5 text-small text-muted" style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                                          <strong>Resume:</strong> {resumeArt.name || 'Tailored Resume'} | URI:{' '}
                                          <span className="text-primary">{resumeArt.uri || 'N/A'}</span><br />
                                          Hash: <span>{resumeArt.hash ? resumeArt.hash.substring(0, 16) + '...' : 'N/A'}</span>
                                        </div>
                                      ) : (
                                        <div className="mt-5 text-small text-muted">
                                          <strong>Resume:</strong> <span className="text-warning">No tailored PDF generated yet</span>
                                        </div>
                                      )}
                                    </div>
                                  </td>
                                  <td>
                                    <span className={`status-pill status-${app.status}`}>{formatStatusLabel(app.status)}</span>
                                  </td>
                                  <td>{new Date(app.createdAt).toLocaleDateString()}</td>
                                  <td>
                                    <div className="tracker-actions-flex">
                                      {!isSubmitted && !isRejected && (
                                        <>
                                          <button className="btn btn-secondary btn-small" onClick={() => handleTailorResume(app.id)} title="Tailor resume using LLM">Tailor Resume</button>
                                          {app.status === 'blocked' && (
                                            <button className="btn btn-primary btn-small" onClick={() => { setSelectedReviewAppId(app.id); setActiveView('review'); }} title="Resolve blocking prompt">Resolve Alert</button>
                                          )}
                                          {!app.approval ? (
                                            <button className="btn btn-primary btn-small" onClick={() => handleRecordApproval(app.id)} title="Record manual approval for application">Record Approval</button>
                                          ) : (
                                            <>
                                              <span className="badge badge-online badge-approved-inline">Approved</span>
                                              <button className="btn btn-success btn-small" onClick={() => handleSubmitApproved(app.id)} title="Start approved automated submission">Submit Approved</button>
                                            </>
                                          )}
                                          <button className="btn btn-secondary btn-small" onClick={() => handleDiscardApplication(app.id)} title="Discard this application">Discard</button>
                                        </>
                                      )}
                                      {(isSubmitted || isRejected) && <span className="text-muted">No actions</span>}
                                    </div>
                                  </td>
                                </tr>
                              );
                            })
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Checklist Section */}
                  <div className="glass-card mt-20">
                    <div className="card-header">
                      <h2>Agent Operational Status & Next Steps</h2>
                    </div>
                    <div className="card-body">
                      <div className="checklist-grid">
                        {/* Vault Status */}
                        <div className="checklist-item">
                          <div className="checklist-icon" aria-hidden="true">{appState.locked ? '🔒' : '🔓'}</div>
                          <div className="checklist-info">
                            <h4>Encrypted Master Vault</h4>
                            <p className="checklist-status">
                              {appState.locked ? (
                                <span className="status-pill status-draft">Locked & Encrypted</span>
                              ) : (
                                <span className="status-pill status-submitted">Decrypted & Active</span>
                              )}
                            </p>
                            <p className="checklist-desc">Secures local portal credentials, API secret keys, and candidate claim bank.</p>
                          </div>
                          <div className="checklist-action">
                            <button
                              type="button"
                              className={`btn btn-small ${appState.locked ? 'btn-primary' : 'btn-secondary'}`}
                              onClick={() => setActiveView('profile')}
                            >
                              {appState.locked ? 'Unlock Vault ➔' : 'View Vault'}
                            </button>
                          </div>
                        </div>

                        {/* Resume Library */}
                        <div className="checklist-item">
                          <div className="checklist-icon" aria-hidden="true">
                            {appState.locked ? '🔒' : (appState.resumes || []).length > 0 ? '📄' : '⚠️'}
                          </div>
                          <div className="checklist-info">
                            <h4>Resume PDF Library</h4>
                            <p className="checklist-status">
                              {appState.locked ? (
                                <span className="status-pill status-draft">Inaccessible (Vault Locked)</span>
                              ) : (appState.resumes || []).length > 0 ? (
                                <span className="status-pill status-submitted">Ready ({(appState.resumes || []).length} resumes, {(appState.profile?.claimBank || []).flatMap(c => c.claims).length} claims)</span>
                              ) : (
                                <span className="status-pill status-blocked">No Resume PDFs Parsed</span>
                              )}
                            </p>
                            <p className="checklist-desc">Fact claim bank parsed from resume PDFs to drive intelligent form autofill.</p>
                          </div>
                          <div className="checklist-action">
                            <button
                              type="button"
                              className={`btn btn-small ${!appState.locked && (appState.resumes || []).length === 0 ? 'btn-primary' : 'btn-secondary'}`}
                              disabled={appState.locked}
                              onClick={() => setActiveView('profile')}
                            >
                              {appState.locked ? 'Locked' : (appState.resumes || []).length > 0 ? 'Manage Resumes' : 'Import Resume PDFs ➔'}
                            </button>
                          </div>
                        </div>

                        {/* LLM Status */}
                        <div className="checklist-item">
                          <div className="checklist-icon" aria-hidden="true">
                            {appState.locked ? '🔒' : (appState.llmProviders || []).some(p => p.isActive) ? '🤖' : '⚠️'}
                          </div>
                          <div className="checklist-info">
                            <h4>LLM Tailoring Agent</h4>
                            <p className="checklist-status">
                              {appState.locked ? (
                                <span className="status-pill status-draft">Inaccessible (Vault Locked)</span>
                              ) : (appState.llmProviders || []).find(p => p.isActive) ? (
                                <span className="status-pill status-submitted">Active ({(appState.llmProviders || []).find(p => p.isActive)?.name})</span>
                              ) : (
                                <span className="status-pill status-blocked">No Active Provider</span>
                              )}
                            </p>
                            <p className="checklist-desc">Active LLM provider used to customize applications and answer screening questions.</p>
                          </div>
                          <div className="checklist-action">
                            <button
                              type="button"
                              className={`btn btn-small ${!appState.locked && !(appState.llmProviders || []).some(p => p.isActive) ? 'btn-primary' : 'btn-secondary'}`}
                              disabled={appState.locked}
                              onClick={() => setActiveView('settings')}
                            >
                              {appState.locked ? 'Locked' : (appState.llmProviders || []).some(p => p.isActive) ? 'Configure' : 'Set LLM Provider ➔'}
                            </button>
                          </div>
                        </div>

                        {/* Proton Status */}
                        <div className="checklist-item">
                          <div className="checklist-icon" aria-hidden="true">
                            {appState.locked ? '🔒' : appState.protonConfigured ? '✉️' : '⚠️'}
                          </div>
                          <div className="checklist-info">
                            <h4>Proton Mail Verification Bridge</h4>
                            <p className="checklist-status">
                              {appState.locked ? (
                                <span className="status-pill status-draft">Inaccessible (Vault Locked)</span>
                              ) : appState.protonConfigured ? (
                                <span className="status-pill status-submitted">Configured & Connected</span>
                              ) : (
                                <span className="status-pill status-blocked">Unconfigured</span>
                              )}
                            </p>
                            <p className="checklist-desc">Local IMAP integration for automated security code and verification link retrieval.</p>
                          </div>
                          <div className="checklist-action">
                            <button
                              type="button"
                              className={`btn btn-small ${!appState.locked && !appState.protonConfigured ? 'btn-primary' : 'btn-secondary'}`}
                              disabled={appState.locked}
                              onClick={() => setActiveView('settings')}
                            >
                              {appState.locked ? 'Locked' : appState.protonConfigured ? 'Configure' : 'Setup Bridge ➔'}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Right Side: Alerts, Prompts, Metrics */}
                <div className="grid-col side-col">
                  {/* Prompt Action Panel */}
                  {blockedAppPendingPrompt && (
                    <div className="glass-card panel-warning">
                      <div className="card-header">
                        <h2>Prompt Action Required</h2>
                      </div>
                      <div className="card-body">
                        <p className="prompt-instruction">
                          {(() => {
                            const unresolved = blockedAppPendingPrompt.unresolvedChecks || {};
                            const blockers = blockedAppPendingPrompt.blockers || [];
                            const firstBlocker = blockers[0] || null;
                            const blockerCode = firstBlocker ? firstBlocker.code : null;

                            if (unresolved.captcha === true || blockerCode === 'captcha_required') {
                              return 'A configured LLM provider is used automatically for direct text/image CAPTCHA prompts when possible. Token-based CAPTCHA widgets or failed LLM attempts require manual completion in the browser window before resuming.';
                            } else if (unresolved.emailVerification === true || blockerCode === 'email_verification_required') {
                              return `Application to ${blockedAppPendingPrompt.company} is held by an email verification check. Manual code entry is required below if Proton Mail Bridge is unavailable.`;
                            } else if (blockerCode === 'missing_resume_artifact') {
                              return `Application to ${blockedAppPendingPrompt.company} is blocked: Missing Resume. Parse a resume PDF or supply it below to resolve.`;
                            } else if (blockerCode === 'unknown_question') {
                              return `Application to ${blockedAppPendingPrompt.company} is blocked by an unknown screening question: "${firstBlocker?.message || 'unspecified question'}". Provide your answer below.`;
                            }
                            return `Application to ${blockedAppPendingPrompt.company} is blocked by ${blockerCode || 'unresolved check'}. Provide the answer/resolution below.`;
                          })()}
                        </p>
                        <form onSubmit={handlePromptAnswerSubmit}>
                          <div className="form-group">
                            <label htmlFor="prompt-answer">
                              {(() => {
                                const unresolved = blockedAppPendingPrompt.unresolvedChecks || {};
                                const blockers = blockedAppPendingPrompt.blockers || [];
                                const firstBlocker = blockers[0] || null;
                                const blockerCode = firstBlocker ? firstBlocker.code : null;
                                if (unresolved.captcha === true || blockerCode === 'captcha_required') return 'CAPTCHA Code';
                                if (unresolved.emailVerification === true || blockerCode === 'email_verification_required') return 'Verification Code';
                                return firstBlocker?.message || 'Answer';
                              })()}
                            </label>
                            <input
                              type="text"
                              id="prompt-answer"
                              className="form-control"
                              value={promptAnswer}
                              onChange={(e) => setPromptAnswer(e.target.value)}
                              placeholder="Provide response..."
                              required
                            />
                          </div>
                          <button type="submit" className="btn btn-primary">Submit Answer</button>
                        </form>
                      </div>
                    </div>
                  )}

                  {/* Audit Stream */}
                  <div className="glass-card">
                    <div className="card-header">
                      <h2>Safety & Audit Stream</h2>
                    </div>
                    <div className="card-body scroll-y" style={{ maxHeight: '300px' }} tabIndex={0} role="region" aria-label="Safety and audit stream">
                      {auditLogs.map((log, idx) => (
                        <div key={idx} className="audit-item system-log">
                          <span className="log-time">{log.time}</span>
                          <span className="log-time" style={{ marginLeft: '10px', color: 'var(--accent-blue)' }}>[{log.source}]</span>
                          <span className="log-msg" style={{ marginLeft: '10px' }}>{log.msg}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* System Metrics */}
                  <div className="glass-card mt-20">
                    <div className="card-header">
                      <h2>System Metrics & Status</h2>
                    </div>
                    <div className="card-body">
                      <p className="text-muted mb-15">Prometheus scrape endpoint for local and Kubernetes monitoring:</p>
                      <div className="metrics-scrape-box">
                        <a href="/metrics" target="_blank" className="metrics-scrape-link">http://localhost:3010/metrics</a>
                      </div>
                      <div className="metrics-list">
                        <div className="metric-item">
                          <span>Draft / Planned Applications:</span>
                          <strong className="metric-item-value">{metricsDisplay.draftPlanned}</strong>
                        </div>
                        <div className="metric-item">
                          <span>Submitted Applications:</span>
                          <strong className="metric-item-value">{metricsDisplay.submitted}</strong>
                        </div>
                        <div className="metric-item">
                          <span>Blocked Applications:</span>
                          <strong className={`metric-item-value ${metricsDisplay.blocked > 0 ? 'has-error' : ''}`}>{metricsDisplay.blocked}</strong>
                        </div>
                        <div className="metric-item">
                          <span>LLM Tailoring Count:</span>
                          <strong className="metric-item-value">{metricsDisplay.llmTailoring}</strong>
                        </div>
                        <div className="metric-item">
                          <span>Browser Runs (Success/Fail):</span>
                          <strong className="metric-item-value">{metricsDisplay.browserSuccess} / {metricsDisplay.browserFailed}</strong>
                        </div>
                      </div>
                      <div className="btn-row mt-15">
                        <button type="button" onClick={reloadMetrics} className="btn btn-secondary btn-small">Refresh Metrics</button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* View: Onboarding Wizard */}
          {activeView === 'onboarding' && (
            <section className="view-panel active">
              <div className="glass-card full-width">
                <div className="card-header">
                  <h2>Agentic First-Run Onboarding Wizard</h2>
                </div>
                <div className="card-body">
                  <p className="text-muted mb-20">Initialize your local encrypted vault, import one or more resume PDFs, set interview preferences, and connect integration tools.</p>

                  <div className="onboarding-stepper">
                    <button className={`stepper-item ${onboardingStep === 1 ? 'active' : ''} ${onboardingStep > 1 ? 'completed' : ''}`} onClick={() => setOnboardingStep(1)}>1. Secure Vault</button>
                    <button className={`stepper-item ${onboardingStep === 2 ? 'active' : ''} ${onboardingStep > 2 ? 'completed' : ''}`} disabled={appState.locked} onClick={() => setOnboardingStep(2)}>2. Resume PDFs</button>
                    <button className={`stepper-item ${onboardingStep === 3 ? 'active' : ''} ${onboardingStep > 3 ? 'completed' : ''}`} disabled={appState.locked} onClick={() => setOnboardingStep(3)}>3. Interview Q&A</button>
                    <button className={`stepper-item ${onboardingStep === 4 ? 'active' : ''} ${onboardingStep > 4 ? 'completed' : ''}`} disabled={appState.locked} onClick={() => setOnboardingStep(4)}>4. Integrations</button>
                    <button className={`stepper-item ${onboardingStep === 5 ? 'active' : ''} ${onboardingStep > 5 ? 'completed' : ''}`} disabled={appState.locked} onClick={() => setOnboardingStep(5)}>5. Next Actions</button>
                  </div>

                  {/* Onboarding Step 1 */}
                  {onboardingStep === 1 && (
                    <div className="onboarding-step-content active">
                      <h3>Step 1: Secure Vault Initialization & Unlock</h3>
                      <p className="text-muted mb-15">All local candidate claims, credentials, and tokens are stored in an AES-256 encrypted zero-knowledge vault.</p>
                      <div className="glass-card inner-card max-width-600">
                        <form onSubmit={handleOnboardingVault}>
                          <div className="form-group">
                            <label htmlFor="onboarding-vault-pass">Master Vault Key / Password</label>
                            <input
                              type="password"
                              id="onboarding-vault-pass"
                              className="form-control"
                              value={onboardingVaultPass}
                              onChange={(e) => setOnboardingVaultPass(e.target.value)}
                              placeholder="Enter or create vault master key..."
                              required
                            />
                          </div>
                          <div className="btn-row">
                            <button type="submit" className="btn btn-primary">
                              {appState.exists ? 'Unlock Vault' : 'Create & Unlock Vault'}
                            </button>
                          </div>
                        </form>
                      </div>
                    </div>
                  )}

                  {/* Onboarding Step 2 */}
                  {onboardingStep === 2 && (
                    <div className="onboarding-step-content active">
                      <h3>Step 2: Resume PDF Parser</h3>
                      <p className="text-muted mb-15">Select one or more PDF resumes to import. The parser will extract text from each PDF to build the candidate fact claim bank.</p>
                      <div className="glass-card inner-card">
                        <form onSubmit={(e) => handleResumeUpload(e, onboardingFiles)}>
                          <div className="form-group">
                            <label htmlFor="onboarding-resume-files">Upload PDF Resumes</label>
                            <input
                              type="file"
                              id="onboarding-resume-files"
                              className="form-control"
                              accept="application/pdf,.pdf"
                              multiple
                              onChange={(e) => setOnboardingFiles(e.target.files)}
                              required
                            />
                          </div>
                          <div className="btn-row">
                            <button type="submit" className="btn btn-primary">Parse Resume PDFs</button>
                          </div>
                        </form>
                      </div>
                    </div>
                  )}

                  {/* Onboarding Step 3 */}
                  {onboardingStep === 3 && (
                    <div className="onboarding-step-content active">
                      <h3>Step 3: Candidate Preference & Interview Q&A</h3>
                      <p className="text-muted mb-15">Provide default answers for common Workday portal screening questions.</p>
                      <div className="glass-card inner-card">
                        <form onSubmit={handleSaveInterview}>
                          <div className="row">
                            <div className="col">
                              <div className="form-group">
                                <label htmlFor="interview-title">Target Job Title(s)</label>
                                <input
                                  type="text"
                                  id="interview-title"
                                  className="form-control"
                                  value={interviewAnswers.title || ''}
                                  onChange={(e) => setInterviewAnswers(prev => ({ ...prev, title: e.target.value }))}
                                  placeholder="e.g. Senior Software Engineer"
                                />
                              </div>
                            </div>
                            <div className="col">
                              <div className="form-group">
                                <label htmlFor="interview-salary">Minimum Expected Salary ($ USD)</label>
                                <input
                                  type="number"
                                  id="interview-salary"
                                  className="form-control"
                                  value={interviewAnswers.salary || ''}
                                  onChange={(e) => setInterviewAnswers(prev => ({ ...prev, salary: e.target.value }))}
                                  placeholder="e.g. 150000"
                                />
                              </div>
                            </div>
                          </div>
                          <div className="row">
                            <div className="col">
                              <div className="form-group">
                                <label htmlFor="interview-relocate">Willing to Relocate?</label>
                                <select
                                  id="interview-relocate"
                                  className="form-control"
                                  value={interviewAnswers.relocate || 'Yes'}
                                  onChange={(e) => setInterviewAnswers(prev => ({ ...prev, relocate: e.target.value }))}
                                >
                                  <option value="Yes">Yes</option>
                                  <option value="No">No</option>
                                  <option value="Remote Only">Remote Only</option>
                                </select>
                              </div>
                            </div>
                            <div className="col">
                              <div className="form-group">
                                <label htmlFor="interview-auth">Sponsorship Required?</label>
                                <select
                                  id="interview-auth"
                                  className="form-control"
                                  value={interviewAnswers.auth || 'No'}
                                  onChange={(e) => setInterviewAnswers(prev => ({ ...prev, auth: e.target.value }))}
                                >
                                  <option value="No">No (Authorized to work)</option>
                                  <option value="Yes">Yes (Will require visa sponsorship)</option>
                                </select>
                              </div>
                            </div>
                          </div>
                          <div className="btn-row">
                            <button type="submit" className="btn btn-primary">Save Interview Preferences</button>
                          </div>
                        </form>
                      </div>
                    </div>
                  )}

                  {/* Onboarding Step 4 */}
                  {onboardingStep === 4 && (
                    <div className="onboarding-step-content active">
                      <h3>Step 4: Integrations & Provider Setup</h3>
                      <p className="text-muted mb-15">Ensure LLM resume tailors and Proton Mail verification bridges are properly set up.</p>
                      <div className="two-column-layout">
                        <div className="glass-card inner-card">
                          <h4>Proton Mail Bridge</h4>
                          <p className="text-muted">
                            Status:{' '}
                            <span className={`status-pill ${appState.protonConfigured ? 'status-submitted' : 'status-draft'}`}>
                              {appState.protonConfigured ? 'Ready' : 'Unconfigured'}
                            </span>
                          </p>
                          <button type="button" className="btn btn-secondary btn-small mt-10" onClick={() => setActiveView('settings')}>
                            Configure Proton Bridge <span aria-hidden="true">➔</span>
                          </button>
                        </div>
                        <div className="glass-card inner-card">
                          <h4>LLM Providers</h4>
                          <p className="text-muted">
                            Status:{' '}
                            <span className={`status-pill ${(appState.llmProviders || []).some(p => p.isActive) ? 'status-submitted' : 'status-draft'}`}>
                              {(appState.llmProviders || []).some(p => p.isActive) ? 'Ready' : 'Unconfigured'}
                            </span>
                          </p>
                          <button type="button" className="btn btn-secondary btn-small mt-10" onClick={() => setActiveView('settings')}>
                            Configure LLM Models <span aria-hidden="true">➔</span>
                          </button>
                        </div>
                      </div>
                      <div className="btn-row mt-20 justify-end">
                        <button type="button" className="btn btn-primary" onClick={() => setOnboardingStep(5)}>Continue ➔</button>
                      </div>
                    </div>
                  )}

                  {/* Onboarding Step 5 */}
                  {onboardingStep === 5 && (
                    <div className="onboarding-step-content active">
                      <h3>Step 5: Initialization Complete - Next Actions</h3>
                      <p className="text-muted mb-20">Your control plane is initialized and ready to execute automated job application workflows.</p>
                      
                      <div className="action-cards-grid">
                        <button type="button" className="action-card" onClick={() => setActiveView('intake')}>
                          <span className="action-card-icon" aria-hidden="true">➔</span>
                          <h4>Submit Workday Job Posting</h4>
                          <p className="text-muted">Import a career portal job posting URL to analyze requirements and start automated autofill.</p>
                          <span className="action-card-link">Open Link Intake <span aria-hidden="true">➔</span></span>
                        </button>
                        <button type="button" className="action-card" onClick={() => setActiveView('review')}>
                          <span className="action-card-icon" aria-hidden="true">⚖</span>
                          <h4>Launch Review Console</h4>
                          <p className="text-muted">Inspect application field provenances, LLM tailoring audits, and record manual approval signatures.</p>
                          <span className="action-card-link">Open Review Console <span aria-hidden="true">➔</span></span>
                        </button>
                        <button type="button" className="action-card" onClick={() => setActiveView('dashboard')}>
                          <span className="action-card-icon" aria-hidden="true">◳</span>
                          <h4>View Agent Dashboard</h4>
                          <p className="text-muted">Monitor live application tracker ledgers, real-time safety streams, and system telemetry metrics.</p>
                          <span className="action-card-link">Open Dashboard <span aria-hidden="true">➔</span></span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* View: Review Console */}
          {activeView === 'review' && (
            <section className="view-panel active">
              <div className="glass-card full-width">
                <div className="card-header flex-between">
                  <h2>Application Audit & Approval Console</h2>
                  <div className="review-selector-box">
                    <label htmlFor="review-app-select" className="mr-10 font-weight-600">Active Application:</label>
                    <select
                      id="review-app-select"
                      className="form-control display-inline-block max-width-300"
                      value={selectedReviewAppId || ''}
                      onChange={(e) => setSelectedReviewAppId(e.target.value || null)}
                    >
                      <option value="">-- Select Application --</option>
                      {(appState.applications || []).map(app => (
                        <option key={app.id} value={app.id}>
                          {app.company} - {app.title} ({formatStatusLabel(app.status)})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="card-body">
                  {!reviewApp ? (
                    <div className="empty-tracker-container p-40">
                      <div className="empty-tracker-icon">⚖</div>
                      <div className="empty-tracker-title">No Application Selected for Review</div>
                      <div className="empty-tracker-desc">Select a tracked application from the dropdown selector above to audit field provenances, inspect LLM tailoring logs, and manage human approval signatures.</div>
                    </div>
                  ) : (
                    <div>
                      {/* Overview details */}
                      <div className="glass-card inner-card mb-20">
                        <div className="flex-between mb-15">
                          <div>
                            <h3 className="mb-5">{reviewApp.title}</h3>
                            <p className="text-muted">Company: {reviewApp.company} | URL: {reviewApp.url}</p>
                          </div>
                          <div>
                            <span className={`status-pill status-${reviewApp.status}`}>{formatStatusLabel(reviewApp.status)}</span>
                          </div>
                        </div>

                        <h4 className="mb-10 text-muted uppercase-title">Application Lifecycle Timeline</h4>
                        <div className="steps-timeline">
                          {(() => {
                            const steps = [
                              { name: 'Intake & Run Plan Draft', desc: 'Job posting imported into local ledger.', key: 'draft' },
                              { name: 'Field Analysis & Tailoring', desc: 'Resume tailored and facts extracted.', key: 'planned' },
                              { name: 'Safety Gate Check / Blockers', desc: 'Automated verification challenges & CAPTCHA check.', key: 'blocked' },
                              { name: 'Manual Review & Approval', desc: 'Human reviewer audit and explicit signature.', key: 'reviewing_application' },
                              { name: 'Final Portal Submission', desc: 'Automated submission executed.', key: 'submitted' }
                            ];
                            const currentIdx = ['draft', 'planned', 'blocked', 'ready_for_manual', 'reviewing_application', 'submitted', 'submitted_mock_for_test'].indexOf(reviewApp.status);
                            return steps.map((step, idx) => {
                              let stepClass = 'timeline-step';
                              if (idx <= currentIdx && currentIdx !== -1) stepClass += ' step-completed';
                              if (step.key === 'blocked' && reviewApp.status === 'blocked') stepClass += ' step-blocked';
                              return (
                                <div key={step.name} className={stepClass}>
                                  <div className="step-marker"></div>
                                  <div className="step-details">
                                    <div className="step-name">{step.name}</div>
                                    <div className="step-description">{step.desc}</div>
                                  </div>
                                </div>
                              );
                            });
                          })()}
                        </div>
                      </div>

                      {/* Resume tailoring and artifacts */}
                      <div className="glass-card inner-card mb-20">
                        <div className="card-header">
                          <h2>Resume Tailoring & Persisted Artifacts</h2>
                        </div>
                        <div className="card-body">
                          {(() => {
                            const resumeArt = (reviewApp.artifacts || []).find(art =>
                              art.type === 'resume_pdf' || art.type === 'resume_docx' || art.type?.startsWith('resume') || art.name?.toLowerCase().includes('resume')
                            );
                            const tailoringAction = (reviewApp.llmActions || [])
                              .filter(act => act.type === 'resume_tailoring')
                              .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
                            const tailoringStatus = tailoringAction ? tailoringAction.status : 'none';

                            return (
                              <>
                                <div>
                                  <strong>Automatic-Tailoring Status:</strong>{' '}
                                  {tailoringStatus === 'completed' && <span className="status-pill status-submitted">Completed (Tailored)</span>}
                                  {tailoringStatus === 'executing' && <span className="status-pill status-planned">Executing (Tailoring...)</span>}
                                  {tailoringStatus === 'failed' && <span className="status-pill status-blocked">Failed</span>}
                                  {tailoringStatus === 'none' && <span className="status-pill status-draft">Not Tailored</span>}
                                </div>
                                {reviewApp.status === 'blocked' && reviewApp.blockers && reviewApp.blockers.length > 0 && (
                                  <div className="mt-10 text-error">
                                    <strong>Blocked Reason:</strong> {reviewApp.blockers.map(b => b.message).join(', ')}
                                  </div>
                                )}

                                {resumeArt ? (
                                  <div className="mt-15 p-15 border-radius-8" style={{ background: 'rgba(16, 185, 129, 0.05)', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
                                    <strong className="color-success">Persisted Resume Artifact Details:</strong>
                                    <table className="table-compact mt-10">
                                      <tbody>
                                        <tr><td className="font-weight-600" style={{ width: '120px' }}>Name:</td><td>{resumeArt.name || 'N/A'}</td></tr>
                                        <tr><td className="font-weight-600">Type:</td><td>{resumeArt.type || 'N/A'}</td></tr>
                                        <tr><td className="font-weight-600">MIME Type:</td><td>{resumeArt.mimeType || 'N/A'}</td></tr>
                                        <tr><td className="font-weight-600">URI / Path:</td><td className="text-mono" style={{ wordBreak: 'break-all' }}>{resumeArt.uri || 'N/A'}</td></tr>
                                        <tr><td className="font-weight-600">SHA256 Hash:</td><td className="text-mono" style={{ wordBreak: 'break-all' }}>{resumeArt.hash || 'N/A'}</td></tr>
                                        <tr><td className="font-weight-600">Created At:</td><td>{new Date(resumeArt.createdAt).toLocaleString()}</td></tr>
                                      </tbody>
                                    </table>
                                  </div>
                                ) : (
                                  <div className="mt-15 p-15 border-radius-8" style={{ background: 'rgba(239, 68, 68, 0.05)', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
                                    <strong className="text-error">No application-specific resume artifact found.</strong>
                                    <p className="text-muted text-small mt-5">Once resume tailoring completes successfully, the tailored PDF artifact details will be persisted and displayed here.</p>
                                  </div>
                                )}
                              </>
                            );
                          })()}
                        </div>
                      </div>

                      {/* Active Blockers */}
                      {reviewApp.blockers && reviewApp.blockers.length > 0 && (
                        <div className="glass-card inner-card mb-20 panel-warning">
                          <div className="card-header">
                            <h4>Active Blockers & Verification Challenges</h4>
                          </div>
                          <div className="card-body">
                            {reviewApp.blockers.map((b, idx) => (
                              <div key={idx} className="blocker-item flex-between align-center mb-10 p-10 bg-error-light border-radius-8">
                                <div>
                                  <strong className="text-error">[{b.code}]</strong> {b.message}
                                </div>
                                <button type="button" className="btn btn-primary btn-small" onClick={() => { setSelectedReviewAppId(reviewApp.id); setActiveView('dashboard'); }}>
                                  Resolve Challenge
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Mapping and Log Grids */}
                      <div className="two-column-layout mb-20">
                        {/* Provenance Table */}
                        <div className="glass-card inner-card">
                          <h4 className="mb-15 uppercase-title">Field Provenance & Claim Mapping</h4>
                          <div className="table-container scroll-y" style={{ maxHeight: '300px' }} tabIndex={0} role="region" aria-label="Field provenance and claim mapping">
                            <table className="table-compact">
                              <thead>
                                <tr>
                                  <th>Field Label</th>
                                  <th>Autofilled Value</th>
                                  <th>Provenance Source</th>
                                </tr>
                              </thead>
                              <tbody>
                                <tr>
                                  <td className="font-weight-600">First Name</td>
                                  <td className="text-mono">{appState.profile?.interviewAnswers?.firstName || 'Local'}</td>
                                  <td><span className="badge-pill-sm status-pill status-submitted">Vault Profile</span></td>
                                </tr>
                                <tr>
                                  <td className="font-weight-600">Last Name</td>
                                  <td className="text-mono">{appState.profile?.interviewAnswers?.lastName || 'Candidate'}</td>
                                  <td><span className="badge-pill-sm status-pill status-submitted">Vault Profile</span></td>
                                </tr>
                                <tr>
                                  <td className="font-weight-600">Email Address</td>
                                  <td className="text-mono">{appState.profile?.interviewAnswers?.email || workdayUsername || 'candidate@example.com'}</td>
                                  <td><span className="badge-pill-sm status-pill status-submitted">Vault Credentials</span></td>
                                </tr>
                                <tr>
                                  <td className="font-weight-600">Expected Salary</td>
                                  <td className="text-mono">${reviewApp.unresolvedChecks?.expectedSalary || appState.profile?.interviewAnswers?.salary || 'N/A'}</td>
                                  <td><span className="badge-pill-sm status-pill status-submitted">Claim Bank</span></td>
                                </tr>
                                <tr>
                                  <td className="font-weight-600">Sponsorship Required</td>
                                  <td className="text-mono">{appState.profile?.interviewAnswers?.auth || 'No'}</td>
                                  <td><span className="badge-pill-sm status-pill status-submitted">Claim Bank</span></td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        </div>

                        {/* LLM Logs */}
                        <div className="glass-card inner-card">
                          <h4 className="mb-15 uppercase-title">LLM Audit & Resume Tailoring Log</h4>
                          <div className="scroll-y" style={{ maxHeight: '300px' }} tabIndex={0} role="region" aria-label="LLM audit and resume tailoring log">
                            {(!reviewApp.llmActions || reviewApp.llmActions.length === 0) ? (
                              <p className="text-muted">No LLM operations logged for this application.</p>
                            ) : (
                              reviewApp.llmActions.map(act => (
                                <div key={act.id} className="audit-item system-log mb-10">
                                  <div className="flex-between">
                                    <strong className="text-primary">{act.type} ({act.status})</strong>
                                    <span className="log-time">{new Date(act.createdAt).toLocaleTimeString()}</span>
                                  </div>
                                  {act.inputPayload && (
                                    <div className="mt-5">
                                      <strong>Input:</strong>
                                      <pre className="text-mono text-small bg-canvas p-10 border-radius-8" style={{ overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'rgba(0,0,0,0.02)' }}>
                                        {JSON.stringify(act.inputPayload, null, 2)}
                                      </pre>
                                    </div>
                                  )}
                                  {act.outputPayload && (
                                    <div className="mt-5">
                                      <strong>Output:</strong>
                                      <pre className="text-mono text-small bg-canvas p-10 border-radius-8" style={{ overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'rgba(0,0,0,0.02)' }}>
                                        {JSON.stringify(act.outputPayload, null, 2)}
                                      </pre>
                                    </div>
                                  )}
                                  {act.error && <div className="mt-5 text-error"><strong>Error:</strong> {act.error}</div>}
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Approval recorded gate container */}
                      <div className="glass-card inner-card border-accent">
                        {(!reviewApp.approval && !['submitted', 'submitted_mock_for_test', 'rejected'].includes(reviewApp.status)) && (
                          <div className="mb-15">
                            <label className="checkbox-label" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <input
                                type="checkbox"
                                id="review-approval-gate"
                                checked={reviewChecked}
                                onChange={(e) => setReviewChecked(e.target.checked)}
                              />
                              <span>I have reviewed the tailored resume artifact and verified the application details</span>
                            </label>
                          </div>
                        )}
                        <div className="flex-between align-center">
                          <div>
                            <h4 className="mb-5 uppercase-title">Human Approval Record & Submission Controls</h4>
                            <div className="text-muted">
                              {reviewApp.approval ? (
                                <strong className="color-success">
                                  ✓ Approved by {reviewApp.approval.approvedBy} on {new Date(reviewApp.approval.approvedAt).toLocaleString()}
                                </strong>
                              ) : ['submitted', 'submitted_mock_for_test', 'rejected'].includes(reviewApp.status) ? (
                                <span className="text-muted">Application process completed or discarded.</span>
                              ) : (
                                <span className="text-warning">Awaiting Approval: Explicit human review required prior to final portal submission.</span>
                              )}
                            </div>
                          </div>
                          <div className="btn-row">
                            {!['submitted', 'submitted_mock_for_test', 'rejected'].includes(reviewApp.status) && (
                              <>
                                {!reviewApp.approval ? (
                                  <button
                                    type="button"
                                    className="btn btn-primary"
                                    onClick={() => handleRecordApproval(reviewApp.id)}
                                    disabled={!reviewChecked}
                                  >
                                    Record Approval
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    className="btn btn-success"
                                    onClick={() => handleSubmitApproved(reviewApp.id)}
                                  >
                                    Submit Approved ➔
                                  </button>
                                )}
                              </>
                            )}
                            {!['submitted', 'submitted_mock_for_test', 'rejected'].includes(reviewApp.status) && (
                              <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() => handleDiscardApplication(reviewApp.id)}
                              >
                                Discard Application
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* View: Profile & Vault */}
          {activeView === 'profile' && (
            <section className="view-panel active" style={{ display: 'flex', flexDirection: 'column' }}>
              <div className="two-column-layout">
                {/* Vault management */}
                <div className="glass-card">
                  <div className="card-header">
                    <h2>Encrypted Vault Management</h2>
                  </div>
                  <div className="card-body">
                    <p className="text-muted">Initialize or lock your zero-knowledge AES-256 local vault to access credentials and resume claim banks.</p>
                    <form onSubmit={handleVaultSubmit}>
                      <div className="form-group">
                        <label htmlFor="vault-password">Master Vault Password</label>
                        <input
                          type="password"
                          id="vault-password"
                          className="form-control"
                          value={vaultPassword}
                          onChange={(e) => setVaultPassword(e.target.value)}
                          placeholder={appState.locked ? "Enter secure key..." : "Enter key to re-unlock, or leave blank to lock..."}
                        />
                      </div>
                      <div className="btn-row">
                        <button type="submit" className="btn btn-primary">
                          {appState.locked ? (appState.exists ? 'Unlock Vault' : 'Unlock / Bootstrap Vault') : (vaultPassword.trim() ? 'Re-unlock Vault' : 'Lock Vault')}
                        </button>
                      </div>
                    </form>
                  </div>
                </div>

                {/* Resume PDF Library */}
                <div className="glass-card">
                  <div className="card-header">
                    <h2>Resume PDF Library</h2>
                  </div>
                  <div className="card-body">
                    <form onSubmit={(e) => handleResumeUpload(e, onboardingFiles)}>
                      <div className="form-group">
                        <label htmlFor="profile-resume-files">Select Resume PDFs</label>
                        <input
                          type="file"
                          id="profile-resume-files"
                          className="form-control"
                          accept="application/pdf,.pdf"
                          multiple
                          disabled={appState.locked}
                          onChange={(e) => setOnboardingFiles(e.target.files)}
                        />
                      </div>
                      <button type="submit" className="btn btn-primary" disabled={appState.locked || !onboardingFiles}>
                        Upload & Parse PDFs
                      </button>
                    </form>

                    <div className="claim-bank-list" style={{ marginTop: '15px' }}>
                      {(!appState.resumes || appState.resumes.length === 0) ? (
                        <p className="text-muted">No resume PDFs parsed yet.</p>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                          {appState.resumes.map(resume => {
                            const isActive = resume.id === appState.activeResumeId;
                            const sizeKb = Math.round(resume.size / 1024);
                            return (
                              <div
                                key={resume.id}
                                className="resume-card glass-card p-15"
                                style={{ border: `1px solid ${isActive ? 'var(--accent-blue, #2563eb)' : 'var(--glass-border)'}` }}
                              >
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                  <div>
                                    <h4 style={{ margin: '0 0 5px 0', fontWeight: 600 }}>{resume.label}</h4>
                                    <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-muted)' }}>
                                      File: {resume.fileName} ({sizeKb} KB) | Uploaded: {new Date(resume.uploadedAt || '').toLocaleDateString()}
                                    </p>
                                    <p style={{ margin: '5px 0 0 0', fontSize: '13px' }}>
                                      Candidate: <strong>{resume.candidateName}</strong> ({resume.candidateEmail})
                                    </p>
                                    <p style={{ margin: '5px 0 0 0', fontSize: '12px', color: 'var(--text-muted)' }}>
                                      Skills: {resume.skillCount} | Claims: {resume.claimCount}
                                    </p>
                                  </div>
                                  <div>
                                    {isActive ? (
                                      <span className="status-pill status-submitted">Active</span>
                                    ) : (
                                      <button
                                        type="button"
                                        className="btn btn-secondary btn-small"
                                        onClick={() => handleSelectResume(resume.id)}
                                      >
                                        Use this resume
                                      </button>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Claims Bank Preview */}
              <div className="glass-card mt-20">
                <div className="card-header">
                  <h2>Extracted Candidate Claim Bank</h2>
                </div>
                <div className="card-body">
                  {appState.locked ? (
                    <p className="text-muted">Unlock vault to parse facts and build the claim bank.</p>
                  ) : (!appState.profile?.claimBank || appState.profile.claimBank.length === 0) ? (
                    <p className="text-muted">No resume parsed yet. Upload a resume to build the claim bank.</p>
                  ) : (
                    <div className="claim-bank-list">
                      {appState.profile.claimBank.map((group, groupIdx) => (
                        <div key={groupIdx} className="claim-bank-item mb-15 p-15 border-radius-8" style={{ background: 'var(--accent-light)' }}>
                          <span className="claim-category" style={{ fontWeight: 600, textTransform: 'uppercase', fontSize: '11px', display: 'block', marginBottom: '8px' }}>
                            {group.category}
                          </span>
                          <ul style={{ paddingLeft: '20px', margin: 0 }}>
                            {group.claims.map((claim, cIdx) => (
                              <li key={cIdx} style={{ marginBottom: '4px' }}>{claim}</li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* View: Link Intake */}
          {activeView === 'intake' && (
            <section className="view-panel active" style={{ display: 'flex', flexDirection: 'column' }}>
              {appState.locked && (
                <div className="glass-card max-width-800 mb-20 panel-warning">
                  <div className="card-body p-20 flex-between align-center">
                    <div>
                      <strong className="text-error">⚿ Vault Security Lock Active</strong>
                      <p className="text-muted text-small mt-5 mb-0">Your encrypted vault is locked. Unlock or bootstrap your vault in Profile & Vault to enable job application intake and automated execution planning.</p>
                    </div>
                    <button type="button" className="btn btn-secondary btn-small ml-10" onClick={() => setActiveView('profile')}>
                      Unlock Vault ➔
                    </button>
                  </div>
                </div>
              )}

              <div className="glass-card max-width-800">
                <div className="card-header">
                  <h2>Job Application Intake & Plan Generator</h2>
                </div>
                <div className="card-body">
                  <form onSubmit={handleLinkIntake}>
                    <div className="form-group">
                      <label htmlFor="intake-url">Workday Career Portal Job URL</label>
                      <input
                        type="url"
                        id="intake-url"
                        className="form-control"
                        value={intakeUrl}
                        onChange={(e) => setIntakeUrl(e.target.value)}
                        placeholder="https://tenant.myworkdayjobs.com/en-US/careers/job/..."
                        required
                        disabled={appState.locked}
                      />
                    </div>
                    <div className="form-group">
                      <label htmlFor="intake-resume-id">Select Resume for Application</label>
                      <select
                        id="intake-resume-id"
                        className="form-control"
                        value={intakeResumeId}
                        onChange={(e) => setIntakeResumeId(e.target.value)}
                        disabled={appState.locked || !(appState.resumes && appState.resumes.length > 0)}
                      >
                        {(!appState.resumes || appState.resumes.length === 0) ? (
                          <option value="">No resumes available (Unlock vault & parse PDFs)</option>
                        ) : (
                          appState.resumes.map(r => (
                            <option key={r.id} value={r.id}>
                              {r.label} ({r.fileName})
                            </option>
                          ))
                        )}
                      </select>
                    </div>
                    
                    <div className="row">
                      <div className="col">
                        <div className="form-group">
                          <label htmlFor="intake-company">Company (Optional)</label>
                          <input
                            type="text"
                            id="intake-company"
                            className="form-control"
                            value={intakeCompany}
                            onChange={(e) => setIntakeCompany(e.target.value)}
                            placeholder="Automatically detected if left blank"
                            disabled={appState.locked}
                          />
                        </div>
                      </div>
                      <div className="col">
                        <div className="form-group">
                          <label htmlFor="intake-title">Job Title (Optional)</label>
                          <input
                            type="text"
                            id="intake-title"
                            className="form-control"
                            value={intakeTitle}
                            onChange={(e) => setIntakeTitle(e.target.value)}
                            placeholder="Automatically detected if left blank"
                            disabled={appState.locked}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="row">
                      <div className="col">
                        <div className="form-group">
                          <label htmlFor="intake-salary">Expected/Offered Salary (Optional)</label>
                          <input
                            type="number"
                            id="intake-salary"
                            className="form-control"
                            value={intakeSalary}
                            onChange={(e) => setIntakeSalary(e.target.value)}
                            placeholder="e.g. 120000"
                            disabled={appState.locked}
                          />
                        </div>
                      </div>
                      <div className="col">
                        <div className="form-group">
                          <label htmlFor="intake-requirements">Job Requirements (Optional, comma-separated)</label>
                          <input
                            type="text"
                            id="intake-requirements"
                            className="form-control"
                            value={intakeRequirements}
                            onChange={(e) => setIntakeRequirements(e.target.value)}
                            placeholder="e.g. React, Node.js, Python"
                            disabled={appState.locked}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="form-group">
                      <label>Simulate Verification Challenges (Testing & Offline Mode)</label>
                      <div className="checkbox-group">
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={simCaptcha}
                            onChange={(e) => setSimCaptcha(e.target.checked)}
                            disabled={appState.locked}
                          />{' '}
                          CAPTCHA challenge required
                        </label>
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={sim2fa}
                            onChange={(e) => setSim2fa(e.target.checked)}
                            disabled={appState.locked}
                          />{' '}
                          Multi-Factor (2FA) verification required
                        </label>
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={simEmail}
                            onChange={(e) => setSimEmail(e.target.checked)}
                            disabled={appState.locked}
                          />{' '}
                          Email verification required
                        </label>
                      </div>
                    </div>

                    <button type="submit" className="btn btn-primary" disabled={appState.locked || !intakeUrl}>
                      Create & Analyze Application Plan
                    </button>
                  </form>
                </div>
              </div>

              {/* Plan Analysis Panel */}
              {pendingPlan && (
                <div className="glass-card mt-20 max-width-800">
                  <div className="card-header flex-between">
                    <h2>Automated Application Execution Plan</h2>
                    <div className={`badge badge-${pendingPlan.application.status}`}>
                      Status: {formatStatusLabel(pendingPlan.application.status)}
                    </div>
                  </div>
                  <div className="card-body">
                    <div className="plan-steps-container">
                      <div className={`plan-summary-alert ${pendingPlan.safety?.blocked ? 'alert-blocked' : 'alert-passed'}`}>
                        {pendingPlan.safety?.blocked ? (
                          <span>
                            <strong>Safety Gate Blocked:</strong> Application has pending checks:{' '}
                            {pendingPlan.safety.reasons.join(', ')}. Auto-submission is paused until resolved.
                          </span>
                        ) : (
                          <span>
                            <strong>Safety Gate Passed:</strong> No blocking alerts detected. Resume claims match requirements. Ready to start automation.
                          </span>
                        )}
                      </div>
                      <div className="steps-timeline">
                        {(pendingPlan.plan?.steps || []).map((step, index) => {
                          let stepClass = 'timeline-step';
                          if (index === 0) stepClass += ' step-completed';
                          if (index === (pendingPlan.plan!.steps.length - 1) && pendingPlan.safety?.blocked) stepClass += ' step-blocked';

                          return (
                            <div key={index} className={stepClass}>
                              <div className="step-marker"></div>
                              <div className="step-details">
                                <div className="step-name">{step.name}</div>
                                <div className="step-description">{step.description}</div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    <div className="btn-row justify-end mt-20">
                      <button className="btn btn-secondary" onClick={handleRejectPlan}>Cancel / Discard</button>
                      <button className="btn btn-success ml-10" onClick={handleApprovePlan}>Approve & Start Automation</button>
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}

          {/* View: Settings */}
          {activeView === 'settings' && (
            <section className="view-panel active">
              <div className="two-column-layout">
                {/* Proton Mail configuration */}
                <div className="glass-card">
                  <div className="card-header">
                    <h2>Proton Mail Bridge Integration</h2>
                  </div>
                  <div className="card-body">
                    <p className="text-muted">Configure IMAP credentials to intercept verification links and security codes.</p>
                    <form onSubmit={(e) => handleProtonConfig(e, false)}>
                      <div className="form-group">
                        <label htmlFor="proton-host">IMAP Host</label>
                        <input
                          type="text"
                          id="proton-host"
                          className="form-control"
                          value={protonHost}
                          onChange={(e) => setProtonHost(e.target.value)}
                          placeholder="127.0.0.1"
                          required
                          disabled={appState.locked}
                        />
                      </div>
                      <div className="form-group">
                        <label htmlFor="proton-port">IMAP Port</label>
                        <input
                          type="number"
                          id="proton-port"
                          className="form-control"
                          value={protonPort}
                          onChange={(e) => setProtonPort(parseInt(e.target.value, 10) || 0)}
                          placeholder="1143"
                          required
                          disabled={appState.locked}
                        />
                      </div>
                      <div className="form-group">
                        <label htmlFor="proton-username">IMAP Username</label>
                        <input
                          type="text"
                          id="proton-username"
                          className="form-control"
                          value={protonUsername}
                          onChange={(e) => setProtonUsername(e.target.value)}
                          placeholder="username@proton.local"
                          required
                          disabled={appState.locked}
                        />
                      </div>
                      <div className="form-group">
                        <label htmlFor="proton-password">IMAP Password</label>
                        <input
                          type="password"
                          id="proton-password"
                          className="form-control"
                          value={protonPassword}
                          onChange={(e) => setProtonPassword(e.target.value)}
                          placeholder="Bridge password"
                          required
                          disabled={appState.locked}
                        />
                      </div>
                      <div className="checkbox-group mb-15">
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={protonSimulate}
                            onChange={(e) => setProtonSimulate(e.target.checked)}
                            disabled={appState.locked}
                          />{' '}
                          Simulate Successful Connection (Offline mode)
                        </label>
                        <p className="proton-notice">
                          <span>
                            {protonSimulate ? (
                              <span>Currently in <strong>Offline Simulated Mode</strong>. Uncheck to connect to real local Proton Bridge at 127.0.0.1.</span>
                            ) : (
                              <span>Configured to query real local IMAP service.</span>
                            )}
                          </span>
                        </p>
                      </div>
                      <div className="btn-row">
                        <button type="button" onClick={(e) => handleProtonConfig(e, true)} className="btn btn-secondary" disabled={appState.locked}>
                          Test Connection
                        </button>
                        <button type="submit" className="btn btn-primary" disabled={appState.locked}>
                          {appState.protonConfigured ? 'Update Proton Config' : 'Save Proton Config'}
                        </button>
                      </div>
                    </form>
                    {protonTestFeedback && (
                      <div className={`mt-15 test-feedback-toast ${protonTestFeedback.type === 'success' ? 'test-feedback-success' : 'test-feedback-error'}`}>
                        <span>{protonTestFeedback.text}</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* LLM Providers */}
                <div className="glass-card mt-20">
                  <div className="card-header">
                    <h2>LLM Provider Registry</h2>
                  </div>
                  <div className="card-body">
                    <p className="text-muted mb-15">Select to edit configuration or run connectivity tests.</p>
                    <div className="provider-list">
                      {(!appState.llmProviders || appState.llmProviders.length === 0) ? (
                        <p className="text-muted">Loading providers...</p>
                      ) : (
                        appState.llmProviders.map(p => (
                          <div
                            key={p.id}
                            className="provider-card"
                            style={{ border: `1px solid ${p.isActive ? 'var(--accent-blue, #2563eb)' : 'var(--glass-border)'}` }}
                          >
                            <div className="provider-card-header">
                              <span className="provider-card-title">{p.name}</span>
                              <span className="badge-pill-sm status-pill status-submitted">{p.kind}</span>
                            </div>
                            <div className="provider-card-meta">
                              Model: <strong>{p.model}</strong><br />
                              Endpoint: <span className="text-mono">{p.baseUrl || 'Default'}</span>
                            </div>
                            <div className="provider-card-footer">
                              <span className="badge-pill-sm key-status-ok">{p.isActive ? 'Active' : 'Inactive'}</span>
                              <div className="btn-row">
                                <button type="button" className="btn btn-secondary btn-small" onClick={() => handleEditLlmProvider(p)} disabled={appState.locked}>
                                  Edit
                                </button>
                                <button type="button" className="btn btn-secondary btn-small" onClick={() => handleTestLlmProvider(p.id)} disabled={appState.locked}>
                                  Test
                                </button>
                              </div>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                {/* Career Portal Credentials */}
                <div className="glass-card">
                  <div className="card-header">
                    <h2>Career Portal Automation Credentials</h2>
                  </div>
                  <div className="card-body">
                    <p className="text-muted">Credentials used by the browser automation runner to log into career portals.</p>
                    <form onSubmit={handleSaveCredentials}>
                      <div className="form-group">
                        <label htmlFor="workday-username">Portal Email / Username</label>
                        <input
                          type="email"
                          id="workday-username"
                          className="form-control"
                          value={workdayUsername}
                          onChange={(e) => setWorkdayUsername(e.target.value)}
                          placeholder="candidate@example.com"
                          required
                          disabled={appState.locked}
                        />
                      </div>
                      <div className="form-group">
                        <label htmlFor="workday-password">Portal Password</label>
                        <input
                          type="password"
                          id="workday-password"
                          className="form-control"
                          value={workdayPassword}
                          onChange={(e) => setWorkdayPassword(e.target.value)}
                          placeholder="••••••••••••"
                          required
                          disabled={appState.locked}
                        />
                      </div>
                      <button type="submit" className="btn btn-primary" disabled={appState.locked || !workdayUsername || !workdayPassword}>
                        {appState.hasCredentials ? 'Update Credentials' : 'Save Credentials'}
                      </button>
                    </form>
                  </div>
                </div>

                {/* LLM Setup Form */}
                <div className="glass-card mt-20">
                  <div className="card-header">
                    <h2>LLM Provider Endpoint & Model Setup</h2>
                  </div>
                  <div className="card-body">
                    <p className="text-muted">Configure OpenAI-compatible, DeepSeek, or local LLM endpoints for resume tailoring.</p>
                    <form onSubmit={handleSaveLlmProvider}>
                      <input type="hidden" value={llmId} />
                      <div className="form-group">
                        <label htmlFor="llm-name">Provider Name</label>
                        <input
                          type="text"
                          id="llm-name"
                          className="form-control"
                          value={llmName}
                          onChange={(e) => setLlmName(e.target.value)}
                          placeholder="DeepSeek API"
                          required
                          disabled={appState.locked}
                        />
                      </div>
                      <div className="form-group">
                        <label htmlFor="llm-kind">Provider Kind</label>
                        <select
                          id="llm-kind"
                          className="form-control"
                          value={llmKind}
                          disabled={appState.locked}
                          onChange={(e) => {
                            const kind = e.target.value;
                            setLlmKind(kind);
                            setLlmModel(PROVIDER_MODELS[kind]?.[0] || '');
                          }}
                        >
                          <option value="deepseek">DeepSeek</option>
                          <option value="openai-compatible">OpenAI Compatible</option>
                          <option value="kimi">Kimi</option>
                          <option value="local">Local Endpoint</option>
                        </select>
                      </div>
                      <div className="form-group">
                        <label htmlFor="llm-model">Model</label>
                        <select
                          id="llm-model"
                          className="form-control"
                          value={llmModel}
                          onChange={(e) => setLlmModel(e.target.value)}
                          disabled={appState.locked}
                          required
                        >
                          {(PROVIDER_MODELS[llmKind] || []).map(m => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                      </div>
                      <div className="form-group">
                        <label htmlFor="llm-baseurl">Base URL (Optional)</label>
                        <input
                          type="url"
                          id="llm-baseurl"
                          className="form-control"
                          value={llmBaseUrl}
                          onChange={(e) => setLlmBaseUrl(e.target.value)}
                          placeholder="https://api.deepseek.com/v1"
                          disabled={appState.locked}
                        />
                      </div>
                      <div className="form-group">
                        <label htmlFor="llm-apikey">API Key / Secret</label>
                        <input
                          type="password"
                          id="llm-apikey"
                          className="form-control"
                          value={llmApiKey}
                          onChange={(e) => setLlmApiKey(e.target.value)}
                          placeholder="••••••••••••"
                          disabled={appState.locked}
                        />
                      </div>
                      <div className="checkbox-group mb-15">
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={llmLiveActive}
                            onChange={(e) => setLlmLiveActive(e.target.checked)}
                            disabled={appState.locked}
                          />{' '}
                          Is Active Provider
                        </label>
                      </div>
                      <div className="btn-row">
                        <button type="submit" className="btn btn-primary" disabled={appState.locked}>
                          Save LLM Provider
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary ml-10"
                          onClick={() => {
                            setLlmId('');
                            setLlmName('');
                            setLlmKind('deepseek');
                            setLlmModel('deepseek-chat');
                            setLlmBaseUrl('');
                            setLlmApiKey('');
                            setLlmLiveActive(true);
                            setLlmTestFeedback(null);
                          }}
                        >
                          Clear Form
                        </button>
                      </div>
                    </form>
                    {llmTestFeedback && (
                      <div className={`mt-15 test-feedback-toast ${llmTestFeedback.type === 'success' ? 'test-feedback-success' : 'test-feedback-error'}`}>
                        <span>{llmTestFeedback.text}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </section>
          )}

        </div>
      </div>
    </div>
  );
}
