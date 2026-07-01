# AGENTS.md — AI Agent Engineering Guidelines

This document provides architectural invariants, repository guidelines, and operational safety rules for autonomous AI agents working within `repo/k8sJobApp`.

## Agent Operational Rules

1. **Repository Scope & Boundaries**:
   - All work for the application must strictly reside under `repo/k8sJobApp/`.
   - Do not modify files outside `repo/k8sJobApp/` unless explicitly instructed by the orchestrator.
   - Do not edit core business logic in `src/` unless performing necessary path or import updates.

2. **Language & Runtime Flexibility**:
   - The system is built using TypeScript/JavaScript running on Node.js (v20+).
   - Maintain clean, modular code with minimal runtime dependencies.

3. **Database Migration Policy**:
   - Never perform destructive schema operations (e.g., `DROP TABLE`) in production migrations.
   - New database schema modifications must be added as incremental versioned migration files in `deploy/db/migrations/` (e.g., `002_add_field.sql`).
   - Keep `deploy/db/schema.sql` synchronized with the cumulative state of all migrations.

4. **Kubernetes & Cloud-Native Invariants**:
   - Kubernetes manifests in `deploy/kubernetes/` must maintain strict decoupling between configuration (`ConfigMap`) and secrets (`Secret`).
   - Manifest updates must maintain compatibility with CloudNativePG CRD standards.

5. **Verification & Testing Contract**:
   - Agents modifying deployment specs or documentation must run `make validate` (or verify manifest syntax) before marking tasks complete.
   - Never suppress failing tests to force build completion.


6. **Workday Captcha Bypass**:
   - The operator has workday site owner permission to implement a captcha bypass.