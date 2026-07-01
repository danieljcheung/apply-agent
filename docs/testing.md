# Testing Strategy

This document describes testing practices, test execution, and mocking mechanisms for `apply-agent`.

For step-by-step end-to-end interactive verification, vault bootstrapping, LLM provider testing, application creation, and human approval flows, refer to the **[Practical Operator Runbook](runbook.md)**.

## Test Suites Overview

1. **Unit & Core Module Tests (`test/app-core.test.mjs`, `test/server.test.mjs`)**:
   - Verify server route handling, API endpoint responses, safety validation rules, and candidate profile compilation (including parsing of skills, experience, education, and structured tech projects from resume PDF data).
   - Run completely in isolation without requiring external network or database access.

2. **Database Integration Tests (`test/db-tracker.test.mjs`)**:
   - Test interaction between the tracker ledger layer (`TrackerLedger`), `AppService`, and the PostgreSQL service (`DatabaseService`).
   - These tests utilize a mock database query executor (`mockExecutor`) to simulate PostgreSQL tables (`applications` and `run_events`) and return rows, validating queries, events, and status changes.

3. **LLM Adapter & App Service Tests (`test/llm-provider.test.mjs`, `test/llm-app-service.test.mjs`)**:
   - Validate connections to DeepSeek, Kimi, or other OpenAI-compatible LLM endpoints.
   - Test resume tailoring logic and verify the `LLMActionRecord` structure and endpoint handlers.

4. **Email & Proton Bridge Integration Tests (`test/proton-bridge.test.mjs`, `test/imap-connector.test.mjs`, `test/email-verification.test.mjs`)**:
   - Exercise Proton Mail Bridge connection configurations, secure credentials management, and polling mechanisms.
   - Test the verification parser to ensure OTP codes and links are extracted correctly.

5. **Browser Policy & Automation Tests (`test/browser-policy.test.mjs`, `test/browser-playwright.test.mjs`, `test/synthetic-challenge-policy.test.mjs`, `test/llm-captcha-solver.test.mjs`)**:
   - Enforce the domain execution policy (blocking navigation outside local fixtures and `*.myworkdayjobs.com`).
   - Verify that the Playwright adapter throws safety blocker alerts when user approval conditions are not met.
   - Test synthetic challenge runner policy flags.
   - Test LLM CAPTCHA solver unit behavior (`test/llm-captcha-solver.test.mjs`), including multimodal request generation, response parsing, and error safety without API key leaks.
   - Verify Playwright browser integration with direct CAPTCHA solving fixtures (`test/fixtures/workday/llm-captcha.html`), confirming that direct text/image prompts are detected, solved, and filled with LLM answers, while unsupported token widgets (reCAPTCHA, hCaptcha, Turnstile, Arkose) remain blocked as `captcha_required`.

6. **Metrics Exporter Tests (`test/metrics.test.mjs`)**:
   - Verify the Prometheus text formatter, status count aggregation, and strict label sanitization rules (redacting secrets, emails, and URLs).

7. **External Service Mocks & Test Helpers**:
   - Mock definitions for Workday automation steps and Proton bridge mock interfaces.
   - Files like `src/protonBridge.ts` and `src/workday.ts` return mock confirmation tokens and simulate form navigation paths to keep test execution predictable and fast.
   - `test/helpers/pdf-fixture.mjs`: A PDF generation utility that programmatically generates valid, transient in-memory PDF buffers with text layers, including mock tech project sections for fixture coverage. This is used as a fixture helper by core unit and route tests to verify text extraction/parsing without using static binary file fixtures.
---

## Running Tests

Ensure you have installed dependencies and built the application first:

```bash
# Clean and build the TypeScript application
npm run build
```

Then you can execute the test suites using one of the following methods:

### Method A: Using npm (Recommended)
This runs the full compilation and executes the Node.js test runner across all test files:
```bash
npm test
```

### Method B: Using the Makefile
This triggers the corresponding make target:
```bash
make test
```

### Method C: Running Individual Tests
To execute a specific test file directly:
```bash
node --test test/server.test.mjs
node --test test/db-tracker.test.mjs
```

---

## CI/CD Pipeline Verification

In CI environments, tests are run within clean Docker containers. You can reproduce the test container validation locally using the following commands:

```bash
# Build the builder stage which runs tsc and copy-public scripts
docker build -t apply-agent:test --target builder .

# Run the test suite within the test container
docker run --rm apply-agent:test npm test
```

---

## Verifying the Canonical Contract

The expanded application contract, status mappings, and blocker normalizations are verified across the existing test suites:

### 1. Pure Helper Validation
Pure normalizations (e.g. mapping legacy strings or fuzzy blocker inputs) are exercised in the core test runner:
*   **Status Normalization**: Checks that legacy status names (`draft`, `planned`, etc.) resolve to their canonical counterparts.
*   **Fuzzy Blocker Mapping**: Confirms that keywords like `captcha` or `2fa` automatically map to `captcha_required` and `two_factor_required` codes.

### 2. Tracker Persistence & Lazy Normalization
*   **Lazy Conversion**: Tests verify that older application records containing legacy status or missing metadata fields are dynamically structured into the new canonical record shape upon file loading or database retrieval.
*   **Duplicate Detection**: Validates that creating an application for a company/posting hash that already exists correctly appends/returns the `duplicate_application` blocker code.

### 3. Database Metadata Mapping
*   **JSONB Metadata Storage**: Integration tests (`test/db-tracker.test.mjs`) verify that the PostgreSQL `DatabaseService` (and the mock query executor) serialize and deserialize new metadata fields (such as `canonicalUrl`, `automationMode`, `blockers`, `llmActions`, and `artifacts`) safely into the JSONB metadata column without data loss or column alteration.
*   **Status Normalization**: Database read queries automatically normalize saved status strings.

