/**
 * Offline status UI (docs/web-offline.md §4).
 *
 * Every function here takes its DOM as an argument and returns plain data. That is the
 * only reason this file can be tested at all: the interesting logic — what state to show,
 * which actions to offer, which sentence to say — is a pure mapping from queue data to a
 * view model, and the rendering is a thin loop over it.
 */

import {
	draftStates,
	opStates,
	opBlockReasons,
	offlineWindowLimits,
} from './offline-contract.js';
import { offlineRetryCeiling } from './offline-coordinator.js';

/**
 * The five things a user can be told about their local work. They are distinct because
 * the ACTIONS differ: "saved locally" needs no action, "pending" needs patience, "conflict"
 * needs a decision, "blocked" needs a sign-in, and "expiring" needs them to come back.
 */
export const offlineStatuses = Object.freeze({
	local: 'local',
	pending: 'pending',
	synced: 'synced',
	conflict: 'conflict',
	blocked: 'blocked',
});

const statusMessages = Object.freeze({
	[offlineStatuses.local]: '已保存在本地浏览器，联网后会提交',
	[offlineStatuses.pending]: '有 N 个改动等待提交',
	[offlineStatuses.synced]: '全部改动已提交',
	[offlineStatuses.conflict]: '有 N 个文件与云端冲突，双方内容都已保留',
	[offlineStatuses.blocked]: '提交已暂停，草稿仍保留在本地',
});

/**
 * Builds the banner view model from the queue, the scope record and the last network
 * result. Precedence is deliberate: conflict beats blocked beats pending, because a
 * conflict needs the user's judgement while a blocked queue only needs a sign-in, and
 * showing "sign in" while a conflict is unresolved would hide the work that is safe.
 */
export function offlineBanner({ operations = [], scopeRecord, online = true, drafts = [], now = Date.now } = {}) {
	const at = typeof now === 'function' ? now() : now;
	const blocked = operations.filter(operation => operation.state === opStates.blocked);
	const pending = operations.filter(operation => operation.state === opStates.pending);
	const failed = operations.filter(operation => operation.state === opStates.failed);
	const conflicts = blocked.filter(operation => operation.blockedReason === opBlockReasons.conflict);
	const conflictDrafts = drafts.filter(draft => draft.state === draftStates.conflict);

	const expired = typeof scopeRecord?.expiresMs === 'number' && at > scopeRecord.expiresMs;
	const locked = scopeRecord?.locked === true;

	let status;
	if (conflicts.length > 0 || conflictDrafts.length > 0) {
		status = offlineStatuses.conflict;
	} else if (locked || expired || failed.length > 0) {
		status = offlineStatuses.blocked;
	} else if (pending.length > 0) {
		status = offlineStatuses.pending;
	} else if (drafts.length > 0) {
		status = offlineStatuses.local;
	} else {
		status = offlineStatuses.synced;
	}

	const count = status === offlineStatuses.conflict
		? Math.max(conflicts.length, conflictDrafts.length)
		: pending.length;

	const actions = [];
	if (status === offlineStatuses.conflict) {
		actions.push('resolve', 'export');
	} else if (status === offlineStatuses.blocked) {
		actions.push('signIn', 'export');
	} else if (status === offlineStatuses.pending) {
		actions.push('retryNow', 'export');
	} else if (status === offlineStatuses.local) {
		actions.push('export');
	}

	return Object.freeze({
		status,
		message: (statusMessages[status] ?? '').replace('N', String(count)),
		count,
		online,
		locked,
		expired,
		lockReason: scopeRecord?.lockReason ?? null,
		expiresMs: scopeRecord?.expiresMs ?? null,
		remainingMs: typeof scopeRecord?.expiresMs === 'number' ? Math.max(0, scopeRecord.expiresMs - at) : null,
		actions: Object.freeze(actions),
	});
}

/**
 * Builds the outbox panel rows. A blocked operation explains WHY in the user's language
 * and keeps its draft reachable: an entry the user cannot act on is worse than no entry.
 */
export function outboxRows({ operations = [] } = {}) {
	const reasons = Object.freeze({
		[opBlockReasons.conflict]: '与云端冲突，草稿已保留',
		[opBlockReasons.noPermission]: '权限已失效，提交暂停',
		[opBlockReasons.resyncRequired]: '需要重新同步后才能提交',
		[opBlockReasons.accountChanged]: '账号已切换，不会跨账号提交',
		[opBlockReasons.offlineExpired]: '离线期限已过，请重新登录',
		[opBlockReasons.dependency]: '同一文件的前序改动未完成',
	});
	return Object.freeze(operations
		.slice()
		.sort((left, right) => left.createdMs - right.createdMs || left.opId.localeCompare(right.opId))
		.map(operation => Object.freeze({
			opId: operation.opId,
			path: operation.path,
			state: operation.state,
			reason: operation.blockedReason ?? null,
			reasonText: operation.blockedReason ? (reasons[operation.blockedReason] ?? operation.blockedReason) : null,
			attempts: operation.attempts,
			attemptLimit: offlineRetryCeiling,
			nearGiveUp: operation.attempts >= offlineRetryCeiling - 2,
			nextRetryAt: operation.nextRetryAt ?? null,
			canRetry: operation.state === opStates.blocked && operation.blockedReason === opBlockReasons.conflict,
			canExport: true,
		})));
}

/**
 * Resolves a pending conflict. The two legal answers are "keep mine" (re-submit the draft
 * on top of the server's current revision) and "keep theirs" (drop the local draft but
 * only after it has been exported or the user has seen it). There is deliberately no
 * third "merge" option: merging Markdown automatically would silently lose formatting and
 * the task book forbids silent overwrites.
 */
export function resolvePendingConflict({ operation, resolution, exported = false } = {}) {
	if (operation?.blockedReason !== opBlockReasons.conflict) {
		return Object.freeze({ ok: false, reason: 'not-a-conflict' });
	}
	if (resolution === 'keep-mine') {
		return Object.freeze({ ok: true, action: 'resubmit', baseRevision: operation.baseRevision, path: operation.path });
	}
	if (resolution === 'keep-theirs') {
		if (!exported) {
			return Object.freeze({ ok: false, reason: 'export-first' });
		}
		return Object.freeze({ ok: true, action: 'discard', path: operation.path });
	}
	return Object.freeze({ ok: false, reason: 'unknown-resolution' });
}

/**
 * The export action. It is offered in every state, including the locked one, because the
 * acceptance criterion for every failure path is "the user can still get their text out".
 */
export function exportPendingDrafts({ drafts = [], now = Date.now } = {}) {
	const at = typeof now === 'function' ? now() : now;
	return Object.freeze({
		count: drafts.length,
		fileName: 'log4stellar-offline-drafts-' + new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z') + '.json',
		documents: Object.freeze(drafts.map(draft => Object.freeze({
			path: draft.path,
			text: draft.text,
			digest: draft.digest,
			baseRevision: draft.baseRevision,
			updatedMs: draft.updatedMs,
			state: draft.state,
		}))),
	});
}

/** Plain-text reminder of the offline window, shown before the user opts in. */
export function offlineWindowNotice(windowMs = offlineWindowLimits.defaultMs) {
	const days = Math.round(windowMs / 86_400_000);
	return '离线改动最多保留 ' + String(days) + ' 天；在此期间不会感知到服务端撤权，重新联网后会重新校验账号与工作区。';
}

/**
 * Renders into a real DOM node. Skipped entirely when the node is absent, so importing
 * this module on the server or in a headless test is harmless.
 */
export function renderOfflineBanner(root, view) {
	if (!root || typeof root.replaceChildren !== 'function') {
		return false;
	}
	const document = root.ownerDocument;
	const element = (tag, className, text) => {
		const node = document.createElement(tag);
		if (className) {
			node.className = className;
		}
		if (text !== undefined) {
			node.textContent = text;
		}
		return node;
	};
	const banner = element('div', 'log4stellar-offline-banner log4stellar-offline-' + view.status, view.message);
	banner.setAttribute('role', 'status');
	banner.dataset.offlineStatus = view.status;
	if (view.actions.length > 0) {
		const actions = element('div', 'log4stellar-offline-actions');
		for (const action of view.actions) {
			const button = element('button', 'log4stellar-offline-action', actionLabel(action));
			button.dataset.offlineAction = action;
			button.type = 'button';
			actions.appendChild(button);
		}
		banner.appendChild(actions);
	}
	root.replaceChildren(banner);
	return true;
}

const actionLabels = Object.freeze({
	resolve: '处理冲突',
	export: '导出草稿',
	signIn: '重新登录',
	retryNow: '立即重试',
});

export function actionLabel(action) {
	return actionLabels[action] ?? action;
}
