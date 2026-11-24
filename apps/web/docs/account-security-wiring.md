# 账户安全与双因素登录：接线方案

本文件是 `apps/web/docs/account-security.md`（设计契约，下称"契约"）的接线实施计划。
契约描述**行为**，本文件描述**代码落点**：每个判权点在哪一行、DDL 在哪跑、回滚时会发生什么。
两者冲突时契约优先；本文件第 8 节记录实施中发现契约有误或不可实现的地方。

## 1. 现状与缺口

契约三件套（`docs/account-security.md`、`account-security.mjs`、`account-security.test.mjs`）
已经在 HEAD 里，但**没有任何运行时消费者**：

| 模块 | 现状 | 缺口 |
|---|---|---|
| `account-security.mjs` | 纯校验/编码模块，只 import `node:crypto` | 无 DDL 执行器（本批已补，见 §2） |
| `auth.mjs` | 注册 `username()` + `admin()` | 未注册 `twoFactor()`，`auth.sqlite` 里没有 `twoFactor` 表与 `user.twoFactorEnabled` 列 |
| `auth-gateway.mjs` | 只认识 `mounted`/`api`/`login`/`workbench` 四类路径 | `/api/auth/*`、`/api/account-security/*`、`/sync/v1/*` 全部从逃生口直通下游 |
| `session-client.js` | 403 → `/login` | 分不清 `TwoFactorPending` 与普通 403 |
| `login-page.mjs` | 只有账号/密码两栏 | 无验证码输入态、无恢复码入口 |

**结构性事实**（不要推翻）：半认证态 = `session` 表没有行。
`better-auth/dist/plugins/two-factor/index.mjs:338-345` 在密码通过后主动
`deleteSessionCookie(ctx, true)` + `internalAdapter.deleteSession(data.session.token)` +
`ctx.context.setNewSession(null)`，再返回 `200 {twoFactorRedirect: true}` 并下发 600 秒的
`two_factor` cookie。所以"密码通过但没做二验就永远读不到笔记"由数据结构保证，
**不需要**`two_factor_pending` 列，**不要**改 better-auth。

## 2. DDL 落点：`account-security-ddl.mjs`

新增模块 `apps/web/account-security-ddl.mjs`，导出两个函数：

```
accountSchemaCurrent(database) -> { replayTable, replayIndex, twoFactorTable, twoFactorEnabledColumn }
ensureAccountSecuritySchema(database) -> { changed: boolean, before, after }
```

两条铁律，都写在模块头注释里：

1. **先只读探测再跑 DDL。** 上一批因为每次冷启动都跑 `ALTER TABLE` 拿到
   AccessExclusiveLock，实测把新读者阻塞 2000ms。`openAuth()` 在每个进程启动的关键路径上，
   稳态必须是一次只读探测然后立刻返回（有测试钉住：稳态 `exec` 调用次数为 0）。
2. **纯增量 + `BEGIN IMMEDIATE`。** 所有语句先过 `assertAdditiveMigration`
   （DROP/RENAME/ALTER-DROP 一律拒绝），然后在同一个 `BEGIN IMMEDIATE` 里再探测一次
   （锁外的探测可能已过期）再执行。这与 `migrateWorkspaceMembers` 修
   "并发首启 duplicate column name"的手法一致。

DDL 内容直接来自契约 §10.1，不另写第二份：

```sql
CREATE TABLE IF NOT EXISTS account_totp_replay (
	user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
	last_used_step INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS account_totp_replay_updated_idx ON account_totp_replay (updated_at);
```

**为什么不写进 `workspace-schema.sql`**：那个文件是 PostgreSQL 的 `log4stellar.*` 存储
schema，由 `rustfs-workspace.mjs:315` 在连接上整段执行。`account_totp_replay` 在
`auth.sqlite`（SQLite）里，主键是 better-auth 的 `user.id`，并且必须与建会话同事务写入。
放进 PostgreSQL schema 只会在错误的库里建一张没人读的表。`workspace-schema.sql` 因此
**本批不改**（契约 §15 的这一条按此处理，见 §8.1）。

**调用点**：`auth.mjs` 的 `openAuth()` 里，在
`await getMigrations(auth.options).runMigrations()` **之后**（插件迁移先建 `user` 表与
`twoFactor` 表，我们的外键依赖 `user`）、在 `migrateWorkspaceMembers(...)` 旁边调用一次。
放在插件迁移之后还有一个好处：`twoFactorEnabledColumn` 的探测结果此时已经是有意义的。

## 3. 判权模型：一个函数，一个入口

契约 §5.3 的访问矩阵由 `account-security.mjs` 的两个纯函数表达，网关只负责把它们接上：

- `classifyAuthState({ session, challenge, nowMs })` → `full` / `half` / `anonymous`
- `authorizeRequest({ state, method, pathname })` → `{ allow, status, action, error?, location? }`

`full` 要求 `session.session.expiresAt > nowMs`（严格大于）且 `session.user` 存在。
`half` 要求 `challenge.identifier` 非空且 `challenge.expiresAtMs > nowMs`。
其余一律 `anonymous`——**验签失败、cookie 缺失、cookie 过期都收敛到 anonymous**，
不区分原因，避免把内部状态暴露成探测信号。

`authorizeRequest` 的判定顺序（顺序本身是安全属性）：

1. 路由表命中 → 按路由的 `requires` 分级（`/api/account-security/*` 的两条 verify 路由
   要求 `anonymous`，即半认证也能调；其余要求 `full`）。
2. 非 anonymous 且路径是 `/api/session/logout` → 放行（允许放弃挑战）。
3. `public` surface（`/static/build/*`、`/session-client.js`）→ 放行。
4. `challenge` surface（`/login`）→ 放行。
5. `full` → 放行。
6. `half` → `GET /` 给 303 `Location: /login?twofactor=1`，其余给 403 `TwoFactorPending`。
7. 兜底 → 401。

`surfaceForPath` 的默认值是 `notes`（拒绝），所以**新加的路径不会因为忘记分类而放行**。

## 4. 网关拦截点：`auth-gateway.mjs`

这是 I1（半认证态读不到笔记）的**唯一执行点**。当前中间件按
`mounted` / `api` / `login` / `workbench` 四个布尔分派，第 115–125 行有一个逃生口：
不属于这四类的一切路径 `await next()` 直通下游。`/api/auth/*`、`/api/account-security/*`
和 `/sync/v1/*` 今天全都从这个口子漏出去。

改造后每个请求的处理顺序（**判权必须在任何参数解析之前**）：

1. host / Origin 校验（421）——保持不变。
2. 读 `Cookie`，算挑战 cookie 的有效性，读 `get-session`（只对 full 有意义）。
3. **`classifyAuthState` + `authorizeRequest` 一次性判定**。不通过立即返回对应状态码，
   **在此之前不读 body、不解析 query、不校验 Content-Type**。
   这是 A8 的要求：半认证发畸形 body 给 `/api/account-security/password` 必须得到
   `403 TwoFactorPending` 而不是 `400 InvalidPasswordInput`。
4. 通过之后才进入各分派分支。

逐类路径的落点：

| 路径 | 分类 | 改动 |
|---|---|---|
| `GET /` | notes | half → 303 `/login?twofactor=1`（不产出任何 HTML 字节，`serve-demo.mjs` 的注入中间件因此永远不会运行） |
| `GET/POST /api/session` | notes（路由表） | half → 403 `TwoFactorPending`；full 不变 |
| `POST /api/session/activity` | notes | half → 403，**不续期**（续期逻辑在判权之后） |
| `POST /api/session/logout` | 特例放行 | half → 200 并清挑战 cookie |
| `/static/mount/*` | notes | half → 403，绝不进入 `resolveWorkspace` |
| `/sync/v1/*` | notes | **新增显式分类**。`sync-contract.mjs:14` 的 `syncMountPath` 今天没人 import，`/sync/v1` 纯靠逃生口直通下游；改造后它必须命中 notes 分支（half → 403） |
| `/session-client.js` | public | 保持 GET 直出（A7） |
| `/static/build/*` | public | 保持放行（webview 分支不动） |
| `/login` | challenge | 加二验分支（见 §5） |
| `/api/auth/*` | **关闭** | half/anonymous → 401；full 只放行本批需要代理的端点，其余 404。`/api/auth/list-sessions` 尤其必须不可达（它返回原始 `session.token`，D9） |
| `/api/account-security/*` | security | 新增，按路由表判定后分派到 §6 的处理函数 |

`/api/auth/two-factor/*` 的处理是**部分代理**：插件端点本身不判权（它们信任传入的
cookie），所以网关必须先做 §3 的判定，再只把下面几个白名单端点交给 `callAuth`：
`two-factor/enable`、`two-factor/disable`、`two-factor/verify-totp`、
`two-factor/verify-backup-code`、`two-factor/generate-backup-codes`。
其余 `/api/auth/*` 一律不代理。

## 5. 登录流程：`/login`

当前登录分支在 `response.ok` 之后直接 `const { user } = await response.json()` 再查
`canReadWorkspace(user.id)`。**启用 2FA 的账号在这个响应里没有 `user`**，只有
`{ twoFactorRedirect: true, twoFactorMethods: [...] }`，所以这段必须先分支：

```
response.ok
├─ body.twoFactorRedirect === true  → 把 Set-Cookie（挑战 cookie）原样下发，渲染二验页（200）
└─ 否则 → 现有 canReadWorkspace 校验 + 303 到 /
```

二验页是 `login-page.mjs` 的新状态，表单 POST 到 `/login` 并带 `twofactor=1`，
网关转成 `POST /api/auth/two-factor/verify-totp`（或 `verify-backup-code`），
成功后把会话 cookie 下发并 303 到 `/`。失败按契约 §13.2 映射错误码，
**错误信息里不带验证码本身**。

## 6. `/api/account-security/*` 运行时

新增模块 `apps/web/account-security-runtime.mjs`，把契约的 10 条路由实现为
`async function handleAccountSecurity(ctx, { action, auth, database, state })`。
它只做三件事：解析已授权的请求体、读写 `auth.sqlite`（直接 SQL，见 §7）、
按 `accountSecurityErrorStatus` 映射错误。密钥/密码/token 一律不进日志与错误信息。

关键实现约束：

- **TOTP 重放防护**：`POST /api/account-security/two-factor/verify` 先算
  `step = totpStepFor(now)`，用 `admitTotpStep` 校验窗口与重放，再在
  `BEGIN IMMEDIATE` 里用一条 CAS 语句消费该 step 并插入 `session` 行（§7）。
- **恢复码**：先用 `matchRecoveryCode`（常量时间、遍历全部、不提前 break）判定，
  判定通过后才调插件的 `verify-backup-code`，让插件那次非常量时间比较必然命中。
- **设备标签**：契约没规定存哪。新增增量表（§7.2），按 22 字符会话摘要存。
- **改密**：调 `POST /api/auth/change-password` 并带 `revokeOtherSessions: true`，
  然后把响应里的新 `Set-Cookie` 转发给客户端（当前设备身份保留、token 更换，E1–E3）。
- **解绑**：先用与登录完全相同的消费路径验一次码（**解绑也消费 step**，F9），
  再调插件 `/two-factor/disable`。

## 7. 事务与直接 SQL

### 7.1 为什么用直接 SQL 而不是 `internalAdapter.createSession`

`internal-adapter.mjs:278-320` 的 `createSession(userId, dontRememberMe, override, overrideAll, ...)`
只有把 `expiresAt` 放进 `override` **并且**`overrideAll === true` 时才会采用调用方的值；
`ipAddress`/`userAgent` 在没有端点上下文时为空串。契约要求 `expiresAt` 从**二验完成时刻**
起算（§5.5），并且设备列表要显示来源，这两个都不满足。

所以二验成功时直接 INSERT `session` 行，列与真实观察值一致：
`id`（32 字符）、`token`（32 字符）、`userId`、`expiresAt`/`createdAt`/`updatedAt`（ISO 字符串）、
`ipAddress`、`userAgent`、`impersonatedBy = NULL`。
会话 cookie 用 `node:crypto` 的 `createHmac('sha256', secret)` 同步签名
（`<value>.<44 字符 base64 签名>`，整串再做 `encodeURIComponent`），
与 `better-call` 的 `signCookieValue` 完全一致——同步签名是能把"消费 step"和
"插入会话"放进同一个同步 `BEGIN IMMEDIATE` 的前提。

### 7.2 CAS 语句

单条语句同时完成插入与比较，`changes === 0` 就是重放/竞争失败信号：

```sql
INSERT INTO account_totp_replay (user_id, last_used_step, updated_at) VALUES (?, ?, ?)
ON CONFLICT (user_id) DO UPDATE
SET last_used_step = excluded.last_used_step, updated_at = excluded.updated_at
WHERE account_totp_replay.last_used_step < excluded.last_used_step
```

已用 `node:sqlite` 实测：首次插入 `changes 1`、同 step 再取 `changes 0`、
更小的 step `changes 0`、下一个 step `changes 1`。整个块在 `BEGIN IMMEDIATE` 内，
`db.isTransaction === true`，任一步失败 `ROLLBACK`——step 与 session 要么一起生效，要么都不生效。

**为什么不能靠 better-auth 自己的事务**：`node-sqlite-dialect.mjs` 的
`beginTransaction` 执行的是裸 `begin`（deferred），拿不到写锁，两个并发验证请求会交错。

### 7.3 设备标签表

```sql
CREATE TABLE IF NOT EXISTS account_session_label (
	session_id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
	label TEXT NOT NULL,
	updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS account_session_label_user_idx ON account_session_label (user_id);
```

`session_id` 是 `sessionIdFor(token)` 的 22 字符摘要，**不是** token。
会话消失后标签行留着无害（主键不会再被复用），`ON DELETE CASCADE` 删的是用户。
这两条语句同样过 `assertAdditiveMigration` 并在 `BEGIN IMMEDIATE` 内执行。

## 8. 实施中发现契约有误或不可实现的地方

### 8.1 契约 §15 要求"向 `workspace-schema.sql` 追加 `account_totp_replay`"

**按契约字面实现是错的**：那是 PostgreSQL 的 `log4stellar.*` schema，
由 `rustfs-workspace.mjs` 在 PG 连接上整段执行；`account_totp_replay` 必须建在
`auth.sqlite` 里（外键指向 better-auth 的 `user.id`，且要与建会话同事务）。
按字面做只会得到一张没人读的 PG 表，而 SQLite 侧仍然没有表，重放防护静默失效
——这是最坏的一种"看起来做了"。**处理**：不追加，DDL 落在 §2 的模块里，
并在该文件顶部写清原因。

### 8.2 契约 §4.5 第 2 条对插件行为的描述不够精确

契约说插件"用 `codes.includes` 短路比较"。实际是
`codes.includes(data.code)` **完全相等**匹配，且比的是**规范化后的字符串**。
关键差异：插件的恢复码生成器产出大小写混合的 `a-zA-Z0-9`，而我们的
`normalizeRecoveryCode` 会 `toUpperCase()`。如果网关把规范化后的码交给插件，
插件的 `includes` 永远不命中，恢复码永远失败。
**处理**：注入 `backupCodeOptions.customBackupCodesGenerate`，让插件存的就是
我们字母表里的大写码；这样"规范化 → matchRecoveryCode → 交给插件"三者一致。

### 8.3 契约 §13.6 F6 要 409，插件给 400

插件 `/two-factor/enable` 在已启用时抛 `400 TOTP_ALREADY_ENABLED`。
**处理**：网关把插件错误码映射成契约的 `409 TotpAlreadyEnrolled`
（`accountSecurityErrorStatus` 里就是这个值），不透传插件的状态码。

### 8.4 契约 §13.6 F7 的"403/401"二选一

契约写"403/401"是因为它不想规定是"缺参数"还是"缺第二因素"。
**处理**：缺第二因素 → `403 ReauthenticationRequired`（这才是判权语义）；
body 里连密码都没有 → 同一个 403，因为判权先于参数校验。
测试按 403 钉住。

### 8.5 `sync-migrate.mjs` 在这个 worktree 里不存在

司线提到照 `apps/web/sync-migrate.mjs` 的 `storageSchemaCurrent(pool)` 抄只读探测。
该文件不在本 worktree（属于另一条并行分支）。**处理**：按同样语义从零写
`accountSchemaCurrent(database)`，并用"稳态 `exec` 调用次数必须为 0"的测试钉住。

## 9. 回滚兼容性

- **数据库**：本批只新增两表 + 一索引 + 插件自己的 `user.twoFactorEnabled`
  与 `twoFactor` 表，零 DROP/RENAME/ALTER-DROP。旧发布包启动时 its `openAuth()` 不会
  创建它们、也不会读它们，所以**切回旧包数据库不需要任何降级脚本**。
- **安全后果**：旧发布包的 `auth-gateway.mjs` 完全不知道 2FA，它在
  `/api/auth/*` 上直通下游。一个启用了 2FA 的账号回滚后会**静默降级成单因素登录**
  ——密码通过即发会话 cookie，插件因为没注册所以也不存在挑战。这不是崩溃，
  没有告警，只有安全等级下降。必须写进变更记录，运维建议见交付说明。
- **备份**：`auth.sqlite` + `auth.sqlite-wal` + `auth.sqlite-shm` 三件一起拷
  （只有主文件会丢掉已提交事务），外加 `<authDir>/secret`（丢了它 TOTP 种子与
  恢复码永久无法解密，且不可轮换）。
- **不要手工清理** `account_totp_replay`：删行会让已经用过的 step 重新可用。

## 10. 验收矩阵 → 测试文件

| 矩阵 | 测试文件 | 门禁 |
|---|---|---|
| A1–A12（半认证读不到） | `account-security-wiring.test.mjs` + `account-security.integration.test.mjs` | 前者纯单测；后者 `LOG4STELLAR_IT=1` |
| B1–B12（TOTP/重放） | 同上 | 同 |
| C1–C9（恢复码） | 同上 | 同 |
| D1–D10（会话列表/脱敏） | 同上 | 同 |
| E1–E11（改密） | 同上 | 同 |
| F1–F10（绑定/解绑） | 同上 | 同 |
| G1–G5（闲置/续期不回归） | `account-security.integration.test.mjs` + 既有 `workspace-access.integration.test.mjs` | `LOG4STELLAR_IT=1` |
| H1–H6（迁移/回滚） | `account-security-ddl.test.mjs` + `account-security.test.mjs` | 默认套件 |
| 半认证判权顺序（A8） | `account-security-wiring.test.mjs` | 默认套件 |

`A1–A12` 必须在网关改造**之前**写、并且**先红后绿**：先跑出失败，再改网关让它通过。
