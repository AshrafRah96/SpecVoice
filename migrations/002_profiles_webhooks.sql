CREATE TABLE webhook_receipts (
  receipt_key text PRIMARY KEY,
  provider text NOT NULL,
  delivery_id text,
  event_type text NOT NULL,
  conversation_id text,
  event_timestamp text,
  body_sha256 text NOT NULL,
  signature_valid boolean NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'processed', 'failed')),
  session_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE UNIQUE INDEX webhook_receipts_delivery ON webhook_receipts(provider, delivery_id) WHERE delivery_id IS NOT NULL;

CREATE TABLE post_call_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_key text NOT NULL UNIQUE REFERENCES webhook_receipts(receipt_key) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  call_duration_secs numeric NOT NULL,
  transcript text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'complete', 'failed')),
  lease_token uuid,
  lease_expires_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX post_call_jobs_claim ON post_call_jobs(status, id);

CREATE TABLE repo_snapshots (
  id text PRIMARY KEY,
  session_id text NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  source jsonb NOT NULL,
  repository_sha text,
  index_status text NOT NULL CHECK (index_status IN ('pending', 'indexing', 'ready', 'partial', 'failed')),
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX repo_snapshots_pending ON repo_snapshots(index_status, created_at);

CREATE TABLE scope_plans (
  id text PRIMARY KEY,
  snapshot_id text NOT NULL REFERENCES repo_snapshots(id) ON DELETE CASCADE,
  data jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('proposed', 'confirmed', 'rejected')),
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scope_plans_snapshot ON scope_plans(snapshot_id, created_at DESC);
