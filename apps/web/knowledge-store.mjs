// PostgreSQL access for the knowledge index (docs/knowledge-links.md §2).
//
// Deliberately small and dependency free, exactly like git-store.mjs: three tables, plain SQL,
// no ORM. The pool is created once per storage configuration and reused, because a backlink
// panel poll would otherwise pay a connect round trip on every keystroke.
//
// Every function that writes takes a connection that already belongs to the caller's
// transaction (the sync-store.mjs convention), so a re-index of one file is all or nothing and
// an interrupted rebuild never leaves half of a document's links behind.
//
// The tables are pure derivatives of the note bodies. Nothing here ever writes to
// storage_entries, storage_file_versions or the objects themselves: re-indexing must not
// modify a note (docs/knowledge-links.md, acceptance).

import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { knowledgeSchemaCurrent, migrateKnowledge, migrationLockId } from './knowledge-migrate.mjs';
import { knowledgeParserVersion, linkStatuses } from './knowledge-parser.mjs';
import { WorkspaceError } from './workspace-contract.mjs';

const linksTable = 'log4stellar.knowledge_links';
const tagsTable = 'log4stellar.knowledge_tags';
const stateTable = 'log4stellar.knowledge_index_state';
const entriesTable = 'log4stellar.storage_entries';

const linkColumns = [
	'source_file_id', 'source_revision_id', 'link_kind', 'target_raw', 'target_path',
	'target_name', 'target_file_id', 'anchor', 'alias', 'status', 'candidate_count',
	'line', '"column"', 'indexed_ms',
];

const maxPageSize = 200;
const defaultPageSize = 50;
const maxCursorLength = 8_192;

/** Reads `LOG4STELLAR_STORAGE_CONFIG` the same way rustfs-workspace.mjs does. */
export async function readKnowledgeStorageSettings(environment = process.env) {
	const configPath = environment.LOG4STELLAR_STORAGE_CONFIG;
	if (!configPath) {
		throw new WorkspaceError(503, 'KnowledgeNotConfigured');
	}
	let settings;
	try {
		settings = JSON.parse(await readFile(configPath, 'utf8'));
	} catch {
		throw new WorkspaceError(503, 'KnowledgeNotConfigured');
	}
	const postgres = settings.postgres;
	if (!postgres?.host || !postgres.database || !postgres.user || !postgres.password) {
		throw new WorkspaceError(503, 'KnowledgeNotConfigured');
	}
	return { configPath, settings, postgres };
}

let cached;
let cachedKey;

/**
 * One pool per storage configuration, migrated on first use with the read-only probe first:
 * a request that only lists tags must not run DDL against a database that is already current.
 */
export async function openKnowledgeStore(environment = process.env) {
	const { configPath, postgres } = await readKnowledgeStorageSettings(environment);
	if (cached && cachedKey === configPath) {
		return cached;
	}
	await closeKnowledgeStore();
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 4, ...postgres });
	try {
		if (!await knowledgeSchemaCurrent(pool)) {
			await migrateKnowledge(pool);
		}
	} catch (error) {
		await pool.end().catch(() => {});
		throw error;
	}
	const store = createStore(pool, configPath);
	cached = store;
	cachedKey = configPath;
	return store;
}

export async function closeKnowledgeStore() {
	if (!cached) {
		return;
	}
	const pool = cached.pool;
	cached = undefined;
	cachedKey = undefined;
	await pool.end().catch(() => {});
}

/** Test seam: drop the cached pool without touching the database. */
export function resetKnowledgeStoreForTest() {
	return closeKnowledgeStore();
}

/**
 * Decodes an opaque page cursor. The cursor is bound to one workspace and one query kind, so a
 * cursor from a different workspace (or a hand-edited one) is rejected instead of leaking rows.
 */
export function decodeKnowledgeCursor(value, { workspaceId, kind }) {
	if (typeof value !== 'string' || value === '' || value.length > maxCursorLength) {
		throw new WorkspaceError(400, 'InvalidCursor');
	}
	let payload;
	try {
		payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
	} catch {
		throw new WorkspaceError(400, 'InvalidCursor');
	}
	if (payload?.w !== workspaceId || payload?.k !== kind) {
		throw new WorkspaceError(400, 'InvalidCursor');
	}
	if (typeof payload.p !== 'string' || !Array.isArray(payload.o)) {
		throw new WorkspaceError(400, 'InvalidCursor');
	}
	return { path: payload.p, order: payload.o };
}

/** Counterpart of `decodeKnowledgeCursor`. */
export function encodeKnowledgeCursor({ workspaceId, kind, path, order }) {
	const token = Buffer.from(JSON.stringify({ w: workspaceId, k: kind, p: path, o: order }), 'utf8').toString('base64url');
	if (token.length > maxCursorLength) {
		throw new WorkspaceError(400, 'InvalidCursor');
	}
	return token;
}

/** Clamps a requested page size into [1, maxPageSize]. Invalid values are a 400, not a default. */
export function knowledgePageSize(value) {
	if (value === undefined || value === null || value === '') {
		return defaultPageSize;
	}
	const size = Number(value);
	if (!Number.isSafeInteger(size) || size < 1) {
		throw new WorkspaceError(400, 'InvalidPageSize');
	}
	return Math.min(size, maxPageSize);
}

function requireStatus(status) {
	if (!linkStatuses.includes(status)) {
		throw new Error('Unknown knowledge link status: ' + String(status) + '.');
	}
	return status;
}

/**
 * A link row as the API returns it. `path` is the live path of the source document, resolved
 * from storage_entries at read time — never the path recorded when the row was indexed, because
 * a note that has been renamed since then must still be reachable.
 */
function linkJson(row) {
	return {
		sourceFileId: row.source_file_id,
		sourceRevisionId: row.source_revision_id,
		sourcePath: row.source_path ?? null,
		sourceEtag: row.source_revision_id ? `"${row.source_revision_id}"` : null,
		kind: row.link_kind,
		raw: row.target_raw,
		targetPath: row.target_path ?? null,
		targetName: row.target_name ?? null,
		targetFileId: row.target_file_id ?? null,
		anchor: row.anchor ?? null,
		alias: row.alias ?? null,
		status: requireStatus(row.status),
		candidateCount: Number(row.candidate_count ?? 0),
		line: Number(row.line),
		column: Number(row.column),
		indexedAt: Number(row.indexed_ms),
	};
}

function tagJson(row) {
	return {
		fileId: row.file_id,
		revisionId: row.revision_id,
		tag: row.tag,
		tagKey: row.tag_key,
		path: row.path ?? null,
		line: Number(row.line),
		column: Number(row.column),
	};
}

/**
 * The effective status of a stored link. A row indexed as `resolved` whose target has since
 * been deleted or moved to the trash reads as `missing` without a re-index, and it becomes
 * `resolved` again when the target is restored — which is exactly the K04 behaviour: the trash
 * round trip changes the *presence* of the target, never the link row or the file identity.
 */
const effectiveStatus = `CASE WHEN l.status = 'resolved' AND t.file_id IS NULL THEN 'missing' ELSE l.status END`;

function createStore(pool, configPath) {
	/**
	 * Runs `action` inside a transaction that holds the shared half of the migration lock, so a
	 * writer never races a concurrent migration. Same protocol as rustfs-workspace.mjs.
	 */
	async function transaction(action) {
		const connection = await pool.connect();
		try {
			await connection.query('BEGIN');
			await connection.query('SELECT pg_advisory_xact_lock_shared($1)', [migrationLockId]);
			const result = await action(connection);
			await connection.query('COMMIT');
			return result;
		} catch (error) {
			await connection.query('ROLLBACK').catch(() => {});
			throw error;
		} finally {
			connection.release();
		}
	}

	const store = {
		pool,
		configPath,
		close: closeKnowledgeStore,
		transaction,
		migrate: () => migrateKnowledge(pool),
		schemaCurrent: () => knowledgeSchemaCurrent(pool),

		/** Every live file of the workspace, with the revision the index must catch up to. */
		async listLiveFiles(workspaceId) {
			const { rows } = await pool.query(`
				SELECT e.path, e.file_id, e.revision_id,
					s.revision_id AS indexed_revision_id, s.parser_version
				FROM ${entriesTable} e
				LEFT JOIN ${stateTable} s
					ON s.workspace_id = e.workspace_id AND s.file_id = e.file_id
				WHERE e.workspace_id = $1 AND e.kind = 1
				ORDER BY e.path
			`, [workspaceId]);
			return rows.map(row => ({
				path: row.path,
				fileId: row.file_id,
				revisionId: row.revision_id,
				indexedRevisionId: row.indexed_revision_id ?? null,
				parserVersion: row.parser_version === null || row.parser_version === undefined
					? null
					: Number(row.parser_version),
			}));
		},

		async listStaleNotes(workspaceId, after, limit) {
			const { rows } = await pool.query(`
				SELECT e.path, e.file_id AS "fileId", e.revision_id AS "revisionId"
				FROM ${entriesTable} e
				LEFT JOIN ${stateTable} s ON s.workspace_id = e.workspace_id AND s.file_id = e.file_id
				WHERE e.workspace_id = $1 AND e.kind = 1 AND e.path > $2
					AND e.path ~* '[.](md|markdown|mdown|mkdn|mkd|mdwn|mdtxt|mdtext)$'
					AND (s.revision_id IS DISTINCT FROM e.revision_id OR s.parser_version IS DISTINCT FROM $3::int)
				ORDER BY e.path LIMIT $4
			`, [workspaceId, after, knowledgeParserVersion, limit]);
			return rows;
		},

		/** The live entry for one stable file ID, or undefined once the note is deleted. */
		async readLiveFile(workspaceId, fileId) {
			const { rows } = await pool.query(`
				SELECT path, file_id, revision_id, kind
				FROM ${entriesTable}
				WHERE workspace_id = $1 AND file_id = $2 AND kind = 1
			`, [workspaceId, fileId]);
			return rows[0];
		},

		/** The live entry at one path, used to turn a resolved path into a stable identity. */
		async readFileByPath(workspaceId, path) {
			const { rows } = await pool.query(`
				SELECT path, file_id, revision_id, kind
				FROM ${entriesTable}
				WHERE workspace_id = $1 AND path = $2 AND kind = 1
			`, [workspaceId, path]);
			return rows[0];
		},

		/**
		 * Candidate targets for the names a document links to, in one round trip. Unresolved
		 * wiki links are matched by name only, so this is what tells "one match" from
		 * "ambiguous, do not guess" (docs/knowledge-links.md §K01).
		 */
		async listCandidateFiles(workspaceId, names) {
			if (!names.length) {
				return [];
			}
			const lower = [...new Set(names.map(name => String(name).toLowerCase()))];
			const { rows } = await pool.query(`
				SELECT path, file_id, revision_id, lower(name) AS name_key
				FROM ${entriesTable}
				WHERE workspace_id = $1 AND kind = 1 AND lower(name) = ANY($2::text[])
				ORDER BY path
			`, [workspaceId, lower]);
			return rows;
		},

		/** The stored index state of one file, used to skip files that are already current. */
		async readIndexState(workspaceId, fileId) {
			const { rows } = await pool.query(`
				SELECT revision_id, parser_version, link_count, tag_count, indexed_ms
				FROM ${stateTable} WHERE workspace_id = $1 AND file_id = $2
			`, [workspaceId, fileId]);
			const row = rows[0];
			if (!row) {
				return undefined;
			}
			return {
				revisionId: row.revision_id,
				parserVersion: Number(row.parser_version),
				linkCount: Number(row.link_count),
				tagCount: Number(row.tag_count),
				indexedAt: Number(row.indexed_ms),
			};
		},

		/**
		 * Replaces everything known about one source file in one transaction: the previous rows
		 * for that file are removed, the new ones inserted, and the state row records the
		 * revision the rows were produced from. Re-running with the same revision is a no-op.
		 */
		async replaceFileIndex(connection, { workspaceId, fileId, revisionId, parserVersion, links, tags, indexedAt }) {
			// Keep a concurrent save from publishing an index for an obsolete revision.
			const { rowCount } = await connection.query(`
				SELECT 1 FROM ${entriesTable}
				WHERE workspace_id = $1 AND file_id = $2 AND revision_id = $3 AND kind = 1
				FOR UPDATE
			`, [workspaceId, fileId, revisionId]);
			if (!rowCount) {
				return false;
			}
			await connection.query(
				`DELETE FROM ${linksTable} WHERE workspace_id = $1 AND source_file_id = $2`,
				[workspaceId, fileId],
			);
			await connection.query(
				`DELETE FROM ${tagsTable} WHERE workspace_id = $1 AND file_id = $2`,
				[workspaceId, fileId],
			);
			for (const link of links) {
				await connection.query(`
					INSERT INTO ${linksTable} (
						workspace_id, source_file_id, source_revision_id, link_kind, target_raw,
						target_path, target_name, target_file_id, anchor, alias, status,
						candidate_count, line, "column", indexed_ms
					) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
				`, [
					workspaceId, fileId, revisionId, link.kind, link.raw,
					link.targetPath ?? null, link.targetName ?? null, link.targetFileId ?? null,
					link.anchor ?? null, link.alias ?? null, requireStatus(link.status),
					link.candidateCount ?? 0, link.line, link.column, indexedAt,
				]);
			}
			for (const tag of tags) {
				await connection.query(`
					INSERT INTO ${tagsTable} (
						workspace_id, file_id, revision_id, tag, tag_key, line, "column", indexed_ms
					) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
				`, [workspaceId, fileId, revisionId, tag.tag, tag.tagKey, tag.line, tag.column, indexedAt]);
			}
			await connection.query(`
				INSERT INTO ${stateTable} (
					workspace_id, file_id, revision_id, parser_version, link_count, tag_count, indexed_ms
				) VALUES ($1,$2,$3,$4,$5,$6,$7)
				ON CONFLICT (workspace_id, file_id) DO UPDATE SET
					revision_id = EXCLUDED.revision_id,
					parser_version = EXCLUDED.parser_version,
					link_count = EXCLUDED.link_count,
					tag_count = EXCLUDED.tag_count,
					indexed_ms = EXCLUDED.indexed_ms
			`, [workspaceId, fileId, revisionId, parserVersion, links.length, tags.length, indexedAt]);
			return true;
		},

		/** Drops the index of a file that no longer exists (deleted, not merely trashed). */
		async deleteFileIndex(connection, workspaceId, fileId) {
			await connection.query(`DELETE FROM ${linksTable} WHERE workspace_id = $1 AND source_file_id = $2`, [workspaceId, fileId]);
			await connection.query(`DELETE FROM ${tagsTable} WHERE workspace_id = $1 AND file_id = $2`, [workspaceId, fileId]);
			await connection.query(`DELETE FROM ${stateTable} WHERE workspace_id = $1 AND file_id = $2`, [workspaceId, fileId]);
		},

		/**
		 * Links pointing at one stable identity. The source path is resolved from storage_entries
		 * so a rename shows up immediately, and a source that has been trashed drops out of the
		 * list until it is restored.
		 */
		async listBacklinks(workspaceId, targetFileId, { cursor, limit } = {}) {
			const after = cursor
				? `AND (s.path, l.line, l."column") > ($4, $5, $6)`
				: '';
			const params = [workspaceId, targetFileId, limit];
			if (cursor) {
				params.push(cursor.path, cursor.order[0], cursor.order[1]);
			}
			const { rows } = await pool.query(`
				SELECT l.source_file_id, l.source_revision_id, l.link_kind, l.target_raw,
					l.target_path, l.target_name, l.target_file_id, l.anchor, l.alias,
					${effectiveStatus} AS status, l.candidate_count, l.line, l."column", l.indexed_ms,
					s.path AS source_path
				FROM ${linksTable} l
				JOIN ${entriesTable} s
					ON s.workspace_id = l.workspace_id AND s.file_id = l.source_file_id AND s.revision_id = l.source_revision_id
				LEFT JOIN ${entriesTable} t
					ON t.workspace_id = l.workspace_id AND t.file_id = l.target_file_id
				WHERE l.workspace_id = $1 AND l.target_file_id = $2 AND (${effectiveStatus}) = 'resolved'
					${after}
				ORDER BY s.path, l.line, l."column"
				LIMIT $3
			`, params);
			return rows.map(linkJson);
		},

		/** The outgoing links of one source document, for the "links from here" panel. */
		async listSourceLinks(workspaceId, sourceFileId, { cursor, limit } = {}) {
			const after = cursor
				? `AND (l.line, l."column") > ($4, $5)`
				: '';
			const params = [workspaceId, sourceFileId, limit];
			if (cursor) {
				params.push(cursor.order[0], cursor.order[1]);
			}
			const { rows } = await pool.query(`
				SELECT l.source_file_id, l.source_revision_id, l.link_kind, l.target_raw,
					l.target_path, l.target_name, l.target_file_id, l.anchor, l.alias,
					${effectiveStatus} AS status, l.candidate_count, l.line, l."column", l.indexed_ms,
					s.path AS source_path
				FROM ${linksTable} l
				JOIN ${entriesTable} s
					ON s.workspace_id = l.workspace_id AND s.file_id = l.source_file_id AND s.revision_id = l.source_revision_id
				LEFT JOIN ${entriesTable} t
					ON t.workspace_id = l.workspace_id AND t.file_id = l.target_file_id
				WHERE l.workspace_id = $1 AND l.source_file_id = $2
					${after}
				ORDER BY l.line, l."column"
				LIMIT $3
			`, params);
			return rows.map(linkJson);
		},

		/**
		 * Everything that does not lead anywhere: unresolvable targets, ambiguous names and
		 * external URLs. Ambiguous rows keep their `candidate_count` so the UI can say "3 notes
		 * share this name" instead of silently picking one.
		 */
		async listUnresolvedLinks(workspaceId, { cursor, limit, status, excludeExternal = false } = {}) {
			const statuses = status ? [requireStatus(status)] : ['missing', 'ambiguous'];
			if (!status && !excludeExternal) statuses.push('external');
			const after = cursor
				? `AND (s.path, l.line, l."column") > ($4, $5, $6)`
				: '';
			const params = [workspaceId, statuses, limit];
			if (cursor) {
				params.push(cursor.path, cursor.order[0], cursor.order[1]);
			}
			const { rows } = await pool.query(`
				SELECT l.source_file_id, l.source_revision_id, l.link_kind, l.target_raw,
					l.target_path, l.target_name, l.target_file_id, l.anchor, l.alias,
					${effectiveStatus} AS status, l.candidate_count, l.line, l."column", l.indexed_ms,
					s.path AS source_path
				FROM ${linksTable} l
				JOIN ${entriesTable} s
					ON s.workspace_id = l.workspace_id AND s.file_id = l.source_file_id AND s.revision_id = l.source_revision_id
				LEFT JOIN ${entriesTable} t
					ON t.workspace_id = l.workspace_id AND t.file_id = l.target_file_id
				WHERE l.workspace_id = $1 AND (${effectiveStatus}) = ANY($2::text[])
					${after}
				ORDER BY s.path, l.line, l."column"
				LIMIT $3
			`, params);
			return rows.map(linkJson);
		},

		/** Tag cloud: one row per normalised tag key with its usage count and display form. */
		async listTags(workspaceId, { prefix = '', after = '', limit } = {}) {
			const { rows } = await pool.query(`
				SELECT g.tag_key, min(g.tag) AS tag, count(*)::int AS uses
				FROM ${tagsTable} g
				JOIN ${entriesTable} e
					ON e.workspace_id = g.workspace_id AND e.file_id = g.file_id AND e.revision_id = g.revision_id
				WHERE g.workspace_id = $1 AND starts_with(g.tag_key, $2) AND g.tag_key > $3
				GROUP BY g.tag_key
				ORDER BY g.tag_key
				LIMIT $4
			`, [workspaceId, prefix.toLowerCase(), after, limit]);
			return rows.map(row => ({ tagKey: row.tag_key, tag: row.tag, uses: Number(row.uses) }));
		},

		/** Every occurrence of one tag (or one tag subtree), with the live path of its file. */
		async listTagOccurrences(workspaceId, tagKey, { includeChildren = false, after, limit } = {}) {
			const key = String(tagKey).toLowerCase();
			const { rows } = await pool.query(`
				SELECT g.file_id, g.revision_id, g.tag, g.tag_key, g.line, g."column", e.path
				FROM ${tagsTable} g
				JOIN ${entriesTable} e
					ON e.workspace_id = g.workspace_id AND e.file_id = g.file_id AND e.revision_id = g.revision_id
				WHERE g.workspace_id = $1
					AND (g.tag_key = $2 OR ($3::boolean AND starts_with(g.tag_key, $2 || '/')))
					AND (e.path, g.line, g."column") > ($4::text, $5::int, $6::int)
				ORDER BY e.path, g.line, g."column"
				LIMIT $7
			`, [workspaceId, key, includeChildren, after?.path ?? '', after?.order[0] ?? 0, after?.order[1] ?? 0, limit]);
			return rows.map(tagJson);
		},

		/** Tags of one file, for the document panel. */
		async listFileTags(workspaceId, fileId) {
			const { rows } = await pool.query(`
				SELECT g.file_id, g.revision_id, g.tag, g.tag_key, g.line, g."column", e.path
				FROM ${tagsTable} g
				LEFT JOIN ${entriesTable} e
					ON e.workspace_id = g.workspace_id AND e.file_id = g.file_id
				WHERE g.workspace_id = $1 AND g.file_id = $2
				ORDER BY g.line, g."column"
			`, [workspaceId, fileId]);
			return rows.map(tagJson);
		},

		/**
		 * Links whose stored target is this file, regardless of stored status. Used by the rename
		 * planner: those are the source documents a rename would have to rewrite.
		 */
		async listLinksToFile(workspaceId, fileId) {
			const { rows } = await pool.query(`
				SELECT l.source_file_id, l.source_revision_id, l.link_kind, l.target_raw,
					l.target_path, l.target_name, l.target_file_id, l.anchor, l.alias,
					l.status, l.candidate_count, l.line, l."column", l.indexed_ms,
					s.path AS source_path
				FROM ${linksTable} l
				JOIN ${entriesTable} s
					ON s.workspace_id = l.workspace_id AND s.file_id = l.source_file_id
				WHERE l.workspace_id = $1 AND l.target_file_id = $2
				ORDER BY s.path, l.line, l."column"
			`, [workspaceId, fileId]);
			return rows.map(linkJson);
		},

		/** Resolved links that spell the target by path, used when a path stops existing. */
		async listLinksByTargetPath(workspaceId, path) {
			const { rows } = await pool.query(`
				SELECT l.source_file_id, l.source_revision_id, l.link_kind, l.target_raw,
					l.target_path, l.target_name, l.target_file_id, l.anchor, l.alias,
					l.status, l.candidate_count, l.line, l."column", l.indexed_ms,
					s.path AS source_path
				FROM ${linksTable} l
				JOIN ${entriesTable} s
					ON s.workspace_id = l.workspace_id AND s.file_id = l.source_file_id
				WHERE l.workspace_id = $1 AND l.target_path = $2
				ORDER BY s.path, l.line, l."column"
			`, [workspaceId, path]);
			return rows.map(linkJson);
		},
	};
	return store;
}

export { linksTable as knowledgeLinksTable, tagsTable as knowledgeTagsTable };
