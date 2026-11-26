import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Pool } from 'pg';
import { normalizeWorkspacePath, WorkspaceError } from './workspace-contract.mjs';

export const uploadApiPath = '/api/v1/uploads';
export const uploadPagePath = '/uploads';
const uploadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ownerPattern = /^[0-9a-f]{64}$/;
const chunkSize = 8 * 1024 * 1024;
const expiresMs = 24 * 60 * 60 * 1000;
const maxPending = 2;
const lockClass = 0x4c345550;
const diskReserve = 256 * 1024 * 1024;
const fail = (status, code) => { throw new WorkspaceError(status, code); };

async function readJsonBody(ctx) {
	if (!ctx.is('application/json')) fail(415, 'InvalidUpload');
	const chunks = [];
	let size = 0;
	for await (const chunk of ctx.req) {
		size += chunk.length;
		if (size > 16384) fail(413, 'InvalidUpload');
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		return fail(400, 'InvalidUpload');
	}
}

async function assureSpace(directory, bytes) {
	const { bsize, bavail } = await statfs(directory);
	if (bsize * bavail < bytes + diskReserve) fail(507, 'UploadStorageFull');
}

async function readState(directory) {
	try {
		return JSON.parse(await readFile(join(directory, 'upload.json'), 'utf8'));
	} catch (error) {
		if (error.code === 'ENOENT') return undefined;
		throw error;
	}
}

async function saveState(directory, state) {
	const pending = join(directory, 'upload.tmp');
	await writeFile(pending, JSON.stringify(state), { mode: 0o600 });
	await rename(pending, join(directory, 'upload.json'));
}

function payload(id, state) {
	return { id, chunkSize, path: state.path, size: state.size, offset: state.offset,
		digests: state.digests, result: state.result, expiresAt: state.updatedAt + expiresMs };
}

function partPath(directory, index) {
	return join(directory, 'part-' + index);
}

async function* partContents(directory, state) {
	for (const [index, expectedHash] of state.digests.entries()) {
		const hash = createHash('sha256');
		const expected = Math.min(chunkSize, state.size - index * chunkSize);
		let size = 0;
		try {
			for await (const bytes of createReadStream(partPath(directory, index))) {
				size += bytes.length;
				if (size > expected) fail(409, 'UploadPartCorrupt');
				hash.update(bytes);
				yield bytes;
			}
		} catch (error) {
			if (error.code === 'ENOENT') fail(409, 'UploadPartCorrupt');
			throw error;
		}
		if (size !== expected || hash.digest('hex') !== expectedHash) fail(409, 'UploadPartCorrupt');
	}
}

async function acceptChunk(ctx, directory, state) {
	const offset = ctx.query.offset;
	if (typeof offset !== 'string' || !/^\d+$/.test(offset) || Number(offset) !== state.offset) {
		fail(409, 'UploadOffsetMismatch');
	}
	const expected = Math.min(chunkSize, state.size - state.offset);
	if (state.result || expected <= 0) fail(409, 'UploadAlreadyReceived');
	if (!ctx.is('application/octet-stream')) fail(415, 'InvalidUpload');
	await assureSpace(directory, expected);
	const pending = join(directory, 'part.tmp');
	const hash = createHash('sha256');
	let size = 0;
	try {
		await pipeline(Readable.from(ctx.req.iterator({ destroyOnReturn: false })), new Transform({
			transform(chunk, _, done) {
				size += chunk.length;
				if (size > expected) return done(new WorkspaceError(413, 'InvalidUploadChunk'));
				hash.update(chunk);
				done(null, chunk);
			},
		}), createWriteStream(pending, { flags: 'w', mode: 0o600 }));
		if (size !== expected) fail(400, 'InvalidUploadChunk');
		await rename(pending, partPath(directory, state.digests.length));
		state.offset += size;
		state.digests.push(hash.digest('hex'));
		state.updatedAt = Date.now();
		await saveState(directory, state);
	} finally {
		await rm(pending, { force: true });
	}
}

export function openResumableUploads({ configPath, postgres, maxUploadBytes }) {
	const root = join(dirname(configPath), 'resumable-uploads');
	const pool = new Pool({ ...postgres, max: 2, connectionTimeoutMillis: 5000 });
	let sweep;

	async function withOwner(owner, action) {
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [lockClass, owner]);
			const result = await action(join(root, owner));
			await client.query('COMMIT');
			return result;
		} catch (error) {
			await client.query('ROLLBACK').catch(() => {});
			throw error;
		} finally {
			client.release();
		}
	}

	async function prune(ownerDirectory) {
		const ids = await readdir(ownerDirectory).catch(error => {
			if (error.code === 'ENOENT') return [];
			throw error;
		});
		let active = 0;
		for (const id of ids.filter(id => uploadIdPattern.test(id))) {
			const directory = join(ownerDirectory, id);
			const state = await readState(directory);
			if (!state || state.updatedAt + expiresMs <= Date.now()) {
				await rm(directory, { recursive: true, force: true });
			} else if (!state.result) {
				active++;
			} else {
				// If the process stopped after committing, remove leftover parts on the next sweep.
				await Promise.all(state.digests.map((_, n) => rm(partPath(directory, n), { force: true })));
			}
		}
		return active;
	}

	const timer = setInterval(() => {
		sweep ??= (async () => {
			const owners = await readdir(root).catch(error => {
				if (error.code === 'ENOENT') return [];
				throw error;
			});
			for (const owner of owners.filter(owner => ownerPattern.test(owner))) await withOwner(owner, prune);
		})().catch(error => console.error('Could not prune expired uploads', error.code ?? error.name))
			.finally(() => { sweep = undefined; });
	}, 60 * 60 * 1000);
	timer.unref();

	async function handle(ctx, { workspaceId, accountId, backend }) {
		const route = /^\/api\/v1\/uploads\/([^/]+)(\/complete)?$/.exec(ctx.path);
		if (!route || !uploadIdPattern.test(route[1])) fail(404, 'UploadNotFound');
		const [, id, complete] = route;
		const owner = createHash('sha256').update(workspaceId + '\0' + accountId).digest('hex');
		await withOwner(owner, async ownerDirectory => {
			const directory = join(ownerDirectory, id);
			let state = await readState(directory);
			if (state && state.updatedAt + expiresMs <= Date.now()) fail(410, 'UploadExpired');
			if (!complete && ctx.method === 'PUT') {
				const input = await readJsonBody(ctx);
				if (typeof input?.path !== 'string') fail(400, 'InvalidUpload');
				const path = normalizeWorkspacePath(input.path);
				const size = input?.size;
				if (path === '/' || !Number.isSafeInteger(size) || size < 0) fail(400, 'InvalidUpload');
				if (size > maxUploadBytes) fail(413, 'FileTooLarge');
				if (state && (state.path !== path || state.size !== size)) fail(409, 'UploadMismatch');
				if (!state) {
					await mkdir(ownerDirectory, { recursive: true, mode: 0o700 });
					if (await prune(ownerDirectory) >= maxPending) fail(429, 'TooManyUploads');
					await assureSpace(ownerDirectory, Math.min(size, chunkSize));
					await mkdir(directory, { recursive: true, mode: 0o700 });
					state = { path, size, offset: 0, digests: [], result: null, updatedAt: Date.now() };
					await saveState(directory, state);
				}
			} else {
				if (!state) fail(404, 'UploadNotFound');
				if (!complete && ctx.method === 'DELETE') {
					if (state.result) fail(409, 'UploadAlreadyCompleted');
					if (state.committing) fail(409, 'UploadFinalizing');
					await rm(directory, { recursive: true, force: true });
					ctx.status = 204;
					return;
				}
				if (!complete && ctx.method === 'PATCH') {
					await acceptChunk(ctx, directory, state);
				} else if (complete && ctx.method === 'POST') {
					if (state.offset !== state.size) fail(409, 'UploadIncomplete');
					if (!state.result) {
						await assureSpace(directory, state.size);
						state.committing = true;
						await saveState(directory, state);
						// syncPutFile durably replays an identical commit after a crash between
						// PostgreSQL commit and updating upload.json. Scope the key by account as well.
						let reply;
						try {
							reply = await backend.syncPutFile({
								path: state.path, mode: 'create', baseRevision: null,
								idempotencyKey: 'upload-' + createHash('sha256').update(owner + id).digest('hex'),
								device: 'web-upload', maxBytes: state.size,
								source: Readable.from(partContents(directory, state)),
							});
						} catch (error) {
							if (error.code === 'UploadPartCorrupt') {
								state.committing = false;
								await saveState(directory, state);
							}
							throw error;
						}
						state.result = {
							path: reply.body.conflictPath ?? reply.body.path,
							revisionId: reply.body.revisionId,
							renamed: Boolean(reply.body.conflictPath),
						};
						state.updatedAt = Date.now();
						await saveState(directory, state);
					}
					await Promise.all(state.digests.map((_, n) => rm(partPath(directory, n), { force: true })));
				} else if (complete || ctx.method !== 'GET') {
					fail(405, 'UploadMethodNotAllowed');
				}
			}
			ctx.body = payload(id, state);
			ctx.status = 200;
		});
	}

	return {
		handle,
		async close() {
			clearInterval(timer);
			await sweep;
			await pool.end();
		},
	};
}
