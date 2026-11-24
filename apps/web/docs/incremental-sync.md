# 增量同步契约（v1，提案）

本文件是「增量同步服务」的实现契约，与 `docs/workspace-access.md` 并列为客户端与服务端的共同判据。PC 客户端、Android 客户端与服务端可以并行开发，凡本文件写明的字段、状态码与顺序，实现与测试都必须一致；如需修改契约，先改本文件再改代码。

配套的常量与校验函数在 `apps/web/sync-contract.mjs`，测试在 `apps/web/sync-contract.test.mjs`。**本文件描述协议，不描述实现**：这一段只定义「服务端必须表现出什么行为」，不规定代码结构。

## 1. 基本概念与不变量

| 概念 | 定义 |
|---|---|
| 变更（change） | 一次逻辑操作的结果，一行 `storage_changes`。保存、重命名、删除、恢复、回滚、冲突各是一种 `kind` |
| 序号（`seq`） | **每个工作区独立**、从 1 开始、严格递增的整数。同一工作区内 `seq` 的顺序即提交顺序 |
| 游标（cursor） | 不透明字符串，编码「我已经应用到第 `seq` 条变更」以及它属于哪个工作区 |
| 快照（snapshot） | 某个 `seq` 上工作区的全量视图，物化为一次性清单，可翻页读取 |
| 冲突副本（conflict copy） | 服务端在两个设备同时写同一路径时，**额外**保留下来的那份内容，是一个真实文件、有独立 `file_id` |

三条不可让步的不变量：

1. **同一工作区内，`seq` 的可见顺序就是提交顺序。** 客户端看到 `seq=7` 时，`seq=1..6` 必然已经可见。允许缺号（保留策略会裁剪），绝不允许乱序。
2. **变更行不可变。** 一行一旦写入就不再修改；重命名、回滚、恢复都是**新增**一行，绝不改写历史。这与 `storage_file_versions` 只追加的策略一致。
3. **一次逻辑操作对每个受影响的路径恰好产生一条变更，同一次操作的变更共享一个 `opId`。** 单路径操作因此恰好一条；批量操作（递归删除、批量恢复、覆盖式重命名）按路径各一条，`opId` 相同、`seq` 连续，客户端把它们当作一个原子批次应用（§8.6）。重试、崩溃重放、并发重放都不得产生第二条（见 §5）。冲突是这条规则还额外多出一条的情形：冲突会额外产生一条 `file.conflicted`，因为服务端确实做了第二件事——留下了第二份内容。

**非目标**：本文不含端到端加密（E2EE）、不做实时推送（客户端靠长轮询或前台轮询）、不做跨工作区同步、不做内容级自动合并（CRDT/行级 merge 都不做，冲突一律保留两份，与 Joplin 的默认行为一致）。E2EE 的设计影响见 §10。

## 2. 变更流数据模型

### 2.1 表结构

沿用 `workspace-schema.sql` 的风格：全限定 schema 名、`bigint` 毫秒时间戳、`IF NOT EXISTS` 内联索引、一列一行。**注意 PostgreSQL 没有 `STRICT`**，`STRICT` 是 SQLite 的建表修饰符，PG 侧的 DDL 里不得出现；同理也不要用 `AUTOINCREMENT`。

```sql
CREATE TABLE IF NOT EXISTS log4stellar.storage_change_heads (
	workspace_id text PRIMARY KEY REFERENCES log4stellar.storage_workspaces(id),
	seq bigint NOT NULL DEFAULT 0 CHECK (seq >= 0),
	retained_floor bigint NOT NULL DEFAULT 1 CHECK (retained_floor >= 1),
	updated_ms bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS log4stellar.storage_changes (
	workspace_id text NOT NULL REFERENCES log4stellar.storage_workspaces(id),
	seq bigint NOT NULL CHECK (seq > 0),
	change_id uuid NOT NULL,
	kind text NOT NULL CHECK (kind IN (
		'file.created', 'file.saved', 'file.renamed', 'file.deleted',
		'file.restored', 'file.rolledback', 'file.conflicted',
		'directory.created', 'directory.renamed', 'directory.deleted'
	)),
	entry_kind smallint NOT NULL CHECK (entry_kind IN (1, 2)),
	path text NOT NULL,
	from_path text,
	conflict_path text,
	file_id uuid,
	revision_id uuid,
	parent_revision_id uuid,
	sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	size_bytes bigint CHECK (size_bytes >= 0),
	trash_id uuid,
	device_id text,
	idempotency_key text,
	idempotency_fingerprint text CHECK (idempotency_fingerprint ~ '^[0-9a-f]{64}$'),
	-- Grouping id for multi-path operations (§8.6): every row of one logical operation
	-- shares it. Declared here because invariant 3 and §8.6 both depend on it.
	op_id uuid,
	-- The base revision the client declared, kept verbatim so the conflict detail (§8.7) can
	-- report it: the fingerprint is a one-way hash and cannot be inverted.
	base_revision uuid,
	created_ms bigint NOT NULL,
	PRIMARY KEY (workspace_id, seq),
	UNIQUE (workspace_id, change_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS storage_changes_idempotency_idx
	ON log4stellar.storage_changes (workspace_id, idempotency_key)
	WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS storage_changes_op_idx
	ON log4stellar.storage_changes (workspace_id, op_id)
	WHERE op_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS storage_changes_created_idx
	ON log4stellar.storage_changes (workspace_id, created_ms);

CREATE INDEX IF NOT EXISTS storage_changes_path_idx
	ON log4stellar.storage_changes (workspace_id, path, seq DESC);

CREATE TABLE IF NOT EXISTS log4stellar.storage_snapshots (
	id uuid PRIMARY KEY,
	workspace_id text NOT NULL REFERENCES log4stellar.storage_workspaces(id),
	seq bigint NOT NULL CHECK (seq >= 0),
	entry_count integer NOT NULL CHECK (entry_count >= 0),
	created_ms bigint NOT NULL,
	expires_ms bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS storage_snapshots_workspace_idx
	ON log4stellar.storage_snapshots (workspace_id, expires_ms DESC);

CREATE TABLE IF NOT EXISTS log4stellar.storage_snapshot_entries (
	snapshot_id uuid NOT NULL REFERENCES log4stellar.storage_snapshots(id) ON DELETE CASCADE,
	path text NOT NULL,
	kind smallint NOT NULL CHECK (kind IN (1, 2)),
	file_id uuid NOT NULL,
	revision_id uuid NOT NULL,
	sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	size_bytes bigint CHECK (size_bytes >= 0),
	modified_ms bigint NOT NULL,
	PRIMARY KEY (snapshot_id, path)
);
```

字段说明（只列需要解释的）：

| 字段 | 说明 |
|---|---|
| `seq` | 工作区内单调序号，见 §2.2。它是 `PRIMARY KEY (workspace_id, seq)` 的后半段，扫描天然有序 |
| `path` | 变更落定**之后**的路径。`file.deleted` 记录删除前的路径；`file.renamed` 记录**新**路径 |
| `from_path` | 仅 `*.renamed` 有值，重命名前的路径 |
| `conflict_path` | 仅 `file.conflicted` 有值，冲突副本的路径；`path` 仍是客户端请求的那个路径 |
| `revision_id` / `parent_revision_id` | 与 `storage_file_versions` 同义；`parent_revision_id` 是客户端声明的 `baseRevision`，用于证明「我确实基于它写」，也让审计能还原分叉点 |
| `sha256` / `size_bytes` | 变更后内容的摘要。**只存摘要，绝不在变更行里内联字节**，这样以后加 E2EE 不必改协议 |
| `trash_id` | 删除产生的回收站条目 ID，客户端可用它发起恢复 |
| `device_id` | 产生变更的设备标识，参与冲突副本命名（§6.3） |
| `idempotency_key` / `idempotency_fingerprint` | 幂等键与其请求指纹，`NULL` 表示该变更不参与幂等（仅供内部操作用）。见 §5 |
| `retained_floor` | 当前仍保留的最小 `seq`。裁剪后推进；`cursor.seq < retained_floor - 1` 即要求重同步 |

### 2.2 序号分配：每个工作区一行计数器

分配发生在**写变更的同一个事务里**，一行一条语句：

```sql
BEGIN;
-- 现有实现已在事务开头做 ensureWorkspace(connection, true)，即 FOR UPDATE 住 storage_workspaces
UPDATE log4stellar.storage_change_heads
	SET seq = seq + 1, updated_ms = $2
	WHERE workspace_id = $1
	RETURNING seq;
INSERT INTO log4stellar.storage_changes (workspace_id, seq, change_id, kind, ...) VALUES (...);
-- 同一个事务里继续写 storage_entries / storage_file_versions
COMMIT;
```

为什么这样就能保证「可见顺序 = 提交顺序」：

- 计数器行的 `UPDATE` 会持有该行的行锁，直到事务提交。第二个写者必须等第一个**提交**才能拿到下一个号。
- 因此「拿到 `seq=6`」蕴含「`seq=5` 的事务已经提交」。`storage_changes` 的行与 `storage_entries` 的改动在同一个事务里提交，所以任何读到 `seq=6` 的读者，读到的 `storage_entries` 一定已经包含 `seq≤6` 的全部效果。
- 行锁是**按工作区**的，不是全局的：两个工作区各拿各的锁，互不排队。并发度随工作区数线性扩展，没有全局热点。

**被否决的方案及原因**（这三条是本文最容易被问到的，先说清楚）：

| 方案 | 为什么不安全 |
|---|---|
| 全局 `bigserial` | 能保证全局唯一且递增，但**不能**保证「同一工作区内的提交顺序」。`nextval` 在事务外取值，事务 A 拿到 100、事务 B 拿到 101，B 先提交，读者看到 101 就以为 100 之前的一切都读过了，于是跳过 100，永久丢一条变更。另外所有工作区共享一个序列，写入集中在一条 `SEQUENCE` 上，是全局瓶颈 |
| 每个工作区一条 `SEQUENCE`（`bigserial` 的直觉版本） | 同上，且更隐蔽：`nextval` **不受事务控制**，回滚不退还号；更要命的是它不参与并发控制，两个事务可以同时拿到相邻的号并乱序提交。这就是「可能被跳过」的来源。缺号本身无害，**乱序致命** |
| 每行取 `xid` / `txid_current()` | 事务 ID 在**第一次写**时分配，与提交顺序无关，乱序是常态；`xid` 会回卷、会被 `VACUUM FREEZE` 重写；`txid_current()` 的大号还会被回卷保护机制改写。三者任意一条都足以让游标失效，且失效方式是「静默丢变更」，最难排查 |
| 用时间戳做游标 | Joplin 的 `basicDelta` 就是为此额外维护了 `filesAtTimestamp`：同一毫秒内的改动会落在游标两侧，只依赖时间戳会跳过它。本协议直接用整数序号，不要时间戳 |

**缺号是允许的，乱序不允许。** 本方案里，事务回滚会把计数器一起回滚，所以正常失败不会缺号；缺号只来自保留策略裁剪，而裁剪一定伴随 `retained_floor` 前移，落在裁剪区内的游标会被明确告知重同步（§7.2）。也就是说：客户端遇到的每一个缺号，都有一句明确的错误码解释它。


## 3. 游标格式

### 3.1 编码

游标是**不透明字符串**，客户端只允许原样回传，不得解析：

```
l4s.<base64url(JSON payload)>.<sha256(payload) 的前 16 个十六进制字符>
```

`l4s` 是协议前缀，第三段是校验和。载荷两种形态：

| 用途 | 载荷 | 说明 |
|---|---|---|
| 增量游标 | `{"v":1,"k":"changes","w":"<workspaceId>","s":<seq>}` | `s` 是「已应用到第几条」 |
| 快照游标 | `{"v":1,"k":"snapshot","w":"<workspaceId>","s":<seq>,"e":<expiresMs>}` | 同一个 `seq`，另带快照窗口的绝对过期时间 |

`v` 是版本号。以后若要改载荷，靠 `v` 分流，老客户端不会被新格式静默误导。

### 3.2 校验顺序（服务端必须按此顺序）

1. **长度**：超过 512 字符直接 `400 InvalidCursor`。先判长度再解析，避免把畸形输入喂给 `JSON.parse`。
2. **结构**：必须以 `l4s.` 开头、恰好三段（`.` 不能在 base64url 里出现，所以三段是确定的）。
3. **校验和**：第三段必须等于对第二段重算的 SHA-256 前 16 位。**校验和在解析之前验证**，所以手工改写的载荷在 `JSON.parse` 之前就被拒绝。
4. **载荷合法性**：`v` 必须是受支持的版本；`k` 必须是 `changes` 或 `snapshot`；`w` 必须等于当前请求的工作区；`s` 必须是非负安全整数；`k = snapshot` 必须带 `e`，`k = changes` 必须不带 `e`。
5. **语义**：给 `requireRetainedCursor` 与 `requireHeadCursor` 判（见 §3.3）。

第 1–4 步失败都是 `400 InvalidCursor`——**客户端代码有 bug**。第 5 步失败是 `410 ResyncRequired`——客户端没做错，是服务端这边历史不够了。

### 3.3 失效的两种形态，都必须是显式信号

| 情形 | 判定 | 响应 |
|---|---|---|
| 游标结构/校验和/工作区不匹配 | 上述第 1–4 步 | `400 InvalidCursor` |
| 游标太旧，所指位置已被裁剪 | `cursor.seq < retained_floor - 1` | `410 ResyncRequired` |
| 游标超前于工作区当前 head | `cursor.seq > head` | `410 ResyncRequired` |
| 快照游标已过窗口期 | `now > e` | `410 ResyncRequired` |

**为什么超前也是重同步而不是 400**：能构造出「超前」的游标只有两种方式，一是客户端持久化了另一个工作区的游标（已被 `w` 检查拦掉），二是服务端丢失了历史（重建、回档）。后者客户端无从判断，也没做错任何事，让它重做一次全量快照是完全可恢复的。这里选 `410` 而不是 `400`，是因为两者对客户端的**动作**相同（丢弃游标、重新快照），而 `410` 不会让客户端把错误上报成「协议不兼容」。

**绝不允许的行为**：用 `200` 返回一个空变更列表。这会告诉客户端「你已是最新」，而实际上历史被裁剪了，那些变更永远不会再被投递——这是最难发现的静默数据丢失。

## 4. 快照与增量衔接

目标：客户端从一个空的本地库开始，或者从任意旧的游标开始，都能拿到**一份完整且一致**的视图，并且不漏掉快照期间落地的写入。

### 4.1 顺序

1. **在同一事务里同时取「head 序号」和「树的内容」**（见 §4.2）。得到 `S = (快照序号, 全部条目)`。因为 `seq` 与树变更同事务提交，`S.seq = N` 意味着这份树正好等于「应用完第 N 条变更之后」的状态。
2. 把 `S` 物化到 `storage_snapshots` / `storage_snapshot_entries`，`expires_ms = now + 6h`。返回 `snapshotId`、`seq = N`、`entryCount`，以及**一个 `k='snapshot'`、`s=N` 的游标**。这一步可以在第 1 步的事务里完成，也可以紧接着做——物化只是把已经一致的视图**抄下来**，不再读 `storage_entries`。
3. 客户端分页读完快照（§4.3），然后**从 `s = N` 的游标开始拉增量变更**（`GET /sync/v1/changes`）。增量严格是 `seq > N`，所以快照里已有的条目不会被重复下发为 `created`，快照期间落地的写入（`seq = N+1, ...`）也不会遗漏。
4. 客户端把快照与增量合并到本地库。**合并规则**：`seq > N` 的变更无条件覆盖快照里的同路径状态；`file.created` 落到本地已存在的路径时，按 Joplin 的做法**跳过**（它属于快照已经覆盖的内容），不要报错。

关键顺序是「**先定快照点，再读树，最后从快照点重放**」。反过来（先读树、再取 head）会漏掉两者之间的写入；只取 tree 不取 seq 则无法知道从哪儿开始重放。

### 4.2 读一致性：`REPEATABLE READ`，而不是 `READ COMMITTED`

第 1 步必须在同一个 `REPEATABLE READ` 事务里完成：

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT seq FROM log4stellar.storage_change_heads WHERE workspace_id = $1;
SELECT path, kind, file_id, revision_id, ... FROM log4stellar.storage_entries WHERE workspace_id = $1;
COMMIT;
```

**为什么 `READ COMMITTED` 是错的**：`READ COMMITTED` 下每条语句各取一次快照。若先读 head 得 `N`，再读树，而两条语句之间有个事务提交了 `N+1`（改了某个文件），那么「树」里已经含 `N+1` 的效果，却仍会从 `N` 之后重放，于是 `N+1` 被**投递两次**。若顺序反过来，先读树再读 head，则更糟：树不含 `N+1`，重放又从 `N+1` 之后开始，`N+1` 被**永久丢失**。两种顺序在 `READ COMMITTED` 下都无法自证一致。

`REPEATABLE READ` 下这两条 `SELECT` 共享同一个快照，且该快照在事务第一条查询时确定；配合这条链路的写入方式（见下），read 到的 head 与 tree 严格对应。

**与「行锁保证提交顺序」的配合**：写入侧的事务先 `UPDATE ..._heads`（拿行锁）再改 `storage_entries`，最后 `COMMIT`。所以「`storage_entries` 里能看到第 `N+1` 条的效果」与「`_heads.seq >= N+1`」要么都成立、要么都不成立，不存在中间态。这是 §2.2 的序号方案顺带给出的性质，也是 `REPEATABLE READ` 足够（不必上 `SERIALIZABLE`）的原因。

`SERIALIZABLE` 不需要：它额外防的是读写互相干扰（谓词锁），而这条路径上读取方不写、写入方已经用行锁串行化，没有它要防的异常。

### 4.3 快照分页

- 快照一旦物化，后续分页**只读 `storage_snapshot_entries`**，不再读 `storage_entries`。所以快照期间和分页期间的工作区写入完全不影响分页结果——这就是「物化」的意义。
- 排序固定为 `ORDER BY path`（文本序，PG 默认 collation）。分页用 `(lastPath, limit)` 而不是 `OFFSET`：`WHERE snapshot_id = $1 AND path > $2 ORDER BY path LIMIT $3`。`OFFSET` 在并发下会跳行，而且深分页要扫过前 N 行。
- 页令牌编码 `{snapshotId, lastPath}`，绑定到它所属的快照；拿 A 快照的令牌去请求 B 快照会被 `400 InvalidPageToken`。

## 5. 幂等

### 5.1 存放位置与唯一性

幂等键与指纹**存在 `storage_changes` 行上**，而不是单独的幂等表。理由：

- 变更行本来就是「这次操作的结果」，键跟着结果走，不会出现「键还在、结果没了」的两张表不一致。
- 唯一性由部分唯一索引保证：`UNIQUE (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL`。用**部分索引**而不是普通唯一约束，是因为内部变更（迁移、导入）没有幂等键，`NULL` 不应参与唯一性；PG 的 `NULL` 本来也不相等，但部分索引让意图显式且索引更小。
- 索引是 `(workspace_id, idempotency_key)`：幂等键由客户端生成，**只在工作区内唯一**，不同工作区撞同一个键是完全正常的。

`idempotency_fingerprint` 是请求内容的 SHA-256，覆盖 10 个字段——**每一项都必须改变指纹，因为每一项都改变这次操作的逻辑结果**：

| 字段 | 来自 | 为什么必须在指纹里 |
|---|---|---|
| `method` | HTTP 方法 | 同一把钥匙不能既开 `PUT` 又开 `DELETE` |
| `path` | 请求目标路径 | 同一把钥匙指向两个路径是客户端 bug |
| `baseRevision` | `X-Log4Stellar-Base-Revision` | 同内容、不同基线是两次不同的保存（§6） |
| `digest` | 上传字节的 SHA-256 | 同键不同内容是典型的键复用 |
| `size` | 上传字节数 | 与 `digest` 一起构成内容身份 |
| `targetPath` | 目标路径（批量、恢复、回滚、删除的 `recursive` 记号） | `from` 相同而 `to` 不同的两次 rename 是两次操作 |
| `device` | `X-Log4Stellar-Device` | 设备决定冲突副本的命名（§6.3），跨设备同键是两次操作 |
| `mode` | `?mode=create\|save` | 决定这次 PUT **可以创建**路径还是**必须推进已有 revision**；`create` 与 `save` 指名同一 `baseRevision` 时，唯一区别就是 `mode` |
| `overwrite` | `POST /rename` 的 `overwrite` | 决定 rename **允许覆盖**目标还是**必须冲突**；`overwrite:true` 被当成重放，意味着客户端的覆盖从未发生却收到 200 |
| `keepBoth` | `POST /restore` 的 `keepBoth` | 决定 restore **保留现有字节为冲突副本**还是**替换**它；同样是「从未执行却报成功」 |

字段顺序由实现固定，与客户端 JSON 顺序无关。布尔与字符串缺省值统一按 `null` 参与序列化：客户端省略 `overwrite` 与显式 `overwrite:false` 是同一次请求，`overwrite:true` 则不是。

### 5.2 三种到达方式

| 情形 | 服务端行为 |
|---|---|
| 键从未见过 | 正常执行，写入变更行（带键与指纹），返回 `201`/`200` 与结果 |
| 键见过，指纹相同 | **不产生新变更**，返回**与首次相同的结果**：同 `seq`、同 `changeId`、同 `ETag`，正文逐字段相同，且 `replayed: true`。状态码统一为 `200`——重放表达的是「这个请求早已成功」，而不是「又执行了一次」，所以首次若是创建（`201`）或冲突（`409`），重放同样是 `200` + `replayed: true` + 原始结果字段。这是重试的常态 |
| 键见过，指纹不同 | `409 IdempotencyKeyReused`，**不覆盖**、不执行。同一把钥匙开了两把锁，只能是客户端 bug 或键被复用，静默覆盖会让第一次的结果凭空消失 |

服务端**不得**把「重试」实现成「再执行一次然后去重」：那会在 `storage_file_versions` 里留下两条版本，客户端看到两条 `file.saved`，尽管内容相同。正确做法是**在写事务里先查键、命中即返回**：拿到工作区行锁之后、写版本与条目之前，`SELECT seq, change_id, revision_id, ... FROM storage_changes WHERE workspace_id = $1 AND idempotency_key = $2`；命中就直接组装与首次相同的响应并 `COMMIT`（不写任何行），只有未命中才走正常写入。

这一步放在事务内而不是事务外，是为了让「查键」与「写变更」落在同一个可串行化的临界区里——否则两个并发重试会同时查不到键、同时写，最后由唯一索引兜底成 `23505` 报错。有唯一索引兜底是必须的，但它只应作为最后一道防线，不应作为常态路径。

### 5.3 崩溃窗口：S3 写了，变更行没提交

这是本协议唯一有真实中间态的地方。`writeFile` 的既有顺序是「先 `blobs.put`（写 S3），再在事务里写版本与条目」，同步层沿用：

1. 客户端带上 `Idempotency-Key` 与文件体。
2. 服务端 `blobs.put(source)` → 得到 `digest` 与 `size`。**内容寻址 + `IfNoneMatch:'*'` 让这一步本身幂等**：同一个字节流重复写得到同一个 key，第二次命中 412 后复核已有对象。
3. 服务端在事务里：查幂等键 → 分配 `seq` → 写 `storage_file_versions` → 更新 `storage_entries` → 写 `storage_changes` → `COMMIT`。
4. 若在 2 与 3 之间崩溃：S3 上有一个**没有任何元数据引用的对象**，而客户端重试时会带来同一份字节流，`blobs.put` 命中已有对象并返回同一个 `digest`，第 3 步照常完成。**行为上完全正确，只是留下一个孤儿对象。**

因此这里的取舍是「接受孤儿对象，换取请求路径上不多一次分布式事务」：

- 孤儿对象是**内容寻址**的，所以孤儿不会「覆盖」活对象，也不会被后续写入误用。
- 清理是离线任务：`GET /sync/v1/changes` 之外的运维作业定期扫 S3 前缀，凡 `digest` 不在 `storage_file_versions.sha256` 里且对象年龄 > 24h 的，删除。24h 的宽限期保证「正在上传、尚未提交」的对象不被误删。
- 反向窗口（变更行提交了，但客户端没收到响应）由幂等键覆盖：客户端重试拿到的是原来的结果。

**绝不为这个窗口引入两阶段提交或 S3 事务性写入**：代价远高于收益，而内容寻址已经把窗口的语义后果降为零。

## 6. 冲突

### 6.1 API 层规则

一次保存必须带 `baseRevision`（`X-Log4Stellar-Base-Revision` 头或等价 body 字段）。服务端在事务内、拿到工作区行锁之后比较：

- `baseRevision` 等于该路径**当前** `revision_id` → 正常保存，`200`，产生一条 `file.saved`。
- `baseRevision` 不等于当前 `revision_id` → **不覆盖**。服务端把客户端这次提交的内容写成**冲突副本**，并产生**两条**变更：`file.saved`（冲突副本路径，新增的文件）与 `file.conflicted`（原路径，`conflict_path` 指向副本）。响应 `409 SyncConflict`，body 里给出 `conflictPath`、`currentRevision`、`seq`。
- 路径不存在且 `mode=create` → 正常创建，`201`，`file.created`。
- 路径不存在但 `mode=save`（声明基于某版本）→ 同样按冲突处理：内容写成副本，`409 SyncConflict`。因为「我以为在改一个已经存在的文件」也是分叉。
- 路径存在但 `mode=create` → 同样按冲突处理，理由对称。

**两条变更，而不是一条**：客户端的本地库需要知道两件事——「原路径现在是什么」（它得把自己的期望状态修正为服务端状态）和「我的内容去哪了」（它得把本地未提交内容标记为已落在副本里）。一条变更表达不了这个二分。

### 6.2 与既有 `If-Match` / `412 FileChanged` 的关系

`workspace-files.mjs` 的 `PUT /static/mount/...` 用 `If-Match` 做乐观并发，不匹配时抛 `WorkspaceError(412, 'FileChanged')`，语义是「**请重新读一遍再写**」，客户端重试即可收敛。

**同步 API 不复用 412，而是返回 `409 SyncConflict` 与结构化 body。** 理由：

| 维度 | 412 `FileChanged` | 409 `SyncConflict`（本协议） |
|---|---|---|
| 服务端对客户端的内容做了什么 | 丢弃 | **保留为冲突副本** |
| 客户端下一步 | 重读、合并、重写 | 无需重写，内容已在服务端 |
| 是否需要额外信息 | 只需要新 ETag | 需要 `conflictPath`、`currentRevision`、`seq` |
| 语义 | 前置条件失败（乐观锁） | 冲突已解决，但解决方式不是覆盖 |

两者不能共用：`412` 的既有契约是「什么都没发生」，而同步路径上**确实发生了**（写入了副本）。若复用 412 而实际操作了存储，就破坏 `workspace-files.mjs` 现有的「412 表示无副作用」契约，现有客户端的重试逻辑会重复写副本。反过来，也不应让 `PUT /static/mount` 改成 409——那会破坏既有 Web 客户端的 412 分支。

所以两个 API 各自保留语义：**`/static/mount` 是「编辑当前内容」的接口，用前置条件失败（412）；`/sync/v1` 是「提交我的本地编辑」的接口，用冲突解决（409）**。它们共存，共享同一个存储层。

### 6.3 冲突副本命名

沿用既有 keep-both 恢复的命名思路（`foo (restored 2).md`），改为：

```
<目录>/<主名> (conflict <device> <timestamp>).<扩展名>
<目录>/<主名> (conflict <device> <timestamp> 2).<扩展名>   ← 同名冲突时递增
```

例：`/notes/plan.md` 在设备 `phone` 上于 `2026-01-01T12:00:00Z` 冲突，得到 `/notes/plan (conflict phone 20260101T120000Z).md`。时间戳格式固定为 `YYYYMMDDTHHMMSSZ`：无冒号、无小数点、UTC、定长，可以直接做文件名字母序排序。

**确定性从哪来**（这是本节的关键）：

1. **输入只有三个**：原路径、`device_id`、时间戳。不依赖随机数、不依赖自增 ID、不依赖服务器本地时钟的时区。
2. **`device_id` 由客户端提供且必须是 slug**（`[a-z0-9-]`，≤32 字符），服务端校验。两台设备名字不同 → 副本名自然不同，**两台设备各写各的名字，不会争抢同一个**。
3. **同一设备的重试**：同一请求重放时，时间戳来自**首次写入的 `storage_changes.created_ms`**，而不是「当前时间」。所以重放得到完全相同的名字；若该名字已被占用（例如重试之前副本已写成功），`nextConflictPath` 会探测并返回下一个空位，幂等键保证不会真的写第二次。
4. **同设备同毫秒**：两台不同设备在同一毫秒冲突已在 2 中分离；同一设备在同一毫秒冲突两次是不可能的（同一设备串行提交）。剩下唯一的竞态是「两台设备恰好同名同毫秒」，这需要设备 ID 相同——而设备 ID 相同意味着客户端配置错误，此时 `(conflict ... 2)` 的递增后缀兜住，不会覆盖。
5. **上限 `maxConflictIndex = 100`**：超过则 `409 ConflictNameExhausted`。这不是性能限制，而是「这里已经不该继续堆副本了」的显式信号，比无限递增安全。

命名必须保持扩展名（`extname`），因为 Office/图片/视频的播放器依赖后缀决定打开方式；`.tar.gz` 只保留 `.gz`，与既有 `restoreTrashItem` 的取法一致。**服务端不解析内容、不转码、不降级**：视频冲突副本和原始视频具有完全相同的字节。


## 7. 分页、保留与重同步

### 7.1 增量分页的不变量

`GET /sync/v1/changes?cursor=<c>&limit=<n>` 等价于：

```sql
SELECT * FROM log4stellar.storage_changes
	WHERE workspace_id = $1 AND seq > $2
	ORDER BY seq
	LIMIT $3;
```

- 排序**必须**按 `seq` 升序，且 `LIMIT` 在排序之后。任何按时间戳排序、或用 `OFFSET` 的实现都会破坏顺序性。
- 返回体带 `nextCursor`（本次最大 `seq`）与 `hasMore`。
- **不跳过**：`seq > c` 且升序取前 `n` 条，`nextCursor` 取最后一条的 `seq`，下页从它之后开始，中间不可能有缝。
- **不重复**：`seq` 在事务内分配且 `(workspace_id, seq)` 是主键，不会有两个变更同号；`seq >` 而非 `>=` 保证边界行不重发。
- **写入并发安全**：翻页期间新提交的变更只是让 `seq` 变大，不会插入到已翻过的区间里——这正是 §2.2 行锁给的性质。所以「翻页期间有写入」既不导致重复，也不导致遗漏；最多是 `hasMore` 比你预期的多一页。
- `limit` 是**建议上限**：服务端硬性不超过它，但可以更少（例如受字节预算限制）。客户端必须按 `hasMore` 而不是「拿满 `limit`」判断结束。这一点与 Joplin delta 的 `limit` 语义一致。
- **空页不等于结束**：客户端只有在 `hasMore === false` 时才算追上。若 `hasMore === true` 且 `changes` 为空，也是合法响应（例如压缩后为空），客户端应继续用 `nextCursor` 拉。

### 7.2 保留策略与「太旧」

| 策略 | 值 | 说明 |
|---|---|---|
| 变更保留期 | 30 天 | 超过即允许裁剪 |
| 快照物化保留期 | 6 小时 | 快照页令牌在网络中断后仍可用，但不保证一天 |
| 单工作区变更行上限 | 200000 | 触发裁剪，防止冷工作区无限增长 |
| 幂等键保留期 | 30 天 | 与变更同期；过期后同一把键会被当作新请求 |

裁剪按 `seq` 从低到高删，删完把 `retained_floor` 推到「仍保留的最小 `seq`」。裁剪**必须**与删除同事务，且必须在删除前拿到行锁，否则会出现「游标判断通过、实际行已被删」的空窗。

客户端的判定：收到 `410 ResyncRequired`、或 `cursor.seq < retained_floor - 1` 时，**丢弃游标、删掉本地 `seq` 状态、重新走 §4 的快照流程**。本地已有的内容不必清空：快照合并规则（§4.1 第 4 点）允许把快照当作「覆盖式修正」，把本地多出来的文件按删除处理即可。

**为什么是 30 天**：Joplin 的 `defaultChangeTtl` 是 180 天，但那针对的是「个人笔记、可能几个月才开一次」的场景，且它不裁剪 CREATE/DELETE，所以代价是存储无限增长。本产品是自托管工作区，存储由部署者承担，30 天 + 20 万行的双上限给出可预测的上界。真出问题时的代价只是「一次全量快照」，而这个流程本来就是为冷启动设计的。

### 7.3 页令牌

快照页令牌编码 `{snapshotId, lastPath}`，是**独立的一种 token 类型**（`k='page'`），与变更游标互斥：拿变更游标当页令牌用、或反之，都返回 400 而不是「恰好能解析」。两类 token 的载荷结构不同、校验分支不同，混用属于客户端 bug，必须显式失败。

## 8. HTTP 接口

所有端点都在 `/sync/v1` 下（`syncMountPath`），与 `/static/mount` 并列而非嵌套。工作区仍由 `X-Log4Stellar-Workspace` 头选择（缺省回落逻辑沿用 `workspace-access.md` §5）。所有端点：

- 需要有效会话；非成员一律 `403 NoPermissions`，**不区分工作区是否存在**。
- 需要 `ctx.secure`、同源检查（写请求必须带正确 `Origin`），沿用网关既有规则。
- 判权**先于**任何参数校验（`workspace-access.md` §4）。实现方式是 `capabilityForSyncRequest(method, pathname)` 先算出能力、再 `workspace.require(capability)`，与 `capabilityForRequest` 同构。
- 错误统一为 `{ "error": "<code>" }`，与 `workspace-files.mjs` 的既有格式一致。

### 8.1 端点与能力映射

| 方法 | 路径 | 能力 | 说明 |
|---|---|---|---|
| `POST` | `/sync/v1/snapshot` | `workspace.read` | 开始快照，返回 `snapshotId`、`seq`、游标与首页 |
| `GET` | `/sync/v1/snapshot/<snapshotId>` | `workspace.read` | 快照分页，`token` + `limit` |
| `GET` | `/sync/v1/changes` | `workspace.read` | 增量拉取，`cursor` + `limit` |
| `PUT` | `/sync/v1/file` | `workspace.write` | 带 `baseRevision` + 幂等键的上传（创建或保存） |
| `DELETE` | `/sync/v1/file` | `workspace.delete` | 删除（入回收站），产生 `file.deleted` |
| `POST` | `/sync/v1/rename` | `workspace.write` | 重命名，产生 `*.renamed` |
| `POST` | `/sync/v1/mkdir` | `workspace.write` | 建目录，产生 `directory.created` |
| `POST` | `/sync/v1/restore` | `workspace.restore` | 从回收站恢复，产生 `file.restored` |
| `POST` | `/sync/v1/rollback` | `workspace.restore` | 回滚到旧版本，产生 `file.rolledback` |
| `GET` | `/sync/v1/conflicts` | `workspace.history` | 列出某工作区内的冲突副本 |
| `GET` | `/sync/v1/conflict` | `workspace.history` | 读取单个冲突的详情与解析上下文 |

能力划分沿用既有矩阵：**下载旧版本是 `read`，回滚是 `restore`，删除是 `delete`**。注意 `POST /sync/v1/mkdir` 与 `POST /sync/v1/rename` 是写；而 `GET /sync/v1/conflicts` 只是查看，属 `history`——恢复（把副本合回原路径）仍需 `restore`。

### 8.2 快照开始

`POST /sync/v1/snapshot`

请求体（可选）：`{ "limit": 1000 }`

响应 `201`：

```json
{
	"snapshotId": "6f1c7d6e-3f3f-4a3b-9a2f-1c2b3a4d5e6f",
	"workspaceId": "log4stellar-main",
	"seq": 4213,
	"cursor": "l4s.eyJ2IjoxLCJrIjoic25hcHNob3Qi...",
	"entryCount": 1832,
	"expiresAt": "2026-01-01T18:00:00.000Z",
	"entries": [ { "path": "/notes/a.md", "kind": 1, "fileId": "...", "revisionId": "...", "sha256": "...", "size": 812, "modifiedAt": "..." } ],
	"pageToken": "l4s....",
	"hasMore": true
}
```

错误：`400 InvalidPageSize`（`limit` 非法）、`413 SnapshotTooLarge`（条目数超 `maxSnapshotEntries`）、`403 NoPermissions`。

`413 SnapshotTooLarge` 而不是静默截断：超限说明工作区已经大到一份物化快照不可行，客户端应改用递归列目录的方式引导（退回 `/static/mount` 的 `files`/`readdir`），而不是拿到一份「看起来完整但不是」的快照。

### 8.3 快照分页

`GET /sync/v1/snapshot/<snapshotId>?token=<pageToken>&limit=<n>`

响应 `200`：

```json
{
	"snapshotId": "...",
	"seq": 4213,
	"entries": [ ... ],
	"pageToken": "l4s....",
	"hasMore": false
}
```

错误：`410 InvalidSnapshot`（快照过期或不存在）、`400 InvalidPageToken`（令牌畸形、属于别的快照）、`400 InvalidPageSize`、`403 NoPermissions`。

`410 InvalidSnapshot` 与 `410 ResyncRequired` 分开：前者表示「这份快照没了，重新 `POST /snapshot`」，后者表示「你的增量游标没了，重新快照」。客户端两者的动作相同（重新快照），但日志与告警要能区分。

### 8.4 增量变更

`GET /sync/v1/changes?cursor=<l4s...>&limit=<n>`

响应 `200`：

```json
{
	"workspaceId": "log4stellar-main",
	"cursor": "l4s.eyJ2IjoxLCJrIjoiY2hhbmdlcyIs...",
	"fromSeq": 4214,
	"toSeq": 4277,
	"head": 4277,
	"hasMore": false,
	"changes": [
		{
			"seq": 4214,
			"changeId": "1b2c...",
			"kind": "file.saved",
			"entryKind": 1,
			"path": "/notes/a.md",
			"fileId": "...",
			"revisionId": "...",
			"parentRevisionId": "...",
			"sha256": "...",
			"size": 900,
			"deviceId": "phone",
			"at": "2026-01-01T12:00:00.000Z"
		}
	]
}
```

错误：`400 InvalidCursor`、`410 ResyncRequired`、`400 InvalidPageSize`、`403 NoPermissions`。

- 首次同步客户端没有游标，可省略 `cursor` 参数：服务端从 `retained_floor - 1` 开始返回（不是从 1），并**不是**快照替代品——客户端必须先用 `POST /snapshot` 建立基线。省略游标只用于「只要增量、我已有全量」的场景，风险由客户端的调用时机负责。这一条是**有意留的窄口**，客户端文档必须写明不可用它与快照替代。
- `head` 字段让客户端能在**无变更**的轮询中跳过后续调用。
- `fromSeq` / `toSeq` 是闭开区间 `(fromSeq, toSeq]`；无变更时两者都等于 `cursor` 的 `seq`。

### 8.5 上传（创建/保存）

`PUT /sync/v1/file?path=<path>&mode=<create|save>`

请求头：`X-Log4Stellar-Base-Revision`（`mode=save` 必填）、`Idempotency-Key`（必填）、`X-Log4Stellar-Device`（可选）、`Content-Type: application/octet-stream`、`Content-Length`。

成功响应 `201`（create）/ `200`（save）：

```json
{
	"seq": 4278,
	"changeId": "...",
	"path": "/notes/a.md",
	"fileId": "...",
	"revisionId": "...",
	"etag": "\"<revisionId>\"",
	"size": 900,
	"sha256": "...",
	"created": true,
	"replayed": false
}
```

- `replayed: true` 表示这是幂等重放，body 与首次响应**逐字段相同**（`seq`、`changeId` 都不变），客户端不应把它当作新变更。
- `mode` 省略时按 `save` 处理（必须带 `baseRevision`）；`mode` 只接受 `create` 与 `save`，其余值恒 `400 InvalidUploadMode`，包括大小写不符的 `CREATE`。
- 错误：`409 SyncConflict`（附 `conflictPath`、`currentRevision`、`seq`）、`400 BaseRevisionInvalid`、`428 BaseRevisionRequired`、`400 InvalidIdempotencyKey`、`409 IdempotencyKeyReused`、`400 InvalidUploadMode`、`400 InvalidDevice`、`413 FileTooLarge`、`403 NoPermissions`、`404 FileNotFound`、`400 FileIsADirectory`。

### 8.6 删除 / 重命名 / 建目录 / 恢复 / 回滚

均为 `DELETE` 或 `POST`，请求体是 JSON，响应统一包含 `seq`、`changeId`、`replayed`。字段表：

| 端点 | 请求体 | 产生的 `kind` | 成功状态 |
|---|---|---|---|
| `DELETE /sync/v1/file` | `{ "path": "/a.md", "recursive": false }` 或 `?path=&recursive=` | `file.deleted`（目录则是 `directory.deleted`，递归时每项一条） | `200` |
| `POST /sync/v1/rename` | `{ "from": "/a.md", "to": "/b.md", "overwrite": false }` | `file.renamed` / `directory.renamed` | `200` |
| `POST /sync/v1/mkdir` | `{ "path": "/notes" }` | `directory.created` | `201` |
| `POST /sync/v1/restore` | `{ "trashId": "<uuid>", "keepBoth": true }` | `file.restored`（每个条目一条） | `200` |
| `POST /sync/v1/rollback` | `{ "path": "/a.md", "revisionId": "<uuid>", "baseRevision": "<uuid>" }` | `file.rolledback` | `200` |

**并非每条变更都有 `device_id`**：只有 `/sync/v1` 写入的变更带 `deviceId`、`opId`、`baseRevision`。从 `/static/mount`（网页界面、旧客户端）写入的变更这三列均为 `null`——那条路径上没有设备标识、没有幂等键、也没有客户端声明的基版本。客户端渲染「这条变更来自哪台设备」时必须容忍 `null`，不能把它当成协议错误。

**递归删除与批量恢复的变更条数**：一个操作涉及 N 个条目就产生 N 条变更，且它们**共用同一个 `seq`**？不可以——`PRIMARY KEY (workspace_id, seq)` 不允许。所以是**N 条变更、N 个连续 `seq`、同一个 `changeId` 之外的分组字段**：实现上用同一事务顺序分配 `seq`，客户端按 `path` 逐条应用。为保证「一个逻辑操作恰好一条变更」的验收语义，响应里给出 `changeIds: [...]` 与最终 `seq`，客户端应把这一组当作一个原子批次应用。**这一点是本文档最值得复核的取舍**，见 §11。

### 8.7 冲突解析读取

`GET /sync/v1/conflicts?limit=<n>&cursor=<l4s...>` —— 列出该工作区所有冲突副本（`file.conflicted` 变更里 `conflict_path` 非空且副本仍存在的）。

```json
{
	"conflicts": [
		{
			"changeId": "...",
			"seq": 4301,
			"path": "/notes/a.md",
			"conflictPath": "/notes/a (conflict phone 20260101T120000Z).md",
			"fileId": "...",
			"revisionId": "...",
			"deviceId": "phone",
			"at": "2026-01-01T12:00:00.000Z",
			"resolved": false
		}
	],
	"cursor": "...",
	"hasMore": false
}
```

`resolved` 恒为 `false`：列表只包含**副本仍存在**的冲突，已被用户删除或改名的副本整条消失，因此这里不会出现 `true`。客户端应把「从列表里消失」当作已解决，而不是等待一个状态翻转。

`GET /sync/v1/conflict?path=<conflictPath>` —— 单个冲突的详情，附 `originalRevisionId`（冲突发生时原路径的版本）与 `baseRevision`（客户端声明的基版本），供客户端展示「你的哪些改动没被合并」。返回 `404 FileNotFound` 表示该路径不是冲突副本。

**解决方式**：本协议**不提供**「合并」端点。用户要么保留副本（当作普通文件继续编辑）、要么删除副本、要么把副本内容重新保存到原路径（此时会因基版本不匹配再次产生冲突，除非用户先读到最新内容）。这是刻意的：自动合并的正确实现需要内容级 diff，而 Office/视频文件根本无法 diff——对它们「保留两份」是唯一诚实的答案，Joplin 对附件的处理也是如此（`createConflictResourceNote`）。

## 9. 验收测试矩阵

| # | 验收项 | 请求序列 | 断言 |
|---|---|---|---|
| 1 | **离线→重连** | 设备 A 在线拉增量到 `seq=100`；断网；服务端继续产生 101..105；A 重连后用 `seq=100` 的游标拉 | 一次响应返回 101..105 全部，顺序不变，`hasMore=false`；A 的本地状态与服务端逐文件一致；**无需重传任何内容** |
| 2 | **重复提交** | A 用 `Idempotency-Key: k1` 上传 `/a.md` 两遍，两遍 body 相同 | 两次响应 `seq`/`changeId`/`etag` 完全相同，第二次 `replayed=true`；`storage_changes` 只有一条 `file.saved`；`storage_file_versions` 只有一条新版本；其他设备只看到一条变更 |
| 3 | **翻页期间有写入** | A 用 `limit=2` 从 `seq=10` 翻页；翻到第 2 页时 B 提交了 `seq=15`、`16` | 第 2 页是 `11,12`，第 3 页是 `13,14`，第 4 页含 `15,16`；**无重复、无跳过**；`hasMore` 在恰当时机转 false |
| 4 | **游标失效** | 客户端持 `seq=5` 的游标；服务端裁剪到 `retained_floor=40` | `GET /changes` 返回 `410 ResyncRequired`，body 无部分结果；客户端重新 `POST /snapshot` 后能拿到完整视图 |
| 5 | **两设备同时改同一文件** | A、B 都基于 `rev=1` 保存 `/a.md`（不同内容），A 先提交 | A：`200`；B：`409 SyncConflict` + `conflictPath="/a (conflict tablet 20260101T120000Z).md"`；服务端两个文件都在，**两份内容都能完整下载且 sha256 与各自上传的一致**；变更流里有 `file.saved`（原路径）、`file.saved`（副本）、`file.conflicted` |
| 6 | **视频附件冲突** | 同上，但路径是 `/media/talk.mp4`（例如 40 MiB） | 同上；副本名为 `/media/talk (conflict tablet 20260101T120000Z).mp4`；**两份字节流都与上传内容逐字节相同**（未转码、未截断）；`Content-Length` 与 `size` 一致；Range 请求能正常播放两份 |
| 7 | **Office 附件冲突** | 路径 `/docs/report.docx` | 副本保留 `.docx` 后缀；下载后 `unzip -t` 通过；两份 MD5 分别等于各自上传的 MD5 |
| 8 | **崩溃窗口（S3 已写、变更未提交）** | 上传 `/a.md` 后、事务提交前杀掉进程；S3 上已有对象 | 客户端重试同一 `Idempotency-Key`：`blobs.put` 命中已有对象，事务正常提交，结果与未崩溃时相同；`storage_changes` 只有一条；S3 上无重复对象 |
| 9 | **同一幂等键不同请求体** | A 用 `k1` 上传 `/a.md` 内容 X；再用 `k1` 上传内容 Y | 第二次 `409 IdempotencyKeyReused`；`/a.md` 仍是 X；无新变更行 |
| 10 | **顺带的重命名** | A 重命名 `/a.md`→`/b.md`，B（离线）稍后同步 | B 收到 `file.renamed`（`fileId` 不变，`fromPath` 有值）；**B 不产生新版本、不重新下载内容**——`revisionId` 未变，B 只需改本地路径 |
| 11 | **回滚进变更流** | A 回滚 `/a.md` 到旧版本 | 变更流出现 `file.rolledback`，`revisionId` 是新版本（不是旧版本 ID）；其他设备按普通保存应用 |
| 12 | **恢复进变更流** | A 从回收站恢复一项 | 变更流出现 `file.restored`；若 `keepBoth`，出现 `(restored)` 后缀的路径 |
| 13 | **无变更轮询** | A 的游标已在 head | `200`、`changes: []`、`hasMore: false`、`fromSeq === toSeq === head`；**不是 304，也不是 410** |

## 10. E2EE 与非目标

本文不含端到端加密。但设计上留好了位置，将来加 E2EE 时不需要改协议形状：

- 变更行只存 `sha256`/`size`/`revisionId`，**不内联内容**。加密后 `sha256` 变为密文摘要，`size` 为密文长度，客户端解密后自行校验明文摘要（可加一个 `plainSha256` 字段，属于向后兼容的可选字段）。
- 冲突判定基于 `revisionId`，与是否加密无关。
- 服务端始终看不到明文，因此冲突副本的命名不能依赖内容——**当前方案只用路径、设备、时间戳，恰好满足**。如果当初选择了「用内容 hash 命名副本」，加 E2EE 时就必须推翻。
- 参考 Joplin：E2EE 下同步内容全程是 JED 序列化的密文，主密钥本身也加密后随同步下发；服务端只做搬运。

其余非目标：实时推送（WebSocket/SSE）、跨工作区移动、路径级权限、内容级自动合并、离线队列的服务端进度上报、`.md` 以外文件的版本 diff。

## 11. 需要复核的取舍

诚实记录三处我认为最可能被挑战的决定：

0. **同一设备同一秒的第 102 次冲突是硬失败（§6.3）**：`maxConflictIndex = 100` 之后返回 `409 ConflictNameExhausted`，没有退路、没有更长时间精度的降级。要触发它，需要同一台设备在同一秒内对同一路径失败 101 次而前 100 个副本都还在——正常客户端达不到，但脚本化重试或时钟被冻结的容器可以达到。真遇到时用户只能先清理副本。这里刻意不做「加到 101、102……」的无限递增：那时副本名已经失去可读性，报错比继续堆更有用。

1. **批量操作的变更粒度（§8.6）**：递归删除 100 个文件会产生 100 条变更、100 个 `seq`，但只有一次逻辑操作。这与「同一逻辑操作恰好产生一个变更」的措辞有张力。我的理由是：变更流的消费单位是「一个路径的状态变成什么」，客户端要能逐文件应用；把它们合成一条超大的变更反而无法部分应用。备选方案是加 `batch_id` 并让客户端原子应用整批——但这要求客户端能回滚半批，复杂度显著上升。
2. **省略 `cursor` 的窄口（§8.4）**：允许不带游标从 `retained_floor - 1` 开始拉。这可能在客户端误用时让它以为拿到了全量。我选择保留是因为「已知本地状态要增量补」是真实场景，且服务端仍会正确裁剪；但这是个可以商量的口子，尤其对 Android 客户端。
3. **30 天 / 20 万行的保留上限（§7.2）**：数值是拍的。Joplin 用 180 天是因为它不裁 CREATE/DELETE；这里裁剪是真正删除，所以保守取值。若实际部署发现同步冷启动频繁，这个值应上调，但上调的代价是存储线性增长——需要部署者参与决策，而不是写死在协议里。
