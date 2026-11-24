import { realpath, stat } from 'node:fs/promises';
import { openAuth } from './auth.mjs';
import { isInside } from './local-workspace.mjs';
import { resolveWorkspaceId, workspaceUploadLimit } from './workspace-contract.mjs';
import { openRustfsWorkspace } from './rustfs-workspace.mjs';
import { workspaceRoles } from './workspace-access.mjs';

const usage = 'Usage: node apps/web/import-workspace.mjs <source folder> <new workspace ID> [--owner <username>]';
const [source, workspaceId, ...options] = process.argv.slice(2);
let owner;
for (let index = 0; index < options.length; index += 2) {
	if (options[index] !== '--owner' || options[index + 1] === undefined || index + 2 !== options.length) {
		throw new Error(usage);
	}
	owner = options[index + 1];
}
if (!source || !workspaceId) {
	throw new Error(usage);
}
const root = await realpath(source);
if (!(await stat(root)).isDirectory()) {
	throw new Error('The import source must be a directory.');
}
for (const file of [
	process.env.LOG4STELLAR_STORAGE_CONFIG,
	process.env.LOG4STELLAR_AUTH_DIR,
	process.env.LOG4STELLAR_TLS_KEY,
].filter(Boolean)) {
	if (isInside(root, await realpath(file))) {
		throw new Error('Keep storage credentials, authentication files and TLS keys outside the import folder.');
	}
}
const destination = await openRustfsWorkspace(workspaceId, { importing: true });
try {
	const counts = await destination.importDirectory(root, workspaceUploadLimit());
	console.log(JSON.stringify({ workspaceId, ...counts }));
} finally {
	await destination.close();
}
// A freshly imported workspace has no members, and a server started on it answers every
// request with 403. Granting the first owner here turns the documented import step into
// something an operator can complete on its own.
if (owner) {
	// The database is opened on the workspace this deployment serves, and the imported
	// workspace is only the target of the membership write. Opening it on the imported
	// workspace would make that brand-new workspace the owner of the placeholder rows of
	// a historical database, which is a decision this command has no business taking.
	const deploymentWorkspaceId = resolveWorkspaceId({ environment: process.env });
	const account = await openAuth({ workspaceId: deploymentWorkspaceId });
	try {
		account.addMember(account.resolveMemberId(owner), workspaceRoles.owner, workspaceId);
		console.log(`Added ${owner} to ${workspaceId} as owner.`);
	} finally {
		account.database.close();
	}
} else {
	console.error(`The workspace ${workspaceId} has no members yet. Add one with:`);
	console.error(`  node apps/web/workspace-members.mjs add <username> --role owner --workspace ${workspaceId}`);
}
