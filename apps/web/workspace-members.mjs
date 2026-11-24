import { legacyWorkspace, openAuth } from './auth.mjs';
import { workspaceRoles } from './workspace-access.mjs';
import { isValidWorkspaceId } from './workspace-contract.mjs';

const usage = `Usage: node apps/web/workspace-members.mjs <command> [options]

Commands:
  list [--workspace <id>]                     List the members of one workspace.
  workspaces                                  List every workspace that has members.
  add <username> [--role owner|editor|viewer] [--workspace <id>]
  set-role <username> --role owner|editor|viewer [--workspace <id>]
  remove <username> [--workspace <id>]

--workspace selects the storage workspace whose members are read or changed. It
defaults to the workspace this deployment serves: LOG4STELLAR_WORKSPACE_ID, then
the built-in default. The placeholder workspace ${legacyWorkspace} is not a storage
workspace and cannot be passed here.`;

const [command, ...rest] = process.argv.slice(2);
const commands = new Set(['list', 'workspaces', 'add', 'set-role', 'remove']);
const readOnlyCommands = new Set(['list', 'workspaces']);
const writeCommands = new Set(['add', 'set-role', 'remove']);
const roleNames = Object.fromEntries(Object.entries(workspaceRoles).map(([name, level]) => [level, name]));

function parseOptions(values) {
	const options = { workspace: undefined, role: undefined, positional: [] };
	for (let index = 0; index < values.length; index++) {
		const value = values[index];
		if (value === '--workspace' || value === '--role') {
			const next = values[index + 1];
			if (next === undefined) {
				throw new Error('Missing value for ' + value + '.');
			}
			options[value.slice(2)] = next;
			index++;
		} else if (value.startsWith('--')) {
			throw new Error('Unknown option ' + value + '.');
		} else {
			options.positional.push(value);
		}
	}
	return options;
}

function parseRole(name, required) {
	if (name === undefined) {
		if (required) {
			throw new Error('This command needs --role owner, editor or viewer.');
		}
		return undefined;
	}
	if (!Object.hasOwn(workspaceRoles, name)) {
		throw new Error('--role must be one of owner, editor or viewer.');
	}
	return workspaceRoles[name];
}

/**
 * A member row for a workspace the storage backend has never created logs the account
 * in and then answers every mount with 403, because the gateway opens the backend
 * before it looks at the role. The row is therefore only written for a workspace that
 * exists (contract §7.1). The local backend has no workspace registry: it serves the
 * one directory it was started with and `LOG4STELLAR_STORAGE_CONFIG` is unset.
 */
async function requireStorageWorkspace(target) {
	if (!process.env.LOG4STELLAR_STORAGE_CONFIG) {
		return;
	}
	const { rustfsWorkspaceExists } = await import('./rustfs-workspace.mjs');
	if (!(await rustfsWorkspaceExists(target))) {
		throw new Error('The workspace ' + target + ' has not been imported. Create it with apps/web/import-workspace.mjs, then add its members.');
	}
}

if (command === undefined || command === '--help') {
	console.log(usage);
	process.exitCode = command === undefined ? 1 : 0;
} else if (!commands.has(command)) {
	throw new Error('Unknown command ' + command + '.\n\n' + usage);
} else {
	// Everything that can be rejected from argv alone is rejected before the database
	// is opened, so a typo cannot reach the migration at all.
	const options = parseOptions(rest);
	const targetFlag = options.workspace;
	if (targetFlag === legacyWorkspace) {
		throw new Error('--workspace must name a storage workspace: the rollback placeholder row ' + legacyWorkspace + ' is never edited as a workspace.');
	}
	if (targetFlag !== undefined && !isValidWorkspaceId(targetFlag)) {
		throw new Error('--workspace must be a lowercase storage workspace ID.');
	}
	if (writeCommands.has(command) && options.positional.length !== 1) {
		throw new Error('Pass exactly one username.');
	}
	const role = command === 'add' || command === 'set-role' ? parseRole(options.role, command === 'set-role') : undefined;
	// Reading must never adopt: adoption is the one-time binding of a historical
	// database to a workspace (contract §7.1), and a command that was asked to list
	// rows must not take that decision. Writing is an explicit administrative act on
	// this deployment's database, so it keeps adopting: the operator's first `add` on
	// a freshly upgraded database is what turns the historical accounts into members.
	const account = await openAuth({ adopt: !readOnlyCommands.has(command) });
	try {
		// The target workspace is NOT the workspace this deployment serves: openAuth is
		// always opened on the deployment workspace so that its placeholder-row guards
		// stay reachable. Only the member operations see `target`.
		const target = targetFlag ?? account.workspaceId;
		switch (command) {
			case 'workspaces': {
				for (const row of account.listWorkspaces()) {
					console.log(row.workspaceId + '\t' + row.members + ' member(s)');
				}
				break;
			}
			case 'list': {
				const members = account.listMembers(target);
				if (!members.length) {
					console.log('No members in ' + target + '.');
				}
				for (const member of members) {
					console.log([member.username ?? member.userId, member.userId, roleNames[member.role]].join('\t'));
				}
				break;
			}
			case 'add': {
				await requireStorageWorkspace(target);
				const userId = account.resolveMemberId(options.positional[0]);
				account.addMember(userId, role ?? workspaceRoles.viewer, target);
				console.log('Added ' + options.positional[0] + ' to ' + target + ' as ' + roleNames[role ?? workspaceRoles.viewer] + '.');
				break;
			}
			case 'set-role': {
				await requireStorageWorkspace(target);
				const userId = account.resolveMemberId(options.positional[0]);
				const changes = account.setMemberRole(userId, role, target);
				console.log(changes === 0 ? 'No membership to update in ' + target + '.' : 'Set ' + options.positional[0] + ' to ' + roleNames[role] + ' in ' + target + '.');
				break;
			}
			case 'remove': {
				await requireStorageWorkspace(target);
				const userId = account.resolveMemberId(options.positional[0]);
				const changes = account.removeMember(userId, target);
				console.log(changes === 0 ? 'No membership to remove in ' + target + '.' : 'Removed ' + options.positional[0] + ' from ' + target + '.');
				break;
			}
		}
	} finally {
		account.database.close();
	}
}
