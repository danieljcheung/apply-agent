# Application State, Events & Lifecycle Specification

This document defines the canonical lifecycle states, blocker taxonomy, event telemetry schema, actor/source provenance, LLM audit policies, and modular boundaries for the `apply-agent` service.

---

## 1. Canonical Application Lifecycle

Every job application tracked by `apply-agent` transitions through a set of structured lifecycle stages. Applications must maintain a typed status matching one of the canonical status values below.

### Canonical Application Statuses

| ApplicationStatus | Category | Description |
| :--- | :--- | :--- |
| `received_link` | Intake | Intake point; link received and queued for processing. |
| `extracting_job` | Perception | LLM/parser actively extracting job posting schema from the portal/URL. |
| `job_extracted` | Perception | Job posting details parsed (company, title, requirements, etc.). |
| `profile_matching` | Matching | Scoring candidate profile compatibility against job requirements. |
| `blocked` | Gate | Process halted due to unresolved check, user input required, or safety gate violation. |
| `generating_resume` | Customization | Tailoring candidate resume/cover letter to match job metadata. |
| `creating_account` | Automation | Automation engine creating candidate credentials on the portal. |
| `verifying_email` | Automation | Automation engine waiting for email OTP / verification link verification. |
| `uploading_resume` | Automation | Automation engine uploading customized resume and portfolio files. |
| `filling_identity` | Automation | Automation engine inputting name, address, contact, and demographics. |
| `filling_experience` | Automation | Automation engine populating work history and prior roles. |
| `filling_education` | Automation | Automation engine populating academic degrees and institutions. |
| `answering_questions` | Automation | Automation engine answering custom screening questions. |
| `waiting_for_user` | Action | Halted waiting for user action (e.g. captcha solve, email verification confirmation). |
| `reviewing_application` | Review | Draft fields fully populated; waiting for candidate's manual review/approval. |
| `ready_to_submit` | Submission | Approved by safety gates and human review; queued for final submission. |
| `submitting` | Submission | Requesting portal endpoint to finalize the application. |
| `submitted` | Completion | Form submitted successfully to target ATS / portal. |
| `confirmation_received` | Completion | Official email or portal confirmation receipt fetched and stored. |
| `rejected` | Terminal | Received notification of application rejection. |
| `failed` | Terminal | Process aborted due to unrecoverable system or gateway error. |
| `cancelled` | Terminal | Aborted manually by the candidate. |

### Legacy Status Normalization

To maintain backward compatibility with older ledgers and test fixtures, legacy status values are mapped dynamically to their canonical equivalents on load. The pure helper `normalizeApplicationStatus(status)` in `src/types.ts` performs this mapping:

*   `draft` &rarr; `job_extracted`
*   `planned` &rarr; `ready_to_submit`
*   `ready_for_manual` &rarr; `reviewing_application`
*   `submitted_mock_for_test` &rarr; `submitted`

Any input status that does not match a canonical status or mapping target defaults to `received_link`.

---

## 2. Blocker Taxonomy

When application processing is halted or enters the `blocked` status, the tracker attaches one or more structured blocker items. Every blocker is identified by a specific `BlockerCode`.

### Blocker Codes

1.  `unknown_required_answer`: Screening question encountered with no matched answer in memory.
2.  `unsupported_profile_claim`: Job requires a skill or verification claim missing from the candidate profile bundle.
3.  `salary_below_floor`: Job compensation falls below candidate's specified minimum salary threshold.
4.  `work_authorization_conflict`: Job requirements conflict with candidate's legal work authorization status.
5.  `sponsorship_ambiguity`: Sponsorship requirements are unclear or conflict with candidate preferences.
6.  `legal_certification_question`: Legal questions (e.g., criminal background, disclaimers) require manual input.
7.  `eeo_policy_question`: Equal Employment Opportunity disclosures require manual review.
8.  `captcha_required`: Portal presented a CAPTCHA challenge, and the LLM solver was unavailable, unsupported, failed, or disabled for this challenge.
9.  `two_factor_required`: Two-factor authentication (2FA/OTP) required to login/access portal.
10. `email_verification_required`: OTP or verification link sent to the candidate's mailbox requires verification.
11. `duplicate_application`: Existing application record found for this company/job posting.
12. `site_automation_disallowed`: Portal terms or security measures prevent automated browser control.
13. `low_match_confidence`: LLM matching score falls below the required threshold for auto-automation.
14. `llm_output_requires_review`: Generated answer or tailored field requires human verification.
15. `missing_browser_credentials`: Target portal credentials are not configured (not required for tenant-specific account creation flow).
16. `automation_not_configured`: Job portal ATS is unsupported or has no automation plan configured.

### Blocker Severity & Mapping

Each blocker is typed with a `BlockerSeverity`:
*   `fatal`: Unrecoverable blocker; terminates run execution.
*   `recoverable`: Processing can continue once the candidate provides inputs or clears the checkpoint.
*   `info`: Non-blocking warning; flagged for user awareness but does not halt automation.

Legacy or custom error strings are mapped to canonical codes using `normalizeBlockerCode(code)` in `src/types.ts`, matching key substrings (e.g., `2fa` &rarr; `two_factor_required`, `captcha` &rarr; `captcha_required`).

---

## 3. Telemetry Event Schema

Telemetry events track incremental progress and audit runs. Every event appended to an application record conforms to the `TrackerEvent` interface:

```typescript
export interface TrackerEvent {
  timestamp: string;               // ISO-8601 UTC timestamp
  type: string;                    // Event type (e.g. 'run_started', 'form_navigation', 'CAPTCHA_SOLVER_SUCCESS', 'CAPTCHA_SOLVER_FAILED')
  message: string;                 // Human-readable message
  status?: string;                 // Status context ('started', 'success', 'failed', 'warning')
  payload?: Record<string, any>;   // JSON context data
  source?: string;                 // Module emitting the event (e.g. 'workday', 'safety')
  actor?: string;                  // Entity triggering the action (e.g. 'system', 'llm', 'user')
  applicationStatus?: string;      // Canonical application status at event time
}
```

---

## 4. Actor, Source & Data Provenance

To guarantee data integrity and auditability, candidate profiles, answers, and generated assets maintain a data lineage trail.

### Provenance Interfaces

*   **`DataProvenance`** (For profile claim structures):
    ```typescript
    export interface DataProvenance {
      source: string;              // Source identifier (e.g. 'resume', 'linkedin', 'user_entry')
      extractedAt?: string;        // UTC Timestamp when parsed
      confidence?: number;         // Extraction confidence score (0.0 to 1.0)
      author?: string;             // Actor that generated the data (e.g. 'parser-v1', 'candidate')
      version?: string;            // Source document version
    }
    ```
*   **`FieldProvenance`** (For specific application form fields):
    ```typescript
    export interface FieldProvenance {
      field: string;               // Field name
      source: string;              // Lineage (e.g. 'claim:work_history_0', 'default_value')
      confidence?: number;         // LLM mapping confidence
      verifiedByHuman?: boolean;   // True if human reviewed/edited
    }
    ```
*   **`ArtifactProvenance`** (For generated resumes/documents):
    ```typescript
    export interface ArtifactProvenance {
      source: string;              // Base document identifier
      generator?: string;          // LLM model or formatting engine ID
      timestamp?: string;          // ISO-8601 generation time
      version?: string;            // Artifact tracking version
    }
    ```

---

## 5. LLM Action Audit Policy & Safety Gate

Automated application submission operates under a strict safety gate policy to prevent unauthorized or inaccurate submissions.

### LLM Action Audit Schema

All LLM calls (perception, tailoring, answering) are recorded in the `llmActions` array on the `ApplicationRecord`:

```typescript
export interface LLMActionRecord {
  id: string;                      // Action UUID
  type: LLMActionType;             // e.g. 'job_extraction', 'resume_tailoring', 'question_answering'
  status: LLMActionStatus;         // 'pending' | 'executing' | 'completed' | 'failed' | 'requires_human_review'
  inputPayload?: unknown;          // Prompt details / context
  outputPayload?: unknown;         // Raw output text / structure
  error?: string;                  // Execution error (if failed)
  audit?: {
    promptTokens?: number;
    completionTokens?: number;
    model?: string;
    latencyMs?: number;
    humanApproved?: boolean;       // Status of manual candidate sign-off
    reviewedBy?: string;
    reviewedAt?: string;
  };
  createdAt: string;
  completedAt?: string;
}
```

### Safety Policy: Default No-Auto-Submit Behavior

*   **Drafting Authorization**: LLM models are permitted to parse job postings (`job_extraction`), evaluate compatibility (`profile_matching`), tailor resumes (`resume_tailoring`), and pre-fill form inputs (`question_answering`).
*   **Human-in-the-Loop Constraint**: Under no circumstances is an application permitted to auto-submit directly from LLM actions without human confirmation. The default final submission policy is `fill/review only`.
*   **Submission Action**: The application status will progress to `reviewing_application` once all fields are filled. A user must manually review the draft in the UI and click "Approve" (triggering the `ready_to_submit` status) before the agent executes the final `submitting` transition.

---

## 6. Modular Boundaries

The `apply-agent` architecture isolates state representation, storage adapters, and rules execution into distinct subsystems:

1.  **Lifecycle Helpers and Types (`src/types.ts`)**:
    *   Defines interfaces for `ApplicationRecord`, `BlockerItem`, `TrackerEvent`, and `LLMActionRecord`.
    *   Contains pure helper functions (`normalizeApplicationStatus`, `normalizeBlockerCode`) that contain zero side effects, state, or database logic.
2.  **Tracker Persistence Ledger (`src/tracker.ts`)**:
    *   Manages local file-backed storage (`TrackerLedger`) for settings and applications.
    *   Implements lazy normalization: older record structures are dynamically updated to the canonical shape during loading.
    *   Validates uniqueness and sets initial state (defaults to `received_link`).
3.  **Database Service Adapter (`src/db.ts`)**:
    *   Implements the `DatabaseService` which acts purely as an adapter to PostgreSQL.
    *   Performs row-to-model transformations and serializes canonical status and metadata JSONB columns. It does not dictate application state transitions.
4.  **Safety Gate Validation (`src/safety.ts`)**:
    *   Contains rule engines checking job requirements (e.g. salary thresholds, blacklist companies).
    *   Acts as a pure evaluator: takes input data, runs checks, and yields blocker records/warnings without persisting or writing updates itself.
