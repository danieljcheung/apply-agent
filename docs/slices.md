# Development Slices & Roadmap

This document outlines the development milestone roadmap for `apply-agent`, detailing delivered capabilities, verification expectations, and planned future execution slices.

## Milestone 1: Core Foundation & Browser Automation Contract (Current)

Milestone 1 establishes the baseline infrastructure, storage abstractions, browser automation contract, and offline verification mechanisms.

### Key Deliverables

1. **Consolidated Documentation**: Comprehensive architectural, operational, and safety specification docs linked from `docs/index.md`.
2. **Browser Automation Contract & Policy**:
   - Standardized `BrowserAutomationAdapter` interface defining `inspect`, `fillDraft`, and `submitApproved` entrypoints.
   - Domain execution policy restricting automation to local test fixtures (`localhost`) and official Workday portals (`*.myworkdayjobs.com`).
3. **Playwright Inspect-Only Adapter**:
   - Foundation Playwright driver implementing structural DOM inspection (`inspect`).
   - `fillDraft` delegates to review-only inspection paths.
   - `submitApproved` strictly refuses execution with an `automation_not_configured` blocker to guarantee submission safety.
4. **Deterministic Workday Test Fixtures**:
   - Local mock HTML pages (`test/fixtures/workday/*.html`) simulating Workday application steps (tenant detection, login, job description extraction, disclosures).

### Verification Expectations

- **Zero External Network Dependencies**: All unit and browser integration tests run strictly offline using local HTML test fixtures served over `localhost` / `127.0.0.1`.
- **Automated Test Suite Execution**:
  - Node.js test runner suite (`npm test`) validating server routes, database query mocks, tracker ledger persistence, status normalizations, and browser adapter inputs.
- **Contract & Safety Verification**:
  - Verification that invoking `submitApproved` without active approval throws a blocker.
  - Verification that untrusted domain navigation is blocked by policy checks.

---

## Implemented System Slices & Capabilities

All development slices have been fully implemented, verified, and integrated into the primary orchestration layer (`AppService`) of `apply-agent`.

### Slice 2: LLM Provider Auth & Resume Tailoring
- **Goal**: Secure, encrypted local provider credentials and audited LLM adapter integration for DeepSeek, Kimi, and other OpenAI-compatible APIs.
- **Status**: **Completed & Integrated**.
- **Capabilities**:
  - Provider configuration and API keys are stored securely within the local encrypted vault (`vault.enc`) and are never exposed to logs, client-side renders, or Kubernetes manifests.
  - The system utilizes the active LLM provider to perform automated job description extraction, candidate compatibility checks, resume tailoring from dossier claim banks, and screening question response drafting.
  - Every LLM interaction creates a structured `LLMActionRecord` capturing token usage, model metadata, latency, and human review status.

### Slice 3: Interactive Form Filling & Field Provenance
- **Goal**: Active form population across multi-step job application portals (e.g. Workday).
- **Status**: **Completed & Integrated**.
- **Capabilities**:
  - Candidate profile bundles (`ProfileBundle`), work experience, education history, and custom dossier answers are dynamically mapped to form input fields.
  - The automation engine generates and records `FieldProvenance` tracking the matching confidence and source lineage for each form field.
  - Audited LLM-tailored resumes and drafted response sets are attached to the draft application only after safety and compliance gates are passed.

### Slice 4: Email Verification & Proton Bridge Integration
- **Goal**: Automated account creation, verification link processing, and OTP email confirmation.
- **Status**: **Completed & Integrated**.
- **Capabilities**:
  - Implements the `verifying_email` state transition.
  - Integrates with the local Proton Mail Bridge client via IMAP over localhost (`127.0.0.1`) to poll mailboxes and programmatically extract verification links and confirmation PINs.
  - Operates under a strict local-only boundary; configuration remains local to the workstation, and testing can utilize a mock IMAP client or `simulateSuccess` mode.

### Slice 5: Controlled Submission & Approval Gate
- **Goal**: Safe end-to-end application submission controlled by an explicit user safety gate.
- **Status**: **Completed & Integrated**.
- **Capabilities**:
  - Implements the `submit_after_approval` run mode and requires an explicit, verified `SubmissionApproval` record to execute a final submission.
  - Before final submission, execution halts at `reviewing_application`. The user must review all populated fields in the console and click "Approve".
  - Approvals generate a `SubmissionApproval` entry containing cryptographic hashes of the current application fields and blocker snapshots to prevent stale submissions or payload tampering.

### Slice 6: Telemetry & Cluster Scale Persistence
- **Goal**: Scale persistence to CloudNativePG PostgreSQL clusters and expose Prometheus telemetry.
- **Status**: **Completed & Integrated**.
- **Capabilities**:
  - Supports dual-mode persistence: a local file-based JSON ledger or direct SQL pooling to a CloudNativePG PostgreSQL database.
  - Exposes a live `/metrics` endpoint serving structured Prometheus metrics mapping application status, run events, safety blockers, browser runs, and LLM usage.
  - Integrates with standard Kubernetes ConfigMaps, Secrets, and Prometheus Operator `ServiceMonitor` resources.
