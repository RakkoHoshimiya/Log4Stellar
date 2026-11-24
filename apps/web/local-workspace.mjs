import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { WorkspaceError, normalizeWorkspacePath } from './workspace-contract.mjs';

export function isInside(root, path) {
	const difference = relative(root, path);
	return !isAbsolute(difference) && difference !== '..' && !difference.startsWith('..' + sep);
}

function describe(info) {
	const revision = createHash('sha256').update(`${info.ino}:${info.dev}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`).digest('base64url');
	return {
		type: info.isDirectory() ? 2 : 1,
		ctime: Number(info.birthtimeMs || info.ctimeMs),
		mtime: Number(info.mtimeMs),
		size: Number(info.size),
		etag: `"${revision}"`,
	};
}

async function tryStat(path) {
	try {
		return await lstat(path, { bigint: true });
	} catch (error) {
		if (error.code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
}

async function syncDirectory(path) {
	const directory = await open(path, 'r');
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

export async function createLocalWorkspace(root) {
	const uploadDirectory = join(dirname(root), '.log4stellar-uploads');
	await mkdir(uploadDirectory, { mode: 0o700, recursive: true });
	if (await realpath(uploadDirectory) !== uploadDirectory || (await stat(uploadDirectory)).dev !== (await stat(root)).dev) {
		throw new Error('The upload directory must be outside the workspace and on the same filesystem.');
	}

	let writeQueue = Promise.resolve();
	function mutate(action) {
		const result = writeQueue.then(action);
		writeQueue = result.catch(() => {});
		return result;
	}

	async function locate(path, allowMissing = false) {
		const parts = normalizeWorkspacePath(path).split('/').slice(1).filter(Boolean);
		const target = resolve(root, ...parts);
		const parent = parts.length ? dirname(target) : root;
		if (await realpath(parent) !== parent || !isInside(root, target)) {
			throw new WorkspaceError(403, 'NoPermissions');
		}
		const info = await tryStat(target);
		if (!info && !allowMissing) {
			throw new WorkspaceError(404, 'FileNotFound');
		}
		if (info && !info.isFile() && !info.isDirectory()) {
			throw new WorkspaceError(403, 'NoPermissions');
		}
		return { target, info };
	}

	function requireNonRoot(target) {
		if (target === root) {
			throw new WorkspaceError(403, 'NoPermissions');
		}
	}

	return {
		async stat(path) {
			const { info } = await locate(path);
			return describe(info);
		},

		async readDirectory(path) {
			const { target } = await locate(path);
			const entries = await readdir(target, { withFileTypes: true });
			return entries.filter(entry => entry.isFile() || entry.isDirectory())
				.map(entry => ({ name: entry.name, type: entry.isDirectory() ? 2 : 1 }));
		},

		async listFiles(path, pattern, limit) {
			const { target } = await locate(path);
			const files = [];
			const needle = pattern.toLowerCase();
			const pending = [target];
			while (pending.length && files.length < limit) {
				const current = pending.pop();
				if (await realpath(current) !== current) {
					continue;
				}
				for (const entry of await readdir(current, { withFileTypes: true })) {
					const candidate = join(current, entry.name);
					if (entry.isDirectory()) {
						pending.push(candidate);
					} else if (entry.isFile()) {
						const filePath = '/' + relative(root, candidate);
						if (filePath.toLowerCase().includes(needle)) {
							files.push(filePath);
							if (files.length >= limit) {
								break;
							}
						}
					}
				}
			}
			return files;
		},

		async openRead(path) {
			const { target, info } = await locate(path);
			if (!info.isFile()) {
				throw new WorkspaceError(400, 'FileIsADirectory');
			}
			const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const fileStat = await file.stat({ bigint: true });
				return { ...describe(fileStat), stream: range => file.createReadStream(range), close: () => file.close() };
			} catch (error) {
				await file.close();
				throw error;
			}
		},

		async writeFile(path, request, options) {
			const { target } = await locate(path, true);
			requireNonRoot(target);
			const staging = join(uploadDirectory, randomUUID());
			let bytes = 0;
			try {
				await pipeline(Readable.from(request.iterator({ destroyOnReturn: false })), new Transform({
					transform(chunk, encoding, callback) {
						bytes += chunk.length;
						callback(bytes > options.maxBytes ? new WorkspaceError(413, 'FileTooLarge') : null, chunk);
					},
				}), createWriteStream(staging, { flags: 'wx', mode: 0o600 }));
				return await mutate(async () => {
					const { target, info } = await locate(path, true);
					if (info?.isDirectory()) {
						throw new WorkspaceError(400, 'FileIsADirectory');
					}
					if (info && !options.overwrite) {
						throw new WorkspaceError(409, 'FileExists');
					}
					if (info ? options.etag !== describe(info).etag : Boolean(options.etag)) {
						throw new WorkspaceError(412, 'FileChanged');
					}
					if (!info && !options.create) {
						throw new WorkspaceError(404, 'FileNotFound');
					}
					if (info) {
						await chmod(staging, Number(info.mode & 0o777n));
					}
					const file = await open(staging, 'r');
					try {
						await file.sync();
					} finally {
						await file.close();
					}
					if (info) {
						await rename(staging, target);
					} else {
						await link(staging, target);
						await unlink(staging);
					}
					await syncDirectory(dirname(target));
					return { ...describe(await lstat(target, { bigint: true })), created: !info };
				});
			} finally {
				await rm(staging, { force: true });
			}
		},

		createDirectory(path) {
			return mutate(async () => {
				const { target, info } = await locate(path, true);
				if (info?.isDirectory()) {
					return;
				}
				requireNonRoot(target);
				await mkdir(target);
				await syncDirectory(dirname(target));
			});
		},

		rename(from, to, overwrite) {
			return mutate(async () => {
				const { target: source } = await locate(from);
				const { target: destination, info } = await locate(to, true);
				requireNonRoot(source);
				requireNonRoot(destination);
				if (source === destination) {
					return;
				}
				if (isInside(source, destination)) {
					throw new WorkspaceError(400, 'InvalidPath');
				}
				if (info && !overwrite) {
					throw new WorkspaceError(409, 'FileExists');
				}
				await rename(source, destination);
				await syncDirectory(dirname(source));
				if (dirname(destination) !== dirname(source)) {
					await syncDirectory(dirname(destination));
				}
			});
		},

		delete(path, recursive) {
			return mutate(async () => {
				const { target, info } = await locate(path);
				requireNonRoot(target);
				if (!info.isDirectory()) {
					await unlink(target);
				} else if (recursive) {
					await rm(target, { recursive: true });
				} else {
					await rmdir(target);
				}
				await syncDirectory(dirname(target));
			});
		},
	};
}
