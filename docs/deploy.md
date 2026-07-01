# Deployment Guide

This document covers installing, running, and deploying `apply-agent` across different environments (local development, containerized production, and Kubernetes clusters).

## Local Installation & Quick Start

To set up the application locally:

### 1. Install Dependencies
Ensure you have Node.js (v20+) installed, then install root and Next.js UI dependencies:
```bash
npm install
npm install --prefix web
```

### 2. Compile TypeScript
The application source code is written in TypeScript and must be built before running. The build step compiles the TS code into the `dist/` folder and builds the static Next.js export from `web/out` into `dist/public` using a helper script:
```bash
npm run build
```

### 3. Run the Application
You can run the application as a local HTTP API server and a Next.js web application.

#### Running the Local HTTP Server
The HTTP server serves API endpoints and acts as the orchestrator. It listens on `APPLY_AGENT_PORT` or falls back to the standard `PORT` environment variable (defaulting to `3010` if neither is specified).
* **Production mode** (runs the built files):
  ```bash
  npm start
  ```
  *(or via Makefile: `make run`)*
* **Development mode** (rebuilds and runs):
  ```bash
  npm run dev
  ```
  *(or via Makefile: `make dev`)*

#### Running the Next.js Web UI
To launch the Next.js web application UI locally:
```bash
npm run dev --prefix web
```
This runs the Next.js developer console interface on `http://localhost:3000` (which automatically proxies `/api/*` and `/metrics` requests to the Node.js API server running on `3010`).
Alternatively, running `npm run build` followed by `npm start` at the root directory compiles and serves the statically exported Next.js app directly from the API server's static middleware.
---

## Database Configuration & Schema Setup

`apply-agent` supports two storage modes:
1. **Local File-backed Storage (Default)**: If no database environment variables are configured, the application falls back to file-backed JSON ledger storage (`ledger.json` under the data directory) and an encrypted vault file (`vault.enc`) to persist state and track applications.
2. **PostgreSQL Database Storage**: When database environment variables or connection strings are defined, the application maps application models and run events to a PostgreSQL database.

### Database Connection Options

You can configure PostgreSQL connectivity in two ways:
* **Single Connection URL**: Using the `DATABASE_URL` (or `DB_URL`) environment variable.
  ```env
  DATABASE_URL=postgres://apply_user:change_me_in_production@localhost:5432/apply_agent_db
  ```
* **Individual Component Variables**: Using the discrete parameters in your environment:
  - `DB_HOST` (e.g. `localhost` or `apply-agent-postgres-rw`)
  - `DB_PORT` (defaults to `5432`)
  - `DB_NAME` or `DB_DATABASE` (defaults to `apply_agent_db`)
  - `DB_USER` or `DB_USERNAME` (defaults to `apply_user`)
  - `DB_PASSWORD` or `DB_PASS` (defaults to `change_me_in_production`)
  - `DB_SSLMODE` or `DB_SSL` (e.g., set to `require` or `true` to enable TLS; in production Kubernetes this config is required to ensure secure database communication with `rejectUnauthorized: false`)

### Migration & Schema Application

`apply-agent` supports both manual schema provisioning and automated startup migrations.

#### Automated Startup Schema Application
At startup, when PostgreSQL configuration is detected, the database service initializes a connection pool and automatically runs an internal DDL check (`ensureSchema()`). This checks for and creates the required tables (`applications` and `run_events`) if they do not already exist:
* **`applications`**: Stores applicant job tracking entries, statuses, platforms, and metadata.
* **`run_events`**: Stores structured lifecycle execution events linked to application runs.

No external migration tools are required to initialize the database schema in the cluster.

#### Manual DDL Application
If you prefer to initialize the database manually before starting the server, you can load the schema DDL using `psql` directly or via the Makefile:
```bash
make install-db DB_URL="postgres://user:password@localhost:5432/dbname"
```
The raw DDL definitions are located in `deploy/db/schema.sql`.

---

## Kubernetes Cluster Deployment

Kubernetes manifests are located under `deploy/kubernetes/` and utilize Kustomize to compose resources.

### Directory Structure

```
deploy/
├── db/
│   ├── schema.sql           # Database schema definition
│   └── migrations/
│       └── 001_initial_schema.sql
├── kubernetes/              # Base Kustomize manifests (no secrets/ServiceMonitor applied by default)
│   ├── 00-namespace.yaml    # Namespace isolation config (apply-agent namespace)
│   ├── 01-configmap.yaml    # Non-sensitive configuration variables
│   ├── 02-secret-template.yaml # Non-applied template for application secrets
│   ├── 03-postgres-cluster.yaml # CloudNativePG database cluster manifest
│   ├── 04-api-deployment.yaml   # Deployment spec for the Node API server
│   ├── 04-worker-deployment.yaml # Deployment spec for the Playwright automation queue worker + Proton Bridge sidecar
│   ├── 04-web-deployment.yaml   # Deployment spec for the statically exported Next.js UI served by Nginx
│   ├── 05-api-service.yaml      # Service endpoint mapping API container port
│   ├── 05-web-service.yaml      # Service endpoint mapping Web container port
│   ├── 07-pvc.yaml          # PersistentVolumeClaim for application storage
│   ├── 08-proton-pvc.yaml   # PersistentVolumeClaim for Proton Bridge state
│   └── kustomization.yaml   # Kustomize entrypoint mapping base resources
├── monitoring/              # Opt-in Kustomize overlay for Prometheus scraping
│   ├── kustomization.yaml
│   └── servicemonitor.yaml  # ServiceMonitor custom resource (requires Prometheus Operator CRDs)
└── backup/                  # Opt-in Kustomize overlay for database backups
    ├── kustomization.yaml
    ├── backup-patch.yaml    # Patches PG cluster to enable Barman S3 backups
    └── scheduled-backup.yaml # Scheduled daily backups configuration
### CloudNativePG vs. External PostgreSQL

The Kubernetes stack supports two database deployment models:

#### Option A: Managed Database (CloudNativePG)
For a cloud-native database managed directly within the Kubernetes cluster, use the CloudNativePG operator. 
* The manifest `03-postgres-cluster.yaml` provisions a high-availability PostgreSQL cluster (`Cluster` CRD) with 3 instances, automated failover, and local persistent volume claims.
* The application pod connects to the read-write service endpoint created by CNPG (configured in `01-configmap.yaml` as `DB_HOST: apply-agent-postgres-rw.apply-agent.svc.cluster.local`). Alternatively, a unified `DATABASE_URL` environment variable posture can be passed in `04-api-deployment.yaml` pointing to `postgres://$(DB_USER):$(DB_PASSWORD)@apply-agent-postgres-rw.apply-agent.svc.cluster.local:5432/apply_agent_db`.

#### Option B: External PostgreSQL Database
If you use an external database (e.g., Amazon RDS, Google Cloud SQL, or a shared external server) instead of CloudNativePG:
1. Exclude `03-postgres-cluster.yaml` from `kustomization.yaml`.
2. Update the `DB_HOST` variable inside `01-configmap.yaml` to point to the external database host (or configure `DATABASE_URL` as an environment variable in `04-api-deployment.yaml` and `04-worker-deployment.yaml`).
3. Ensure the database user has sufficient DDL permissions to run table creations on startup.

### Proton Bridge Sidecar Architecture & Operator Setup

In Kubernetes cluster deployments, Proton Mail Bridge runs as a sidecar container named `proton-bridge` alongside the worker application container (`apply-agent-worker`) in the `apply-agent-worker` pod.

#### Pod Networking & Environment Contract
* **Localhost Binding**: Because containers in the same Kubernetes pod share the network namespace, the `proton-bridge` sidecar exposes IMAP on `127.0.0.1:1143` (loopback only).
* **Environment Configuration**: The worker container connects using environment variables passed from ConfigMap and Secret definitions:
  - `PROTON_BRIDGE_HOST`: Set to `127.0.0.1`
  - `PROTON_BRIDGE_PORT`: Set to `1143`
  - `PROTON_BRIDGE_USERNAME`: References `apply-agent-secret` key `PROTON_BRIDGE_USERNAME`
  - `PROTON_BRIDGE_PASSWORD`: References `apply-agent-secret` key `PROTON_BRIDGE_PASSWORD`
* **Persistent State**: Bridge session state, encryption keychains, and IMAP metadata persist across pod restarts on a dedicated PersistentVolumeClaim (`proton-bridge-data` mounted at `/home/protonbridge/.config/protonmail/bridge`).

#### Remaining Operator Setup Steps for Bridge Authentication
Because Proton Mail login requires user interaction (or 2FA), an operator must complete initial authentication inside the sidecar once deployed:
1. **Interactive Session**: Exec into the `proton-bridge` sidecar container:
   ```bash
   kubectl exec -it -n apply-agent deployment/apply-agent-worker -c proton-bridge -- proton-bridge-cli
   ```
2. **Authenticate Account**: Run `login` inside the Bridge CLI prompt using your Proton account credentials and 2FA token.
3. **Retrieve Bridge IMAP Password**: Execute `info` or check generated bridge credentials to view the assigned IMAP username and bridge-specific password.
4. **Update Kubernetes Secrets**: Store the generated username and bridge password in your active `apply-agent-secret` in the cluster (e.g. by modifying and applying your secret manifest, updating it in your external secrets manager, or using sealed secrets):
- PROTON_BRIDGE_USERNAME
- PROTON_BRIDGE_PASSWORD
5. **Session Verification**: Bridge state is saved to the persistent volume (`proton-bridge-data`), enabling continuous non-interactive email verification checks by `apply-agent`.

---

### Step-by-Step Cluster Installation

#### 1. Provision Secret Configuration
The deployment separates configuration (`ConfigMap`) from credentials (`Secret`). In production, **never apply placeholder secrets**. The base Kustomize configuration does not include a secret manifest, and you must deploy a secret named `apply-agent-secret` into the `apply-agent` namespace using your preferred secure secrets operator or manual flow.

##### The Secrets Contract
Any implementation of `apply-agent-secret` must satisfy the dual contract of the application container and the PostgreSQL operator (CloudNativePG):

| Secret Key | Target Component | Description / Contract |
| :--- | :--- | :--- |
| `DB_USER` | Application | Username for PostgreSQL database connection |
| `DB_PASSWORD` | Application | Password for PostgreSQL database connection |
| `username` | CloudNativePG | Owner database username (must match `DB_USER`) |
| `password` | CloudNativePG | Owner database password (must match `DB_PASSWORD`) |
| `VAULT_PASSWORD` | Application | Master password for decrypting the application vault (`vault.enc`) |
| `PROTON_BRIDGE_USERNAME` | Application | Username generated by Proton Mail Bridge CLI |
| `PROTON_BRIDGE_PASSWORD` | Application | Password generated by Proton Mail Bridge CLI |
| `API_SECRET_KEY` | Application | Cryptographic key for server sessions, approval signatures, and auth tokens |

##### Production Secret Provisioning Paths
You can provision the secret using one of three paths:

**Path A: Manual Creation (Quick Start / Non-Production)**
```bash
kubectl create secret generic apply-agent-secret \
-  --namespace=apply-agent \
-  --from-literal=DB_USER="apply_user" \
-  --from-literal=DB_PASSWORD="your_secure_db_password" \
-  --from-literal=username="apply_user" \
-  --from-literal=password="your_secure_db_password" \
-  --from-literal=VAULT_PASSWORD="your_vault_password" \
-  --from-literal=PROTON_BRIDGE_USERNAME="your_proton_bridge_username" \
-  --from-literal=PROTON_BRIDGE_PASSWORD="your_proton_bridge_password" \
-  --from-literal=API_SECRET_KEY="your_api_secret_key"
```

**Path B: Sealed Secrets (Bitnami SealedSecrets Operator)**
Create a local secret manifest (never commit it to git) and seal it:
```bash
# Generate the plain secret yaml locally
kubectl create secret generic apply-agent-secret \
-  --namespace=apply-agent \
-  --from-literal=DB_USER="apply_user" \
-  --from-literal=DB_PASSWORD="your_secure_db_password" \
-  --from-literal=username="apply_user" \
-  --from-literal=password="your_secure_db_password" \
-  --from-literal=VAULT_PASSWORD="your_vault_password" \
-  --from-literal=PROTON_BRIDGE_USERNAME="your_proton_bridge_username" \
-  --from-literal=PROTON_BRIDGE_PASSWORD="your_proton_bridge_password" \
-  --from-literal=API_SECRET_KEY="your_api_secret_key" \
-  --dry-run=client -o yaml > plain-secret.yaml

# Seal the secret with kubeseal (safe to commit to git)
kubeseal --format=yaml < plain-secret.yaml > sealed-secret.yaml
kubectl apply -f sealed-secret.yaml
rm plain-secret.yaml
```

**Path C: External Secrets Operator (ESO)**
Create an `ExternalSecret` pointing to AWS Secrets Manager, HashiCorp Vault, or Google Secret Manager:
```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: apply-agent-secret
  namespace: apply-agent
spec:
  refreshInterval: "1h"
  secretStoreRef:
    name: vault-backend
    kind: ClusterSecretStore
  target:
    name: apply-agent-secret
    creationPolicy: Owner
  data:
-    - secretKey: DB_USER
      remoteRef:
        key: apply-agent/db
        property: DB_USER
-    # ... repeat mapping for all 8 keys in the contract above
```

> **Note**: No separate CAPTCHA secrets or environment variables are required. CAPTCHA solving uses the existing active LLM provider configured dynamically via `/api/settings/llm/providers` and its existing credentials stored in the encrypted storage vault.

Ensure the namespace and secrets are deployed before continuing:
```bash
kubectl apply -f deploy/kubernetes/00-namespace.yaml
# Ensure apply-agent-secret is provisioned in apply-agent namespace via manual command or operator.
```

#### 2. Deploy CloudNativePG Database Cluster
*(Bypass this step if using an external database).*
Deploy the PostgreSQL operator cluster manifest:
```bash
kubectl apply -f deploy/kubernetes/03-postgres-cluster.yaml
```
Verify cluster health and status:
```bash
kubectl get cluster -n apply-agent
```

#### 3. Build & Publish Application Images
Application images are published by GitHub Actions from `.github/workflows/container-images.yml` on pushes to `main` or manual workflow dispatch. The workflow builds the `web`, `api`, and `worker` Dockerfile targets and pushes:
```text
ghcr.io/danieljcheung/apply-agent-web:0.1.0
ghcr.io/danieljcheung/apply-agent-api:0.1.0
ghcr.io/danieljcheung/apply-agent-worker:0.1.0
```
For local rebuilds, use `npm run container` after setting `IMAGE_REGISTRY` and `TAG` if needed. Kubernetes deployments pin the published image digests and reference `imagePullSecrets: ghcr-pull-secret`; provision that registry secret in the `apply-agent` namespace before rollout if the GHCR packages are private. The Proton Bridge sidecar uses the pinned public image digest in `04-worker-deployment.yaml`.

#### 3.5. Dry-Run Manifest Validation
Before applying to a live cluster, run client-side validation on the Kustomize manifests:
```bash
# Validate base configuration (no secrets or ServiceMonitor applied)
kubectl apply -k deploy/kubernetes/ --dry-run=client

# (Optional) Validate monitoring overlay
kubectl apply -k deploy/monitoring/ --dry-run=client

# (Optional) Validate backup overlay
kubectl apply -k deploy/backup/ --dry-run=client
```

#### 4. Apply Kustomize Stack
Deploy the configuration map, database cluster, services, and application deployment:
```bash
# Deploy base configuration
kubectl apply -k deploy/kubernetes/

# (Optional) Deploy monitoring overlay to configure ServiceMonitor custom resource
kubectl apply -k deploy/monitoring/

# (Optional) Deploy backup overlay to configure WAL and database backups
kubectl apply -k deploy/backup/
```
*(or via Makefile: `make install-cluster`)*

---

## Operational & Resource Limits

The cluster deployment specifies strict resource allocations and configuration boundaries to enforce application stability.

### Application Pod Limits
Configured inside the respective deployment manifests under container resources:

1. **API Server (`04-api-deployment.yaml`)**:
   - **CPU**: `250m` (request) / `1000m` (limit)
   - **Memory**: `512Mi` (request) / `2Gi` (limit)
2. **Worker & Proton Bridge Pod (`04-worker-deployment.yaml`)**:
   - **Worker Container (`apply-agent-worker`)**:
     - **CPU**: `250m` (request) / `1000m` (limit)
     - **Memory**: `512Mi` (request) / `2Gi` (limit)
   - **Proton Bridge Container (`proton-bridge`)**:
     - **CPU**: `100m` (request) / `500m` (limit)
     - **Memory**: `128Mi` (request) / `512Mi` (limit)
3. **Web Server (`04-web-deployment.yaml`)**:
   - **CPU**: `100m` (request) / `500m` (limit)
   - **Memory**: `128Mi` (request) / `512Mi` (limit)

### Managed PostgreSQL (CNPG) Limits
Configured inside `deploy/kubernetes/03-postgres-cluster.yaml` under PostgreSQL cluster specifications:
* **Replication/Instances**: 3 instances (providing active failover and resilience)
* **Storage Allocation**: `10Gi` persistent volume size
* **Max Active Database Connections**: `100`
* **Shared Buffer Cache Size**: `256MB`
* **Work Memory (`work_mem`)**: `8MB` (per-query sort operations limit)
* **Maintenance Work Memory**: `64MB`

---

## Health Probes & Operational Metrics

`apply-agent` exposes JSON health status check endpoints for observability.

### Health & Readiness Endpoints
* **Liveness Endpoint**: `GET /api/health`
* **Readiness Endpoint**: `GET /api/ready`
* **Response Status**: HTTP 200
* **Response Body**:
  ```json
  {
    "status": "ok",
    "time": 1782635900000
  }
  ```
This endpoint is utilized by the Dockerfile `HEALTHCHECK` check:
```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"
```
And by Kubernetes liveness and readiness probes configured in the respective deployments:

1. **API Server (`04-api-deployment.yaml`)**:
```yaml
livenessProbe:
  httpGet:
    path: /api/health
    port: http
  initialDelaySeconds: 15
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /api/ready
    port: http
  initialDelaySeconds: 5
  periodSeconds: 5
```

2. **Web Server (`04-web-deployment.yaml`)**:
```yaml
livenessProbe:
  httpGet:
    path: /
    port: 8080
  initialDelaySeconds: 15
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 5
```

3. **Worker & Proton Bridge (`04-worker-deployment.yaml`)**:
- **Worker**:
```yaml
livenessProbe:
  exec:
    command: ["pgrep", "-f", "dist/src/worker.js"]
  initialDelaySeconds: 15
  periodSeconds: 10
readinessProbe:
  exec:
    command: ["pgrep", "-f", "dist/src/worker.js"]
  initialDelaySeconds: 5
  periodSeconds: 5
```
- **Proton Bridge Sidecar**:
```yaml
livenessProbe:
  tcpSocket:
    port: imap
  initialDelaySeconds: 10
  periodSeconds: 10
readinessProbe:
  tcpSocket:
    port: imap
  initialDelaySeconds: 5
  periodSeconds: 5
```
### Telemetry & Event Collection

`apply-agent` exposes a live HTTP Prometheus metrics exporter on `GET /metrics` returning text-format metrics (`Content-Type: text/plain; version=0.0.4; charset=utf-8`).

The endpoint exports real-time metrics including:
* `apply_agent_applications_total{status="..."}`
* `apply_agent_run_events_total{event_type="..."}`
* `apply_agent_safety_blockers_total{code="...",severity="..."}`
* `apply_agent_browser_runs_total{status="..."}`
* `apply_agent_llm_actions_total{action_type="...",status="..."}`

In Kubernetes, pod template and service manifests define scrape annotations (`prometheus.io/scrape: "true"`, `prometheus.io/port: "3000"`, `prometheus.io/path: "/metrics"`). For Prometheus Operator environments, an optional ServiceMonitor custom resource is provided at `deploy/monitoring/servicemonitor.yaml` (applied via the `deploy/monitoring` overlay).

Additionally, all run counters and lifecycle events stream structured JSON logs to `stdout` and persist in the database `run_events` table for central log aggregation.

---

## Operator Verification Runbook
For complete step-by-step instructions on verifying local execution, cluster port-forwarding (`kubectl port-forward`), probe testing, and manual handoffs, see the **[Practical Operator Runbook](runbook.md)**.
