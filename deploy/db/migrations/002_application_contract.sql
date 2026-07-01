-- Migration 002: Add DB support for the canonical application contract
-- Migration created: 2026-06-29

BEGIN;

-- Add GIN index on applications metadata JSONB for efficient querying of new contract fields
CREATE INDEX IF NOT EXISTS idx_applications_metadata ON applications USING gin (metadata);

-- Add specific expression indices for commonly queried metadata fields
CREATE INDEX IF NOT EXISTS idx_applications_metadata_posting_hash ON applications ((metadata->>'postingHash'));
CREATE INDEX IF NOT EXISTS idx_applications_metadata_ats ON applications ((metadata->>'ats'));
CREATE INDEX IF NOT EXISTS idx_applications_metadata_automation_mode ON applications ((metadata->>'automationMode'));

COMMIT;
