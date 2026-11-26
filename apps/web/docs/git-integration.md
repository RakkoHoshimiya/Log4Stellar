# Git 仓库接入契约（v1）

本文件是「Git 仓库接入」的实现契约，与 `docs/workspace-access.md`、`docs/incremental-sync.md` 并列为客户端与服务端的共同判据。凡本文件写明的路由、字段、状态码与判定顺序，实现与测试都必须一致；如需修改契约，先改本文件再改代码。

配套的常量与校验函数在 `apps/web/git-contract.mjs`，测试在 `apps/web/git-contract.test.mjs`。**本文件描述协议，不描述实现**：这一段只定义「服务端必须表现出什么行为」，不规定代码结构。

判权的唯一依据是 `docs/workspace-access.md` 的能力矩阵；本文件只**新增**能力条目，不新增判权机制。

## 1. 范围与非目标

### 1.1 首版做什么

| 能力 | 说明 |
|---|---|
| 关联已有仓库 | 把一个**已经存在的**本地 Git 仓库路径登记为某工作区的 Git 仓库；可同时登记远端 URL 与默认分支 |
| 查看提交 | 提交列表（可指定 ref、分页）与单个提交详情（含改动文件清单） |
| 查看工作树状态 | 当前分支、HEAD、上游、领先/落后、逐条变更（暂存/未暂存/未跟踪/冲突）、是否干净 |
| 查看分支 | 本地分支、远端跟踪分支、当前分支 |
| 手动 `fetch` | 调用真实 `git fetch`，回报引用的前后值 |
| 手动 `push` | 调用真实 `git push`（永不强制），回报远端 HEAD |
| 切换/新建分支 | 工作树干净时执行 `git switch`；脏工作树必须被拒绝 |
| 项目检查点关联 commit | 新建/列出/读取/删除检查点，每个检查点固定住一个 commit sha，可选固定住一个笔记文件版本 |
| 远端凭证托管 | 每个工作区可存 0..n 份凭证（SSH 私钥或 HTTPS token），AES-256-GCM 加密落盘、按引用注入、绝不回显。**轮换（改密钥）未实现**，见 §6.3 |

**「项目检查点」是本项新引入的概念**：`checkpoints` 在此之前不存在于本仓库（`grep -rn checkpoint apps/web/` 零命中）。它的语义是「用户认定的一个项目里程碑」：名字、说明、绑定的 commit、可选的笔记文件版本快照指针。检查点不复制内容，只记录指针。

### 1.2 非目标（明确不做）

| 不做 | 立场与理由 |
|---|---|
| **服务端克隆（server-side clone）** | 不做。首版只**关联已存在**的仓库路径。理由：克隆会把「远端可达性」变成关联操作的阻塞条件，把网络故障、证书、限速、大仓库超时全部引入一个本该是纯登记的接口；也让「关联」和「同步」两件事的错误语义纠缠在一起。用户可以先在服务器上（运维手工或后续 CLI）准备好仓库，再在笔记服务里关联。`PUT /git/v1/repository` 只接受已存在且 `rev-parse --git-dir` 成功的路径，否则 422 `NotARepository`。 |
| **服务端持有凭证，但只托管、不代 git 自己发明** | 托管（加密落盘、按引用注入）**做**；但凭证**只用于 `fetch`/`push` 这一次子进程调用**，绝不被写进仓库的 `.git/config`、绝不进 Git 的凭据存储、绝不回显。 |
| 裸仓库（bare）作为**工作树** | 不支持。`status`/`switch`/`push` 都需要工作树，裸仓库关联 → 422 `BareRepository`。裸仓库可以被登记为**远端**（测试就是这么用的）。 |
| 强制推送 | 不支持。任何 `force` 字段出现 → 400 `ForcePushNotAllowed`。非快进必须由用户在本地 `merge`/`rebase` 后重推。 |
| `diff` / `blame` / `merge` / `rebase` / `cherry-pick` / 子模块 / LFS | 不做。这些是 IDE 的职责，Web 端复用 VS Code 的 `git-base` 扩展即可（它有 `browser` 入口）。 |
| 一个工作区多个仓库 | 首版一工作区**一个**仓库（`git_repositories` 以 `workspace_id` 为主键）。多仓库的键只需要从 PK 改成 `(workspace_id, repo_id)`，属于纯增量演进。 |
| 幂等键 | 不做。`fetch`/`push`/`status` 本身就是状态查询或状态迁移，重复执行结果一致；`push` 的「已是最新」有显式 `updated: false` 回报。 |
| Web 端直接复用 `extensions/git` | 不可能：`extensions/git/package.json` 只有 `"main": "./out/main"`，**没有 `browser` 字段**，所以 Web 端无法加载它。这正是本项必须做服务端集成的原因。 |

## 2. 身份与权限

### 2.1 新增能力

在 `workspace-access.mjs` 的 `workspaceCapabilities` 里新增三条，其余不变：

| capability | viewer(1) | editor(2) | owner(3) | 覆盖的操作 |
|---|---|---|---|---|
| `workspace.git.read` | ✅ | ✅ | ✅ | 查看仓库信息、`status`、`log`、`branches`、`commit`、**`fetch`**、检查点读取、凭证列表（只列元数据） |
| `workspace.git.write` | ❌ | ✅ | ✅ | **`push`**、切换/新建分支、检查点新建/删除 |
| `workspace.git.admin` | ❌ | ❌ | ✅ | 关联/更新/解绑仓库、凭证增删改、设置远端 |

三条能力严格嵌套：`admin ⇒ write ⇒ read`。**读操作与写操作必须分开**是硬要求：`viewer` 能 `fetch`（它只改本地远端跟踪引用，不改工作树、不改历史、不往远端写），但**不能** `push`、不能切分支、不能建检查点。

`fetch` 归入 `read` 而不是 `write` 的理由：`fetch` 的副作用限于 `refs/remotes/*` 与 `FETCH_HEAD`，不触碰工作树、不触碰本地分支、不向远端写任何东西；把它归入 `write` 会让只读协作者无法同步查看远端进度，而 `log refs/remotes/origin/main` 本来就已经把远端内容暴露给 `read` 了。

### 2.2 请求 → 能力映射（唯一判据表）

`serveGitRequest` 的每个分支都必须先落到下列某一行，再由该行决定所需能力。映射只依赖方法与路径，**不依赖 body、不依赖 query、不依赖路径参数解码**，所以可以在任何参数校验之前完成：

| 请求形态 | capability |
|---|---|
| `GET/HEAD /git/v1/repository` | `workspace.git.read` |
| `GET/HEAD /git/v1/status` | `workspace.git.read` |
| `GET/HEAD /git/v1/log` | `workspace.git.read` |
| `GET/HEAD /git/v1/branches` | `workspace.git.read` |
| `GET/HEAD /git/v1/commit/<sha>` | `workspace.git.read` |
| `GET/HEAD /git/v1/checkpoints`、`/git/v1/checkpoints/<id>` | `workspace.git.read` |
| `GET/HEAD /git/v1/credentials` | `workspace.git.read`（只列元数据，永不返回秘密） |
| `POST /git/v1/fetch` | `workspace.git.read` |
| `POST /git/v1/push` | `workspace.git.write` |
| `POST /git/v1/branch` | `workspace.git.write` |
| `POST /git/v1/checkpoints` | `workspace.git.write` |
| `DELETE /git/v1/checkpoints/<id>` | `workspace.git.write` |
| `PUT /git/v1/repository`、`DELETE /git/v1/repository` | `workspace.git.admin` |
| `PUT /git/v1/credentials`、`DELETE /git/v1/credentials/<id>` | `workspace.git.admin` |
| 其余任何 `method + path` 组合 | `undefined`（→ 404 `NotFound`） |

**判定顺序是契约的一部分**，`serveGitRequest` 必须严格按此顺序：

1. 解析 `capabilityForGitRequest(method, path)`；为 `undefined` → 404 `NotFound`。
2. `workspace.require(capability)`（未授权 → 403 `{error:'NoPermissions'}`）。
3. 才读 body / query，做参数校验。
4. 才做路径解码、分支名解析、commit 解析。
5. 才触达 Git 子进程或数据库。

推论（测试必须覆盖）：`viewer` 发 `POST /git/v1/push` 带一个语法非法的 body，得到的是 **403 `NoPermissions`**，不是 400；`viewer` 发 `POST /git/v1/branch` 带 `%ZZ` 非法转义，得到 403 而不是 400；`viewer` 发 `PUT /git/v1/repository` 得到 403 并且 **Git 子进程与数据库零调用**。

### 2.3 工作区解析

与 `/static/mount`、`/sync/v1` 完全一致：`X-Log4Stellar-Workspace` 头（小写化）→ 否则 `defaultWorkspaceId(userId)`；`resolveRole` 无角色 → 403 `NoPermissions`（不泄露存在性）；后端打开失败 → 同样 403。Git 路由**不新增**任何工作区解析逻辑，完全复用 `auth-gateway.mjs` 的 `resolveWorkspace`。

## 3. 数据模型

三张新表，全部 `CREATE TABLE IF NOT EXISTS`，全部在 `log4stellar` schema 下，全部**纯增量**：不新增列到既有表、不修改既有列、不改既有约束。上一版发布包（`web-markdown-preview-01`，只认识 5 张 storage 表 + 4 张 sync 表）看到这 3 张新表时完全无视它们，仍能正常读写。

### 3.1 `git_repositories`

```sql
CREATE TABLE IF NOT EXISTS log4stellar.git_repositories (
	workspace_id text PRIMARY KEY,
	local_path text NOT NULL,
	repository_root text NOT NULL,
	default_branch text NOT NULL,
	remote_url text,
	remote_kind text NOT NULL CHECK (remote_kind IN ('file','https','ssh','git','http')),
	remote_branch text NOT NULL,
	credential_id text,
	bound_by_actor text NOT NULL,
	bound_ms bigint NOT NULL,
	updated_ms bigint NOT NULL,
	last_fetch_ms bigint,
	last_fetch_commit text,
	last_push_ms bigint,
	last_push_commit text,
	CHECK (char_length(workspace_id) BETWEEN 1 AND 64),
	CHECK (char_length(local_path) BETWEEN 1 AND 4096),
	CHECK (credential_id IS NULL OR credential_id ~ '^[0-9a-f]{32}$'),
	CHECK (last_fetch_commit IS NULL OR last_fetch_commit ~ '^[0-9a-f]{40}$'),
	CHECK (last_push_commit IS NULL OR last_push_commit ~ '^[0-9a-f]{40}$')
);
```

- `local_path` / `repository_root` 存**绝对路径**，但这是服务端凭据；API 只回显 `local_path` 相对于 `repository_root` 的部分（§5.3）。`repository_root` 是绑定时匹配到的允许根，单独存一列而不是每次重新推导：允许根列表会变（运维改环境变量），记录「当时是哪个根」才能让相对路径在未来仍然稳定可读。
- **没有 `REFERENCES log4stellar.storage_workspaces(id)`**。`git_repositories` 的工作区 id 来自调用方的会话，而 `storage_workspaces` 只有在工作区**被写入过**时才有行；一个刚创建、还没写过文件的工作区也应该能关联仓库。加外键会把「先关联仓库再写第一篇笔记」这个完全合法的顺序变成一个 500。
- `credential_id` 指向 `git_credentials`，**不建外键**：删凭证与解绑仓库的先后顺序不该由数据库决定（应用层判 `CredentialInUse` → 409）。id 用 `text` + `CHECK (~ '^[0-9a-f]{32}$')` 而不是 `uuid` 类型：这条 CHECK 同时干两件事——约束形状，**以及让「把 token 误贴进 credential_id 列」当场失败**。`uuid` 类型在宽松模式下会把任意串转成字节，`text` 不会。
- `remote_url` 可为 `NULL`（纯本地仓库，只能 `status`/`log`/`switch`，不能 `fetch`/`push`）。`remote_kind` 是落盘时的 scheme 归类，用于审计与展示，**不用于判权或校验**（校验在解析时做）。
- 一工作区一仓库由 PK 表达；重复绑定是 `ON CONFLICT (workspace_id) DO UPDATE`，所以没有 `repo_id`。

### 3.2 `git_credentials`

```sql
CREATE TABLE IF NOT EXISTS log4stellar.git_credentials (
	workspace_id text NOT NULL,
	credential_id text NOT NULL,
	kind text NOT NULL CHECK (kind IN ('ssh-key','https-token')),
	label text NOT NULL,
	sealed text NOT NULL CHECK (sealed LIKE 'v1:%'),
	created_ms bigint NOT NULL,
	updated_ms bigint NOT NULL,
	PRIMARY KEY (workspace_id, credential_id),
	CHECK (credential_id ~ '^[0-9a-f]{32}$'),
	CHECK (char_length(label) BETWEEN 1 AND 120),
	CHECK (char_length(sealed) <= 16384)
);
```

- `sealed` 是 AES-256-GCM 密文，格式见 §5.1；`CHECK (sealed LIKE 'v1:%')` 是一道「明文不得入库」的结构性闸门——任何忘了加密的写入路径都会被数据库拒绝，而不是静默落盘。
- **没有 `key_id` 列**：首版单密钥（§5.2），记一个永远相同的 keyId 是假信息。
- 没有 `username` 列：SSH 用户名在 URL 里（`ssh://git@host/…`）或由 `core.sshCommand` 的 `-i` 隐含；HTTPS token 的用户名对 GitHub/GitLab 都是固定占位值，存下来只增加一处需要脱敏的字段。
- 秘密明文只在 `PUT /git/v1/credentials` 的请求体里出现一次，落盘即加密，之后任何读路径（含 `GET /git/v1/credentials`、错误信息、日志）都拿不到。

### 3.3 `git_checkpoints`

```sql
CREATE TABLE IF NOT EXISTS log4stellar.git_checkpoints (
	workspace_id text NOT NULL,
	checkpoint_id text NOT NULL,
	name text NOT NULL,
	note text NOT NULL DEFAULT '',
	commit_sha text NOT NULL,
	branch text,
	note_path text,
	note_revision_id text,
	note_sha256 text,
	created_by_actor text NOT NULL,
	created_ms bigint NOT NULL,
	PRIMARY KEY (workspace_id, checkpoint_id),
	CHECK (checkpoint_id ~ '^[0-9a-f]{32}$'),
	CHECK (char_length(name) BETWEEN 1 AND 120),
	CHECK (char_length(note) <= 4000),
	CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
	CHECK (note_sha256 IS NULL OR note_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS git_checkpoints_name
	ON log4stellar.git_checkpoints (workspace_id, lower(name));
CREATE INDEX IF NOT EXISTS git_checkpoints_created
	ON log4stellar.git_checkpoints (workspace_id, created_ms DESC);
```

`name` 在工作区内唯一（大小写不敏感），重复 → 409 `CheckpointExists`（由唯一索引的 `23505` 映射，而不是先查后插——后者两个并发请求都能通过检查）。`note` 是检查点自己的说明字段，`note_path` 指向被钉住的**笔记文件**，两者不要混淆。

### 3.4 检查点如何与笔记版本关联（决定与理由）

**决定：同时记 `note_revision_id` 与 `note_sha256`，`note_path` 记路径。不建外键，不复制内容。**

理由逐条：

1. **为什么记 `storage_file_versions.revision_id` 而不是只记文件树摘要**：`revision_id` 是**精确可寻址的指针**，它能直接喂给现成的 `openRevision(path, revisionId)` 读出当时的内容字节，零新增存储、零新增读路径、完全复用既有 `workspace.history` 能力。只记摘要则做不到「打开检查点那一刻的笔记」——摘要只能证明「内容还是不是那个内容」，不能取回内容。用户对检查点的期待是「回到那个里程碑」，不是「校验那个里程碑」。（首版实现里 `note_revision_id` 取自 `storage.stat(path).etag` 去引号，`openRevision` 的读取路径已经存在，接上即可——见 §6 未完成项。）
2. **为什么同时记 `sha256`**：`storage_file_versions` 行会被保留策略裁剪（`sync-schema.sql` 之外没有版本 GC，但增量同步的保留策略已经明确允许裁剪变更流，版本行的生命周期不该被 git 模块假设为永久）。版本行被裁掉后，`revision_id` 仍然存在但不可读。此时检查点必须能回答「这一版已不可用」，而不是抛 500 或显示别人的内容。`sha256` 是本地即可验证的完整性锚：读取时若版本行已不可读，检查点仍能如实回报 `noteReference.available = false` 并给出摘要，让客户端决定是提示「版本已过期」还是忽略。`note_sha256` 的计算上限是 8 MiB（`noteDigestLimit`）：更大的笔记只钉 `revisionId`，摘要留 `NULL`，避免一次 `PUT /checkpoints` 把整个文件读进内存。
3. **为什么不建外键到 `storage_file_versions`**：外键会让「删除/裁剪版本行」与「删检查点」耦合，并且 `storage_file_versions` 的主键是 `(workspace_id, file_id, revision_id)`，而检查点只知道路径——建外键就得先反查 `file_id`，把一个软指针变成硬约束，收益为零、风险是上一版发布包删文件时被我们的外键挡住（那会直接违反 §6 的「旧包必须继续工作」）。所以检查点对笔记版本是**软引用**，读时解析、缺失降级。
4. **为什么不记整棵文件树的摘要**：commit 本身就是文件树身份。一个检查点已经用 40 位 sha 钉住了代码侧的全部内容，再存一份笔记树摘要是重复记账，而且笔记树本来就由 `storage_change_heads.seq` / 快照机制表达。**一个检查点 = 代码侧一个 commit + 笔记侧至多一个文件版本**，两者都由既有机制寻址。

`note_path`/`note_revision_id`/`note_sha256` 全部可为 `NULL`（纯代码检查点）。

### 3.5 迁移

新模块 `apps/web/git-migrate.mjs`，照 `sync-migrate.mjs` 的模式：

- `gitSchemaCurrent(pool)`：**只读** catalog 探测——`to_regclass` 三张表 + `information_schema.columns` 逐列核对（`git_repositories` 的 `remote_kind`/`remote_branch`/`credential_id`/`last_fetch_commit`，`git_checkpoints` 的 `note_path`/`note_revision_id`/`note_sha256`/`commit_sha`/`branch`）。不拿锁、不跑 DDL；探测为真 → 一次 DDL 都不发。
- `migrateGit(pool)`：`BEGIN` → `pg_advisory_xact_lock(467209224)` → 应用 `git-schema.sql` → `COMMIT`（出错 `ROLLBACK`）。
- **复用同一个 advisory lock id `467209224`**（从 `sync-migrate.mjs` import，不新开）。理由与那边写的一致：三份 schema 必须串行应用，第二个锁 id 只会让新旧迁移互相穿插。
- 触发点是 `apps/web/git-store.mjs` 的 `openGitStore()`：`gitSchemaCurrent(pool)` 为假才 `migrateGit(pool)`。**`rustfs-workspace.mjs` 一行没改**——Git 表与 storage 表没有外键关系，把 Git 迁移塞进 storage 的 open 路径只会让每个存储请求都多付一次探测。**绝不在每次请求时无条件跑 DDL**：`CREATE TABLE IF NOT EXISTS` 也要 `AccessExclusiveLock`，无条件跑会把读者全堵住。
- 命令行入口与 `sync-migrate.mjs` 同构：`node apps/web/git-migrate.mjs <storage.json>`（省略参数时读 `LOG4STELLAR_STORAGE_CONFIG`），成功打印 `migrated: git_repositories,git_credentials,git_checkpoints`。

## 4. API

前缀 `/git/v1`，与 `/static/mount`、`/sync/v1` 并列，挂载在 `auth-gateway.mjs` 的同一处 dispatch 上（新增 `gitting` 判定，见 §7.1）。

通用约定（沿用既有网关，不新增）：

- 非 GET/HEAD 请求必须带 `Origin: https://<host>:<port>`，否则网关在 dispatch 之前就 403（`auth-gateway.mjs` 的 `if (!reading && ctx.get('Origin') !== origin.origin)`）。**这是本项目的固定坑，验收脚本必须带。**
- 请求体：`application/json`，上限 1 MiB；非 JSON → 415 `InvalidContentType`；超限 → 413 `RequestTooLarge`。
- 响应体一律 JSON，错误体一律 `{ "error": "<Code>" }`，**永不包含**远端 URL、凭证、服务端绝对路径、Git 原始 stderr 里的路径片段。
- 所有时间戳是 `bigint` 毫秒（与既有表一致）。

### 4.1 错误码表

| HTTP | Code | 语义 |
|---|---|---|
| 400 | `InvalidRequest` | body 不是对象 / JSON 解析失败 |
| 400 | `InvalidPath` | 关联路径不合法（非法转义、空、含 `..`） |
| 400 | `InvalidBranch` | 分支名不符合 `git check-ref-format` 的简化子集 |
| 400 | `InvalidCommit` | commit sha 不是 40 位十六进制 |
| 400 | `InvalidName` | 检查点名不合法（1–120 可见字符） |
| 400 | `InvalidCredential` | `kind` 不在允许集合 / `secret` 为空 / `secret` 超过 8 KiB |
| 400 | `InvalidRemote` | 远端 URL 的 scheme 不在 `file|https|ssh|git|http` 白名单；或仓库关联时没配远端却发起了 `fetch`/`push` |
| 400 | `ForcePushNotAllowed` | 请求里出现 `force`/`--force` 语义 |
| 403 | `NoPermissions` | 能力不足（与全部其它模块同一个 code） |
| 404 | `NotFound` | method + path 不匹配任何路由 |
| 404 | `RepositoryNotBound` | 该工作区还没有关联仓库 |
| 404 | `CheckpointNotFound` | 检查点不存在（**不区分**「不属于本工作区」，避免泄露存在性） |
| 404 | `CommitNotFound` | 仓库里没有这个 commit |
| 404 | `BranchNotFound` | `ref`/`branch` 参数指向不存在的分支 |
| 409 | `CheckpointExists` | 同名检查点已存在 |
| 409 | `NotFastForward` | **验收场景②**：远端领先，推送被拒 |
| 409 | `RepositoryBusy` | 同一工作区已有并发的 git 写操作在执行 |
| 409 | `CredentialInUse` | 凭证仍被仓库引用 |
| 409 | `RepositoryImmutable` | 只为 `git-credentials.mjs` 的 `--create` 保留：密钥文件已存在时拒绝覆盖（API 不返回它） |
| 412 | `RemoteChanged` | **验收场景②的前置形态**：带 `expectedRemote` 而远端已变 |
| 413 | `RequestTooLarge` | body 超过 1 MiB |
| 415 | `InvalidContentType` | body 不是 `application/json` |
| 422 | `WorkTreeDirty` | **验收场景③**：工作树有未保存修改，切分支被拒 |
| 422 | `NotARepository` | 关联的路径不是 Git 仓库 |
| 422 | `BareRepository` | 关联的路径是裸仓库（无工作树） |
| 422 | `RepositoryLocked` | 仓库被 Git 自身的锁占用（`.git/index.lock` 等）——保留语义，`switchBranch` 目前把它归入 `GitFailed`，见 §6 未完成项 |
| 500 | `GitFailed` | Git 以非预期方式失败（已脱敏） |
| 501 | `GitUnavailable` | 后端没有 Git 方法（本地目录后端、旧发布包） |
| 502 | `RemoteUnavailable` | **验收场景①**：远端不可达 |
| 502 | `RemoteAuthenticationFailed` | **验收场景①**：远端拒绝凭证 |
| 503 | `GitNotConfigured` | 没有配置允许根 `LOG4STELLAR_GIT_WORKSPACE_ROOTS` / 加密密钥 |
| 504 | `RemoteTimeout` | 远端操作超时 |

**状态码语义分工（不得滥用）**：

- **401 / 403 专属自家身份层**。Git 远端拒绝凭证**必须**是 `502 RemoteAuthenticationFailed`，绝不是 401/403——否则「远端说你的部署密钥不对」和「你不是本工作区成员」在客户端不可区分，而后者是本项目明令禁止泄露的存在性信息。
- **412 只表示「声明式前置条件不成立」**（与 `/static/mount` 的 `If-Match` → `412 FileChanged` 同族）。`RemoteChanged` 是调用方声明了 `expectedRemote` 而远端已变。
- **409 只表示「状态冲突，重读后可重试」**（与 `SyncConflict`、`FileExists`、`AccountChanged` 同族）。`NotFastForward` 属于此类：用户 `git pull` 后重推即可。
- **422 表示「请求格式正确、权限足够，但目标仓库的当前状态使该操作无法执行」**。`422` 在既有代码里**零命中**（`grep -rn 422 apps/web/ --include=*.mjs` 无结果），所以本模块明确认领它：它既不是 409（不是「重读后重试」就能过，必须先提交或丢弃本地改动），也不是 412（不是前置条件不匹配）。`WorkTreeDirty`、`NotARepository`、`BareRepository`、`RepositoryLocked` 都是「本地仓库状态不允许」。
- **410 不用**。410 在同步契约里等于「游标太旧，请重新快照」，与 Git 无关；借用会让客户端误触发重同步。

### 4.2 `GET /git/v1/repository`

未关联时**不是错误**：返回 `200` 且 `bound: false`，让客户端一次请求就能决定「显示绑定向导」还是「显示仓库面板」，不必用 404 当控制流。

```json
{
  "bound": true,
  "repository": {
    "remoteId": "3f2a8c91d4e70b56",
    "remoteKind": "file",
    "remoteBranch": "main",
    "defaultBranch": "main",
    "path": "app",
    "credential": { "credentialId": "6a1f…" },
    "lastFetch": { "at": 1730000012000, "commit": "525aadaaf070c7cd77de00de4645b1ea39157293" },
    "lastPush": null,
    "head": { "branch": "main", "detached": false, "commit": "525aadaaf070c7cd77de00de4645b1ea39157293" }
  }
}
```

- `path` 是**相对于匹配到的允许根**的路径（`displayRepositoryPath(root, local_path)`），永不以 `/` 开头、永不含允许根本身；仓库恰好就是根时是 `"."`。
- `remoteId = sha256(remote_url)` 的前 16 位十六进制。**远端 URL 本身永不回显**（§5.3）。运维可用它与 `git remote -v` 的值比对来确认「改的是同一台远端」。
- `credential` 只回 id，永不含 `kind` 之外的内容、密文、明文或加密元数据。
- 尚未 `fetch` 过 → `lastFetch: null`（不是 0 时间戳）。

### 4.3 `GET /git/v1/status`

```json
{
  "repository": { "…与 §4.2 同形…" },
  "workTree": {
    "clean": false,
    "truncated": false,
    "entries": [
      { "path": "a.md", "index": " ", "workTree": "M", "sub": "N...", "untracked": false, "ignored": false },
      { "path": "new.md", "index": "?", "workTree": "?", "untracked": true, "ignored": false },
      { "path": "r.md", "originalPath": "old.md", "index": "R", "workTree": ".", "sub": "N...", "untracked": false, "ignored": false },
      { "path": "c.md", "index": "U", "workTree": "U", "sub": "N...", "untracked": false, "ignored": false, "conflicted": true }
    ]
  },
  "upstream": { "name": "origin/main", "ahead": 0, "behind": 2 }
}
```

- `entries` 直接来自 `git status --porcelain=v2 --branch -z` 的解析结果（`parsePorcelainStatus`）：`index` / `workTree` 是两列状态字符原样（`' '`、`M`、`A`、`D`、`R`、`U`、`?`、`!`），`sub` 是子模块状态串。**不做语义改名**——任何把 `M` 翻译成 `"modified"` 的映射都会丢掉 porcelain 组合态（`MM`、`AM`）的表达力，而客户端本来就要处理这两个字符。
- 重命名/复制条目带 `originalPath`；冲突条目带 `conflicted: true`。
- `entries` 上限 2000 条（`gitPageLimits.maxStatusEntries`），超出时 `truncated: true`。
- `clean` = 除 `# branch.*` 头信息外没有任何条目。未跟踪文件**也算脏**（`--untracked-files=normal`），因为它会阻止切分支。
- 读操作一律带 `--no-optional-locks`，避免只读接口替用户抢 `.git/index.lock`。

### 4.4 `GET /git/v1/log?limit=<n>&branch=<name>&commit=<sha>`

`limit` 默认 50、上限 200（越界 → 400 `InvalidRequest`，非整数同理）；`branch` 先过分支名白名单（否则 400 `InvalidBranch`），`commit` 先过 40 位十六进制（否则 400 `InvalidCommit`）。两者都不给 → HEAD。**不存在的 ref 在 git 里就是「空历史」**，返回 `{"commits": []}`（200），不是 404：一个刚 `git init` 的仓库与一个拼错的分支名，在 `rev-list` 层面无法区分，用 404 会把「空仓库」误报成错误。

```json
{
  "commits": [{
    "commit": "525aadaaf070c7cd77de00de4645b1ea39157293",
    "tree": "…",
    "parents": ["fd43cc879db368e808a98b81005d6f21a8852a15"],
    "author": "T",
    "email": "t@example.invalid",
    "date": "2026-11-22T10:00:00+08:00",
    "subject": "c1",
    "body": ""
  }]
}
```

字段名与 `git log --format` 的占位符一一对应（`%H %T %P %an %ae %aI %s %b`），`date` 是**原始 ISO-8601 字符串**而不是毫秒数：时区偏移是提交的一部分，转成毫秒会丢掉它，而客户端要展示「作者本地时间」。裸仓库（无工作树）也能 `log`；只有 `status`/`switch`/`push` 需要工作树。

### 4.5 `GET /git/v1/commit/<sha>`

`sha` 必须是 40 位十六进制（否则 400 `InvalidCommit`），仓库里不存在 → 404 `CommitNotFound`。

```json
{
  "commit": { "…与 §4.4 单条同形…" },
  "files": [
    { "status": "M", "path": "a.md" },
    { "status": "A", "path": "sub/s.txt" }
  ]
}
```

`files` 来自 `git show --name-status --format= -z <sha>^{commit}`，`status` 是 git 自己的单字母状态（`A`/`M`/`D`/`R100`/`T`/`C`），`files` 上限 2000 条。

### 4.6 `GET /git/v1/branches`

```json
{
  "current": "main",
  "branches": [
    { "name": "main", "commit": "525aada…", "upstream": "origin/main", "current": true },
    { "name": "feature/x", "commit": "fd43cc8…", "current": false }
  ]
}
```

来自 `git for-each-ref --format=… refs/heads`。`current` 顶层字段是当前分支名，detached HEAD 时为 `null`（此时没有任何分支带 `current: true`）。首版不单独列远端跟踪分支：`refs/remotes/*` 已经可以通过 `GET /log?branch=origin/main` 读到。

### 4.7 `POST /git/v1/fetch`（`workspace.git.read`）

请求体可为空（`Content-Type: application/json` + 空 body 即合法）。**尚无远端 → 400 `InvalidRemote`**：仓库关联了但没配远端，是「这个工作区没打算同步」的确定性状态，不是「找不到仓库」；用 404 会让客户端以为绑定丢了。

`git fetch --prune --no-tags <url> +refs/heads/*:refs/remotes/origin/*`——固定 refspec 而不是读仓库自己的配置，远端名固定为 `origin`，永不写 `.git/config`。

```json
{
  "fetched": true,
  "remoteId": "3f2a8c91d4e70b56",
  "remoteBranch": "main",
  "commit": "525aadaaf070c7cd77de00de4645b1ea39157293"
}
```

`commit` 是 `refs/remotes/origin/<remoteBranch>` 抓取后的值，远端该分支不存在时是 `null`。

失败映射（**验收场景①**）：

| 现象（脱敏后的 stderr 关键字） | 返回 |
|---|---|
| `does not appear to be a git repository` / `Could not read from remote repository` / `repository … not found` / `does not exist` / `Connection refused` / `Connection timed out` / `Connection reset` / `Couldn't connect` / `Could not connect` / `Failed to connect` / `unable to access` / `remote end hung up` / `early EOF` / `Network is unreachable` / `Could not resolve host` / `No route to host` / `transport '<x>' not allowed` | **502 `RemoteUnavailable`** |
| `Authentication failed` / `Could not read Username` / `Could not read Password` / `Permission denied (publickey)` / `Invalid username or password` / `401 Unauthorized` / `403 Forbidden` / `Access denied` / `Terminal prompts disabled` | **502 `RemoteAuthenticationFailed`** |
| 超过 `LOG4STELLAR_GIT_TIMEOUT_MS`（默认 60000，合法区间 1000–600000） | **504 `RemoteTimeout`**（子进程 `SIGKILL`） |
| 其它 | 500 `GitFailed` |

`detail` 字段带上脱敏后的一行 stderr（≤400 字符），是这三类失败唯一带 `detail` 的地方——运维需要区分「DNS 挂了」和「部署密钥过期」，否则只能翻服务器日志。

### 4.8 `POST /git/v1/push`（`workspace.git.write`）

请求体字段均为可选。可提交 `branch`、`expectedRemote`（SHA 或 null）、`expectedHead`（SHA）及 `expectedRemoteId`（远端标识）。

- 当前提交和 `expectedHead` 不一致时返回 412 `HeadChanged`。仓库新绑定的远端和 `expectedRemoteId` 不一致时返回 412 `RemoteChanged`。服务端以确认过的 commit 推送，避免稍后读取到其他 HEAD。

- **出现 `force` 且不为 `false`** → `true` 是 400 `ForcePushNotAllowed`，其它非布尔值是 400 `InvalidRequest`。这与 §1.3「永不强制推送」对应。
- `expectedRemote` 出现时先 `git ls-remote --heads <url> refs/heads/<branch>` 读远端，不一致 → **412 `RemoteChanged`**；`null` 表示「断言远端还没有这个分支」。字段缺省则不做检查。
- `branch` 缺省为当前分支；给了但与 HEAD 不同 → 400 `InvalidBranch`（推的是工作树 HEAD，让调用方以为推了别的分支是最坏的 API 设计）；detached HEAD → 404 `BranchNotFound`。
- 推送被远端以非快进拒绝 → **409 `NotFastForward`**。
- 成功：

```json
{
  "pushed": true,
  "branch": "main",
  "commit": "525aadaaf070c7cd77de00de4645b1ea39157293",
  "previousRemoteCommit": "fd43cc879db368e808a98b81005d6f21a8852a15",
  "remoteId": "3f2a8c91d4e70b56"
}
```

`previousRemoteCommit` 是推送**前**远端的值（`null` = 远端原来没有该分支）。「远端已经就是这个 commit」也是成功（`git push` 报 `[ up to date ]`，退出码 0），`previousRemoteCommit` 与 `commit` 相同。

### 4.9 `POST /git/v1/branch`（`workspace.git.write`）

请求体：`{ "name": "feature/x", "create": false, "startPoint": "<sha>" }`（`startPoint` 只在 `create: true` 时生效）。

- 工作树有未提交改动且切换会覆盖 → **422 `WorkTreeDirty`**（**验收场景③**），body 附 `{ "error": "WorkTreeDirty", "detail": "<脱敏后的 git 说明>" }`，并把 git 列出的被拒文件放进 `detail`。
- 目标分支不存在且 `create: false` → 404 `BranchNotFound`。
- `create: true` 且已存在 → 409 `BranchExists`。
- 分离 HEAD 状态下切到分支 → 允许。
- 成功返回 200：

```json
{
  "switched": true,
  "repository": { "…与 §4.2 同形…" },
  "workTree": { "clean": true, "entries": [], "truncated": false }
}
```

**注意**：「脏工作树但切换不会覆盖任何文件」是允许的（Git 本身也允许，实测 `git switch -c new` 在有未提交改动时成功）。判定以 Git 的真实行为为准——不在应用层做「有脏文件就一律拒绝」的过度保守判断，否则用户连改一行后查看别的分支都做不到。契约是「**切换被拒绝时**必须是 422 `WorkTreeDirty` 并说明被拒文件」，而不是「有脏文件就必定拒绝」。

### 4.10 检查点

`GET /git/v1/checkpoints`（按 `created_ms DESC`，最多 200 条）

```json
{
  "checkpoints": [{
    "checkpointId": "9f0a…",
    "name": "v1.0",
    "note": "首个可用版本",
    "commit": "525aadaaf070c7cd77de00de4645b1ea39157293",
    "branch": "main",
    "createdBy": "alice",
    "createdAt": 1730000000000,
    "noteReference": {
      "path": "/notes/plan.md",
      "revisionId": "…",
      "sha256": "…",
      "available": true,
      "currentRevisionId": "…",
      "matchesCurrent": true
    }
  }]
}
```

`noteReference` 为 `null` 表示纯代码检查点。`available: false` 表示笔记文件已被删除（检查点本身仍然有效，只是指针悬空）；`matchesCurrent: false` 表示笔记又改过了，检查点钉住的是旧版本。`revisionId` / `sha256` 在文件存在但没有版本行（刚创建未提交）时可以是 `null`。

`GET /git/v1/checkpoints/<id>` → 直接返回该检查点对象（**不带 `checkpoint` 包裹**，与列表元素同形）；`<id>` 不在本工作区或格式不对 → 404 `CheckpointNotFound`（不区分「不存在」与「不属于你」）。

`POST /git/v1/checkpoints`（`workspace.git.write`）：`{ "name": "v1.0", "note": "…", "commit": "<sha>"（默认 HEAD）, "notePath": "/notes/plan.md", "branch": "main" }` → **201**，body 就是新建的检查点对象（同 §4.10 元素形状）。

- `name` 1–120 可见字符（去控制字符、trim），否则 400 `InvalidName`；同名（**大小写不敏感**，库里有 `UNIQUE (workspace_id, lower(name))`）→ 409 `CheckpointExists`。
- `note` ≤4000 字符，否则 400 `InvalidRequest`。
- `commit` 必须是仓库里真实存在的 commit（`git show --no-patch <sha>^{commit}` 失败 → 404 `CommitNotFound`）；缺省用 HEAD，HEAD 还没有提交（空仓库）→ 404 `CommitNotFound`。
- `notePath` 指向不存在或不是文件的路径 → 400 `InvalidPath`。

`DELETE /git/v1/checkpoints/<id>` → **200** `{ "deleted": true, "checkpointId": "…" }`（不用 204：本模块所有响应都带 JSON body，混合 204 会让客户端多一条分支）；不存在 → 404 `CheckpointNotFound`。

### 4.11 仓库关联与凭证（admin）

`PUT /git/v1/repository`

```json
{ "path": "app", "remote": "/tmp/remotes/app.git", "remoteBranch": "main", "defaultBranch": "main", "credentialId": null }
```

- `path` 必填，**相对于某个允许根**（§5.4）；四层校验全过才算成功，任一失败：不在允许根下/含 `..`/软链逃逸 → 400 `InvalidPath`；`rev-parse --git-dir` 失败 → 422 `NotARepository`；裸仓库 → 422 `BareRepository`。
- `remote` 可选。缺省 = 只关联本地仓库、不同步；此时 `fetch`/`push` 返回 400 `InvalidRemote`。给了则 scheme 必须 ∈ `file|https|ssh|git|http`（`http` 仅限 loopback，否则 400 `InvalidRemote`）；`ext::`、`fd::`、含 `::` 的一律拒绝（400 `InvalidRemote`）。**`file` 远端同样要过四层校验**：只接受允许根之内的裸仓库，否则 400 `InvalidPath`（否则 `file:///etc` 会把宿主机文件变成可读的 git 对象库）。
- URL 里的 userinfo（`user:pass@`）在**落盘前**被剥离，`remote_url` 里只剩 `https://host/path`。凭证必须走 `PUT /git/v1/credentials` 单独登记并用 `credentialId` 引用——把口令塞进 URL 会被 git 写进 `.git/FETCH_HEAD` 与 `ls-remote` 的 stderr。
- `credentialId` 必须是本工作区已存在的凭证（否则 400 `InvalidCredential`）。
- 一个工作区一个仓库：重复 `PUT` 是 **UPSERT**（`ON CONFLICT (workspace_id) DO UPDATE`），`path` 变了也允许——「先解绑再绑定」对一个纯登记接口是多余的仪式。**代价**：`local_path` 被换掉时旧的 `lastFetch`/`lastPush` 会被清空（UPSERT 显式置 NULL），否则会留下指向另一个仓库的过时 commit。
- 返回 200 `{ "bound": true, "repository": { … } }`（始终 200，不用 201：UPSERT 之后「新建」与「更新」对客户端没有行为差别）。

`DELETE /git/v1/repository` → 200 `{ "unbound": true }`；未关联 → 404 `RepositoryNotBound`。**只解绑，不删仓库目录、不删 `.git`、不删凭证**——删用户的代码不在这个接口的职责里。

`GET /git/v1/credentials`（`workspace.git.read`）→

```json
{ "credentials": [{ "credentialId": "6a1f…", "kind": "ssh-key", "label": "部署密钥", "createdAt": 1730000000000, "updatedAt": 1730000000000, "inUse": true }] }
```

**永不返回秘密、永不返回密文、永不返回密钥 id 之外的加密元数据。** `inUse` 表示当前仓库绑定是否引用它。

`PUT /git/v1/credentials`（`workspace.git.admin`）：`{ "credentialId": "<32 位十六进制>"（可选，给则覆盖/轮换）, "kind": "ssh-key|https-token", "label": "…", "secret": "<私钥或 token>" }` → **201**，只回元数据。`label` 1–120 字符；`secret` 1–8192 字符（`gitSecretLimit`）；`kind` 不在集合内 → 400 `InvalidCredential`。轮换（同 id 再 PUT）立刻覆盖 `sealed`，旧值不可恢复。

`DELETE /git/v1/credentials/<id>` → 200 `{ "deleted": true, "credentialId": "…" }`；格式不对 → 400 `InvalidCredential`；不存在 → 404 `NotFound`；仍被仓库引用 → **409 `CredentialInUse`**（先解绑或改绑其它凭证）。

## 5. 安全

### 5.1 凭证加密（AES-256-GCM，密钥文件在盘上）

`apps/web/account-security.mjs` 里**只有** `createHash` / `randomInt` / `timingSafeEqual`，**没有任何加密原语**（全仓 `grep -rn createCipheriv apps/web/` 零结果）。所以本模块自带 `apps/web/git-credentials.mjs`，只用 Node 内置 `node:crypto`，**不引入任何新依赖**（`apps/web/package.json` 仍然没有 git/加密库）。

- 算法 AES-256-GCM，96 位随机 IV，128 位认证标签（`ivBytes = 12`、`tagBytes = 16`、`keyBytes = 32`）。
- **密钥是磁盘上的一个文件，不是环境变量**：`<LOG4STELLAR_STORAGE_CONFIG 所在目录>/git-secret`（`secretPathFor` → `secretFileName = 'git-secret'`），内容为 64 个十六进制字符 + 换行，权限必须 `0600`。这与既有 `auth/secret` 的组织方式一致：密钥跟数据目录走，跟着备份走。
  - 生成：`node apps/web/git-credentials.mjs secret --create [storage.json]`，等价于 `openssl rand -hex 32 > <dir>/git-secret && chmod 600`。
  - 查看（只打印路径，永不打印密钥）：`node apps/web/git-credentials.mjs secret --status [storage.json]`。
  - 文件缺失 → **503 `GitNotConfigured`，绝不静默生成**。静默生成是最坏的一种「能用」：第一次 `PUT /credentials` 时悄悄造一个密钥，运维以为备份了配置，迁移机器后所有凭证永久解不开且没有任何错误指向成因。
  - 文件不可读 / 不是 64 位十六进制 → 503 `GitNotConfigured`，**也绝不重新生成**（截断的密钥文件必须被当成损坏，而不是当成「没有」）。
- 落盘格式：`v1:` + `base64(iv ∥ ciphertext ∥ tag)`，无 keyId、无明文元数据。`sealed` 上的 `CHECK (sealed LIKE 'v1:')` 是第二道闸：任何把明文写进这一列的实现会立刻被数据库拒绝，而不是安静地存下秘密。
- 附加认证数据（AAD）= `'l4s-git-credential\n' + workspaceId + '\n' + credentialId`：**密文复制到另一个工作区/凭证行后解不开**，这是防跨工作区搬运的结构性保证，有专门测试。
- 解封失败（tag 不匹配、AAD 不符、格式不认识）→ 400 `InvalidCredential`，绝不回退到「当作没有凭证」从而莫名以匿名身份推送。

#### 密钥文件是加密根，不可轮换、不可丢

`<storage 目录>/git-secret` 是**所有 Git 凭证的加密根，也是后续 TOTP seed 等账户机密预定的加密根**：

- **不要轮换它。** 首版没有实现「当前密钥 + 上一把密钥」的双密钥读路径，轮换 = 用新密钥重新封装每一行；这个能力**没有实现**（见 §5.2）。
- **丢了它 = 所有已存凭证永久失效。** 数据库里的 `sealed` 变成不可解密的字节，只能删掉重录。备份策略必须包含这个文件，且它不在数据库备份里。
- 它**不在** `apps/web/` 的发布包里（不在 `serverFiles` 白名单），所以升级/回滚发布包不会覆盖它。

### 5.2 轮换：首版单密钥，轮换是未完成项

首版**只有一把密钥**，没有 keyId，没有 previous-key 读路径，也没有 `--rekey`。

- 换密钥的唯一方式：删掉 `git-secret`、重建、**把所有凭证重新 `PUT` 一遍**（旧的 `sealed` 已不可解）。这是一个运维手工动作，不是 API。
- 已知影响：无法做到「轮换期间服务持续可读」。参见 §6 的未完成项。
- 之所以不在首版做半套：一个只有写路径没有读回路的双密钥方案，会在**密钥删掉的那一刻**让所有 `openCredential` 抛错，看起来像安全加固，实际比单密钥更脆。

### 5.3 绝不回显

- 远端 URL：只回 `remoteId`（sha256 前 16 位）。日志里只有 `workspaceId` 与 `remoteId`。
- 凭证：明文只在 `PUT` 请求体里出现一次；响应、列表、错误、日志全部零出现。密文也不出现。
- 服务端绝对路径：只回相对于允许根的部分。
- **Git 子进程的 stderr 必须脱敏后才能进入响应或日志**：`git-contract.mjs` 的 `sanitizeGitMessage(message, { remoteUrl, localPath })` 按顺序做：
  1. 删 ANSI 转义（git 的彩色错误串会让按关键字分类全部失效）；
  2. 把**已知的** `remoteUrl` 与 `localPath`、以及 `file://<localPath>` 替换为 `<redacted>`；
  3. 把任何 `scheme://user:pass@host` 的 userinfo 剥掉（`([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@` → `$1`）；
  4. 把**剩下的**任何 `file://…` 替换为 `<redacted>`（即使调用方没把路径传进来——`file://` 后面一定是宿主机绝对路径）；
  5. 把 `-----BEGIN/END … PRIVATE KEY-----` 替换为 `<redacted>`（截断的私钥没有 END 标记，所以单标记也要删）；
  6. 砍掉 http(s) URL 的查询串（token 藏在 `?` 后面）；
  7. 把 token 形状串（`ghp_…`/`gho_…`/`xox[baprs]-…`/`AKIA[0-9A-Z]{16}`/`(token|password|secret|key)=…`）替换为 `<redacted>`；
  8. 压成单行、`trim`、截断到 400 字符。

  只有远端相关失败（502/504）会带 `detail`，且 `detail` 就是这一步的产物。对应测试：`sanitizeGitMessage` 的单元测试覆盖上述每一类输入；集成测试把远端设成一个带 `user:hunter2@` 的 URL，断言响应体里不含 `hunter2`、不含 `/tmp/` 绝对路径。

### 5.4 路径穿越与可关联范围

**允许根**：由部署方通过 `LOG4STELLAR_GIT_WORKSPACE_ROOTS` 提供工作区到绝对目录数组的 JSON，例如 `{"team-a":["/srv/git/team-a"],"team-b":["/srv/git/team-b"]}`。不同工作区的实际路径不得重叠，包括符号链接指向的目录。未配置、路径不可解析或授权目录重叠时返回 503 `GitNotConfigured`。

四层校验，缺一层就等于「任意路径读取」，每层都有测试（`apps/web/git-repository.test.mjs`）：

| 层 | 检查 | 挡住的攻击 | 失败 |
|---|---|---|---|
| 1 | `resolveWithinRoot(roots, requested)`：拒绝空串、NUL、归一后以 `..` 开头或含 `/../` 的路径；绝对路径必须落在某个允许根之下（`relative()` 不以 `..` 开头） | `../../etc`、`/etc/shadow`（当它不在任何根下时） | 400 `InvalidPath` |
| 2 | `await realpath(candidate)`：先解开软链 | `allowed/link → /etc/repo`（字符串看是在根内，实际在根外） | 400 `InvalidPath` |
| 3 | **realpath 之后再** `isInsideRoot(realpathedRoot, realpathedPath)` | 层 1 之后才出现的软链、`..` 之外的挂载逃逸 | 400 `InvalidPath` |
| 4 | `git rev-parse --git-dir --is-bare-repository --absolute-git-dir` 成功，且 **`gitDir` 也必须在允许根内**（`isInsideRoot(root, gitDir)`） | `.git` 文件里写 `gitdir: /允许根之外/x` 的「gitfile 逃逸」（实测可行：`printf 'gitdir: /tmp/outside.git' > fake/.git` 后 `rev-parse --absolute-git-dir` 真的返回 `/tmp/outside.git`） | 400 `InvalidPath`（gitfile 逃逸）/ 422 `NotARepository`（不是仓库） |

判权先于这四层：能力校验在 `serveGitRequest` 第一步完成（§2.2），四层校验在 `gitBindRepository` 里，即开发者连「这个路径存不存在」都问不出来。层 2/3 的顺序是反的会引入漏洞，所以顺序本身是契约。

**每次操作都重新校验一遍**：`git-service.mjs` 的 `handle()` 在每次 `status`/`log`/`push` 前都用**当前的** `gitRoots(environment)` 重新 `openGitRepository`。允许根可以在运行期被运维改掉，昨天合法的绑定今天不该继续合法。校验失败（`NotARepository` / `InvalidPath`）映射为 404 `RepositoryNotBound`——客户端需要重新绑定，而不是重试。

**`file` 远端同样过这四层**（`locateFileRemote` → `locateRepositoryPath`）：否则 `file:///etc` 或 `file://$HOME/.ssh` 会把宿主机目录变成可读的 git 对象库。绑定时校验失败是 400 `InvalidPath`；绑定之后（远端被删/被改软链）校验失败映射为 502 `RemoteUnavailable`（见 §4.7）。

### 5.5 命令注入

- 所有 Git 调用一律 `spawn(gitCommand, argv, { shell: false })`，`argv` 是**数组**。**没有 `exec`，没有 `shell: true`，没有字符串拼接**。这是唯一一条不可协商的实现约束：`git-service.mjs` 里没有任何地方把用户输入插进字符串。
- argv 形状固定为 `git -c <key>=<value> … <subcommand> <args…>`（`gitArgv`），`-c` 只用来**收紧**行为，不来自用户输入。
- 分支名先过 `gitBranchNameValid`（`git check-ref-format` 的简化子集：不以 `-` 或 `/` 开头、不以 `/` 或 `.` 结尾、不含空白/`~^:?*[\`/控制字符、不含 `..`、不含 `@{`、不含 `//`、不是 `HEAD`），所以 `--upload-pack=evil` 这类「看起来像参数」的分支名根本不可能进 argv。
- commit 先过 `/^[0-9a-f]{40}$/`；检查点 id 先过 `/^[0-9a-f]{32}$/`；checkpoint 名去掉控制字符并限 120 字符。
- 远端 URL 走 scheme 白名单（`parseGitRemote`），且**含 `::` 的一律拒绝**——`ext::sh -c "…"` 与 `fd::7` 走的是 scp-like 语法的解析路径，不显式拒绝就会被当成 ssh 远端。
- 环境硬化（`gitEnvironment()` **从零构建**，不合并 `process.env`，所以调用方无法意外放宽）：
  - `GIT_ALLOW_PROTOCOL` = `https:ssh`（`gitAllowedProtocols()`）。`git://` 无认证无加密，永不允许；`file` 只在 `allowFile: true` 时追加，而 `allowFile` 只来自 `locateFileRemote` 的校验结果；`http` 只在 loopback 时追加。`ext` / `fd` 永不在集合里。
  - `GIT_TERMINAL_PROMPT=0` —— 永不在子进程里等输入（否则一次 fetch 会挂到超时）。
  - `SSH_ASKPASS_REQUIRE=never` —— 不让 ssh 弹出 askpass。
  - `GIT_CONFIG_NOSYSTEM=1`、`GIT_ATTR_NOSYSTEM=1` —— 忽略 `/etc/gitconfig` 与服务账号自己的 dotfile；否则宿主机 `url.<x>.insteadOf` 能把我们的远端重定向到别处。
  - `LANG=C`、`LC_ALL=C` —— 让 stderr 的匹配模式稳定（错误分类依赖英文关键字）。
- `-c` 固定覆盖（`pinnedConfig`，**每一条都有测试断言它真的出现在 argv 里**）：

| 键 | 值 | 为什么必须钉死 |
|---|---|---|
| `core.hooksPath` | 服务端自建的空目录（`mkdtemp`） | 仓库自带的 `.git/hooks/pre-push` 会在推送时**以服务进程身份执行任意代码**。实测：有可执行 `pre-push` 时普通 `git push` 会执行它，加 `-c core.hooksPath=<空目录>` 后不执行；两个方向都有测试（用我们的 `pushBranch` 不执行、用裸 `git push` 执行作为对照） |
| `core.fsmonitor` | `false` | 仓库配置里的 fsmonitor hook 同样会执行 |
| `uploadpack.packObjectsHook` | 空 | 同上，作用于 `upload-pack` |
| `core.sshCommand` | `ssh` | 否则仓库配置里的 `sshCommand` 就是「下次 fetch 执行任意命令」；凭证路径会在此之后再追加一条带 `-i` 的 `core.sshCommand`（靠后的 `-c` 覆盖靠前的） |
| `core.pager` | `cat` | 不让 git 起分页器（分页器会吃掉 stdout） |
| `safe.directory` | `*` | 受管仓库的 owner 可能与服务进程不同，否则 git 直接拒绝操作 |

- `-c credential.helper=`（空）在带 HTTPS token 时追加，且 `GIT_ASKPASS` 指向一次性 0700 脚本、token 通过**环境变量** `L4S_GIT_TOKEN` 传给该脚本——token 不出现在 argv 里（argv 在 `/proc/<pid>/cmdline` 对同机用户可读）。
- 超时：`LOG4STELLAR_GIT_TIMEOUT_MS`（默认 60000，合法区间 1000–600000，越界回落默认值），超时 `SIGKILL` 子进程 → 504 `RemoteTimeout`。测试断言子进程真的被 kill（`/proc/<pid>` 消失、`signal === 'SIGKILL'`）。

### 5.6 并发

同一工作区的 Git 操作（`fetch`/`push`/`branch`）在**进程内**按 `workspaceId` 串行化，第二个并发请求立刻 → **409 `RepositoryBusy`**（不排队等待：排在 60 s 的 fetch 后面看起来和挂死一样）。读操作（`status`/`log`/`branches`/…）不加锁，但用 `--no-optional-locks` 避免只读接口替用户抢 `.git/index.lock`。

局限（见 §6）：锁是**进程内**的 `Map`，多实例部署时两个进程仍可同时写同一个仓库。真正的串行化需要 `.git` 之外的文件锁或数据库行锁，首版没做。

临时目录（`core.hooksPath` 的空目录、凭证脚本的 scratch 目录）每个进程各建一个，`mkdtemp` 在 `tmpdir()` 下，**进程退出时同步删除**（`git-repository.mjs` 的 `removeOnExit`）。不删的话每次重启都会在 `/tmp` 留一份，开发期间就攒了一百多个 `l4s-git-hooks-*`。

## 6. 回滚与迁移

### 6.1 升级（旧 → 新）

`apps/web/git-migrate.mjs`（或首次 `openGitStore()`）按 §3.5 建立 3 张新表。既有 9 张表（5 storage + 4 sync）**零改动**：没有 `ALTER`、没有新增列、没有新外键，所以旧发布包（`web-markdown-preview-01`）与新发布包可以同时读写同一个库。旧数据无需迁移：Git 关联是全新概念，没有历史数据要搬。

**需要额外备份的**：`<LOG4STELLAR_STORAGE_CONFIG 所在目录>/git-secret`（§5.1）。它**不在**数据库备份里、也不在发布包里，丢了就等于所有已存凭证作废。新表初始为空，本身不需要备份。

### 6.2 回滚（新 → 旧）

直接切回上一版发布包即可，**不需要反向 DDL**。

- 旧包代码里**没有任何** `git_*` 表的引用（`grep -rn 'git_' apps/web/*.mjs` 在旧包里零命中），这 3 张表对它是完全不可见的死数据：既不参与查询，也不产生约束——因为**没有外键**（§3.1 明确说明为何不建 `REFERENCES storage_workspaces`）。所以旧包删工作区、删文件、删版本行都不会被我们的表挡住。这一点是特意设计的：如果当初加了外键，回滚到旧包后「删除工作区」会失败，用户会看到删不掉的工作区。
- 回滚期间**新表里的数据不会被读取**，用户看到的「没有关联仓库」是预期行为；再次升级回来数据仍在。
- 实测方式与结果见 `交付说明/task7-git-integration.md` §3：用 `releases-baseline/` 里的旧包对**已迁移的库**跑一次 `serve-demo.mjs --release`，登录、读写笔记、确认 200，再确认旧包能正常删除工作区与版本行。

### 6.3 未完成项与已知限制

契约里承诺了、实现里没有的（按影响排序）：

| # | 未完成 / 限制 | 影响 | 补齐方式 |
|---|---|---|---|
| 1 | **凭证密钥轮换**（§5.2） | 换密钥只能删文件重建 + 手工重录全部凭证；无法做到轮换期间持续可读 | 加 `key_id` 列 + 双密钥读路径 + `--rekey` 命令。注意：首版单密钥意味着**现在不做这件事也不会比双密钥更不安全**，只是运维成本高 |
| 2 | 并发锁是**进程内**的（§5.6） | 多实例部署时两个进程可以同时 push 同一个仓库，git 自己的 ref 锁会挡住部分情况，但 `RepositoryBusy` 不再可靠 | 换 `pg_advisory_lock`（按 `hash(workspaceId)` 取锁 id）或 `.git` 旁的文件锁 |
| 3 | `note_revision_id` 只记录、**没有读取端点** | 检查点能告诉你「当时是这个版本」，但 API 还没有「读出那个版本的笔记」的入口；客户端目前得自己去 `GET /static/mount?versions=1` | 在 `GET /git/v1/checkpoints/<id>` 上加 `?note=1`，或直接复用既有 `openRevision` 的读接口（能力已经存在，缺的是路由） |
| 4 | `RepositoryLocked`（422）**已定义但未被区分** | `.git/index.lock` 被占时返回 500 `GitFailed` 而不是 422 `RepositoryLocked` | 在 `switchBranch`/`pushBranch` 的 stderr 匹配里加 `index.lock` / `cannot lock ref` 分支 |
| 5 | `git://` 协议**不支持**（§5.5 白名单只有 `https:ssh`） | 内网匿名的 `git://` 远端无法关联 | 有意为之：`git://` 无认证无加密。需要时改 `gitAllowedProtocols` 一处 |
| 6 | 一个工作区**一个仓库**（§1.2） | 多仓库需要把 `git_repositories` 的 PK 改成 `(workspace_id, repo_id)`，属纯增量演进 | 见 §1.2 |
| 7 | `http://` 只允许 loopback | 内网明文 HTTP 的 Git 服务（非 loopback）无法关联 | 与 5 一起改 |
| 8 | Web Git 入口覆盖工作树、历史、Fetch 和 Push | 仓库绑定、凭证管理、分支切换和检查点由已授权的 API 提供 | 根据后续验收补充对应界面 |

## 7. 实现要点（服务端行为约束）

### 7.1 挂载

`auth-gateway.mjs` 新增 `const gitting = ctx.path === gitPath || ctx.path.startsWith(gitPath + '/')`，与 `syncing` **并列出现在全部 4 处判定**：
1. `if (!login && !api && !mounted && !syncing && !gitting && !workbench)` 的早退；
2. 方法白名单 `if ((!reading && !activity && !signOut && !mounted && !syncing && !gitting) || …)` —— Git 路由自己决定 405，网关放行；
3. `if (!mounted && !syncing && !gitting && !canReadWorkspace(...))` 的登录门豁免；
4. `else if (mounted || syncing || gitting)` 的 dispatch：`syncing ? serveSyncRequest : gitting ? serveGitRequest : serveWorkspaceFile`。

`workspace-files.mjs` 的 `capabilityForRequest` **不扩展**（Git 用独立路由，不挤进 `/static/mount` 的请求形态表）。新增 `capabilityForGitRequest` 放在 `git-contract.mjs`，与 `capabilityForSyncRequest` 同构。

### 7.2 后端方法

`authorizeWorkspace` 的 `backendMethods` 增加三组，把已有实现的方法门控起来（方法不存在则留在 facade 上 `undefined`，`serveGitRequest` 用 `requireGitBackend()` 返 501 `GitUnavailable`，与 `requireSyncBackend` 同构）：

| capability | 方法名 |
|---|---|
| `workspace.git.read` | `gitRepository`, `gitStatus`, `gitLog`, `gitBranches`, `gitCommit`, `gitFetch`, `gitCheckpoints`, `gitCredentials` |
| `workspace.git.write` | `gitPush`, `gitSwitchBranch`, `gitCreateCheckpoint`, `gitDeleteCheckpoint` |
| `workspace.git.admin` | `gitBindRepository`, `gitUnbindRepository`, `gitPutCredential`, `gitDeleteCredential` |

## 8. 验收矩阵

四条用户点名的场景，各自的最小可复现路径（详见 `交付说明/task7-git-integration.md`）：

| # | 场景 | 构造 | 期望 |
|---|---|---|---|
| ① | 凭证失效 | 把远端路径 `chmod 000` / 整目录移走 / 改成不可达的 `ssh://git@127.0.0.1:1/x.git` / 改成连不通的 `https://127.0.0.1:9/x.git`，或删掉被引用的凭证行，再 `POST /git/v1/fetch` 与 `/push` | 502 `RemoteAuthenticationFailed` / 502 `RemoteUnavailable`（**绝不是 401/403**）；响应体不含远端绝对路径；凭证被引用时 `DELETE /credentials/<id>` 为 409 `CredentialInUse` |
| ② | 非快进推送 | 另起一个克隆推一个新提交到裸远端，受管仓库落后，`POST /git/v1/push` | 409 `NotFastForward`，且**远端 ref 未移动**（`git rev-parse` 前后一致）；带过期 `expectedRemote` 时先 412 `RemoteChanged`；带 `force: true` 时 400 `ForcePushNotAllowed` |
| ③ | 工作树有未保存修改 | 改动一个在两分支间不同的文件，再 `POST /git/v1/branch` 切到另一分支 | 422 `WorkTreeDirty`，`detail` 里列出被拒文件；`GET /status` 的 `workTree.clean` 为 `false` 且能看到该改动；**工作树内容逐字节不变**、HEAD 仍是原分支 |
| ④ | 切分支后的状态 | `POST /git/v1/branch {name, create:true}`，然后 `GET /status` + `GET /branches` + `GET /log` | `repository.head.branch` 是新分支、`workTree.clean` 为真；`branches.current` 与 `git rev-parse --abbrev-ref HEAD` 一致；`log` 首条与 `git log -1 --format=%H` 一致 |

## 9. 需要复核的取舍

1. **`fetch` 归入 `read`**（§2.1）。若认为「任何触达远端的动作都算 write」，改一行能力表即可，但会让只读者无法看远端进度。
2. **422 认领**（§4.1）。422 在本仓库此前无任何语义，本文件首次赋予它「本地仓库状态不允许」。若不接受，可退回 409，代价是「脏工作树」与「非快进」在客户端不可区分。
3. **检查点软引用笔记版本**（§3.4）。不建外键的代价是可能出现 `available: false`；收益是不把 git 迁移绑死到 storage 表的删除语义上。
4. **远端 URL 完全不可回显**（§5.3）。严格到连 `file` 远端也只回 `identity`。收益是「绝不可能泄漏」，代价是运维无法从 API 直接读出「现在是哪个远端」，只能靠 `identity` 比对或看数据库。
5. **不做服务端 clone**（§1.2）。若用户期望「贴一个 GitHub URL 就能用」，那需要单独评估：网络可达性、大仓库超时、凭证校验时机、克隆失败的回滚。
6. **`entries` 原样暴露 porcelain 状态字符**（§4.3）。好处是不丢 `MM`/`AM` 组合态、不需要维护一张映射表；代价是客户端必须懂 `git status` 的列语义。
7. **`GET /repository` 未绑定时返回 200 + `bound:false`**（§4.2）。与 `/git/v1/checkpoints/<id>` 用 404 不一致；理由是「未绑定」是首次使用的**正常状态**，而「检查点不存在」是错误。
8. **`log` 对不存在的 ref 返回空数组而不是 404**（§4.4）。空仓库与拼错的分支名在 git 层无法区分，宁可返回空让客户端显示「没有提交」。
9. **密钥不可轮换**（§5.2/§6.3 第 1 项）。这是首版最明确的取舍：宁可不做，也不做半套。

## Web 验收入口

在隔离验收工作区用管理员 API 关联获准的仓库。登录后打开 Explorer 标题栏的 Git 图标，或在命令面板运行 `Log4Stellar: Git`。

1. 选择工作树状态与提交历史，核对当前分支、改动路径和提交。
2. 打开 Fetch 或 Push，取消确认后检查远端状态未变化。
3. 确认 Fetch。当前分支和所配置的远端分支一致后再确认 Push，核对确认框的提交和远端新增的提交一致。
4. 换用只读成员执行 Push，确认服务端拒绝。把远端改变后重试旧确认，确认客户端提示重新拉取。

前端使用现有会话和工作区身份请求服务器，凭证由服务端管理。回滚到尚无 Git 前端的包后，该命令消失，已有关联表保留。

运行 `node --test apps/web/git-ui.test.mjs apps/web/git-contract.test.mjs apps/web/git-files.test.mjs apps/web/git-repository.test.mjs` 进行离线回归。真实 Git 测试只访问各用例创建的临时仓库。

## Web 面板验收

从资源管理器的 Git 图标或命令面板进入 Git。用已经绑定的工作树验证以下操作。

1. 拉取远端引用，确认工作树当前提交保持一致，远端跟踪引用已刷新。
2. 使用「切换分支」选择另一个本地分支，重新打开 Git 面板确认分支和显示的提交。工作树有未提交改动时，界面提示提交或暂存，现有内容保留。
3. 切回配置的远端分支，拉取并确认当前提交后推送。核对远端分支指向同一提交。
4. 由第二个工作树推进远端，再从旧的拉取记录尝试推送。界面提示远端已变更，远端提交保留。再次拉取后，分叉的历史仍由 Git 非快进检查保护。

部署方通过 `LOG4STELLAR_GIT_WORKSPACE_ROOTS` 给验收工作区分配专用目录，并由 Owner 调用 `PUT /git/v1/repository` 绑定。可用允许根内的裸仓库作为测试远端。正式 GitHub 仓库使用配置的 HTTPS 或 SSH 远端及相应凭据。

## HTTPS 与 SSH 环境配置

- HTTPS 默认使用系统信任的 CA。内网 Git 使用专用 CA 时，设置 LOG4STELLAR_GIT_HTTPS_CA_FILE 指向受保护的 CA 文件。Git Token 仍从工作区凭据入口配置。需要指定登录名的 Git 服务可通过 LOG4STELLAR_GIT_HTTPS_USERNAME 配置，默认用户名为 x-access-token。
- SSH 工作区使用独立 SSH 私钥。部署时通过可信渠道取得 Git 服务主机公钥，写入受保护的 known_hosts，再把 LOG4STELLAR_GIT_SSH_KNOWN_HOSTS 指向该文件。已配置此项时，服务器拒绝未登记或已变更的主机密钥。
- Log4Stellar 的代码提交、分支和标签以 GitHub 远端为准，本地 Git 工作树用于开发。RustFS 存储笔记和附件的文件版本。
