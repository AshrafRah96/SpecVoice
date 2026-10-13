ALTER TABLE post_call_jobs ADD COLUMN available_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX post_call_jobs_ready ON post_call_jobs(available_at, id) WHERE status = 'queued';

CREATE TABLE worker_heartbeats (
  id text PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('running', 'stopping')),
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);
