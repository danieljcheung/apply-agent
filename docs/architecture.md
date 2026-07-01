# Architecture & Environment Boundaries

This document defines the system architecture, component responsibilities, and local-versus-cluster execution boundaries for `apply-agent`.

## Architecture Overview

`apply-agent` is structured as a modular TypeScript service providing an HTTP API backend, automated job processing workflows, and multi-mode persistence layers.

```mermaid
graph TD
    subgraph Local Workstation Boundary
        WebUI[Next.js Web UI] -->|HTTP / localhost| Backend[apply-agent Node Service]
        Backend -->|Ledger & Vault| LocalFS[(JSON Ledger / Vault.enc)]
        Backend -->|SMTP/IMAP| ProtonBridge[Proton Mail Bridge]
        DevHarness[agent-browser CLI] -->|Dev / Debug| Backend
    end

    subgraph Cluster Boundary (Talos Linux / Kubernetes)
        K8sService[Kubernetes Service / Ingress] -->|HTTP| Pods[apply-agent Pod Containers]
        Pods -->|SQL Connection Pool| CNPG[(CloudNativePG PostgreSQL HA Cluster)]
        Pods -->|Automation execution| Workday[Workday Job Portals]
    end
```

## System Components

1. **Application Core (`AppService`)**:
   - Acts as the central hub of the control plane, exposing HTTP API routes (`/api/*`).
   - Manages cryptographic initialization of the local secure vault (`vault.enc`) and handles database transaction mapping.
   - Orchestrates LLM tailoring adapters, email IMAP bridge synchronization, safety gate checks, and execution status machines.
2. **Persistence Layer (`TrackerLedger` & `DatabaseService`)**:
   - **Local File Mode**: Falls back to `ledger.json` and `vault.enc` for secure local file storage.
   - **PostgreSQL Database Mode**: Uses a connection pool to map records to `applications` and `run_events` tables in a high-availability PostgreSQL cluster managed by CloudNativePG.
   - **Lazy Schema Normalization**: Dynamically transforms legacy application JSON records into canonical schemas when loading.
3. **Browser Automation Layer (`BrowserAutomationAdapter`)**:
   - Defines a unified contract for DOM inspection (`inspect`), draft form filling (`fillDraft`), and final submission (`submitApproved`).
   - **Production Mode (Playwright)**: Programmatic headless engine containerized for cluster environments. In testing, runs offline against mock test fixtures served on `localhost`.
   - **Developer Mode (agent-browser)**: Interactive browser UI and CLI harness used purely for local debugging, selector exploration, and manual operator overrides.
4. **Safety Gateway (`SafetyGate`)**:
   - Evaluates applicant constraints (salary floors, duplicates, company blacklists) and enforces safety invariants.
   - Verifies signed `SubmissionApproval` hashes before letting the automation adapter execute any final submit.
5. **Communication Bridge (`ProtonMailBridge`)**:
   - Secure IMAP client wrapper connecting strictly over `127.0.0.1` to local Proton Mail Bridge desktop setups to retrieve OTP / confirmation link parameters.

---

## Workday Application Flow

The system operates according to an 8-step Workday application flow:
1. **Upload past/seed resumes**: The operator uploads one or more past or seed resumes to the dashboard.
2. **Parse resume bank of truth**: The system uses text-layer PDF parsing to extract job history, projects, and skills into the resume bank of truth (without performing OCR or LLM-based text extraction).
3. **Paste Workday link**: The operator pastes the targeted Workday job application URL.
4. **Produce Kami resume**: The system generates an application-specific tailored Kami resume based on relevant past resume facts from the bank of truth.
5. **Automate Workday account creation**: The automation engine automatically registers a new Workday account for the target portal if one does not already exist.
6. **Grab verification from connected inbox**: The system automatically retrieves the verification/OTP email from the connected inbox via the IMAP communication bridge.
7. **Fill application & handle CAPTCHA/missing info**: The system automates form filling. It attempts to solve direct text/image CAPTCHA prompts automatically using the active configured LLM provider. If no active provider is configured, the challenge is an unsupported token widget (reCAPTCHA, hCaptcha, Turnstile, Arkose), or solving fails, the system pauses to hand off to the operator for manual completion in the browser window.
8. **Track application**: The application lifecycle and processing events are logged and tracked in the database or local ledger.

---

## End-to-End Control Plane Workflows

### 1. Vault Onboarding & Initialization
- **Bootstrapping**: Unlocks and boots the system via `POST /api/profile/bootstrap`. The operator supplies a secure vault password along with optional initial interview answers to decrypt/initialize the secure local data environment.
- **Multi-Resume PDF Parsing**: Post-bootstrap, the operator uploads one or more PDF resumes to the secure vault library. The service performs text-layer PDF parsing (without OCR or LLM-based text extraction) to extract candidate details, including job history, tech projects, and skills, storing them in the resume bank of truth within the secure vault state, and maps parsed resume data to the profile bundle.
- **Encryption Gate**: The server writes or decrypts the AES-256 encrypted `vault.enc` file. The decrypted state contains base resume records, the active resume selection, optional Workday credentials, secure LLM provider configurations, and IMAP bridge configuration.

### 2. Dossier Interview & Memory Indexing
- **Interactive Prompts**: When the form filling process detects unknown questions, it generates an `unknown_required_answer` blocker.
- **enrichment**: The operator provides the answer through the client console or endpoint `POST /api/prompts/answer`. The service records the reply in the event log and indexes the question-answer pair in the dossier's `answerMemory` within the vault. The active LLM adapter leverages this historical memory in subsequent runs to draft responses automatically.

### 3. Resume Upload & Tailoring
- **LLM Context Generation**: When creating or updating an application, the operator tailors the candidate's base experience to match job posting requirements via `POST /api/applications/tailor-resume` using the active resume selected from the multi-resume library.
- **Kami Resume Rendering**: The service resolves the application's associated resume version, invokes the active LLM provider to compute structured tailoring guidance, and renders the final tailored resume PDF using the Kami resume template layout.
- **Audit Trails**: The tailoring process creates an `LLMActionRecord` including redacted inputs, model metadata, latency, token usage, and review flags.
### 4. Review Console & Approval Verification
- **Review Stop**: In `fill_review_only` or `submit_after_approval` (without active approval), the system halts after filling forms, updating the status to `reviewing_application`.
- **Console Interaction**: The candidate reviews filled details, visualizes the tailored resume, answers unresolved questions, and clicks "Approve".
- **Cryptographic Approval**: Approving calls `POST /api/applications/approve` with `{ approved: true }`. This generates a `SubmissionApproval` containing hashes of the current application fields and blocker states.
- **Safe Submission**: The automation engine matches the approval hash against the live fields before executing the final `submitApproved` transition to prevent out-of-sync submissions.

---

## Local vs. Cluster Execution Boundary

| Environment Boundary | Local Workstation | Kubernetes Cluster (Talos Linux) |
| :--- | :--- | :--- |
`**Primary UI / Console**` | Next.js Web UI (`npm run dev --prefix web`) | Web API / Headless management |
| **Persistence Storage** | Local filesystem (`ledger.json`, `vault.enc`) | CloudNativePG PostgreSQL HA Cluster (3 replicas) |
| **Email Integration** | Local Proton Mail Bridge (`127.0.0.1:1025`) | Cluster SMTP / Proton Bridge pod |
| **Browser Runtime** | `agent-browser` / Playwright local headless | Headless Playwright container engine |
| **Configuration** | Local environment variables (`.env`) | Kubernetes ConfigMaps & Secrets |

### Local Workstation Mode
Optimized for developer iteration, manual review, and single-user application tracking. In this mode, `apply-agent` relies on local file persistence and direct local service hooks (such as a Next.js Web UI console and desktop Proton Mail Bridge).

### Cluster Deployment Mode
Designed for automated processing at scale on Talos Linux or standard Kubernetes infrastructure. Persistence is offloaded to a CloudNativePG high-availability PostgreSQL cluster with automated failover and JSONB event ledger tracking.
