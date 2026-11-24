-- Object-storage garbage collection state (task 06, 存储对象清理).
--
-- Strictly additive, like sync-schema.sql: the five original tables in
-- workspace-schema.sql and the four sync tables keep their exact definitions, so an
-- older release keeps reading and writing the same database during a rollback.
--
-- Nothing here holds the object bytes. The tables only record what the collector
-- observed, what it decided, and which recovery copy it made before a delete, so a
-- crash can be resumed and every decision can be replayed from the audit trail.
--
-- Mapping to the column names suggested by the task book (06-存储对象清理.md §状态与功能):
--   gc_runs            (run_id, scope, state, inventory_cursor)   -> same names
--   gc_candidates      (workspace_id, digest, object_version, first_seen, eligible_after,
--                       state, reason)                            -> *_ms suffixes, plus size
--   blob_write_intents (workspace_id, digest, writer_id, expires_at) -> expires_ms
--   blob_holds         (scope, digest, reason, expires_at)         -> expires_ms, plus
--                                                                   hold_id/workspace_id
--
-- Every statement is idempotent (CREATE ... IF NOT EXISTS) and is applied while holding
-- the same advisory lock sync-migrate.mjs uses (migrationLockId), so a collector and a
-- server migrating at the same time serialise instead of interleaving DDL.

CREATE TABLE IF NOT EXISTS log4stellar.gc_runs (
	run_id uuid PRIMARY KEY,
	scope text NOT NULL,
	-- 'plan' never touches the object store; 'apply' is the only mode that may delete.
	mode text NOT NULL CHECK (mode IN ('plan', 'apply')),
	-- Dry-run is recorded per run: an apply run that was held back by the switch still
	-- leaves evidence of what it would have deleted.
	dry_run boolean NOT NULL,
	state text NOT NULL CHECK (state IN ('planned', 'applying', 'completed', 'cancelled', 'failed')),
	inventory_cursor text,
	candidate_count integer NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
	candidate_bytes bigint NOT NULL DEFAULT 0 CHECK (candidate_bytes >= 0),
	deleted_count integer NOT NULL DEFAULT 0 CHECK (deleted_count >= 0),
	deleted_bytes bigint NOT NULL DEFAULT 0 CHECK (deleted_bytes >= 0),
	started_ms bigint NOT NULL,
	updated_ms bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS gc_runs_scope_idx ON log4stellar.gc_runs (scope, started_ms DESC);
CREATE INDEX IF NOT EXISTS gc_runs_state_idx ON log4stellar.gc_runs (state, updated_ms DESC);

CREATE TABLE IF NOT EXISTS log4stellar.gc_candidates (
	workspace_id text NOT NULL,
	digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
	-- Provider identity of the object at observation time (ETag, or a version id when the
	-- provider has one). A later delete is only allowed against this exact identity, so a
	-- rebuilt object is never removed by an old candidate.
	object_version text,
	size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
	run_id uuid REFERENCES log4stellar.gc_runs(run_id),
	state text NOT NULL CHECK (state IN (
		'observed', 'eligible', 'deleting', 'deleted', 'cancelled', 'failed'
	)),
	-- Human-readable, already redacted: never an object key, never a bucket name.
	reason text NOT NULL,
	first_seen_ms bigint NOT NULL,
	eligible_after_ms bigint NOT NULL CHECK (eligible_after_ms >= first_seen_ms),
	updated_ms bigint NOT NULL,
	-- Verified recovery copy made immediately before the delete (a path on the collector
	-- host). It is the only supported way to undo a deletion.
	recovery_path text,
	-- Last failure category, for the operator report. Values are enum-like short strings.
	last_error text,
	PRIMARY KEY (workspace_id, digest)
);

CREATE INDEX IF NOT EXISTS gc_candidates_state_idx
	ON log4stellar.gc_candidates (state, eligible_after_ms);
CREATE INDEX IF NOT EXISTS gc_candidates_run_idx
	ON log4stellar.gc_candidates (run_id) WHERE run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS log4stellar.blob_write_intents (
	workspace_id text NOT NULL,
	digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
	writer_id text NOT NULL,
	created_ms bigint NOT NULL,
	expires_ms bigint NOT NULL CHECK (expires_ms > created_ms),
	PRIMARY KEY (workspace_id, digest, writer_id)
);

-- The collector asks "is any intent live for this object"; expired intents are ignored
-- (a crashed writer must not block collection forever) and deleted lazily.
CREATE INDEX IF NOT EXISTS blob_write_intents_expiry_idx
	ON log4stellar.blob_write_intents (workspace_id, expires_ms);

CREATE TABLE IF NOT EXISTS log4stellar.blob_holds (
	hold_id uuid PRIMARY KEY,
	-- 'global' holds every workspace, 'workspace:<id>' one workspace, 'backup:<run>'
	-- objects covered by a verified backup manifest. Free text for audit only; the
	-- workspace_id column is what the collector matches on.
	scope text NOT NULL,
	workspace_id text,
	digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
	reason text NOT NULL,
	created_ms bigint NOT NULL,
	-- NULL means "until an operator removes it": the correct default for a backup hold,
	-- whose lifetime is the backup's, not the collector's.
	expires_ms bigint
);

CREATE INDEX IF NOT EXISTS blob_holds_digest_idx
	ON log4stellar.blob_holds (digest, workspace_id);
