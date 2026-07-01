-- Migration 003: Add uniqueness constraint for applications posting hash
-- Migration created: 2026-07-01

BEGIN;

-- Drop the old non-unique index if it exists, to avoid duplicate index storage
DROP INDEX IF EXISTS idx_applications_metadata_posting_hash;

-- Create a unique index on the posting hash metadata field
CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_metadata_posting_hash_unique ON applications ((metadata->>'postingHash'));

COMMIT;
