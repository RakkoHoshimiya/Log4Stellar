-- Knowledge index schema: the derived tables behind backlinks, tags and broken links.
--
-- Additive only, exactly like sync-schema.sql and git-schema.sql: every object is
-- `IF NOT EXISTS` and no existing column or table is touched, so an older release
-- that knows nothing about these tables keeps running unchanged and a rollback
-- needs no DDL at all. The tables are pure derivatives of the note bodies: they
-- can be dropped, emptied or rebuilt at any time without losing user content, and
-- rebuilding the index never writes to storage_entries, storage_file_versions or
-- the objects themselves.
--
-- Identity, not paths: a link edge points at `target_file_id`, the stable
-- identifier that survives renames, moves and trash/restore cycles. `target_path`
-- is recorded as a display hint from indexing time only -- readers must resolve
-- the live path from storage_entries, never trust the hint for authorization.
--
-- The `column` column is quoted because COLUMN is a reserved word in PostgreSQL.
--
-- `target_file_id` is a soft reference (no foreign key) for the same reason
-- git_checkpoints uses one: a note can be deleted and later restored, and a hard
-- reference would either block the delete or cascade the knowledge rows away.

BEGIN;

CREATE TABLE IF NOT EXISTS log4stellar.knowledge_links (
	workspace_id text NOT NULL CHECK (char_length(workspace_id) BETWEEN 1 AND 64),
	source_file_id uuid NOT NULL,
	source_revision_id uuid NOT NULL,
	link_kind text NOT NULL CHECK (link_kind IN ('markdown', 'wiki')),
	target_raw text NOT NULL CHECK (char_length(target_raw) <= 2048),
	target_path text CHECK (target_path IS NULL OR char_length(target_path) BETWEEN 1 AND 1024),
	target_name text CHECK (target_name IS NULL OR char_length(target_name) BETWEEN 1 AND 512),
	target_file_id uuid,
	anchor text CHECK (anchor IS NULL OR char_length(anchor) <= 1024),
	alias text CHECK (alias IS NULL OR char_length(alias) <= 1024),
	status text NOT NULL CHECK (status IN ('resolved', 'missing', 'ambiguous', 'external')),
	candidate_count integer NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
	line integer NOT NULL CHECK (line >= 1),
	"column" integer NOT NULL CHECK ("column" >= 1),
	indexed_ms bigint NOT NULL,
	PRIMARY KEY (workspace_id, source_file_id, link_kind, line, "column")
);

CREATE INDEX IF NOT EXISTS knowledge_links_source_idx
	ON log4stellar.knowledge_links (workspace_id, source_file_id);

CREATE INDEX IF NOT EXISTS knowledge_links_target_idx
	ON log4stellar.knowledge_links (workspace_id, target_file_id, source_file_id)
	WHERE target_file_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS knowledge_links_status_idx
	ON log4stellar.knowledge_links (workspace_id, status, source_file_id)
	WHERE status <> 'resolved';

CREATE INDEX IF NOT EXISTS knowledge_links_name_idx
	ON log4stellar.knowledge_links (workspace_id, lower(target_name))
	WHERE target_name IS NOT NULL;

CREATE TABLE IF NOT EXISTS log4stellar.knowledge_tags (
	workspace_id text NOT NULL CHECK (char_length(workspace_id) BETWEEN 1 AND 64),
	file_id uuid NOT NULL,
	revision_id uuid NOT NULL,
	tag text NOT NULL CHECK (char_length(tag) BETWEEN 1 AND 128),
	tag_key text NOT NULL CHECK (char_length(tag_key) BETWEEN 1 AND 128),
	line integer NOT NULL CHECK (line >= 1),
	"column" integer NOT NULL CHECK ("column" >= 1),
	indexed_ms bigint NOT NULL,
	PRIMARY KEY (workspace_id, file_id, line, "column")
);

CREATE INDEX IF NOT EXISTS knowledge_tags_key_idx
	ON log4stellar.knowledge_tags (workspace_id, tag_key);

CREATE INDEX IF NOT EXISTS knowledge_tags_file_idx
	ON log4stellar.knowledge_tags (workspace_id, file_id);

-- One row per indexed source file: the revision the rows above were produced from.
-- A saved revision that already matches is skipped, so re-running the indexer is
-- idempotent and an interrupted rebuild resumes instead of starting over.
CREATE TABLE IF NOT EXISTS log4stellar.knowledge_index_state (
	workspace_id text NOT NULL CHECK (char_length(workspace_id) BETWEEN 1 AND 64),
	file_id uuid NOT NULL,
	revision_id uuid NOT NULL,
	parser_version integer NOT NULL CHECK (parser_version >= 1),
	link_count integer NOT NULL DEFAULT 0 CHECK (link_count >= 0),
	tag_count integer NOT NULL DEFAULT 0 CHECK (tag_count >= 0),
	indexed_ms bigint NOT NULL,
	PRIMARY KEY (workspace_id, file_id)
);

CREATE INDEX IF NOT EXISTS knowledge_index_state_revision_idx
	ON log4stellar.knowledge_index_state (workspace_id, revision_id);

COMMIT;
