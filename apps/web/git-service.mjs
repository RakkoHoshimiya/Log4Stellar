// The Git integration backend: the object `authorizeWorkspace()` wraps, and the only place
// that combines the database binding, the local repository and the remote (§2.2). Every
// method name here is listed in workspace-access.mjs `backendMethods`, so the facade gates
// each one with `workspace.git.read` / `.write` / `.admin`; there is no second permission
// check anywhere in this file.
//
// Nothing in this module ever puts a remote URL, a credential or an absolute host path into
// a return value. The binding is described by `remoteId = sha256(url)[0..16]`, and the
// repository path is reported relative to its allowed root (§5.3).

import { createHash, randomBytes } from 'node:crypto';
import { gitError, parseGitRemote, remoteIdentity, displayRepositoryPath, normalizeCheckpointName, requireBranchName, requireCommitSha, requireCredentialKind, gitRoots, locateFileRemote, normalizeGitLimit, gitPageLimits, gitSecretLimit, isCommitSha } from './git-contract.mjs';
import { openGitRepository, readRepositoryState, readStatus, readLog, readCommit, readCommitFiles, readBranches, switchBranch, fetchRemote, pushBranch, branchTrackingState, remoteLabel, runGit } from './git-repository.mjs';
import { openGitStore } from './git-store.mjs';
import { requireGitSecret, sealCredential, openCredential } from './git-credentials.mjs';

/** Notes larger than this are still referenced by revision id, but not digested (§3.4). */
const noteDigestLimit = 8 * 1024 * 1024;

/** Per-workspace serialisation (§5.6): one remote/mutation operation at a time. */
const locks = new Map();

function acquireLock(workspaceId) {
	if (locks.has(workspaceId)) {
		return undefined;
	}
	let release;
	const held = new Promise(resolve => {
		release = () => {
			locks.delete(workspaceId);
			resolve();
		};
	});
	locks.set(workspaceId, held);
	return release;
}

/** Test seam: forget every in-flight lock (never used by production code). */
export function resetGitLocksForTest() {
	locks.clear();
}

export function gitTimeoutMs(environment = process.env) {
	const configured = Number(environment.LOG4STELLAR_GIT_TIMEOUT_MS);
	if (Number.isFinite(configured) && configured >= 1000 && configured <= 600_000) {
		return Math.floor(configured);
	}
	return 60_000;
}

function nowMs() {
	return Date.now();
}

function newId() {
	return randomBytes(16).toString('hex');
}

/**
 * Runs one operation under the workspace lock. A second concurrent operation is refused with
 * `409 RepositoryBusy` instead of queued: a queued push behind a 60 s fetch is indistinguishable
 * from a hang, and the client can retry once it sees a definite answer.
 */
async function withLock(workspaceId, work) {
	const release = acquireLock(workspaceId);
	if (!release) {
		throw gitError('RepositoryBusy');
	}
	try {
		return await work();
	} finally {
		release();
	}
}

/**
 * Creates the backend. Constructing it performs no I/O — that matters because the route
 * handler creates it before it validates anything, and the capability check must be the first
 * thing that can fail.
 */
export function createGitBackend({ workspaceId, actor, storage, environment = process.env }) {
	let storePromise;
	const store = () => {
		storePromise ??= openGitStore(environment).catch(error => {
			storePromise = undefined;
			throw error;
		});
		return storePromise;
	};

	async function binding() {
		const record = await (await store()).readRepository(workspaceId);
		if (!record) {
			throw gitError('RepositoryNotBound');
		}
		return record;
	}

	/**
	 * Re-validates the stored path against the *current* allowlist on every call. The roots
	 * can change under a running server (an operator edits the environment), and a binding
	 * that was legal yesterday must not stay legal after its root was removed (§5.4).
	 */
	async function handle() {
		const record = await binding();
		const roots = await gitRoots(environment, workspaceId);
		let opened;
		try {
			opened = await openGitRepository(record.local_path, roots);
		} catch (error) {
			// The path is gone or no longer a repository: that is a state problem, not a request
			// problem, so it is reported the same way as a missing binding would be — the client
			// must re-bind, and the error says so.
			if (error?.code === 'NotARepository' || error?.code === 'InvalidPath') {
				throw gitError('RepositoryNotBound');
			}
			throw error;
		}
		return { record, handle: opened };
	}

	async function credentialFor(record) {
		if (!record.credential_id) {
			return undefined;
		}
		const stored = await (await store()).readCredential(workspaceId, record.credential_id);
		if (!stored) {
			// The reference is dangling: treat it as an authentication failure rather than as
			// "no credential", so the operation does not silently fall back to an anonymous call.
			throw gitError('RemoteAuthenticationFailed');
		}
		const secret = await requireGitSecret(environment.LOG4STELLAR_STORAGE_CONFIG);
		return { kind: stored.kind, secret: openCredential(secret, { workspaceId, credentialId: stored.credential_id, sealed: stored.sealed }) };
	}

	async function remoteFor(record) {
		if (!record.remote_url) {
			throw gitError('InvalidRemote');
		}
		const roots = await gitRoots(environment, workspaceId);
		// A file remote is only usable when it resolves inside an allowed root; `file:///etc`
		// must not become a readable object store (§5.5). The stored URL was validated when the
		// repository was bound, so a re-validation that now fails means the remote is gone,
		// moved or its symlink was retargeted — a state problem (`502 RemoteUnavailable`), not a
		// malformed request (`400 InvalidPath`). Refusing either way is what matters; the code
		// only tells the client whether re-binding can help.
		let located;
		try {
			located = await locateFileRemote(record.remote_url, roots);
		} catch (error) {
			if (error?.code === 'InvalidPath') {
				throw gitError('RemoteUnavailable');
			}
			throw error;
		}
		return { url: located.kind === 'file' ? located.path : record.remote_url, kind: located.kind, allowFile: located.kind === 'file' };
	}

	function describeRepository(record, state) {
		return {
			remoteId: record.remote_url ? remoteIdentity(record.remote_url) : null,
			remoteKind: record.remote_kind,
			remoteBranch: record.remote_branch,
			defaultBranch: record.default_branch,
			path: displayRepositoryPath(record.repository_root, record.local_path),
			credential: record.credential_id ? { credentialId: record.credential_id } : null,
			lastFetch: record.last_fetch_ms ? { at: Number(record.last_fetch_ms), commit: record.last_fetch_commit } : null,
			lastPush: record.last_push_ms ? { at: Number(record.last_push_ms), commit: record.last_push_commit } : null,
			head: state ? describeHead(state) : null,
		};
	}

	function describeHead(state) {
		return {
			branch: state.branch ?? null,
			detached: state.detached,
			commit: state.commit?.commit ?? null,
		};
	}

	return {
		// ---- read ---------------------------------------------------------
		async gitRepository() {
			let record;
			try {
				record = await binding();
			} catch (error) {
				if (error?.code === 'RepositoryNotBound') {
					return { bound: false, repository: null };
				}
				throw error;
			}
			const { record: bound, handle: opened } = await handle();
			const state = await readRepositoryState(opened);
			return { bound: true, repository: describeRepository(bound, state) };
		},

		async gitStatus() {
			const { record, handle: opened } = await handle();
			const status = await readStatus(opened, { limit: gitPageLimits.maxStatusEntries });
			const state = await readRepositoryState(opened);
			return {
				repository: describeRepository(record, state),
				workTree: {
					clean: status.clean,
					entries: status.entries,
					truncated: status.truncated === true,
				},
				upstream: {
					name: status.upstream ?? null,
					ahead: status.ahead,
					behind: status.behind,
				},
			};
		},

		async gitLog({ limit, branch, commit } = {}) {
			const { handle: opened } = await handle();
			const size = normalizeGitLimit(limit, { fallback: gitPageLimits.defaultLogSize, maximum: gitPageLimits.maxLogSize });
			if (branch !== undefined) {
				requireBranchName(branch);
			}
			if (commit !== undefined) {
				requireCommitSha(commit, 'InvalidCommit');
			}
			const commits = await readLog(opened, { limit: size, branch, commit });
			return { commits };
		},

		async gitBranches() {
			const { handle: opened } = await handle();
			const branches = await readBranches(opened);
			return { branches, current: branches.find(entry => entry.current)?.name ?? null };
		},

		async gitCommit({ commit } = {}) {
			const sha = requireCommitSha(commit, 'InvalidCommit');
			const { handle: opened } = await handle();
			const detail = await readCommit(opened, sha);
			const files = await readCommitFiles(opened, sha, gitPageLimits.maxCommitFiles);
			return { commit: detail, files };
		},

		async gitCheckpoints() {
			const rows = await (await store()).listCheckpoints(workspaceId, 200);
			const checkpoints = await Promise.all(rows.map(row => describeCheckpoint(row)));
			return { checkpoints };
		},

		async gitCredentials() {
			const rows = await (await store()).listCredentials(workspaceId);
			const bindingRow = await (await store()).readRepository(workspaceId);
			return {
				credentials: rows.map(row => ({
					credentialId: row.credential_id,
					kind: row.kind,
					label: row.label,
					createdAt: Number(row.created_ms),
					updatedAt: Number(row.updated_ms),
					inUse: bindingRow?.credential_id === row.credential_id,
				})),
			};
		},

		// ---- remote -------------------------------------------------------
		async gitFetch() {
			return withLock(workspaceId, async () => {
				const { record, handle: opened } = await handle();
				if (!record.remote_url) {
					throw gitError('InvalidRemote');
				}
				const remote = await remoteFor(record);
				const credential = await credentialFor(record);
				// The refspec always lands in refs/remotes/origin/<name>, so the tracked branch is
				// readable afterwards without touching the repository's own config.
				await fetchRemote(opened, {
					url: remote.url,
					credential,
					allowFile: remote.allowFile,
					timeoutMs: gitTimeoutMs(environment),
				});
				const remoteCommit = await refCommit(opened, 'refs/remotes/' + remoteLabel + '/' + record.remote_branch);
				await (await store()).recordFetch(workspaceId, { commit: remoteCommit, now: nowMs() });
				return {
					fetched: true,
					remoteId: remoteIdentity(record.remote_url),
					remoteBranch: record.remote_branch,
					commit: remoteCommit ?? null,
				};
			});
		},

		async gitPush({ branch, expectedRemote, expectedHead, expectedRemoteId } = {}) {
			return withLock(workspaceId, async () => {
				const { record, handle: opened } = await handle();
				if (!record.remote_url) {
					throw gitError('InvalidRemote');
				}
				const state = await readRepositoryState(opened);
				if (state.detached || !state.branch || !state.commit?.commit) {
					// Pushing from a detached HEAD has no defensible target ref.
					throw gitError('BranchNotFound');
				}
				const target = branch === undefined || branch === null ? state.branch : requireBranchName(branch);
				if (target !== state.branch) {
					// The work tree HEAD is what gets pushed; asking for another branch is a caller
					// mistake the user has to fix by switching first.
					throw gitError('InvalidBranch');
				}
				const commit = state.commit.commit;
				if (expectedHead !== undefined && requireCommitSha(expectedHead, 'InvalidCommit') !== commit) {
					throw gitError('HeadChanged');
				}
				if (expectedRemoteId !== undefined && expectedRemoteId !== remoteIdentity(record.remote_url)) {
					throw gitError('RemoteChanged');
				}
				let expected;
				if (expectedRemote !== undefined) {
					expected = expectedRemote === null ? null : requireCommitSha(expectedRemote, 'InvalidCommit');
				}
				const remote = await remoteFor(record);
				const credential = await credentialFor(record);
				const result = await pushBranch(opened, {
					url: remote.url,
					branch: target,
					commit,
					expectedRemote: expected,
					credential,
					allowFile: remote.allowFile,
					timeoutMs: gitTimeoutMs(environment),
				});
				await (await store()).recordPush(workspaceId, { commit, now: nowMs() });
				return {
					pushed: true,
					branch: target,
					commit,
					previousRemoteCommit: result.remote ?? null,
					remoteId: remoteIdentity(record.remote_url),
				};
			});
		},

		// ---- write --------------------------------------------------------
		async gitSwitchBranch({ name, create = false, startPoint } = {}) {
			const branch = requireBranchName(name);
			if (create && startPoint !== undefined) {
				requireCommitSha(startPoint, 'InvalidCommit');
			}
			return withLock(workspaceId, async () => {
				const { record, handle: opened } = await handle();
				const status = await switchBranch(opened, branch, { create, startPoint });
				const state = await readRepositoryState(opened);
				return {
					switched: true,
					repository: describeRepository(record, state),
					workTree: { clean: status.clean, entries: status.entries, truncated: status.truncated === true },
				};
			});
		},

		async gitCreateCheckpoint({ name, note = '', commit, notePath, branch } = {}) {
			const label = normalizeCheckpointName(name);
			if (note !== undefined && (typeof note !== 'string' || note.length > 4000)) {
				throw gitError('InvalidRequest');
			}
			const { record, handle: opened } = await handle();
			const state = await readRepositoryState(opened);
			let commitSha;
			if (commit === undefined || commit === null) {
				if (!state.commit) {
					throw gitError('CommitNotFound');
				}
				commitSha = state.commit.commit;
			} else {
				commitSha = requireCommitSha(commit, 'InvalidCommit');
				await readCommit(opened, commitSha);
			}
			const noteBinding = notePath === undefined || notePath === null ? {} : await bindNote(notePath);
			const row = await (await store()).createCheckpoint({
				workspaceId,
				checkpointId: newId(),
				name: label,
				note: note ?? '',
				commitSha,
				branch: branch === undefined ? state.branch : requireBranchName(branch),
				notePath: notePath ?? null,
				noteRevisionId: noteBinding.revisionId ?? null,
				noteSha256: noteBinding.sha256 ?? null,
				actor,
				now: nowMs(),
			});
			return describeCheckpoint(row);
		},

		async gitDeleteCheckpoint({ checkpointId } = {}) {
			const id = requireCheckpointId(checkpointId);
			const removed = await (await store()).deleteCheckpoint(workspaceId, id);
			if (!removed) {
				throw gitError('CheckpointNotFound');
			}
			return { deleted: true, checkpointId: id };
		},

		// ---- admin --------------------------------------------------------
		async gitBindRepository({ path, remote, remoteBranch, defaultBranch, credentialId } = {}) {
			const roots = await gitRoots(environment, workspaceId);
			const opened = await openGitRepository(path, roots);
			if (opened.bare) {
				// §1.4: a bare repository can be a *remote*, but a workspace is a work tree — the
				// status and branch endpoints are meaningless without one.
				throw gitError('BareRepository');
			}
			const state = await readRepositoryState(opened);
			let remoteKind;
			let remoteIdentityValue;
			let resolvedRemote;
			if (remote === undefined || remote === null || remote === '') {
				// Associating a local repository without a remote is legal: fetch/push then answer
				// 400 InvalidRemote instead of pretending to sync.
				remoteKind = 'file';
				resolvedRemote = undefined;
			} else {
				const parsed = parseGitRemote(remote);
				const located = await locateFileRemote(remote, roots);
				resolvedRemote = located.kind === 'file' ? located.path : parsed.url;
				remoteKind = located.kind;
				remoteIdentityValue = remoteIdentity(resolvedRemote);
			}
			if (credentialId !== undefined && credentialId !== null) {
				const stored = await (await store()).readCredential(workspaceId, String(credentialId));
				if (!stored) {
					throw gitError('InvalidCredential');
				}
			}
			const defaultBranchValue = defaultBranch === undefined || defaultBranch === null
				? (state.branch ?? 'main')
				: requireBranchName(defaultBranch);
			const remoteBranchValue = remoteBranch === undefined || remoteBranch === null
				? defaultBranchValue
				: requireBranchName(remoteBranch);
			const row = await (await store()).bindRepository({
				workspaceId,
				localPath: opened.path,
				repositoryRoot: opened.root,
				defaultBranch: defaultBranchValue,
				remoteUrl: resolvedRemote ?? null,
				remoteKind,
				remoteBranch: remoteBranchValue,
				credentialId: credentialId === undefined || credentialId === null ? null : String(credentialId),
				actor,
				now: nowMs(),
			});
			const fresh = await readRepositoryState(opened);
			return { bound: true, repository: describeRepository(row, fresh) };
		},

		async gitUnbindRepository() {
			const removed = await (await store()).unbindRepository(workspaceId);
			if (!removed) {
				throw gitError('RepositoryNotBound');
			}
			return { unbound: true };
		},

		async gitPutCredential({ credentialId, kind, label, secret } = {}) {
			const resolvedKind = requireCredentialKind(kind);
			if (typeof label !== 'string' || label.trim() === '' || label.length > 120) {
				throw gitError('InvalidCredential');
			}
			if (typeof secret !== 'string' || secret.trim() === '' || secret.length > gitSecretLimit) {
				throw gitError('InvalidCredential');
			}
			const id = credentialId === undefined || credentialId === null ? newId() : requireCredentialId(credentialId);
			const key = await requireGitSecret(environment.LOG4STELLAR_STORAGE_CONFIG);
			const sealed = sealCredential(key, { workspaceId, credentialId: id, plaintext: secret });
			const row = await (await store()).putCredential({
				workspaceId,
				credentialId: id,
				kind: resolvedKind,
				label: label.trim(),
				sealed,
				now: nowMs(),
			});
			return {
				credentialId: row.credential_id,
				kind: row.kind,
				label: row.label,
				createdAt: Number(row.created_ms),
				updatedAt: Number(row.updated_ms),
			};
		},

		async gitDeleteCredential({ credentialId } = {}) {
			const id = requireCredentialId(credentialId);
			const removed = await (await store()).deleteCredential(workspaceId, id);
			if (!removed) {
				throw gitError('NotFound');
			}
			return { deleted: true, credentialId: id };
		},
	};

	/**
	 * Binds a checkpoint to a note file. The digest is computed from the bytes the workspace
	 * serves right now, so the checkpoint records what the user actually saw; the revision id
	 * pins the version. Neither is a foreign key — see docs/git-integration.md §3.4.
	 */
	async function bindNote(notePath) {
		if (typeof notePath !== 'string' || notePath === '') {
			throw gitError('InvalidPath');
		}
		const stat = await storage.stat(notePath);
		if (stat.type !== 1) {
			throw gitError('InvalidPath');
		}
		const revisionId = String(stat.etag ?? '').replaceAll('"', '');
		const readable = await storage.openRead(notePath);
		const hash = createHash('sha256');
		let size = 0;
		try {
			// `stream()` hands back a promise of a stream, so it has to be awaited before it can
			// be consumed (the same shape attachment-versions.test.mjs relies on).
			for await (const chunk of await readable.stream()) {
				size += chunk.length;
				if (size <= noteDigestLimit) {
					hash.update(chunk);
				}
			}
		} finally {
			readable.close?.();
		}
		return { revisionId: revisionId || null, sha256: size <= noteDigestLimit ? hash.digest('hex') : null };
	}

	async function describeCheckpoint(row) {
		const note = row.note_path ? await resolveNote(row) : undefined;
		return {
			checkpointId: row.checkpoint_id,
			name: row.name,
			note: row.note,
			commit: row.commit_sha,
			branch: row.branch,
			createdBy: row.created_by_actor,
			createdAt: Number(row.created_ms),
			noteReference: row.note_path
				? {
					path: row.note_path,
					revisionId: row.note_revision_id,
					sha256: row.note_sha256,
					// The reference is soft (§3.4): the note may have been edited or deleted since,
					// and the checkpoint must still be readable when it has.
					available: note?.available === true,
					currentRevisionId: note?.currentRevisionId ?? null,
					matchesCurrent: note?.matchesCurrent === true,
				}
				: null,
		};
	}

	/**
	 * Compares the recorded revision with what the workspace serves now. A note that no longer
	 * exists, or whose current revision differs, is reported as `available: false` /
	 * `matchesCurrent: false` — never as an error, because the checkpoint itself is still valid.
	 */
	async function resolveNote(row) {
		if (!row.note_path) {
			return { available: false };
		}
		let current;
		try {
			current = await storage.stat(row.note_path);
		} catch {
			return { available: false };
		}
		if (!current || current.type !== 1) {
			return { available: false };
		}
		const currentRevisionId = String(current.etag ?? '').replaceAll('"', '') || null;
		return {
			available: true,
			currentRevisionId,
			matchesCurrent: row.note_revision_id !== null && row.note_revision_id === currentRevisionId,
		};
	}
}

function requireCredentialId(value) {
	if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) {
		throw gitError('InvalidCredential');
	}
	return value;
}

function requireCheckpointId(value) {
	if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) {
		throw gitError('CheckpointNotFound');
	}
	return value;
}

/** Commit a ref points at, or undefined when the ref does not exist (an unborn branch). */
async function refCommit(handle, ref) {
	const result = await runGit(['rev-parse', '--verify', '--quiet', ref + '^{commit}'], { cwd: handle.path });
	const sha = result.stdout.trim();
	return result.code === 0 && isCommitSha(sha) ? sha : undefined;
}

export { branchTrackingState };
