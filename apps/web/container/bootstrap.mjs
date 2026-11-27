import { pbkdf2Sync, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { chown, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('/opt/log4stellar/release/server/package.json');
const { Client } = require('pg');
const { CreateBucketCommand, HeadBucketCommand, S3Client } = require('@aws-sdk/client-s3');
export const webUid = 18023;
export const objectUid = 18022;

export function randomSecret() {
	return randomBytes(32).toString('hex');
}

export async function readJson(path) {
	try {
		return JSON.parse(await readFile(path, 'utf8'));
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
}

export async function writePrivate(path, contents, uid = 0) {
	const temporary = join(dirname(path), '.' + randomUUID());
	try {
		const handle = await open(temporary, 'wx', 0o600);
		try {
			await handle.writeFile(contents);
			await handle.chown(uid, uid);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
		const parent = await open(dirname(path), 'r');
		try {
			await parent.sync();
		} finally {
			await parent.close();
		}
	} finally {
		await rm(temporary, { force: true });
	}
}

export async function newInstance(statePath, pgVersion, requireExisting) {
	const saved = await readJson(statePath);
	if (saved) {
		if (saved.format !== 1 || saved.pgVersion !== pgVersion ||
			![saved.postgres, saved.application, saved.rustfsAdmin, saved.rustfsApplication].every(value => /^[a-f0-9]{64}$/.test(value))) {
			throw new Error('Instance bootstrap state is incompatible with the image');
		}
		return saved;
	}
	if (requireExisting) throw new Error('Database or object storage already exists without instance bootstrap state');
	const state = {
		format: 1, pgVersion,
		postgres: randomSecret(), application: randomSecret(), rustfsAdmin: randomSecret(), rustfsApplication: randomSecret(),
	};
	await writePrivate(statePath, JSON.stringify(state) + '\n');
	return state;
}

export function storageSettings(state) {
	return {
		postgres: { host: '127.0.0.1', port: 5432, database: 'log4stellar', user: 'log4stellar_app', password: state.application },
		s3: { endpoint: 'http://127.0.0.1:9000', region: 'us-east-1', bucket: 'log4stellar',
			accessKeyId: 'stellarapp', secretAccessKey: state.rustfsApplication },
	};
}

export function embeddedDatabaseAdmin(state) {
	return { host: '127.0.0.1', port: 5432, database: 'postgres', user: 'postgres', password: state.postgres };
}

function scramVerifier(password) {
	const salt = randomBytes(16);
	const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
	const clientKey = createHmac('sha256', salted).update('Client Key').digest();
	const stored = createHash('sha256').update(clientKey).digest('base64');
	const server = createHmac('sha256', salted).update('Server Key').digest('base64');
	return ['SCRAM-SHA-256$4096:', salt.toString('base64'), '$', stored, ':', server].join('');
}

async function withPg(settings, work) {
	const client = new Client({ ...settings, connectionTimeoutMillis: 2500, statement_timeout: 5000 });
	try {
		await client.connect();
		return await work(client);
	} finally {
		await client.end().catch(() => {});
	}
}

export async function prepareDatabase(state, storage) {
	await withPg(embeddedDatabaseAdmin(state), async client => {
		const role = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [storage.postgres.user]);
		if (!role.rowCount) {
			const password = client.escapeLiteral(scramVerifier(state.application));
			await client.query('CREATE ROLE log4stellar_app LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB PASSWORD ' + password);
		}
		const existing = await client.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1', [storage.postgres.database]);
		if (existing.rowCount === 0) {
			await client.query('CREATE DATABASE log4stellar OWNER log4stellar_app');
		} else if (existing.rows[0].owner !== storage.postgres.user) {
			throw new Error('Existing standalone database is owned by a different role');
		}
	});
}

export function probeDatabase(settings) {
	return withPg(settings, async client => {
		const { rows: [row] } = await client.query("SELECT has_database_privilege(current_database(), 'CREATE') AS schemas, has_schema_privilege('public', 'CREATE') AS auth");
		if (!row.schemas || !row.auth) throw new Error('PostgreSQL role cannot create the application schema and authentication tables');
	});
}

function objectClient(s3) {
	return new S3Client({ endpoint: s3.endpoint, region: s3.region ?? 'us-east-1', forcePathStyle: true, maxAttempts: 1,
		credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey } });
}

export async function probeObjects(s3) {
	const client = objectClient(s3);
	try {
		await client.send(new HeadBucketCommand({ Bucket: s3.bucket }), { abortSignal: AbortSignal.timeout(3500) });
	} finally {
		client.destroy();
	}
}

export async function prepareObjects(state, storage, exec) {
	const settings = { ...storage.s3, accessKeyId: 'stellarsystem', secretAccessKey: state.rustfsAdmin };
	const admin = objectClient(settings);
	try {
		try {
			await admin.send(new HeadBucketCommand({ Bucket: settings.bucket }), { abortSignal: AbortSignal.timeout(3500) });
		} catch (error) {
			if (error.$metadata?.httpStatusCode !== 404) throw error;
			await admin.send(new CreateBucketCommand({ Bucket: settings.bucket }), { abortSignal: AbortSignal.timeout(3500) });
		}
	} finally {
		admin.destroy();
	}
	const policy = {
		Version: '2012-10-17',
		Statement: [
			{ Effect: 'Allow', Action: ['s3:ListBucket', 's3:GetBucketLocation'], Resource: ['arn:aws:s3:::log4stellar'] },
			{ Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: ['arn:aws:s3:::log4stellar/tenants/*'] },
		],
	};
	async function request(path, body) {
		const input = [
			'url = ' + JSON.stringify(settings.endpoint + '/rustfs/admin/v3/' + path),
			'user = ' + JSON.stringify(settings.accessKeyId + ':' + settings.secretAccessKey),
			'aws-sigv4 = "aws:amz:us-east-1:s3"', 'request = "PUT"', 'header = "Content-Type: application/json"',
			...(body ? ['data = ' + JSON.stringify(JSON.stringify(body))] : []),
		].join('\n') + '\n';
		await exec('curl', ['--config', '-', '--silent', '--show-error', '--fail', '--max-time', '12'], { input });
	}
	await request('add-canned-policy?name=stellar-workspaces', policy);
	await request('add-user?accessKey=stellarapp', { secretKey: state.rustfsApplication, status: 'enabled' });
	await request('set-user-or-group-policy?policyName=stellar-workspaces&userOrGroup=stellarapp&isGroup=false');
}

export async function seedAdmin(webEnv, password, username, exec) {
	const pending = '/data/config/platform-bootstrap.json';
	const done = await readJson(pending);
	if (done?.complete || !password) return;
	const existing = await readJson(pending);
	if (existing && existing.username !== username) throw new Error('Resume first-admin setup with the original username');
	// Reserve the request before opening the application or creating the user.
	if (!existing) await writePrivate(pending, JSON.stringify({ username }) + '\n');
	await exec('gosu', ['stellar', 'node', '/opt/log4stellar/container/seed-admin.mjs', username], { env: webEnv, input: password });
	await writePrivate(pending, JSON.stringify({ username, complete: true }) + '\n');
}

export async function privateDirectory(path, uid) {
	await mkdir(path, { recursive: true, mode: 0o700 });
	if (!(await lstat(path)).isDirectory()) throw new Error('Persistent service path must be a real directory: ' + path);
	// Each service receives access to its own mount, without chown on its contents.
	await chown(path, uid, uid);
}
