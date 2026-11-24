import { openAuth } from './auth.mjs';
import { resolveWorkspaceId } from './workspace-contract.mjs';

const [handle, workspace, ...extra] = process.argv.slice(2);
if (!handle || !/^[a-z\d._]{3,30}$/i.test(handle) || process.stdin.isTTY || extra.length) {
	throw new Error('Usage: pass the password through stdin to node apps/web/create-account.mjs <username> [workspace ID].');
}
// The new account must belong to the workspace the server actually serves, so the
// workspace ID comes from the same precedence the server uses: the positional
// argument, then LOG4STELLAR_WORKSPACE_ID, then the compatible default. With the
// RustFS backend serve-demo.mjs takes its own positional argument as the storage
// workspace ID, so passing the same ID here is what keeps the two in agreement.
const workspaceId = resolveWorkspaceId({ explicit: workspace, environment: process.env });
const source = workspace ? 'the argument' : process.env.LOG4STELLAR_WORKSPACE_ID ? 'LOG4STELLAR_WORKSPACE_ID' : 'the built-in default';
process.stdin.setEncoding('utf8');
let password = '';
for await (const chunk of process.stdin) {
	password += chunk;
	if (password.length > 129) {
		throw new Error('The password is too long.');
	}
}
const { createAccount, database } = await openAuth({ workspaceId });
try {
	await createAccount(handle, password.replace(/\r?\n$/, ''));
	console.log(`Created account ${handle} as an owner of ${workspaceId} (workspace ID from ${source}).`);
	if (source === 'the built-in default') {
		console.error('Warning: neither a workspace argument nor LOG4STELLAR_WORKSPACE_ID was given.');
		console.error(`Start the server with the same workspace ID, for example: node apps/web/serve-demo.mjs ${workspaceId} 18990 <build>`);
	}
} finally {
	database.close();
}
