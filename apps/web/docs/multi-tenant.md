# 多租户契约（v1）

本文件是「多租户管理」任务的契约。任何实现与测试必须以本文件的判据为准；如需修改契约，先改本文件再改代码。

本文件描述的是**已合入的现状**，不是提案：`tenant-store.mjs`、`tenant-service.mjs`、`tenant-files.mjs`、`tenant-migrate.mjs` 与 `tenant.test.mjs`（43 个用例）一一对应下文各节。

## 1. 为什么要分两个库

租户身份、成员、邀请、审计放在 `auth.sqlite`；PostgreSQL 只存「工作区 → 租户」映射。

这不是随手选的。租户的每一次写都发生在某个会话的上下文里：接受邀请要同时写成员行和会话行，签发邀请要记审计。这些行在同一个 SQLite 事务里才能保证「邀请被消费了但成员没建」不可达；如果成员在 SQLite、审计在 PostgreSQL，那么两台库之间任意一次失败都会留下一个没法解释的状态。这条理由和 `account-security-ddl.mjs` 把二次验证表放在 `auth.sqlite` 的理由是同一条。

反过来，「工作区属于哪个租户」必须能被存储层读到——`storage_entries` 那一侧要做跨租户隔离，而它只连 PostgreSQL。所以映射单独放 PostgreSQL，并且**只放映射**。

| 数据 | 位置 | 理由 |
|---|---|---|
| `tenant`、`tenant_member`、`tenant_invitation`、`tenant_audit`、`tenant_idempotency` | `auth.sqlite` | 与会话/成员同事务 |
| `log4stellar.storage_tenant_map` | PostgreSQL | 存储层判隔离时要读 |
| `log4stellar.storage_tenant_intent` | PostgreSQL | 跨库创建的幂等账本 |

## 2. 身份与角色

两层角色，互不推导：

| 层 | 角色 | 等级 | 管什么 |
|---|---|---|---|
| 租户 | `tenant_member`（普通成员） | 1 | 看自己属于哪些租户 |
| 租户 | `tenant_admin`（管理员） | 2 | 成员、邀请、审计 |
| 工作区 | `viewer` / `editor` / `owner` | 1 / 2 / 3 | 见 `workspace-access.md` §2 |

**关键约束一：租户管理员不等于工作区成员。** 租户管理员是「管人」的，不是「看别人笔记」的。一个租户管理员如果不在某个工作区的成员表里，读那个工作区的任何内容都返回 403。这样审计记录里才会出现一条真实的工作区成员关系，也才能回答「谁在什么时候读了这个文件」。

**关键约束二：工作区 owner 不等于租户管理员。** 一个 owner 可以读写自己工作区里的一切，但调 `/api/v1/tenants/:id/members` 会拿到 403。两层各自有各自的判据，任何一层都不因为另一层的高权限而放行。

`workspace_member.tenant_id` 从本次发布之前就存在，历史行里全是字面量 `'default'`。`legacyTenantId = 'default'` 就是这个发布继承下来的单工作区部署的租户名。迁移用 `seedLegacyTenant()` 建出对应的一行，而不是另造一个 ID——另造 ID 会让历史成员关系指向一个不存在的租户。

**播种是增量的，不是一次性的。** 全新部署的实际启动顺序是：`create-account.mjs` 先 `openAuth()`，此时 `user` 表是空的，所以播种拿到的管理员列表也是空的，只建出 `tenant` 行。账号随后才被创建。如果播种在「租户已存在」时直接返回，那么这个创建出来的账号会是工作区 owner、但不是租户成员，`GET /api/v1/tenants` 对全系统唯一的运维账号永远返回 `{"tenants":[]}`——部署自己把自己锁在管理面之外。所以第一次 `openAuth()` 建租户行，之后每次 `openAuth()` 以及 `createAccount()` 都会用 `INSERT OR IGNORE` 把「当前工作区的 owner」补进 `tenant_member`：已有行（任何角色）优先，所以这既不会重复插入，也不会把运维手工降级过的管理员重新提权。

## 3. 邀请

- 邀请里**只存 token 的 sha256**（`token_digest`），明文 token 只在签发响应里出现一次。这条表会进每一次认证库备份，备份不能变成一叠能用的邀请链接。
- 有效期默认 7 天，上限 30 天。超过上限是 400 `InvalidInvitationLifetime`，不是截断。
- 消费是单次的，靠 `UPDATE ... WHERE id = ? AND accepted_ms IS NULL AND revoked_ms IS NULL AND expires_ms > ?` 加 `changes === 1`，并且在同一个事务里插入成员行。
- **已用、已过期、已撤销、根本不存在，四种情况返回同一个 404。** 用「已经用过了」来回应会确认这个 token 曾经有效，这就把一次猜测变成了一个可以放大利用的信号。
- 已经在该租户里的成员消费第二张邀请，成员行是 `INSERT OR IGNORE`：不重复、也不会被邀请里写的角色悄悄改掉。

## 4. 并发与顺序

| 场景 | 保证 | 手段 |
|---|---|---|
| 两个请求同时降级仅剩的两个管理员 | 至多一个成功，至少留一个管理员 | 管理员计数在同一个 `BEGIN IMMEDIATE` 里读，第二个请求看见第一个的提交（T03） |
| 客户端拿旧版本号改角色 | 409 `VersionConflict` | `tenant_member.version` 乐观并发，`UPDATE ... WHERE version = ?` |
| 同一 idempotency key 重试建租户 | 返回第一次建的租户，`created: false` | `tenant_idempotency` 主键，与插入同事务 |
| 跨库创建第二步失败 | 租户行保留，返回 503 `TenantMappingFailed`，同 key 重试可收敛 | 先写 SQLite 再写 PostgreSQL，失败不回滚已建租户（T04） |

分页一律 keyset（`user_id` 升序、审计 `id` 降序），不用 `OFFSET`：成员列表在翻页途中有人加入时，`OFFSET` 会重复或漏掉一个成员，而成员列表恰恰是被用来发现「谁不该在这里」的。

## 5. 四种合取：`resolveTenantScope`

```js
const scope = await resolveTenantScope({ store, readWorkspaceMapping, principalId, tenantId, workspaceId, capability, resolveWorkspaceRole });
```

按顺序四步，任一步失败即拒：

1. **租户成员关系有效**。租户不存在、不是成员、租户被挂起——三者回答同一个 404。
2. **工作区映射到本租户且状态为 `active`**。未映射、映射到别的租户、`pending`、`failed`——全部 404，不是 403。403 会告诉调用方「这个工作区存在但不在你的租户里」，那就是一个跨租户存在性探测口（T01）。
3. **调用方持有工作区角色**。没有就是 403——此时调用方已经证明了它属于这个租户，指出缺哪项权限不再泄漏新信息。
4. **该角色授予所需 capability**。

两个 capability 词表不能混用。`tenant.read` / `tenant.admin` 属于租户层，`workspace.*` 属于工作区层。`resolveTenantScope` 由调用形状推导词表：不传 `workspaceId` 就是租户作用域，默认 `tenant.read`；传了 `workspaceId` 就是工作区作用域，默认 `workspace.read`。传错词表抛 `TypeError` 而不是返回 403——租户 capability 在每一个工作区角色眼里都是不持有的，静默 403 会让下一个人去找一个不存在的权限，而不是那行写错的常量。

返回的 scope 是冻结对象，`workspaceId` 在租户作用域下**显式存在且为 `null`**，不是缺键：缺键会让解构方把「没有限制」和「没有这个字段」混为一谈。

## 6. 请求面清单

每个读或写租户内容的面，以及它解析成什么。缺一个就是有人还没对它做决定：

| 面 | 解析为 | 需要租户门 |
|---|---|:--:|
| `/static/mount` | 每请求解析工作区角色 | ✅ |
| `/sync/v1` | 每请求解析工作区角色 | ✅ |
| `/git/v1` | 每请求解析工作区角色 | ✅ |
| `/api/search` | 每请求解析工作区角色 | ✅ |
| `/api/v1/office-previews` | 每请求解析工作区角色 | ✅ |
| `/api/v1/tenants` | 租户作用域 | ✅ |
| `/api/session` | 只有会话，无租户内容 | ❌ |

租户 API 挂载在 `auth-gateway.mjs` 里，并且**自动**继承了账户安全层对「非 `full` 会话」的拒绝（`account-security.mjs` 的 `surfaceForPath` 把未知路径归到 `notes` 面，只有完整会话才能 `serve`）。也就是说二次验证未完成的半登录态，连租户列表都读不到。

## 7. 错误码

响应体一律 `{ error: <code> }`，不带 message、不带 requestId 以外的东西。

| HTTP | code | 含义 |
|---|---|---|
| 400 | `InvalidTenantId` / `InvalidTenantName` / `InvalidTenantRole` / `InvalidEmail` / `InvalidInvitationToken` / `InvalidInvitationLifetime` / `InvalidVersion` / `InvalidWorkspaceId` | 入参不合法 |
| 403 | `NoPermissions` | 已确认属于该租户，但缺这项权限 |
| 404 | `NotFound` | 租户/成员/邀请/工作区不存在**或不属于你**（刻意合并） |
| 409 | `TenantExists` / `InvitationExists` / `InvitationNotPending` / `VersionConflict` / `LastAdmin` | 状态冲突 |
| 415 | `InvalidContentType` | 非 `application/json` |
| 503 | `TenantMappingFailed` | 跨库创建第二步失败，可用同 key 重试 |

## 8. 验收

| 编号 | 场景 | 判据 |
|---|---|---|
| T01 | 跨租户访问对象与审计 | 403 或统一 404（响应体、对象凭据、计数都不能区分）；`tenant.test.mjs` 里两条「答案完全一致」用例 |
| T02 | 邀请重复接受 | 恰好一条成员关系；第二次 404 |
| T03 | 并发移除仅剩的两个管理员 | 至少留一个；第二个请求 409/403 |
| T04 | PostgreSQL 工作区建了、SQLite 写失败 | 工作区不可访问（映射 `pending` ⇒ 404）；同 key 重试或补偿可收敛 |

## 9. 已知未做

- **成员管理没有 HTTP 入口之外的管理界面**。本篇只做契约与判据；租户切换、成员页、邀请页、审计页属于阶段 4，尚未实现（`tenantSurfaceManifest` 里 `/api/v1/tenants` 已经是它们的服务端）。
- **`storage_tenant_map` 尚未被存储层真正用于过滤**。本发布里 workspace 级隔离仍由 `workspace-access.mjs` 的角色承担；租户映射是判据来源，但 `storage_entries` 的查询还没按租户加条件。加之前必须先补「按租户压测」——见 `performance-capacity.md`。
- **挂起租户的计费语义未定**。当前实现是「挂起即不可见」，没有宽限期也没有数据保留期。
