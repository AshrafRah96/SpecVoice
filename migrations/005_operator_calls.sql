CREATE TABLE operator_sessions (
  token_hash text PRIMARY KEY,
  fingerprint text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operator_sessions_expiry ON operator_sessions(expires_at);
CREATE TABLE operator_login_limit (
  id integer PRIMARY KEY CHECK (id = 1),
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL
);

CREATE TABLE session_calls (
  id uuid PRIMARY KEY,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  provider_conversation_id text UNIQUE,
  status text NOT NULL CHECK (status IN ('active', 'awaiting_transcript', 'complete', 'failed')),
  expires_at timestamptz NOT NULL,
  transcript text,
  duration_secs numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX session_calls_history ON session_calls(session_id, sequence DESC);
ALTER TABLE post_call_jobs ADD COLUMN call_id uuid REFERENCES session_calls(id);
ALTER TABLE post_call_jobs ADD COLUMN conversation_id text;
CREATE INDEX sessions_history ON sessions((data->>'createdAt') DESC, id DESC);
