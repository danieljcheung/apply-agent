# Practical Operator Runbook

This runbook provides step-by-step instructions for operating, testing, and verifying `apply-agent` across local workstation environments and Kubernetes cluster deployments.

---

## 1. Local Environment Setup & Test Runner

### Prerequisites
* **Node.js**: v20 or higher
* **npm**: v10 or higher
* **Make** (optional, for convenience wrappers)

### Installation & Build
```bash
# Clone repository and navigate to working directory
cd repo/k8sJobApp

# Install dependencies
npm install

# Build TypeScript source and copy static assets
npm run build
```

### Executing Test Suites
Run all automated unit, database mock integration, LLM provider, and browser policy tests:
```bash
# Execute standard npm test suite
npm test

# Alternatively, run via Makefile wrapper
make test
```
*Note: Test execution results and evidence must be verified directly by the operator or CI pipeline runner.*

---

## 2. Running Local Service & Browser Interface

### Start Local Server
Launch the HTTP control plane server in development mode:
```bash
npm run dev
```
By default, the development server binds to port `3010` (or `3000` depending on `APPLY_AGENT_PORT` / `PORT` environment variables).

### Accessing the Web Dashboard
Open your web browser and navigate to:
```
http://localhost:3010
```
*(Or `http://localhost:3000` if running in container/K8s port-forwarded modes).*

---

## 3. Workday Application Flow

The standard operator workflow is organized as a simple 8-step application flow:
1. **Upload past/seed resumes**: The operator uploads one or more past or seed resumes to the dashboard.
2. **Parse resume bank of truth**: The system uses text-layer PDF parsing to extract job history, projects, and skills into the resume bank of truth (without performing OCR or LLM-based text extraction).
3. **Paste Workday link**: The operator inputs or pastes the targeted Workday job application URL.
4. **Produce Kami resume**: The system generates a styled Kami resume tailored from relevant past resume facts stored in the bank of truth.
5. **Automate Workday account creation**: The automation engine automatically registers a new Workday account for the target portal if one does not already exist.
6. **Grab verification from connected inbox**: The system automatically retrieves the verification/OTP email from the connected inbox via the IMAP communication bridge.
7. **Fill application & handle CAPTCHA/missing info**: The system automates form filling. It attempts to solve direct text/image CAPTCHA prompts automatically using the active configured LLM provider. If no active provider is configured, the challenge is an unsupported token widget (reCAPTCHA, hCaptcha, Turnstile, Arkose), or solving fails, the system pauses to hand off to the operator for manual completion in the browser window.
8. **Track application**: The application lifecycle and processing events are logged and tracked in the database or local ledger.

---

## 4. Vault Bootstrapping & Profile Onboarding

The application operates in a zero-trust model and starts locked until initialized with a master vault password.

### Option A: Via Web Dashboard
1. Open `http://localhost:3010` in your browser.
2. Enter a master vault password into the bootstrap prompt and click **Initialize & Unlock Vault** to create the vault.
3. In the "Resume PDFs" step, upload one or more PDF resumes (multiple uploads supported) and click **Parse Resume PDFs**.
4. (Optional) Provide interview Q&A details in the next step to complete candidate onboarding.

### Option B: Via HTTP API
Initialize the vault structure and optional initial interview answers:
```bash
curl -X POST http://localhost:3010/api/profile/bootstrap \
  -H "Content-Type: application/json" \
  -d '{
    "password": "your-secure-vault-password",
    "interviewAnswers": {
      "Preferred Location": "Remote",
      "Work Authorization": "Authorized to work"
    }
  }'
```
After bootstrapping, use the Resume Upload API to upload base PDF resumes.

---

## 5. LLM Provider Setup & Connection Verification

Configure OpenAI-compatible LLM endpoints (e.g., DeepSeek, Kimi, local Ollama) for automated job description extraction and resume tailoring.

### Register Provider via HTTP API
```bash
curl -X POST http://localhost:3010/api/settings/llm/providers \
  -H "Content-Type: application/json" \
  -d '{
    "provider": {
      "id": "deepseek-v3",
      "name": "DeepSeek Production Provider",
      "endpoint": "https://api.deepseek.com/v1",
      "apiKey": "sk-your-api-key",
      "model": "deepseek-chat"
    }
  }'
```

### Verify Provider Connectivity
```bash
curl -X POST http://localhost:3010/api/settings/llm/test \
  -H "Content-Type: application/json" \
  -d '{
    "providerId": "deepseek-v3"
  }'
```
Expected output confirms endpoint reachability and valid API credentials without leaking key material.

---

## 6. Resume Upload & PDF Artifact Pipeline

Upload candidate resume assets in PDF format to serve as the base experience for job tailoring. Multiple PDF resumes are stored in the secure vault library, and one active resume is selected for automation execution.

### Upload Resume Assets
```bash
curl -X POST http://localhost:3010/api/profile/resume-upload \
  -H "Content-Type: application/json" \
  -d '{
    "resumes": [
      {
        "fileName": "base-resume.pdf",
        "contentBase64": "JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmoKPDw...",
        "mimeType": "application/pdf",
        "label": "Primary Resume"
      }
    ]
  }'
```

### Select Active Resume
```bash
curl -X POST http://localhost:3010/api/profile/resumes/select \
  -H "Content-Type: application/json" \
  -d '{
    "resumeId": "resume_a1b2c3d4e5f6g7h8"
  }'
```
The system performs text-layer PDF parsing (without OCR or LLM-based text extraction) to extract candidate details, including job history, tech projects, and skills, storing them in the resume bank of truth within the secure vault state, and maps parsed resume data to the profile bundle. Tailored application-specific PDFs are rendered from relevant past resume facts using the Kami resume template styling.
---

## 7. Job Application Creation

Register a targeted job posting URL to initiate automated processing and status tracking.

### Create Application Entry
```bash
curl -X POST http://localhost:3010/api/applications \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://tenant.myworkdayjobs.com/en-US/careers/job/123",
    "jobDetails": {
      "company": "Acme Systems",
      "title": "Cloud Engineer"
    }
  }'
```
Returns a unique application record `{ "id": "app_123...", "status": "received_link", ... }`.

---

## 8. Approval & Review Workflow (Human-in-the-Loop Gate)

### Trigger Resume Tailoring
Tailor candidate experience specifically to the job posting requirements using the configured LLM provider:
```bash
curl -X POST http://localhost:3010/api/applications/tailor-resume \
  -H "Content-Type: application/json" \
  -d '{
    "appId": "app_123"
  }'
```

### Resolve Unknown Screening Questions
If form automation encounters an unindexed application prompt, it issues an `unknown_required_answer` blocker. Enrich candidate dossier memory:
```bash
curl -X POST http://localhost:3010/api/prompts/answer \
  -H "Content-Type: application/json" \
  -d '{
    "appId": "app_123",
    "promptId": "prompt_456",
    "question": "Years of Kubernetes experience?",
    "answer": "4 years"
  }'
```

### Sign Cryptographic Approval
Before final submission, execute manual candidate approval. This records a cryptographic hash (`SubmissionApproval`) preventing execution if form data shifts:
```bash
curl -X POST http://localhost:3010/api/applications/approve \
  -H "Content-Type: application/json" \
  -d '{
    "appId": "app_123",
    "approved": true,
    "approvedBy": "operator"
  }'
```

---

## 9. Kubernetes Single-Pod Deployment & Dry-Run

Verify Kubernetes manifests before cluster deployment.

### Dry-Run Manifest Validation
```bash
# Validate base configuration (no secrets or ServiceMonitor applied)
kubectl apply -k deploy/kubernetes/ --dry-run=client

# (Optional) Validate monitoring overlay
kubectl apply -k deploy/monitoring/ --dry-run=client

# (Optional) Validate backup overlay
kubectl apply -k deploy/backup/ --dry-run=client
```

### Apply Cluster Manifests
```bash
# 1. Create namespace and configure secret resources
kubectl apply -f deploy/kubernetes/00-namespace.yaml
# Ensure apply-agent-secret is provisioned in apply-agent namespace manually or via secret operator.

# 2. Deploy CloudNativePG database (or configure external DB host)
kubectl apply -f deploy/kubernetes/03-postgres-cluster.yaml

# 3. Apply main application stack
kubectl apply -k deploy/kubernetes/
```

---

## 10. Cluster Port-Forwarding & Health Verification

### Establish Port-Forward
Access the in-cluster application services locally:
```bash
# Forward the Web frontend service locally:
kubectl port-forward svc/apply-agent-web 8080:8080 -n apply-agent

# Forward the API backend service locally (in a separate terminal):
kubectl port-forward svc/apply-agent-api 3000:3000 -n apply-agent
```

### Inspect Probes & Telemetry
In a separate terminal, verify pod readiness and metrics:
```bash
# API Liveness probe
curl -i http://localhost:3000/api/health

# API Readiness probe
curl -i http://localhost:3000/api/ready

# Web Liveness/Readiness probe
curl -i http://localhost:8080/

# Prometheus metrics stream
curl -i http://localhost:3000/metrics
```

---

## 11. Known Manual Handoffs & Operational Invariants

Certain security boundaries require manual operator intervention:

1. **CAPTCHA & Anti-Bot Challenges (`captcha_required`)**:
   - The system attempts to solve direct text/image CAPTCHA prompts using the active configured LLM provider.
   - If no active provider is configured, the challenge is an unsupported token widget (reCAPTCHA, hCaptcha, Turnstile, Arkose), or solving fails, the automation engine pauses, raises a `captcha_required` blocker code, and hands off to the operator for manual completion in the browser window before resuming.

2. **Proton Mail Bridge Authentication (`proton_bridge_auth_required`)**:
   - Secure IMAP email verification requires Proton Mail Bridge authentication.
   - The operator must launch Proton Mail Bridge locally or configure sidecar secrets (`PROTON_BRIDGE_USERNAME` and `PROTON_BRIDGE_PASSWORD`, IMAP port `1143`) with valid bridge credentials. Raw passwords or 2FA tokens are never committed to code or manifests.

---

## 12. Backup & Restore Posture

This section defines the backup architecture, operational policies, and restore verification steps for cluster deployments.

### 12.1. CloudNativePG Database Backup (WAL & Object Store)
Database backups leverage the CloudNativePG (CNPG) operator's native Barman integration, which continuously archives Write-Ahead Logs (WAL) and performs daily physical snapshots to an S3-compatible object store.

To enable database backups, apply the `deploy/backup` overlay:
```bash
kubectl apply -k deploy/backup/
```

This overlay does not define any secret resources directly. It references a secret named `cnpg-backup-secret` which you must provision manually in the namespace containing:
- `ACCESS_KEY_ID`: S3 credentials
- `SECRET_ACCESS_KEY`: S3 secret key

#### Daily Backups Configuration
A ScheduledBackup resource is defined at `deploy/backup/scheduled-backup.yaml` and executes daily at midnight:
```yaml
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: apply-agent-postgres-daily-backup
  namespace: apply-agent
spec:
  schedule: "0 0 0 * * *"
  backupOwnerReference: self
  cluster:
    name: apply-agent-postgres
```

### 12.2. PVC Volume Snapshots (Non-Database State)
For the active application files and Proton Bridge session metadata (which contain local keychains and authentication sessions), use CSI Volume Snapshots targeting the PersistentVolumeClaims:
1. `apply-agent-data` (Application state and cache)
2. `proton-bridge-data` (Proton Bridge configuration and offline keychains)

Example `VolumeSnapshot` manifest:
```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: proton-bridge-data-snapshot
  namespace: apply-agent
spec:
  volumeSnapshotClassName: csi-aws-vsc # CSI snapshot class configured in cluster
  source:
    persistentVolumeClaimName: proton-bridge-data
```

#### PVC Snapshot Coverage and Residual Risks
While database backups are highly transaction-safe and continuous, non-database state (candidate resumes, session logs, and offline keychains) on the application and bridge PVCs is backed up daily using CSI Volume Snapshots. However, there are significant residual risks when operating these filesystem volumes in a shared (ReadWriteMany / RWX) posture or on multi-node clusters:

1. **Lack of Application/Write Consistency**: CSI Volume Snapshots are filesystem-consistent but not application-consistent. If the snapshot is initiated while active file writes are occurring (such as when Proton Mail Bridge is sync'ing its local SQLite database or when the API server is writing files), the snapshot may capture half-written data, resulting in database corruption upon restoration.
2. **Concurrent Write Risks under RWX**:
   - `proton-bridge-data` holds an active SQLite database and keychain cache. SQLite does not support network-shared concurrent writers (e.g., via NFS or standard RWX storage classes). Deploying the worker container in a replica count greater than 1, or running multi-writer mounts across nodes, will corrupt the Bridge SQLite database.
   - `apply-agent-data` hosts resume PDFs, encryption keys, and cache files. Concurrently writing to the same filesystem paths from different nodes/pods (e.g., API and worker pods writing to the same directories) can lead to race conditions, split-brain session states, or file descriptor lock-ups.
3. **Mitigations & Operational Guidelines**:
   - Limit the worker deployment and web deployment to a replica count of 1.
   - Ensure the database-backed configuration is used for all core application state so that SQLite-based local storage is not the source of truth for transactions.
   - Pin stateful worker containers to single nodes using NodeAffinity or rely on ReadWriteOnce (RWO) storage paths where possible to guarantee exclusive access.
   - Quiesce heavy automation tasks before scheduling CSI Volume Snapshots.

### 12.3. Backup Policies (Retention, RPO, and RTO)

| Data Type | Mechanism | Retention | RPO (Max Data Loss) | RTO (Recovery Time) |
| :--- | :--- | :--- | :--- | :--- |
| **PostgreSQL Database** | CNPG continuous WAL + daily physical backup | 30 days | < 5 seconds | < 15 minutes |
| **App & Bridge PVCs** | Daily CSI Volume Snapshots | 14 days | 24 hours | < 10 minutes |

### 12.4. Restore Verification Procedures

In the event of a disaster, verify the backup restoration using the procedures below.

#### Database Restoration (Point-in-Time Recovery)
To recover the PostgreSQL database from the object store, define a new `Cluster` manifest that bootstraps from the backup source.
```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: apply-agent-postgres-restored
  namespace: apply-agent
spec:
  instances: 3
  imageName: ghcr.io/cloudnative-pg/postgresql:16.1
  storage:
    size: 10Gi
  bootstrap:
    recovery:
      source: apply-agent-postgres
  externalClusters:
    - name: apply-agent-postgres
      barmanObjectStore:
        destinationPath: "s3://apply-agent-postgres-backups/"
        endpointURL: "https://s3.amazonaws.com"
        s3Credentials:
          accessKeyId:
            name: cnpg-backup-secret
            key: ACCESS_KEY_ID
          secretAccessKey:
            name: cnpg-backup-secret
            key: SECRET_ACCESS_KEY

#### PVC Restoration
To restore persistent filesystem volumes from snapshots, create new PVCs referencing the VolumeSnapshot source:
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: proton-bridge-data-restored
  namespace: apply-agent
spec:
  storageClassName: gp3
  dataSource:
    name: proton-bridge-data-snapshot
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
```
Verify that mounting this PVC restores files and maintains current session states without forcing new CLI logins.
