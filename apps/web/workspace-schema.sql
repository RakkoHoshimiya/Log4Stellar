CREATE TABLE IF NOT EXISTS log4stellar.storage_workspaces (
	id text PRIMARY KEY,
	created_ms bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS log4stellar.storage_entries (
	workspace_id text NOT NULL REFERENCES log4stellar.storage_workspaces(id),
	path text NOT NULL,
	parent_path text,
	name text NOT NULL,
	file_id uuid NOT NULL,
	revision_id uuid NOT NULL,
	kind smallint NOT NULL CHECK (kind IN (1, 2)),
	created_ms bigint NOT NULL,
	modified_ms bigint NOT NULL,
	PRIMARY KEY (workspace_id, path),
	UNIQUE (workspace_id, file_id)
);

CREATE INDEX IF NOT EXISTS storage_entries_parent_idx
	ON log4stellar.storage_entries (workspace_id, parent_path, name);

CREATE TABLE IF NOT EXISTS log4stellar.storage_file_versions (
	workspace_id text NOT NULL REFERENCES log4stellar.storage_workspaces(id),
	file_id uuid NOT NULL,
	revision_id uuid NOT NULL,
	parent_revision_id uuid,
	sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
	created_ms bigint NOT NULL,
	PRIMARY KEY (workspace_id, file_id, revision_id)
);

CREATE TABLE IF NOT EXISTS log4stellar.storage_trash (
	id uuid PRIMARY KEY,
	workspace_id text NOT NULL REFERENCES log4stellar.storage_workspaces(id),
	original_path text NOT NULL,
	deleted_ms bigint
);

CREATE INDEX IF NOT EXISTS storage_trash_workspace_idx
	ON log4stellar.storage_trash (workspace_id, deleted_ms DESC);

CREATE TABLE IF NOT EXISTS log4stellar.storage_trash_entries (
	trash_id uuid NOT NULL REFERENCES log4stellar.storage_trash(id) ON DELETE CASCADE,
	path text NOT NULL,
	file_id uuid NOT NULL,
	revision_id uuid NOT NULL,
	kind smallint NOT NULL CHECK (kind IN (1, 2)),
	created_ms bigint NOT NULL,
	modified_ms bigint NOT NULL,
	PRIMARY KEY (trash_id, path)
);
