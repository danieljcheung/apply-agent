# Browser Automation Contract & Safety Policy

This document details the `BrowserAutomationAdapter` interface, hybrid runtime support, URL execution policies, run modes, and safety invariants governing browser operations within `apply-agent`.

## Hybrid Architecture & Runtimes: Playwright vs. agent-browser

`apply-agent` supports a dual-adapter execution model designed to separate production automation pipelines from developer-interactive environments:

```typescript
export type BrowserRuntime = 'playwright' | 'agent-browser';
```

1. **Playwright Production Adapter (`playwright`)**:
   - **Purpose**: The primary production automation driver. It executes headless/headed browser sessions via standard scripts, is fully containerized, integrates with the safety gate rules engine, and handles automated email extraction.
   - **Execution Context**: Used in production Kubernetes deployments, CI verification pipelines, and local headless runs. It provides deterministic DOM extraction and reliable automated form interaction.
   - **Constraints**: Runs programmatically according to pre-defined execution plans. In local test mode, it operates offline against mock test fixtures (`localhost`) to guarantee zero external dependency run safety.

2. **agent-browser Developer Harness (`agent-browser`)**:
   - **Purpose**: An optional development-only / operator tool. It opens an interactive browser session, exposing a developer control harness.
   - **Execution Context**: Used during local developer loops to inspect page state, explore DOM selectors, debug specific form-filling failure modes, or run subagent-driven automated exploratory tasks.
   - **Constraints**: Unlike Playwright production mode, `agent-browser` relies on interactive developer prompts or local CLI controls, requires active human or subagent guidance, and is never deployed in cluster environments.
## Adapter Contract (`BrowserAutomationAdapter`)

All browser automation drivers must implement the unified `BrowserAutomationAdapter` interface:

```typescript
export interface BrowserInspectInput {
  url: string;
  options?: Record<string, unknown>;
}

export interface BrowserFillInput {
  url: string;
  profileBundle: unknown;
  answers?: Record<string, string>;
  options?: Record<string, unknown>;
}

export interface BrowserSubmitInput {
  url: string;
  applicationId: string;
  approvalToken: string;
  options?: Record<string, unknown>;
}

export interface BrowserAutomationAdapter {
  inspect(input: BrowserInspectInput): Promise<unknown>;
  fillDraft(input: BrowserFillInput): Promise<unknown>;
  submitApproved(input: BrowserSubmitInput): Promise<unknown>;
  close?(): Promise<void>;
}
```

### Execution Modes (`AutomationRunMode`)

Browser automation operates under three discrete run modes defining execution boundaries:

```typescript
export type AutomationRunMode = 'inspect_only' | 'fill_review_only' | 'submit_after_approval';
```

- **`inspect_only`**: Navigates to target postings and extracts structural DOM/job details without interacting with form input fields or submitting data.
- **`fill_review_only`**: Populates form fields (personal info, work history, attachments) but halts prior to final application submission to allow human review.
- **`submit_after_approval`**: Executes complete end-to-end flow, including final submission, only when explicit user approval is verified.

---

## Control Plane Workflows

The `apply-agent` HTTP API exposes routes that interface directly with the encrypted vault and automation engine. These routes form the backbone of the core user workflows:

### 1. Vault Onboarding Flow
   - **Initiation**: The application starts locked. The user/client initializes and unlocks the local data environment by calling `POST /api/profile/bootstrap` with a vault password, optionally supplying initial resume text and interview answers.
   - **Vault Persistence**: The service instantiates a local encrypted storage vault (`vault.enc`) using AES-256 encryption. The decrypted memory structure contains:
     - **Profile Bundle (`ProfileBundle`)**: Unified dossier of `candidateProfile`, `claimBank` (evidence and verification metrics), and `answerMemory` (historical answer ledger).
     - **Credentials**: Optional portal credentials (stored Workday tenant credentials not required for tenant account creation flow).
     - **LLM Settings**: LLM provider configurations and API keys.
     - **Proton settings**: IMAP bridge authentication details.
   - **Database Synchronization**: If database persistence is configured (CloudNativePG), the decrypted profile bundle is mirrored in the PostgreSQL database for cluster replica availability.

### 2. Dossier Interview Flow
   - **Question Discovery**: During form filling, when the automation engine encounters a screening question that does not match any current profile claims, it registers a blocker (such as `unknown_required_answer`).
   - **Interactive Prompting**: The system halts the run and prompts the candidate via the Next.js web dashboard.
   - **Dossier Enrichment**: The candidate answers the question by calling `POST /api/prompts/answer`. The service appends the response to the ledger event log and indexes the answer in the dossier's `answerMemory` within the vault. Future runs on similar forms will automatically match and resolve these prompts via the LLM provider.

### 3. Resume Tailoring Flow
   - **Requirement Matching**: For any job application, the system can tailors the base resume HTML/PDF to align with the specific job description by calling `POST /api/applications/tailor-resume`.
   - **LLM Customization**: The service calls the active LLM provider (configured via `POST /api/settings/llm/providers`) to analyze job requirements and generate a customized version of the candidate's experience.
   - **Audit Trail**: Every resume generation produces a signed `LLMActionRecord` containing redacted inputs, model metadata, latency, and a human approval state. The tailored resume version is saved in the ledger for review.

### 4. Review Console & Human-in-the-Loop Gate
   - **Review Handoff**: When operating under `fill_review_only` or `submit_after_approval` (without active approval), the automation engine fills all details but stops before final submission, transitioning the application status to `reviewing_application`.
   - **User Inspection**: The candidate opens the Next.js web dashboard, reviews the populated fields, inspects the tailored resume version, and resolves any pending screening questions.
   - **Explicit Approval**: The candidate clicks "Approve", calling `POST /api/applications/approve` with `{ approved: true, approvedBy: 'user' }`. This creates a permanent, signed `SubmissionApproval` record containing cryptographic hashes of the current application fields and blocker states.
   - **Submission Trigger**: The automation engine detects the valid approval record, verifies that the application hash matches (ensuring no inputs have changed since review), and executes the final `submitting` transition.

---
## Safety Invariants

### 1. No Live Final Submit Without Explicit Approval
The foundational safety invariant of `apply-agent` is: **NO LIVE FINAL SUBMIT WITHOUT EXPLICIT APPROVAL**.

- Calling `submitApproved(input)` without a valid, verified user approval token (`approvalToken`) or when operating outside `submit_after_approval` mode must immediately abort execution.
- If approval conditions are unmet, the adapter must return or throw a canonical blocker (specifically `automation_not_configured` or `llm_output_requires_review`).
- In Milestone 1, the Playwright adapter foundation operates as inspect-only; `fillDraft` delegates to inspection/review-only paths, and `submitApproved` unconditionally refuses execution with a blocker.

### 2. Domain URL Policy & Navigation Boundaries
To prevent unintended automation execution against unverified external portals, browser automation enforces strict URL domain gating:

| Environment / Mode | Allowed URL Domains | Policy Behavior |
| :--- | :--- | :--- |
| **Test Fixtures & Local Dev** | `http://localhost/*`, `http://127.0.0.1/*` | Unrestricted local test execution against mock HTML fixtures. |
| **Production Workday** | `https://myworkdayjobs.com/*`, `https://*.myworkdayjobs.com/*` | Permitted target domain for Workday application automation. |
| **Untrusted / External** | All other domains | Immediately rejected with `site_automation_disallowed` blocker. |


### 3. Proton Mail Bridge & Email Verification Boundary
* **Local Desktop Environment**: Proton Mail Bridge operates on host `127.0.0.1`, allowing local email verification checks.
* **Kubernetes Cluster Deployment**: Proton Mail Bridge is deployed as a sidecar container (`proton-bridge`) in the same single pod as `apply-agent`. Because containers in a Kubernetes pod share a network namespace, IMAP is exposed on `127.0.0.1:1143` (localhost inside the pod) and is not exposed outside the pod.
* **Credential & Storage Safety**: Connection credentials (`PROTON_BRIDGE_USERNAME` and `PROTON_BRIDGE_PASSWORD`) are passed via Kubernetes secrets or vault-preferred equivalents. Raw credentials are never exposed in API responses, renderer state, artifacts, or logs. Bridge state is persisted across pod restarts using a dedicated PersistentVolumeClaim (`proton-bridge-data`). Offline testing and local mock runs are supported via `simulateSuccess` configuration.
---

## Canonical Blocker Codes

When navigation, policy checks, or form parsing encounter ambiguity or safety boundary violations, the application sets a `BlockerCode` (defined in `src/types.ts`).

### Common Automation Blocker Codes

 - `automation_not_configured`: Adapter initialization or approval gates are not set up.
- `site_automation_disallowed`: Target domain violates the domain URL policy.
- `captcha_required`: CAPTCHA or bot challenge detected. For authorized Workday site-owner integrations, direct text/image prompts are attempted with the active configured LLM provider; token widgets such as reCAPTCHA, hCaptcha, Turnstile, and Arkose remain blocked unless manually completed.
- `two_factor_required`: Interactive MFA challenge detected requiring manual intervention unless a first-party configured channel is available.
- `email_verification_required`: Workday account email confirmation step pending.
- `unknown_required_answer` / `unsupported_profile_claim`: Form prompt cannot be safely matched against candidate profile memory.
- `salary_below_floor` / `work_authorization_conflict`: Strategic application rules reject job constraints.
- `llm_output_requires_review`: Generated answer, tailored resume content, or filled field confidence is below safety thresholds.

---

## LLM Provider Boundary

- LLM providers such as DeepSeek, Kimi, OpenAI-compatible APIs, or local model servers are used only through a dedicated provider registry, not directly from browser automation code.
- Provider API keys live in the encrypted local vault and are never written to application records, logs, browser artifacts, renderer state, or Kubernetes manifests.
- Allowed LLM tasks are job extraction, profile matching, resume tailoring from existing claim-bank evidence, answer drafting, and field mapping.
- Every LLM call must produce an `LLMActionRecord` with redacted input, provider/model metadata, latency, token counts when available, output provenance, and human-review status.
- LLM output may pre-fill draft fields only in `fill_review_only` mode and never authorizes final submission.
- LLM providers may be used for direct text/image CAPTCHA prompts in this authorized Workday integration, but never for minting third-party widget tokens, and never to bypass final submission approval.
