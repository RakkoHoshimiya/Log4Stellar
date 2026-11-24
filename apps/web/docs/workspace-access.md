# 工作区权限契约（v1，提案）

本文件是「多工作区权限隔离」与「附件版本历史」两个任务的共同契约。任何实现与测试必须以本文件的判据为准；如需修改契约，先改本文件再改代码。

## 1. 身份模型

四层身份，逐层收窄：

| 层级 | 标识 | 存在位置 | 说明 |
|---|---|---|---|
| 租户 | `tenant_id` | `auth.sqlite` 的 `workspace_member` | 计费与成员归属的最外层分组 |
| 工作区 | `workspace_id` | `auth.sqlite` + PostgreSQL `log4stellar.storage_workspaces.id` + RustFS 对象键前缀 | **一个工作区只有一个字符串 ID，三处必须完全一致** |
| 成员 | `(tenant_id, workspace_id, user_id)` | `auth.sqlite` | 成员关系携带角色（`role`：1 viewer / 2 editor / 3 owner） |
| 会话 | better-auth `session` | `auth.sqlite` | 只证明「你是某个用户」，不证明「你能进某个工作区」 |

**关键约束**：`workspace_id` 是唯一的权威标识。历史上 `auth.sqlite` 用 `tenant_id='default'`、`workspace_id='default'` 记录成员，而存储侧工作区 ID 是 `log4stellar-main`。这是两套互不相通的 ID，本次迁移必须让它们合一：迁移后 `workspace_member.workspace_id` 直接存存储侧工作区 ID。

存储侧工作区 ID 由部署侧提供，不由认证库推断。`serve-demo.mjs` 通过命令行参数与环境变量把它传进 `openAuth()`，优先级从高到低：

1. `LOG4STELLAR_STORAGE_BACKEND=rustfs` 时，位置参数 `<workspace>` 本身就是存储侧工作区 ID（部署脚本已经传 `log4stellar-main`），直接采用；
2. 环境变量 `LOG4STELLAR_WORKSPACE_ID`；
3. 缺省值 `log4stellar-main`（向后兼容：旧脚本不设置任何变量也能启动）。

本地目录后端（`LOG4STELLAR_STORAGE_BACKEND=local`）的 argv 是磁盘目录路径、不是工作区 ID，所以它只认第 2、3 步解析出的 ID，并且只服务这一个工作区。

## 2. 角色与权限矩阵

角色只有三个，能力严格包含（owner ⊇ editor ⊇ viewer）：

| 角色 | 等级 | 说明 |
|---|---|---|
| `owner` | 3 | 工作区所有者。拥有 editor 全部能力，另可管理成员与工作区设置 |
| `editor` | 2 | 编辑者。可读写内容、回滚、回收站 |
| `viewer` | 1 | 只读成员。只能读与下载，不能产生任何逻辑变更 |

能力（capability）是判权的唯一单位，**不要按 HTTP 方法或 URL 判权**：

| capability | viewer | editor | owner | 覆盖的操作 |
|---|:--:|:--:|:--:|---|
| `workspace.read` | ✅ | ✅ | ✅ | 列目录、stat、搜索文件、读文件、byte range 下载、读取旧版本内容（下载旧版） |
| `workspace.history` | ✅ | ✅ | ✅ | 查看版本列表、查看回收站列表、`capabilities` 探测 |
| `workspace.write` | ❌ | ✅ | ✅ | 新建/覆盖文件、mkdir、rename |
| `workspace.delete` | ❌ | ✅ | ✅ | 移入回收站 |
| `workspace.restore` | ❌ | ✅ | ✅ | 回滚到旧版本、从回收站恢复（含批量、keep-both） |
| `workspace.admin` | ❌ | ❌ | ✅ | 增删成员、调整成员角色、改工作区设置（仅 CLI：由运维命令行 `workspace-members.mjs` 使用，没有 HTTP 入口，本版本也不打算开） |

规则：
- 「下载旧版本」属于读操作，viewer 可以做；「回滚到旧版本」会生成新版本，属于写操作，viewer 不可以。
- 读能力从不下放给「无成员关系」的用户。非成员的一切操作返回 403，不区分「工作区不存在」与「你不是成员」（避免枚举）。

## 3. 请求 → 能力映射（唯一判据表）

`serveWorkspaceFile` 的每个分支都必须先落到下列某一行，再由该行决定所需能力：

| 请求形态 | capability |
|---|---|
| `GET/HEAD` + `capabilities=1`（根） | `workspace.history` |
| `GET/HEAD` + `trash=1`（根） | `workspace.history` |
| `GET/HEAD` + `versions=1` | `workspace.history` |
| `GET/HEAD` + `revision=<id>` | `workspace.read` |
| `GET/HEAD` + `stat` / `readdir` / `files=1` / 无查询（下载） | `workspace.read` |
| `PUT`（任意查询） | `workspace.write` |
| `POST` + `mkdir=1` / `rename=` | `workspace.write` |
| `POST` + `restoreVersion=` | `workspace.restore` |
| `POST` + `restoreTrash=` / `restoreTrashBatch=1` | `workspace.restore` |
| `DELETE` | `workspace.delete` |

注意 `trash=1`、`capabilities=1` 只在根路径上是历史查询；非根路径带这些参数时现有分支会落到读文件，因此映射到 `workspace.read`（否则一旦引入「可读历史但不可读文件」的角色就会越权）。`versions=1` 在任何路径上都是版本查询。

方法不支持、查询组合非法仍按现有逻辑返回 405/400，但**权限校验先于参数校验**：viewer 对 `PUT` 的请求应得到 403，而不是 415/400。校验也先于路径解码，所以 viewer 请求 `/%ZZ` 这类非法转义得到的是 403 而不是 400。

## 4. 执行点（单一收口）

判权必须发生在**一个**地方，不允许每个 handler 各自检查：

```
请求 → 网关鉴权（会话有效？） → 解析目标工作区 → 解析 (user, workspace) 角色
     → 从契约表得到 capability → 角色是否具备该 capability
     → 具备：调用存储层；不具备：403 { error: 'NoPermissions' }
```

实现方式：在 gateway 里把存储后端包成一层 `authorizeWorkspace(backend, { role })` 门面，`serveWorkspaceFile` 只认这个门面。门面按能力白名单放行方法，未授权直接抛 `WorkspaceError(403, 'NoPermissions')`，绝不触达存储。

### 4.1 登录门禁的语义（本次变更）

`auth.mjs` 的 `canReadWorkspace(userId)` 过去等价于「该用户是 `(default, default)` 这个唯一工作区的成员」，现在含义变为 **「该用户至少是一个工作区的成员」**——即是否允许进入工作台（登录门禁），而不是「能否读某个工作区」。

理由：一个用户可能不是默认/规范工作区的成员，但仍是其它工作区的成员；此时拒绝登录是错误的。逐请求的读能力判定由网关解析出的 `(user, workspace)` 角色决定，不再复用登录门禁的答案。

- 登录门禁（`POST /login`、`GET /login`、`GET /`、`/api/session*`）：只看「至少一个成员关系」。
- 文件与历史请求（`/static/mount/*`）：看解析出的工作区角色。
- 无任何成员关系的用户：登录被拒（403 `forbidden`），也不能读任何工作区。
- 门禁必须与「至少能解析出一个工作区」一致：只持有回滚兼容行、没有任何规范成员行的账号（回滚窗口里旧发布包创建的账号、归属不明的库）**不能**通过门禁。否则会出现「能登录、`/api/session` 正常、但每个挂载请求都是 403」的状态，运维也没有手段补救。归属不明的库请用 `workspace-members.mjs add <username> --workspace <id>` 显式授权。
- 例外：进程本身以占位 ID `default` 启动时（本地后端的兼容用法），占位行就是被服务的工作区，门禁与判权都按它计算。

## 5. 工作区解析与路由

- 客户端通过请求头 `X-Log4Stellar-Workspace`（首版）声明目标工作区 ID；缺省时使用该会话用户的「默认工作区」（其成员关系中最早创建的一个）。
- 网关用 `(session.user.id, workspaceId)` 查成员关系得到角色。查不到 → 403 `NoPermissions`，且响应体不含任何「工作区是否存在」的信息。
- 一个服务进程可以服务多个工作区。工作区后端按 ID 懒加载并缓存，缓存有上限；不同工作区的后端实例**不得互相复用**。
- 现有的 `X-Log4Stellar-Account` / `X-Log4Stellar-Workspace-Account` 语义保持不变（账号一致性校验），工作区校验是在其之上的第二道检查。

网关需要两个由部署方注入的依赖（`serve-demo.mjs` 提供，测试提供替身）：

| 依赖 | 签名 | 说明 |
|---|---|---|
| `workspaces` | `{ acquire(workspaceId), release(workspaceId), close() }` | 按 ID 懒加载并缓存后端；`acquire` 取租约，`release` 在响应结束（或出错）时归还，因此缓存淘汰永远不会关掉正在服务请求的连接池；未知 ID 抛错，由网关转成 403 |
| `defaultWorkspaceId` | `(userId) => workspaceId \| undefined` | 该用户的默认（最早加入的）工作区 |
| `resolveRole` | `(userId, workspaceId) => 1 \| 2 \| 3 \| undefined` | 查成员角色；`undefined` 表示非成员 |

解析顺序：
1. 读 `X-Log4Stellar-Workspace`（小写化）；有值就用它，只校验 ID 格式，**不校验存在性**（不存在与无权限都落到同一条 403）。
2. 无值 → 用 `defaultWorkspaceId(userId)`；该用户没有任何成员关系时为 `undefined` → 403。
3. 有 workspaceId 就 `resolveRole(userId, workspaceId)`；`undefined` → 403 `NoPermissions`。
4. `workspaces.acquire(id)` 取后端，把角色交给 `authorizeWorkspace(backend, { role })`，再交给 `serveWorkspaceFile`；响应结束后 `workspaces.release(id)`。

后端打开失败（例如未知工作区 ID）同样返回 403 `NoPermissions`，不返回 404 或 500，避免通过状态码枚举工作区。

本地目录后端（`LOG4STELLAR_STORAGE_BACKEND=local`）只支持 argv 指定的那一个工作区 ID；`serve-demo.mjs` 传给后端缓存的 `open(workspaceId)` 对其它 ID 一律抛错（网关转 403）。

### 5.1 客户端声明（首版）

`workspace-extension` 在 `/static/mount` 的每个请求上带 `X-Log4Stellar-Workspace`。首版该值来自服务端，而不是客户端自选：

- 网关在 `GET /api/session` 的响应里返回服务端为该会话解析出的默认工作区 `workspaceId`（响应同时保留 `remainingMs`，向后兼容）；
- 扩展在第一次挂载请求时读取该值并缓存（同一个扩展宿主只取一次），此后所有挂载请求带同一请求头；读不到时（接口失败、无该字段）不带该头，服务端按「缺省工作区」处理，行为与首版之前一致。

这意味着首版一个浏览器会话只操作一个工作区；切换工作区需要服务端为会话解析出不同的默认工作区。真正的多工作区切换 UI 不在本次范围（见第 8 节）。

## 6. 「知道 ID 也拿不到」的判据

因为同一套表用 `workspace_id` 列隔离，且每次查询都带 `workspace_id` 参数，所以：

- 拿到别的租户的 `file_id`、`revision_id`、`trash_id` 都无法直接使用：所有按 ID 的查询都以 `(workspace_id, path, file_id)` 为条件。
- 真正的风险点不是 SQL，而是**网关把请求映射到了哪个工作区**。因此验收测试必须在 HTTP 层做：A 租户的会话 + B 工作区的 ID/头部 + B 的 file_id/version_id，必须得到 403（或在该工作区内的 404），且响应体不含任何 B 的内容字节。

## 7. 迁移

- 现有的 `workspace_member(tenant_id, workspace_id, user_id)` 升级为携带 `role`（`INTEGER NOT NULL DEFAULT 3 CHECK (role IN (1, 2, 3))`）。旧行默认成为 `owner`。
- **旧的兼容行必须保留，不得删除。** 上一版发布包用
  `SELECT 1 FROM workspace_member WHERE tenant_id = 'default' AND workspace_id = 'default' AND user_id = ?`
  判断「能否进入工作台」。如果迁移把旧行删掉，回滚到上一发布包就会把所有用户锁在门外。因此迁移后同一个用户同时拥有：

  | tenant_id | workspace_id | user_id | role | 用途 |
  |---|---|---|---|---|
  | `default` | `default` | `alice` | 3 | 回滚兼容：旧发布包的登录门禁只看这一行 |
  | `default` | `log4stellar-main` | `alice` | 3 | 新代码的规范行：携带角色，参与逐请求判权 |

  兼容行不参与新代码的判权（本版本不把 `default` 当工作区，只把它当旧登录门禁），只在新代码回滚后由旧发布包读取。新建账号时两种行一起写入。

### 7.1 占位行的收养规则（一次性绑定）

**升级窗口只有一次，且由第一次「写」决定。** 从没有逐账号账本的构建（`a146ed8d945` 及更早）升级上来时，库里只有占位行、没有 `workspace_meta`，所有历史账号都还没有被任何工作区决定过。这个窗口在**第一次真正产生决定的操作**发生时关闭：`create-account.mjs` 建号、`serve-demo.mjs` 启动服务、或 `workspace-members.mjs add`/`set-role`/`remove` 中的任一条。一旦旧发布包（或旧构建）在窗口期内撤销过某个成员，那条规范行就没了、而占位行还在；升级到本版本后该账号会被第一次收养的工作区接回成 `owner`——因为对被撤销的账号而言，「只剩占位行」与「从未被决定过」在库里长得一模一样。要避免这种复活，请在升级**之前**停掉旧包、或升级后立刻用 `workspace-members.mjs remove` 复核一遍成员表。只读命令（`list`、`workspaces`）不消耗这个窗口：它们传 `adopt: false`，只做 schema 升级，不改写 `workspace_meta`。

历史库里的占位行 `(default, default, user)` 是**库级**的，不属于任何一个具体工作区：它只是"上一版发布包承认这些账号"的标记。因此不能每次打开数据库都把它复制成本次部署的工作区 ID —— 否则只要同一个 `auth.sqlite` 被另一个工作区 ID 的部署打开过（导入新工作区、跑第二个工作区、运维手工试跑），库里所有历史账号都会变成那个工作区的 owner，直接击穿第 6 节。

收养（把占位行复制成规范行）必须同时满足两道闸门：

1. **该库只能被收养一次。** `workspace_meta` 表记录 `legacy_workspace_adoption` = 拥有本库占位行的那个工作区 ID。此后只有同一个工作区还能再次收养；其它任何工作区一律不收养。数据库第一次被打开且库里已有规范行时，用现有的那个工作区 ID 反向补齐标记（兼容本任务早期构建留下的库）；若库里存在多个工作区 ID，则视为归属不明、**不做任何收养**，同样不写标记，保持只读。
2. **只收养没有任何工作区认领过的账号。** 只有当某账号在库里除占位行外没有任何成员行时才复制它。别的部署创建的账号、管理员显式加入的成员、以及上一版发布包写下的任何规范行都不会被拉进来。

只能收养一次的原因与例外的原因不同，两者都必要：

- 「只收养一次」保证共享同一个 `auth.sqlite` 的第二个部署拿不到第一个部署的账号。
- 「拥有者可以重复收养」是**回滚期间不丢账号**的需要：回滚到上一版发布包时新建的账号只有占位行（旧包不写规范行），恢复新版本后必须能被第一次收养的那个工作区接回。第 2 道闸门保证重复收养不会顺带把别人的账号拉进来。

**第 3 道闸门：逐账号账本。** 单靠上面两道闸门，撤权会失效：撤销一个成员的做法是删掉他的规范行，而占位行必须保留，于是他在下一次 `openAuth()` 时又满足「只有占位行」的条件、被重新收养成 `owner`（角色取自占位行的默认值 3）。因此 `workspace_meta` 还为每个账号记录一条 `legacy_member_adopted:<user_id>` = 决定它的工作区 ID：

- 任何已经拥有过规范行的账号（新建账号、被 `addMember` 显式加入的账号、以及第一次被收养的历史账号）都写入这条记录；
- 收购时跳过已有记录的账号，因此删除成员之后重开数据库不会再把它加回来；
- 只有从未被任何工作区决定过、仅剩占位行的账号（回滚窗口里旧发布包新建的账号）仍然可被拥有者收养。

这就是「撤权持久」与「回滚兼容」可以同时成立的原因：**撤权删的是规范行，账本记录的是决定，两者互不覆盖**；旧包新建的账号没有被任何工作区决定过，所以仍会被接回。

实现细节：判断与复制在同一 `BEGIN IMMEDIATE` 事务内完成（先取写锁再读），两个进程同时打开同一个库不会双重收养；复制使用 `INSERT OR IGNORE`，管理员已设置的角色不会被覆盖，重复执行无副作用。给 `workspace_member` 补 `role` 列的 `PRAGMA table_info` 读取与 `ALTER TABLE`、以及索引创建，同样在这一个 `BEGIN IMMEDIATE` 事务内完成——否则两个进程同时首次打开旧结构库时都会读到「没有 role 列」、都去 ALTER，后者抛 `duplicate column name: role` 直接起不来。

成员管理的运维入口是 `node apps/web/workspace-members.mjs`（`list` / `workspaces` / `add` / `set-role` / `remove`）。它直接写 `workspace_member`，不经过 HTTP，因此本版本没有需要额外保护的成员管理接口。

`--workspace` 只表示「要读/改哪个工作区的成员」，**不是**本次部署的工作区：命令总是以部署自己的工作区（`LOG4STELLAR_WORKSPACE_ID`，缺省为内置默认）打开 `auth.sqlite`，再把目标 ID 传给成员操作。这条分工是必要的——把 `--workspace` 也交给 `openAuth()` 会让 §7.1 的三道闸门全部失效：`list --workspace default` 会把占位行当成一个工作区打印出来，`remove alice --workspace default` 会把回滚兼容行删掉，回滚到上一版发布包后该账号永久锁死。两道防线都在：CLI 入口直接拒绝 `--workspace default`，`auth.mjs` 的 `listMembers`/`addMember`/`removeMember`/`setMemberRole` 也各自拒绝把占位行当工作区。

只读的 `list` 与 `workspaces` 以 `adopt: false` 打开数据库：读命令不下决定，否则一次「看一眼成员表」就会永久绑定整个历史库（§7.1 的升级窗口）。写命令（`add`/`set-role`/`remove`）保留收养，因为运维在全新升级的库上执行的第一个 `add` 正是把历史账号接回来的那次操作。

写命令在动手前会确认目标工作区已经导入（rustfs 后端查 `log4stellar.storage_workspaces`；本地后端没有这个注册表，跳过）。给未导入的工作区加成员会让账号能登录、但每个挂载请求都是 403，正是 §4.1 要求门禁不能产生的状态。

存储侧工作区 ID 由部署配置提供（见第 1 节，当前为 `log4stellar-main`）。

### 7.2 回滚与数据

- 迁移只改 `auth.sqlite`，**不动** PostgreSQL 与 RustFS。文件 ID、版本 ID、内容摘要全部保持不变，因此回滚到上一发布包后数据仍可读。
- 回滚兼容性：兼容行始终保留，新增列有默认值，旧版本代码只 `SELECT 1`、不读 `role`，因此旧发布包可以直接继续运行。
- 需要备份的只有 `auth.sqlite`（建议连同 `-wal`/`-shm` 一起，或在停服后备份）。PostgreSQL 与对象存储不需要为本次升级做额外处理。
- 新增的 `workspace_meta` 表也在这个文件里，属于本次升级的一部分：删掉它不会破坏回滚（旧包不读它），但会让「撤权持久」和「只收养一次」失效，重启后历史账号可能被重新收养。升级后请不要手工清理该表。
- 用不同工作区 ID 的多个部署**不要共用同一个 `auth.sqlite`**。技术上它现在是安全的（第二个部署不会收养第一个部署的账号），但两边只能通过 `workspace-members.mjs --workspace` 显式授权，缺省工作区与登录门禁各自独立，容易配错；每个部署一个目录是更省心的选择。

## 8. 非目标（首版不做）

- 跨工作区复制/移动。
- 成员邀请流程与邮件通知。
- 细粒度路径级权限（如「只能读某个目录」）。
- 组织级策略、SSO。
