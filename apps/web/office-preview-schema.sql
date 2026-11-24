-- Office preview schema (项目进度跟踪表/大肥鱼工作区/05-Office文件预览.md §3).
--
-- Additive only, exactly like git-schema.sql and sync-schema.sql: every object is
-- `IF NOT EXISTS`, no existing column or table is touched, and the previous release
-- never selects from these tables, so a rollback needs no data change.
--
-- Three objects:
--   * office_previews       one row per (workspace, file, revision, digest, profile)
--   * office_preview_slots  the deployment-wide conversion slot (single concurrency)
-- PDF bytes never live here: only their size and the attempt-specific object key do.

BEGIN;

-- §3 The dedupe row and its state machine `queued -> running -> ready | failed`.
--
-- `preview_key` is sha256 over the authoritative source identity and the render
-- profile; the five column UNIQUE constraint is the actual dedupe key from the task
-- book, kept explicit so an operator can see it without recomputing a hash.
--
-- `evicted` is a tombstone: the derived object was removed by the cache budget but
-- the row stays so a later request re-queues the same version instead of inserting a
-- second job for it.
CREATE TABLE IF NOT EXISTS log4stellar.office_previews (
	preview_id uuid PRIMARY KEY,
	workspace_id text NOT NULL,
	file_id uuid NOT NULL,
	revision_id uuid NOT NULL,
	source_sha256 text NOT NULL,
	profile_fingerprint text NOT NULL,
	preview_key text NOT NULL,
	state text NOT NULL,
	-- Fencing token of the conversion attempt that owns the row. Only the attempt
	-- that still holds both the id and an unexpired lease may publish `ready`.
	attempt_id uuid,
	attempt_count integer NOT NULL DEFAULT 0,
	lease_until_ms bigint,
	-- Bytes currently held by the cache for this row (`ready`), or reserved by an
	-- in-flight attempt that has not uploaded yet (`running`). Publishing moves the
	-- reservation into `size_bytes`, so the accounting never double counts.
	size_bytes bigint NOT NULL DEFAULT 0,
	reserved_bytes bigint NOT NULL DEFAULT 0,
	object_key text,
	-- A transient failure (worker died, disk full) may be retried a bounded number
	-- of times; a permanent one (corrupt, password protected, over the output budget)
	-- is never retried, so a broken document is not converted in a loop.
	retryable boolean NOT NULL DEFAULT false,
	error_code text,
	created_ms bigint NOT NULL,
	updated_ms bigint NOT NULL,
	last_access_ms bigint NOT NULL,
	CHECK (state IN ('queued', 'running', 'ready', 'failed', 'evicted')),
	CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
	CHECK (preview_key ~ '^[0-9a-f]{64}$'),
	CHECK (profile_fingerprint ~ '^[0-9a-f]{32}$'),
	CHECK (char_length(workspace_id) BETWEEN 1 AND 64),
	CHECK (size_bytes >= 0 AND reserved_bytes >= 0),
	CHECK (attempt_count >= 0),
	-- A ready row must point at a published object and know its size; a failed row
	-- must say why. An inconsistent row would make the read path either serve nothing
	-- or serve something it cannot account for.
	CHECK (state <> 'ready' OR (object_key IS NOT NULL AND size_bytes > 0)),
	CHECK (state <> 'failed' OR error_code IS NOT NULL),
	CHECK (state <> 'evicted' OR size_bytes = 0),
	CHECK (attempt_id IS NULL OR state IN ('running', 'ready', 'failed')),
	CHECK (state <> 'running' OR (attempt_id IS NOT NULL AND lease_until_ms IS NOT NULL)),
	CHECK (object_key IS NULL OR object_key LIKE 'office-previews/%')
);

-- The dedupe key from §3, in the exact column order the task book names.
CREATE UNIQUE INDEX IF NOT EXISTS office_previews_dedupe_idx
	ON log4stellar.office_previews (workspace_id, file_id, revision_id, source_sha256, profile_fingerprint);

-- Queue scan: the worker claims the oldest waiting row.
CREATE INDEX IF NOT EXISTS office_previews_queue_idx
	ON log4stellar.office_previews (state, created_ms, preview_id);

-- Expired lease recovery (§3 "应用重启后，过期租约可回收").
CREATE INDEX IF NOT EXISTS office_previews_lease_idx
	ON log4stellar.office_previews (lease_until_ms, preview_id) WHERE state = 'running';

-- Cache accounting and the LRU choice for eviction.
CREATE INDEX IF NOT EXISTS office_previews_cache_idx
	ON log4stellar.office_previews (workspace_id, last_access_ms) WHERE state = 'ready';

-- §5 The deployment-wide conversion slot. One row exists only while a conversion is
-- running anywhere in the deployment; multiple worker instances serialise on this
-- row before they may start a process, so "single concurrency" is a database fact and
-- not a per-process assumption.
CREATE TABLE IF NOT EXISTS log4stellar.office_preview_slots (
	slot text PRIMARY KEY CHECK (slot IN ('conversion')),
	owner_id text NOT NULL,
	acquired_ms bigint NOT NULL,
	lease_until_ms bigint NOT NULL,
	CHECK (char_length(owner_id) BETWEEN 1 AND 200)
);

COMMIT;
