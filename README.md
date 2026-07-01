# apply-agent

`apply-agent` is an autonomous application processing agent built with Node.js and TypeScript, designed to manage job applications, automate form interactions, track application telemetry, and maintain safety verification rules.

## Features

- **Automated Job Application Tracking**: Manage job applications across companies and status workflows.
- **Applicant Profile & Answer Memory**: Store and retrieve applicant profiles and standardized answers.
- **Safety Verification Engine**: Enforce customizable rules prior to application submission.
- **Cloud-Native Kubernetes Deployment**: Pre-configured manifests for Kubernetes and CloudNativePG PostgreSQL clusters.
- **Telemetry & Event Tracking**: Structured run events logging for auditing and monitoring.


## Application State & Safety Policy

The agent manages processing workflow state via a canonical model:
*   **Canonical States**: Transitions applications across 22 typed statuses (e.g. `received_link`, `profile_matching`, `reviewing_application`, `submitting`).
*   **Blocker Taxonomy**: Identifies 16 specific blocker codes (such as `captcha_required` or `duplicate_application`) with severity attributes (`fatal`, `recoverable`, `info`) to handle automation checkpoints.
*   **No Auto-Submit by Default**: In compliance with human-in-the-loop validation rules, LLM-driven drafting, profiling, and form-filling are automated, but final submissions require human verification (`fill/review only` mode).

For details, see the **[Event Lifecycle Specification](docs/events.md)**.
## Repository Structure

```
repo/k8sJobApp/
├── server.ts               # Application server entrypoint (TypeScript)
├── src/                    # Core service modules (TypeScript)
│   ├── appService.ts       # Core orchestration service
│   ├── db.ts               # Database service mapping models to Postgres
│   ├── profile.ts          # Profile manager
│   ├── safety.ts           # Safety verification rules engine
│   ├── storage.ts          # Encrypted vault file storage abstraction
│   ├── tracker.ts          # Application tracker & ledger logic
│   └── workday.ts          # Workday automation bridge
├── web/                    # Next.js frontend web UI
├── deploy/                 # Deployment infrastructure
│   ├── db/                 # SQL schema & migrations
│   └── kubernetes/         # K8s manifests (CNPG, deployment, service)
├── docs/                   # System documentation
├── test/                   # Test suite files
├── Dockerfile              # Multi-stage container build spec
├── Makefile                # Build, run, test, and install targets
└── README.md
```

## Quick Start

### Local Development

To run the application locally (without containers or Kubernetes):

```bash
# Install dependencies (both root and web UI)
npm install
npm install --prefix web

# Build application (compiles TypeScript backend, builds Next.js UI, and copies static assets to dist/public)
npm run build

# Start server locally (serves static Next.js UI from dist/public and API on port 3010)
npm start

# Alternatively, start backend in dev mode
npm run dev

# Run Next.js UI in development mode
npm run dev --prefix web

# Run unit and integration tests
npm test
```
### Database Setup

Apply PostgreSQL schema locally or to a target database:

```bash
make install-db DB_URL="postgres://user:pass@localhost:5432/dbname"
```

### Kubernetes Deployment

Deploy to a Kubernetes cluster using Kustomize:

```bash
make install-cluster
```

For detailed deployment instructions and secrets configuration, see **[Docs: Deployment Guide](docs/deploy.md)**.
