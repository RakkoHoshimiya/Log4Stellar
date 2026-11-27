import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { openManagedAuth } from '/opt/log4stellar/release/server/managed-auth.mjs';

const require = createRequire('/opt/log4stellar/release/server/package.json');
const { Client } = require('pg');
const { verify } = require('@node-rs/argon2');
const username = process.argv[2];
const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
const storage = JSON.parse(readFileSync(process.env.LOG4STELLAR_STORAGE_CONFIG, 'utf8'));
const runtime = await openManagedAuth();
const db = new Client(storage.postgres);
try {
	await db.connect();
	const admins = await db.query('SELECT 1 FROM log4stellar.platform_admins LIMIT 1');
	if (admins.rowCount === 0) {
		const { rows: [existing] } = await db.query(`
			SELECT u.id, a.password FROM public."user" u
			LEFT JOIN public.account a ON a."userId"=u.id AND a."providerId"='credential'
			WHERE u.username=$1
		`, [username]);
		if (existing && (!existing.password || !await verify(existing.password, password))) {
			throw new Error('Existing account does not match the first-admin bootstrap credentials');
		}
		const id = existing?.id ?? await runtime.createAccount(username, password);
		await runtime.managedWorkspaces.bootstrapPlatformAdmin(id);
		console.log('Platform administrator initialized');
	} else {
		console.log('Existing platform administration retained');
	}
} finally {
	await db.end().catch(() => {});
	await runtime.close();
}
