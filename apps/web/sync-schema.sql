-- Incremental sync storage (docs/incremental-sync.md §2.1).
--
-- This file is strictly additive: it only ever creates new tables and indexes in the
-- log4stellar schema. The five tables owned by workspace-schema.sql keep their exact
-- column definitions, so the previous release (web-markdown-preview-01, which knows
-- nothing about sync) keeps reading and writing the same database.
--
-- Everything here is idempotent and is applied while holding the same PostgreSQL
-- advisory lock as workspace-schema.sql, so several processes may migrate at once.

CREATE TABLE IF NOT EXISTS log4stellar.storage_change_heads (
	workspace_id text PRIMARY KEY REFERENCES log4stellar.storage_workspaces(id),
	seq bigint NOT NULL DEFAULT 0 CHECK (seq >= 0),
	retained_floor bigint NOT NULL DEFAULT 1 CHECK (retained_floor >= 1),
	updated_ms bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS log4stellar.storage_changes (
	workspace_id text NOT NULL REFERENCES log4stellar.storage_workspaces(id),
	seq bigint NOT NULL CHECK (seq > 0),
	change_id uuid NOT NULL,
	kind text NOT NULL CHECK (kind IN (
		'file.created', 'file.saved', 'file.renamed', 'file.deleted', 'file.restored',
		'file.rolledback', 'file.conflicted', 'directory.created', 'directory.renamed',
		'directory.deleted'
	)),
	entry_kind smallint NOT NULL CHECK (entry_kind IN (1, 2)),
	path text NOT NULL,
	from_path text,
	conflict_path text,
	file_id uuid,
	revision_id uuid,
	parent_revision_id uuid,
	sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	size_bytes bigint CHECK (size_bytes >= 0),
	trash_id uuid,
	device_id text,
	idempotency_key text,
	idempotency_fingerprint text CHECK (idempotency_fingerprint ~ '^[0-9a-f]{64}$'),
	created_ms bigint NOT NULL,
	PRIMARY KEY (workspace_id, seq),
	UNIQUE (workspace_id, change_id)
);

-- Additive extension documented in 交付说明/task3-incremental-sync.md §契约偏差清单:
-- every row written by one logical operation shares an op_id, which is what §8.6 calls
-- "分组字段" but the §2.1 DDL never declares. Kept out of the CREATE TABLE above so the
-- contract DDL stays verbatim, and added with IF NOT EXISTS so an existing database is
-- upgraded in place.
ALTER TABLE log4stellar.storage_changes ADD COLUMN IF NOT EXISTS op_id uuid;
-- §8.7 has to return the client's declared baseRevision for a conflict, but §2.1 declares
-- no column for it and the fingerprint is one-way. One additive column fixes that.
ALTER TABLE log4stellar.storage_changes ADD COLUMN IF NOT EXISTS base_revision uuid;

CREATE UNIQUE INDEX IF NOT EXISTS storage_changes_idempotency_idx
	ON log4stellar.storage_changes (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS storage_changes_created_idx ON log4stellar.storage_changes (workspace_id, created_ms);
CREATE INDEX IF NOT EXISTS storage_changes_path_idx ON log4stellar.storage_changes (workspace_id, path, seq DESC);
CREATE INDEX IF NOT EXISTS storage_changes_op_idx ON log4stellar.storage_changes (workspace_id, op_id) WHERE op_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS log4stellar.storage_snapshots (
	id uuid PRIMARY KEY,
	workspace_id text NOT NULL REFERENCES log4stellar.storage_workspaces(id),
	seq bigint NOT NULL CHECK (seq >= 0),
	entry_count integer NOT NULL CHECK (entry_count >= 0),
	created_ms bigint NOT NULL,
	expires_ms bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS storage_snapshots_workspace_idx
	ON log4stellar.storage_snapshots (workspace_id, expires_ms DESC);

CREATE TABLE IF NOT EXISTS log4stellar.storage_snapshot_entries (
	snapshot_id uuid NOT NULL REFERENCES log4stellar.storage_snapshots(id) ON DELETE CASCADE,
	path text NOT NULL,
	kind smallint NOT NULL CHECK (kind IN (1, 2)),
	file_id uuid NOT NULL,
	revision_id uuid NOT NULL,
	sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	size_bytes bigint CHECK (size_bytes >= 0),
	modified_ms bigint NOT NULL,
	PRIMARY KEY (snapshot_id, path)
);
