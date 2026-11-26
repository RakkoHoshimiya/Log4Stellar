CREATE SEQUENCE IF NOT EXISTS log4stellar.managed_member_version AS integer;

CREATE TABLE IF NOT EXISTS log4stellar.platform_admins (
    user_id text PRIMARY KEY REFERENCES public."user"(id)
);

CREATE TABLE IF NOT EXISTS log4stellar.managed_tenants (
    id text PRIMARY KEY,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 128),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS log4stellar.managed_tenant_members (
    tenant_id text NOT NULL REFERENCES log4stellar.managed_tenants(id),
    user_id text NOT NULL REFERENCES public."user"(id),
    role smallint NOT NULL CHECK (role IN (1, 2)),
    version integer NOT NULL DEFAULT nextval('log4stellar.managed_member_version') CHECK (version > 0),
    PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS log4stellar.managed_workspaces (
    id text PRIMARY KEY REFERENCES log4stellar.storage_workspaces(id),
    tenant_id text NOT NULL REFERENCES log4stellar.managed_tenants(id),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 128),
    UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS log4stellar.managed_workspace_members (
    tenant_id text NOT NULL,
    workspace_id text NOT NULL,
    user_id text NOT NULL,
    role smallint NOT NULL CHECK (role IN (1, 2, 3)),
    version integer NOT NULL DEFAULT nextval('log4stellar.managed_member_version') CHECK (version > 0),
    PRIMARY KEY (workspace_id, user_id),
    FOREIGN KEY (tenant_id, workspace_id) REFERENCES log4stellar.managed_workspaces(tenant_id, id),
    FOREIGN KEY (tenant_id, user_id) REFERENCES log4stellar.managed_tenant_members(tenant_id, user_id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS managed_workspace_members_user_idx
    ON log4stellar.managed_workspace_members(user_id, workspace_id);

CREATE TABLE IF NOT EXISTS log4stellar.managed_audit (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id text NOT NULL REFERENCES log4stellar.managed_tenants(id),
    actor_id text NOT NULL REFERENCES public."user"(id),
    action text NOT NULL,
    target text NOT NULL,
    detail jsonb,
    at_ms bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS managed_audit_tenant_idx
    ON log4stellar.managed_audit(tenant_id, id DESC);

CREATE TABLE IF NOT EXISTS log4stellar.managed_operations (
    actor_id text NOT NULL REFERENCES public."user"(id),
    operation text NOT NULL,
    request_key text NOT NULL,
    fingerprint text NOT NULL,
    result jsonb NOT NULL,
    PRIMARY KEY (actor_id, operation, request_key)
);

CREATE TABLE IF NOT EXISTS log4stellar.managed_invitations (
    id text PRIMARY KEY,
    tenant_id text NOT NULL REFERENCES log4stellar.managed_tenants(id),
    email text NOT NULL,
    role smallint NOT NULL CHECK (role IN (1, 2)),
    token_digest text NOT NULL UNIQUE,
    expires_ms bigint NOT NULL,
    used_at timestamptz,
    revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS log4stellar.managed_tenant_security (
    tenant_id text PRIMARY KEY REFERENCES log4stellar.managed_tenants(id),
    require_second_factor boolean NOT NULL,
    version integer NOT NULL DEFAULT nextval('log4stellar.managed_member_version') CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS log4stellar.managed_workspace_moves (
    id uuid PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES log4stellar.managed_workspaces(id),
    source_tenant_id text NOT NULL REFERENCES log4stellar.managed_tenants(id),
    target_tenant_id text NOT NULL REFERENCES log4stellar.managed_tenants(id),
    moved_at timestamptz NOT NULL DEFAULT now()
);
