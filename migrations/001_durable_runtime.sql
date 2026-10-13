CREATE TABLE sessions (
  id text PRIMARY KEY,
  data jsonb NOT NULL CHECK (data->>'id' = id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE session_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  event jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_events_replay ON session_events(session_id, id);

CREATE TABLE build_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id text NOT NULL REFERENCES sessions(id),
  attempt_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'complete', 'failed', 'blocked', 'needs_reconciliation')),
  lease_token uuid,
  lease_expires_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, attempt_key)
);
CREATE UNIQUE INDEX one_active_attempt ON build_attempts(session_id)
  WHERE status IN ('queued', 'running', 'needs_reconciliation');
CREATE INDEX queued_attempts ON build_attempts(id) WHERE status = 'queued';
