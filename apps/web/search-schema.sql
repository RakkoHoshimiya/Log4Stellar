-- Derived full text search tables for the web workspace (task 01 全文搜索).
--
-- Strictly additive: this file only creates new tables and indexes inside the
-- existing `log4stellar` schema. No existing table is altered, so a release
-- built from this branch can be rolled back to the previous web release and
-- the storage tables stay readable by that release. The search tables are
-- derived data: dropping them loses no note content, and they are rebuilt from
-- the storage tables by POST /search/v1/reindex.
--
-- The search index never owns the truth. `search_documents` caches an extracted
-- copy of a file revision; `/search/v1` joins it back to `storage_entries` and
-- only returns rows whose revision is still the current one.

CREATE TABLE IF NOT EXISTS log4stellar.search_documents (
	workspace_id text NOT NULL,
	file_id uuid NOT NULL,
	revision_id uuid NOT NULL,
	path text NOT NULL,
	title text NOT NULL,
	body text NOT NULL,
	truncated boolean NOT NULL DEFAULT false,
	indexed_ms bigint NOT NULL,
	PRIMARY KEY (workspace_id, file_id),
	CONSTRAINT search_documents_path_check CHECK (left(path, 1) = '/'),
	CONSTRAINT search_documents_indexed_check CHECK (indexed_ms >= 0)
);

-- Keyset pagination walks (path, file_id) inside one workspace, so the index
-- matches the ORDER BY exactly and the page never needs an OFFSET.
CREATE INDEX IF NOT EXISTS search_documents_path_idx
	ON log4stellar.search_documents (workspace_id, path, file_id);

-- One queue row per (workspace, file). `desired_seq` is the storage change
-- sequence that produced the row, so a duplicate or out of order event can
-- never overwrite a newer desired state: enqueueIndexUpdate only replaces a row
-- whose `desired_seq` is not newer than the event being applied.
CREATE TABLE IF NOT EXISTS log4stellar.search_jobs (
	workspace_id text NOT NULL,
	file_id uuid NOT NULL,
	operation text NOT NULL,
	desired_revision_id uuid,
	desired_seq bigint NOT NULL,
	status text NOT NULL DEFAULT 'pending',
	attempts integer NOT NULL DEFAULT 0,
	queued_ms bigint NOT NULL,
	updated_ms bigint NOT NULL,
	PRIMARY KEY (workspace_id, file_id),
	CONSTRAINT search_jobs_operation_check CHECK (operation IN ('upsert', 'delete')),
	CONSTRAINT search_jobs_status_check CHECK (status IN ('pending', 'running', 'done')),
	CONSTRAINT search_jobs_attempts_check CHECK (attempts >= 0),
	CONSTRAINT search_jobs_revision_check CHECK (
		(operation = 'upsert' AND desired_revision_id IS NOT NULL)
		OR (operation = 'delete' AND desired_revision_id IS NULL)
	)
);

-- Claiming the oldest pending rows is the hot path of the indexer.
CREATE INDEX IF NOT EXISTS search_jobs_pending_idx
	ON log4stellar.search_jobs (workspace_id, status, queued_ms);

-- Per workspace index generation. Every rebuild bumps it, which invalidates
-- cursors handed out by the previous index so a stale page token can never
-- address rows that the rebuild moved or removed.
CREATE TABLE IF NOT EXISTS log4stellar.search_index_state (
	workspace_id text PRIMARY KEY,
	generation bigint NOT NULL DEFAULT 1,
	indexed_ms bigint NOT NULL DEFAULT 0,
	rebuilt_ms bigint,
	CONSTRAINT search_index_state_generation_check CHECK (generation >= 1),
	CONSTRAINT search_index_state_indexed_check CHECK (indexed_ms >= 0)
);
