CREATE TABLE model_runs (
  attempt_id bigint PRIMARY KEY REFERENCES build_attempts(id),
  token_hash text NOT NULL UNIQUE,
  lease_token uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'revoked')),
  spent_usd numeric NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  requests integer NOT NULL DEFAULT 0,
  in_flight boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE model_requests (
  id uuid PRIMARY KEY,
  attempt_id bigint NOT NULL REFERENCES model_runs(attempt_id),
  reserved_usd numeric NOT NULL,
  charged_usd numeric NOT NULL,
  usage jsonb,
  latency_ms integer,
  status text NOT NULL CHECK (status IN ('pending', 'reported', 'unknown')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_requests_attempt ON model_requests(attempt_id, created_at);
