import { readFileSync } from 'node:fs';
import { openManagedAuth } from './managed-auth.mjs';

const [handle, flag, ...rest] = process.argv.slice(2);
if (!/^[a-z0-9._]{3,30}$/.test(handle ?? '') || (flag && flag !== '--bootstrap-platform') || rest.length) {
	throw new Error('Usage: node apps/web/create-managed-account.mjs <username> [--bootstrap-platform] < password-file');
}
const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
if (password.length < 8 || password.length > 128) {
	throw new Error('The password must be 8–128 characters.');
}
const runtime = await openManagedAuth();
try {
	const id = await runtime.createAccount(handle, password);
	if (flag) {
		await runtime.managedWorkspaces.bootstrapPlatformAdmin(id);
	}
	console.log('Created managed account ' + handle + '.');
} finally {
	await runtime.close();
}
