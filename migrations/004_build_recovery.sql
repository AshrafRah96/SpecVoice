ALTER TABLE build_attempts
  ADD COLUMN input jsonb,
  ADD COLUMN branch_name text,
  ADD COLUMN phase text NOT NULL DEFAULT 'queued'
    CHECK (phase IN ('queued', 'generating', 'push_pending', 'pushed')),
  ADD COLUMN commit_sha text,
  ADD COLUMN recovery_count integer NOT NULL DEFAULT 0,
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT now();

-- Existing attempts lack immutable inputs. Recovery must never regenerate them.
UPDATE build_attempts SET status = 'needs_reconciliation'
WHERE status IN ('queued', 'running');
