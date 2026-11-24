-- Git integration schema (docs/git-integration.md §3).
--
-- Additive only, exactly like sync-schema.sql: every object is `IF NOT EXISTS` and no
-- existing column or table is touched. The previous release does not know these three
-- tables, never selects from them and never writes to them, so it keeps working against
-- a migrated database and a rollback needs no data change.
--
-- One repository per workspace is a deliberate v1 limit (§1.4): the primary key is the
-- workspace id, so a second binding is a plain UPSERT rather than a silent second row that
-- the status endpoint would then have to disambiguate.

BEGIN;

-- §3.1 The association: which local repository a workspace points at, which remote it
-- syncs with and which credential (if any) that remote needs. `remote_url` is stored in
-- plaintext because git must hand it to the transport; it is never echoed by an API, never
-- logged and never returned (the response carries `remoteId = sha256(url)[0..16]`).
CREATE TABLE IF NOT EXISTS log4stellar.git_repositories (
	workspace_id text PRIMARY KEY,
	local_path text NOT NULL,
	repository_root text NOT NULL,
	default_branch text NOT NULL,
	remote_url text,
	remote_kind text NOT NULL CHECK (remote_kind IN ('file', 'https', 'ssh', 'git', 'http')),
	remote_branch text NOT NULL,
	credential_id text,
	bound_by_actor text NOT NULL,
	bound_ms bigint NOT NULL,
	updated_ms bigint NOT NULL,
	last_fetch_ms bigint,
	last_fetch_commit text,
	last_push_ms bigint,
	last_push_commit text,
	CHECK (char_length(workspace_id) BETWEEN 1 AND 64),
	CHECK (char_length(local_path) BETWEEN 1 AND 4096),
	-- A credential reference must look like an id, never like a secret: this CHECK makes a
	-- paste of an actual token into the wrong column fail loudly instead of being stored.
	CHECK (credential_id IS NULL OR credential_id ~ '^[0-9a-f]{32}$'),
	CHECK (last_fetch_commit IS NULL OR last_fetch_commit ~ '^[0-9a-f]{40}$'),
	CHECK (last_push_commit IS NULL OR last_push_commit ~ '^[0-9a-f]{40}$')
);

-- §3.2 Credentials are sealed (AES-256-GCM, key file beside the storage configuration) and
-- the sealed blob is prefixed with the scheme version so a future format is distinguishable
-- from a corrupted one. The plaintext never reaches this table, a log line or a response.
CREATE TABLE IF NOT EXISTS log4stellar.git_credentials (
	workspace_id text NOT NULL,
	credential_id text NOT NULL,
	kind text NOT NULL CHECK (kind IN ('ssh-key', 'https-token')),
	label text NOT NULL,
	sealed text NOT NULL CHECK (sealed LIKE 'v1:%'),
	created_ms bigint NOT NULL,
	updated_ms bigint NOT NULL,
	PRIMARY KEY (workspace_id, credential_id),
	CHECK (credential_id ~ '^[0-9a-f]{32}$'),
	CHECK (char_length(label) BETWEEN 1 AND 120),
	CHECK (char_length(sealed) <= 16384)
);

-- §3.3 A checkpoint records "the project state at this moment was produced from this
-- commit". The note side is stored as a soft reference (revision + digest, no FK): a note
-- can be deleted, restored or replaced by a later sync, and a hard FK would either block
-- that deletion or cascade the checkpoint away — both wrong. Reads resolve it to
-- `note.available = false` instead, so the commit association always survives (§3.4).
CREATE TABLE IF NOT EXISTS log4stellar.git_checkpoints (
	workspace_id text NOT NULL,
	checkpoint_id text NOT NULL,
	name text NOT NULL,
	note text NOT NULL DEFAULT '',
	commit_sha text NOT NULL,
	branch text,
	note_path text,
	note_revision_id text,
	note_sha256 text,
	created_by_actor text NOT NULL,
	created_ms bigint NOT NULL,
	PRIMARY KEY (workspace_id, checkpoint_id),
	CHECK (checkpoint_id ~ '^[0-9a-f]{32}$'),
	CHECK (char_length(name) BETWEEN 1 AND 120),
	CHECK (char_length(note) <= 4000),
	CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
	CHECK (note_sha256 IS NULL OR note_sha256 ~ '^[0-9a-f]{64}$')
);

-- Checkpoint names are unique per workspace, case-insensitively: two names that differ only
-- by case are the same label to a user, and a unique index is what keeps that true even if
-- two requests arrive at once.
CREATE UNIQUE INDEX IF NOT EXISTS git_checkpoints_name
	ON log4stellar.git_checkpoints (workspace_id, lower(name));

CREATE INDEX IF NOT EXISTS git_checkpoints_created
	ON log4stellar.git_checkpoints (workspace_id, created_ms DESC);

COMMIT;
