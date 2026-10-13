ALTER TABLE repo_snapshots DROP CONSTRAINT repo_snapshots_index_status_check;
ALTER TABLE repo_snapshots ADD CONSTRAINT repo_snapshots_index_status_check
  CHECK (index_status IN ('pending', 'indexing', 'ready', 'partial', 'failed', 'expired'));

-- Legacy copies share the earliest recorded origin we can prove, not their latest Session update.
CREATE TEMP TABLE transcript_origins ON COMMIT DROP AS
SELECT session_id, md5(transcript) AS digest, min(recorded_at) AS recorded_at FROM (
  SELECT session_id, event->'session'->>'transcript' AS transcript, created_at AS recorded_at
    FROM session_events WHERE event->'session'->>'transcript' IS NOT NULL
  UNION ALL SELECT session_id, transcript, created_at FROM session_calls WHERE transcript IS NOT NULL
  UNION ALL SELECT j.session_id, j.transcript, coalesce(c.created_at, j.created_at)
    FROM post_call_jobs j LEFT JOIN session_calls c ON c.id = j.call_id
  UNION ALL SELECT id, data->>'transcript', updated_at FROM sessions WHERE data->>'transcript' IS NOT NULL
  UNION ALL SELECT session_id, input->>'transcript', created_at FROM build_attempts WHERE input->>'transcript' IS NOT NULL
) copies GROUP BY session_id, md5(transcript);
CREATE UNIQUE INDEX ON transcript_origins(session_id, digest);
UPDATE sessions s SET data = jsonb_set(s.data, '{transcriptRecordedAt}', to_jsonb(o.recorded_at))
 FROM transcript_origins o WHERE o.session_id = s.id AND o.digest = md5(s.data->>'transcript')
 AND NOT s.data ? 'transcriptRecordedAt';
UPDATE session_events e SET event = jsonb_set(e.event, '{session,transcriptRecordedAt}', to_jsonb(o.recorded_at))
 FROM transcript_origins o WHERE o.session_id = e.session_id AND o.digest = md5(e.event->'session'->>'transcript')
 AND NOT (e.event->'session') ? 'transcriptRecordedAt';
UPDATE build_attempts b SET input = jsonb_set(b.input, '{transcriptRecordedAt}', to_jsonb(o.recorded_at))
 FROM transcript_origins o WHERE o.session_id = b.session_id AND o.digest = md5(b.input->>'transcript')
 AND NOT b.input ? 'transcriptRecordedAt';
