import { AsyncLocalStorage } from 'node:async_hooks';

const authIdentifiers = /\b(?:user|twoFactor|twoFactorEnabled|userId|providerId|backupCodes|failedVerificationCount|lockedUntil|expiresAt|createdAt|updatedAt|ipAddress|userAgent|impersonatedBy)\b/g;

function postgresStatement(sql) {
	let index = 0;
	// Runtime SQL is authored in the application. Request data is always bound separately.
	return sql.replace(authIdentifiers, identifier => '"' + identifier + '"')
		.replaceAll('?', () => '$' + ++index);
}

export async function openPostgresAccountSecurity(pool) {
	const connectionScope = new AsyncLocalStorage();
	await pool.query(`
		CREATE TABLE IF NOT EXISTS account_session_factor (
			session_id text PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE
		);
		CREATE TABLE IF NOT EXISTS account_totp_replay (
			user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
			last_used_step bigint NOT NULL,
			updated_at bigint NOT NULL
		);
		CREATE TABLE IF NOT EXISTS account_session_label (
			session_id text PRIMARY KEY,
			user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
			label text NOT NULL,
			updated_at bigint NOT NULL
		);
		CREATE INDEX IF NOT EXISTS account_totp_replay_updated_idx ON account_totp_replay(updated_at);
		CREATE INDEX IF NOT EXISTS account_session_label_user_idx ON account_session_label(user_id);
	`);
	return {
		async hasSecondFactor(sessionId, userId) {
			const { rowCount } = await pool.query(`
				SELECT 1 FROM account_session_factor proof
				JOIN session s ON s.id=proof.session_id
				JOIN "user" u ON u.id=s."userId"
				WHERE s.id=$1 AND u.id=$2 AND u."twoFactorEnabled"=TRUE AND s."expiresAt">now()
			`, [sessionId, userId]);
			return rowCount !== 0;
		},
		prepare(sql) {
			const statement = postgresStatement(sql);
			const query = args => (connectionScope.getStore() ?? pool).query(statement, args);
			return {
				get: async (...args) => (await query(args)).rows[0],
				all: async (...args) => (await query(args)).rows,
				run: async (...args) => ({ changes: (await query(args)).rowCount }),
			};
		},
		async transaction(userId, work) {
			const connection = await pool.connect();
			try {
				await connection.query('BEGIN');
				await connection.query('SELECT pg_advisory_xact_lock(926445023, hashtext($1))', [userId]);
				const result = await connectionScope.run(connection, work);
				await connection.query('COMMIT');
				return result;
			} catch (error) {
				await connection.query('ROLLBACK').catch(() => {});
				throw error;
			} finally {
				connection.release();
			}
		},
	};
}
