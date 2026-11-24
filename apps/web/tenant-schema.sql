-- Tenant mapping for the Web storage layer (docs/multi-tenant.md §3).
--
-- This file is the only part of the tenant model that lives in PostgreSQL. Tenant
-- identity, memberships, invitations and the audit trail stay in the authentication
-- database (`auth.sqlite`), because each of those writes must share a transaction with
-- a better-auth row. What PostgreSQL has to own is the mapping from a storage workspace
-- to its tenant, because that mapping is read by the storage layer on every workspace
-- open and a workspace row that is not mapped must not open at all.
--
-- Additive only: no existing column is altered or dropped, so the previous release
-- package — which knows nothing about tenants — keeps reading and writing the same
-- database during a rollback. The mapping table starts empty, and an empty mapping is
-- exactly the "this release has not been told about tenants yet" state that
-- `tenant-migrate.mjs` resolves by adopting the single legacy tenant.
--
-- `status` mirrors the constraint in auth.sqlite: a workspace whose mapping is not
-- active is invisible to every tenant-scoped entry point, which is how a half-finished
-- cross-database creation (workspace row written, SQLite transaction failed) fails
-- closed instead of exposing an orphan workspace (acceptance case T04).

CREATE TABLE IF NOT EXISTS log4stellar.storage_tenant_map (
	workspace_id text PRIMARY KEY REFERENCES log4stellar.storage_workspaces(id),
	tenant_id text NOT NULL,
	status text NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'failed')),
	created_ms bigint NOT NULL,
	updated_ms bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS storage_tenant_map_tenant_idx
	ON log4stellar.storage_tenant_map (tenant_id, workspace_id);

-- The idempotency ledger for cross-database workspace creation. The primary key is the
-- client's key, so a retried creation resolves to the same pending workspace instead of
-- a second one, and the `operation` column keeps tenant creation and workspace binding
-- from consuming each other's keys.
CREATE TABLE IF NOT EXISTS log4stellar.storage_tenant_intent (
	idempotency_key text PRIMARY KEY,
	operation text NOT NULL,
	tenant_id text NOT NULL,
	workspace_id text NOT NULL,
	state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'committed', 'abandoned')),
	created_ms bigint NOT NULL,
	updated_ms bigint NOT NULL
);
