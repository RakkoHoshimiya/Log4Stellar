import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	defaultStorageWorkspaceId,
	isValidWorkspaceId,
	resolveWorkspaceId,
	WorkspaceError,
} from './workspace-contract.mjs';

test('a storage workspace ID must be a lowercase slug', () => {
	assert.equal(isValidWorkspaceId('log4stellar-main'), true);
	assert.equal(isValidWorkspaceId('a'), true);
	assert.equal(isValidWorkspaceId('a'.repeat(63)), true);
	for (const value of ['', 'A'.repeat(1), 'Upper', 'a'.repeat(64), '-lead', 'has space', '../etc', 'has_underscore', null, 1, undefined]) {
		assert.equal(isValidWorkspaceId(value), false, String(value));
	}
});

test('the workspace ID resolves from the explicit argument, then the environment, then the default', () => {
	// A backwards-compatible default keeps an existing deployment starting unchanged.
	assert.equal(resolveWorkspaceId({ environment: {} }), defaultStorageWorkspaceId);
	assert.equal(defaultStorageWorkspaceId, 'log4stellar-main');
	assert.equal(resolveWorkspaceId({ environment: { LOG4STELLAR_WORKSPACE_ID: 'team-notes' } }), 'team-notes');
	// An explicit argv value (the RustFS positional argument) wins over the environment.
	assert.equal(resolveWorkspaceId({ explicit: 'cmdline-notes', environment: { LOG4STELLAR_WORKSPACE_ID: 'team-notes' } }), 'cmdline-notes');
	// An empty environment value falls through instead of producing an empty ID.
	assert.equal(resolveWorkspaceId({ environment: { LOG4STELLAR_WORKSPACE_ID: '' } }), defaultStorageWorkspaceId);
});

test('an invalid workspace ID is rejected instead of being silently normalized', () => {
	assert.throws(
		() => resolveWorkspaceId({ environment: { LOG4STELLAR_WORKSPACE_ID: 'Not A Slug' } }),
		/A workspace ID must contain/,
	);
	assert.throws(() => resolveWorkspaceId({ explicit: '../etc' }), /A workspace ID must contain/);
});

test('WorkspaceError carries the status and the machine-readable code', () => {
	const error = new WorkspaceError(403, 'NoPermissions');
	assert.equal(error.status, 403);
	assert.equal(error.code, 'NoPermissions');
	assert.equal(error.message, 'NoPermissions');
	assert.ok(error instanceof Error);
});


test('workbench identities remain distinct when default membership changes', async () => {
  const { workbenchAuthority } = await import('./workspace-contract.mjs');
  assert.equal(workbenchAuthority('owner123', 'main'), 'mount-owner123.main');
  assert.equal(workbenchAuthority('owner123', 'second-notes'), 'mount-owner123.second-notes');
  assert.notEqual(workbenchAuthority('owner123', 'main'), workbenchAuthority('owner123', 'second-notes'));
  assert.throws(() => workbenchAuthority('owner123', '../outside'), TypeError);
});
