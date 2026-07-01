# Observability & Metrics Specification

This document details the health probes, metrics, and operational telemetry model for `apply-agent`.

## Health & Metrics Endpoints

`apply-agent` exposes HTTP endpoints for system probes and operational telemetry:

- **`GET /api/health`**: Liveness probe. Returns HTTP 200 with JSON payload `{"status":"ok","time":<timestamp>}` when the application server is running.
- **`GET /api/ready`**: Readiness probe. Returns HTTP 200 with JSON payload `{"status":"ok","time":<timestamp>}` when the application server is ready to handle traffic.
- **`GET /metrics`**: Prometheus text-format metric exporter (`Content-Type: text/plain; version=0.0.4; charset=utf-8`). Returns live counters and gauges aggregated from application ledger state and database records. When the application is locked, metrics are generated without instantiating or leaking transient database pools.

Example health/readiness response (`GET /api/health` or `GET /api/ready`):
```json
{
  "status": "ok",
  "time": 1782635900000
}
```

---

## Live Prometheus Metrics Exporter (`/metrics`)

The `/metrics` endpoint dynamically aggregates current operational state across five primary Prometheus metrics. In database-backed mode, these metrics are aggregated directly using transaction-safe database count queries (avoiding full-table scans of applications and events to ensure optimal performance).

### Exported Metrics Schema

1. **Applications Snapshot (`apply_agent_applications_total`)**
   - **Type**: `gauge`
   - **Help**: `Total count of job applications by status.`
   - **Labels**: `status` (e.g. `received_link`, `blocked`, `ready_to_submit`, `submitted`, `rejected`, `failed`, `draft`).
   - **Example**: `apply_agent_applications_total{status="submitted"} 14`

2. **Run Events Counter (`apply_agent_run_events_total`)**
   - **Type**: `counter`
   - **Help**: `Total count of run events by event type.`
   - **Labels**: `event_type` (e.g. `CREATED`, `PLAN_GENERATED`, `STATUS_CHANGED`, `SAFETY_GATE_BLOCKED`, `PROMPT_ANSWERED`, `SUBMISSION_APPROVED`, `EXEC_STEP_SUCCESS`, `EXEC_STEP_FAILED`, `CAPTCHA_SOLVER_SUCCESS`, `CAPTCHA_SOLVER_FAILED`).
   - **Example**: `apply_agent_run_events_total{event_type="EXEC_STEP_SUCCESS"} 42`

3. **Safety Blockers Counter (`apply_agent_safety_blockers_total`)**
   - **Type**: `counter`
   - **Help**: `Total count of safety blockers by code and severity.`
   - **Labels**: `code` (e.g. `captcha_required`, `missing_browser_credentials`, `salary_below_floor`), `severity` (e.g. `fatal`, `recoverable`, `info`).
   - **Example**: `apply_agent_safety_blockers_total{code="captcha_required",severity="fatal"} 3`

4. **Browser Runs Counter (`apply_agent_browser_runs_total`)**
   - **Type**: `counter`
   - **Help**: `Total count of browser runs by status.`
   - **Labels**: `status` (e.g. `success`, `failed`, `blocked`).
   - **Example**: `apply_agent_browser_runs_total{status="success"} 19`

5. **LLM Actions Counter (`apply_agent_llm_actions_total`)**
   - **Type**: `counter`
   - **Help**: `Total count of LLM actions by action type and status.`
   - **Labels**: `action_type` (e.g. `job_extraction`, `resume_tailoring`, `browser_action`), `status` (e.g. `completed`, `failed`, `pending`).
   - **Example**: `apply_agent_llm_actions_total{action_type="resume_tailoring",status="completed"} 8`

---

## Security & Secret Exclusions

To maintain zero-trust security and data privacy, the `/metrics` endpoint strictly enforces label sanitization:

- **Zero PII or Secret Leaks**: Metric labels **NEVER** contain candidate names, emails, street addresses, phone numbers, raw job URLs, prompt questions, candidate answers, resume text, or credentials.
- **Strict Label Sanitization**: All label values are validated against clean identifier patterns (`[a-zA-Z0-9_-]+`). Any string containing spaces, special characters, email markers (`@`), URL protocols (`http://`, `https://`), or secret keywords (`token`, `password`, `secret`) is automatically redacted and replaced with `redacted` or `unknown`.

---

## Kubernetes Scrape Configuration & ServiceMonitor

Kubernetes cluster deployments expose metrics using standard annotations and optional CRDs:

1. **Pod and Service Annotations**:
   The API deployment (`04-api-deployment.yaml`) and API service (`05-api-service.yaml`) include annotations for automated Prometheus scraping:
   ```yaml
   annotations:
     prometheus.io/scrape: "true"
     prometheus.io/port: "3000"
     prometheus.io/path: "/metrics"
   ```

2. **Prometheus Operator ServiceMonitor**:
   For environments utilizing the Prometheus Operator, an optional `ServiceMonitor` manifest is provided at `deploy/monitoring/servicemonitor.yaml` (applied via the `deploy/monitoring` overlay) targeting the `http` port (3000) and `/metrics` path.

3. **Network Security & Isolation Policy**:
   Under production NetworkPolicy configurations, ingress access to the API pods on the metrics port (3000) is restricted. By default, ingress is blocked for standard application traffic, and is explicitly allowed only from the Prometheus monitoring/scraping namespace and scraper pods. This blocks unauthorized internal cluster pods from harvesting operational metrics.
---

## Verification Runbook
For instructions on inspecting live probes (`curl http://localhost:3000/api/health`), readiness checks, and scraping Prometheus metrics in local and cluster environments, see the **[Practical Operator Runbook](runbook.md)**.
