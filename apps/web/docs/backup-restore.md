# 备份与恢复契约（v2）

本文件是「备份与恢复」的实现契约，与 `docs/workspace-access.md`、`docs/git-integration.md` 并列为服务端与运维的共同判据。凡本文件写明的成员、摘要、判定顺序与退出码，实现与测试都必须一致；如需修改契约，先改本文件再改代码。

配套实现：

| 文件 | 职责 |
|---|---|
| `apps/web/backup-manifest.mjs` | 成员契约、清单读写、完整性校验、运行结果与新鲜度、过期清理 |
| `apps/web/backup-cipher.mjs` | AES-256-GCM 信封与 scrypt 密钥派生 |
| `apps/web/backup-data.mjs` | 采集（SQLite、密钥、PostgreSQL、对象）并发布备份 |
| `apps/web/restore-backup.mjs` | 先校验再恢复，并拒绝写回备份来源 |
| `apps/web/backup-schedule.mjs` | 单实例定时器、状态查询、过期清理 |
| `apps/web/backup-manifest.test.mjs`<br>`apps/web/restore-backup.test.mjs`<br>`apps/web/backup-schedule.test.mjs` | 单元测试（无需外部服务） |
| `apps/web/backup-drill.integration.test.mjs` | 对真实服务的往返演练 |

## 1. 为什么需要这一层

`backup-data.mjs` 从第一版起就能导出一个目录，但它导出的备份**无法回答「它是不是完整的」**：清单里只有计数，没有每个成员的摘要；没有任何加密，账号库和两把密钥以明文躺在备份目录里；恢复脚本只处理对象，账号库与 PostgreSQL 从未被恢复过；没有任何机制定期跑，也没有任何地方记录「最近一次成功备份是多久以前」。

一次真正的灾难恢复需要四件事同时成立，缺一件备份就等于不存在：

1. **完整**：账号库、签名密钥、Git 加密密钥、PostgreSQL、仍被引用的对象、部署配置，一样都不能少。
2. **可判定**：机器能回答「这份备份完整吗」，而不是靠人翻目录。
3. **可恢复**：恢复路径被真实执行过，而不是只写了文档。
4. **有时效**：有东西在跑，并且在停止跑的时候会有人知道。

本文档描述这四件事的契约。

## 2. 备份成员契约

### 2.1 五个必需成员

| 成员名 | 磁盘文件 | kind | 来源 | 丢失后果 |
|---|---|---|---|---|
| `auth.sqlite` | `auth.sqlite.enc` | `sqlite-accounts` | `$LOG4STELLAR_AUTH_DIR/auth.sqlite`（`VACUUM INTO` 一致性快照） | 所有账号、会话与工作区成员关系消失，工作区变成无人可访问 |
| `secret` | `secret.enc` | `auth-secret` | `$LOG4STELLAR_AUTH_DIR/secret` | 所有会话失效，二次验证（TOTP）密钥无法解开 |
| `git-secret` | `git-secret.enc` | `git-secret` | `$LOG4STELLAR_CONFIG_DIR/git-secret` | 所有托管的 Git 凭据无法解密，推送与拉取全部失效 |
| `log4stellar.sql` | `log4stellar.sql.enc` | `postgres-dump` | `pg_dump` plain SQL，取自 `pg_export_snapshot()` 的同一快照 | 文件树、版本历史、回收站、Git 仓库登记全部消失 |
| `objects.index` | `objects.index.enc` | `object-inventory` | 由 PostgreSQL 版本表导出的对象清单 | 无法判断对象是否齐全；恢复时不知道要恢复什么 |

**顺序即写入顺序**，这也是校验时的报告顺序。

**必需成员的集合从常量重算，不读清单**（`requiredMembersFor(scope)` 读 `memberContract`）。理由：如果集合来自清单，那么「改清单删掉一个成员」与「删掉对该成员的要求」可以同时完成，校验会一路绿灯。从常量重算让修改清单变成一次可检测的篡改。

### 2.2 部署配置成员

部署配置文件不是每个部署都相同，所以它们由调用方指定，且 `required: false`：

| 成员名 | 磁盘文件 | 来源 |
|---|---|---|
| `deployment/<name>` | `deployment/<name>.enc` | `$LOG4STELLAR_CONFIG_DIR/<name>` |

默认值为 `workspace-storage.json`、`web-clients`、`start-web.sh`。其中 `workspace-storage.json` **含明文口令**——这正是它必须进备份、且备份必须加密的原因。

`deploymentFiles` 只接受配置目录内的纯文件名，含 `..`、以 `/` 开头或含反斜杠一律拒绝；否则 `--deployment=../../etc/passwd` 会把任意可读文件打进备份。

### 2.3 全量与限定范围

| scope | exportObjects | 用途 | 校验默认行为 |
|---|---|---|---|
| `full` | 必须 `true` | 可用于真实恢复的备份 | 通过 |
| `limited` | 必须 `false` | 只备份元数据，不导出对象字节 | 默认**拒绝**，需要显式 `allowMetadataOnly` |

`full` 又不导对象是可恢复性谎言（只有元数据、没有内容），`limited` 又导对象是自相矛盾的范围声明，两种组合都在 `planBackupScope` 阶段直接报错，不进入采集。

`limited` 备份在恢复侧默认被拒绝（`MetadataOnly`），因为它恢复出来的工作区里每个文件都是坏的。放宽必须由调用方显式声明，不允许默认发生。

## 3. 加密信封

### 3.1 为什么加密是必需的而非可选的

备份目录里同时有账号库、签名密钥、Git 加密密钥和含数据库口令的部署配置。这样的目录一旦落在共享盘上或被 `scp` 到别处，泄漏程度等同于整机的完全沦陷。因此**加密不是选项**，`backup-data.mjs` 在没有密钥文件时直接失败：

```
A backup key file is required: pass --key-file=<path> or set LOG4STELLAR_BACKUP_KEY_FILE.
```

### 3.2 信封格式

```
magic(7) = "l4sbk1\n" | iv(12) | ciphertext(n) | tag(16)
```

| 常量 | 值 | 说明 |
|---|---|---|
| `backupCipher` | `aes-256-gcm` | 带认证的加密，篡改必然导致解密失败 |
| `backupKdf` | `scrypt` | `N=2^14, r=8, p=1, maxmem=64 MiB` |
| `saltBytes` | 16 | **每次备份**一个随机 salt，记在清单的 `encryption.salt`，**不在信封里** |
| `ivBytes` | 12 | **每个文件**一个随机 IV |
| `tagBytes` | 16 | GCM tag 在文件尾部 |
| `keyBytes` | 32 | 派生密钥长度 |
| `minimumKeyMaterial` | 16 | 密钥材料最小长度，短于此值直接拒绝 |

**salt 放清单、不进信封**，是为了让 GCM tag 落在文件末尾：解密时可以先读 19 字节头部与末尾 16 字节 tag，再单遍流式解密中间部分，内存占用与文件大小无关（272 MB 对象的备份因此不需要把对象读进内存）。

**每次备份一个 salt、每个文件一个 IV**：如果每个文件都跑一次 scrypt，1033 个对象的备份会因为密钥派生而慢到不可用；per-backup 密钥 + per-file IV 同样是标准做法（每个文件仍是不同的密钥流，重放与重排都会被 GCM 认证拦下）。

### 3.3 密钥文件

`writeKeyFile(path)` 生成 44 字节随机密钥材料，`mode 0600`，`flag: 'wx'` **绝不覆盖**已有文件——覆盖密钥文件等于让所有既有备份永久不可读。密钥文件必须与备份分开存放：同盘同目录的密钥 + 备份，等于没加密。

## 4. 清单（manifest.json，format 2）

### 4.1 每个成员记两个摘要

```json
{
  "name": "auth.sqlite",
  "file": "auth.sqlite.enc",
  "kind": "sqlite-accounts",
  "required": true,
  "size": 49187,
  "sha256": "36fd6cf2…",
  "contentSha256": "40cd6664…",
  "contentSize": 49152
}
```

| 字段 | 对象 | 校验意义 |
|---|---|---|
| `size` / `sha256` | 磁盘上的**密文** | 不需要密钥即可发现截断与位翻转 |
| `contentSize` / `contentSha256` | **明文** | 用密钥解密后才能发现「密文完好但不是这份备份的密文」（等长互换、换 key 重加密） |

只校验密文摘要抓不到等长替换；只校验明文摘要则在没有密钥时完全无法工作。两者都记，让「有没有密钥」都至少有一层校验。

### 4.2 对象清单存两处

`manifest.objects.entries` 内联一份，加密的 `objects.index` 成员里再存一份。校验时交叉比对：改清单删对象会被密封的 index 抓到（`ObjectIndexMismatch`），截断 index 会被内联副本抓到。

每个对象条目记四个数，缺一不可：

```json
{
  "workspaceId": "log4stellar-main",
  "sha256": "ec21549b…",
  "size": 28,
  "storedSize": 63,
  "storedSha256": "…",
  "source": { "type": "s3", "table": "log4stellar.storage_file_versions" }
}
```

`sha256`/`size` 是对象的身份与明文长度；`storedSize`/`storedSha256` 是信封在磁盘上的样子；`source` 记录它凭什么进入备份（哪张表、哪一列），这样「为什么这个对象在备份里」永远可回答。

`source` 值为 `log4stellar.storage_file_versions` 而非某个具体文件路径：对象是被 PostgreSQL 的版本表引用的，不是被目录树引用的。历史版本（不被任何 `storage_entries` 指向、只剩 `storage_file_versions` 里的行）与回收站引用因此都会被带上——这正是「只备份当前目录树」会漏掉的部分。

### 4.3 来源与计数

`origin` 记录 endpoint / region / bucket / host / port / database / schema，**不含任何口令**。口令只存在于加密的部署成员里，这也正是加密存在的理由。

`counts` 记录 `memberships`、`workspaces`、`entries`、`versions`、`trash`、`storageWorkspaces`、`members`；恢复后必须与恢复出来的库对得上（演练里就是这么比的）。

### 4.4 清单读失败的错误码

| code | 触发 |
|---|---|
| `ManifestMissing` | 备份目录里没有 `manifest.json` |
| `ManifestCorrupt` | JSON 无法解析 |
| `ManifestUnsupported` | `format !== 2`；文案含 `restore a pre-v2 backup with the release that wrote it` |
| `EncryptionUnsupported` | `cipher` / `kdf` 不是本版本能解开的 |

## 5. 校验（verifyBackupManifest）

### 5.1 判定顺序

1. **清单**：存在、可解析、format/加密算法受支持、scope 合法且符合预期。
2. **范围**：`full` 必须带对象；`limited` 默认拒绝（`MetadataOnly`）。
3. **成员**：必需成员集合从常量重算；清单列出的成员必须都在，磁盘文件必须都在；重复成员报 `MemberDuplicate`。
4. **密文摘要**：`size` 与 `sha256` 逐个比对。
5. **解密与明文摘要**：解密到 staging 目录，比对 `contentSize` 与 `contentSha256`；失败报 `DecryptionFailed`。
6. **对象**：每个 `entries` 项的文件必须在、`storedSize`/`storedSha256` 必须对、解密后 `size`/`sha256` 必须对；总数与总字节必须等于清单声明的值。
7. **交叉比对**：解密后的 `objects.index` 与内联 `entries` 必须一致。
8. **来源**：`source` 必须存在且可解释（`ObjectSourceMissing` / `ObjectReferenceInvalid`）。

**收集所有问题再抛**，不是遇到第一个就返回。运维看到的是一份「这份备份坏了哪儿」的清单，而不是需要修一次跑一次才能逐个发现的序列。`error.details.problems` 是数组，每项带 `code` 与可读 `message`。

### 5.2 staging 目录的位置

解密产生的明文写到 `mkdtemp(join(tmpdir(), 'log4stellar-verify-'))`，**不在备份目录里**。否则「校验」这个动作本身会把明文留在备份旁边，下一次 `rsync` 就把明文传到异地去了。

`keepPlaintext: true` 时保留并返回 `plaintext: Map<name, path>`，供恢复使用；否则 `finally` 删除。

## 6. 恢复（restore-backup）

### 6.1 先校验再写

`restoreBackup()` 的第一件事是 `verifyBackupManifest(..., { keepPlaintext: true })`。任何问题都在**写入第一个字节之前**抛出。这条规则是「缺任一必需成员要明确失败而不是静默部分恢复」的实现方式：没有「先恢复能恢复的部分」这个分支。

`restoreToDirectory` 在写任何文件之前先 `stat` 全部四个成员文件；任一个在 verify 与 restore 之间消失（/tmp 被清、盘满）就整体失败并报 `The decrypted <label> vanished before it could be restored: <path>`。恢复是唯一一个「几乎全部数据」并不比「停下来」更好的地方。

### 6.2 拒绝恢复到备份来源

`assertRestoreTargetIsSeparate(manifest, { s3, postgres, authDir })` 在写入前比对：

| 目标 | 判据 |
|---|---|
| S3 | endpoint（规范化 URL）+ bucket 都相同 |
| PostgreSQL | host + port + database 都相同 |
| 账号库 | authDir 相同 |

命中任一即抛 `RestoreTargetError`，文案以 `Refusing to restore onto the source of this backup:` 开头。

理由不是洁癖：把备份恢复回它自己的来源，会在灾难现场之上覆盖原生数据。恢复演练必须对着独立目标做，这也正是本项目要求「独立 PostgreSQL 与独立 S3 桶演练」的直接原因。

### 6.3 PostgreSQL dump 的适用性检查

`inspectSqlDump(path)` 返回 `{ tables, hasSchema, complete, copyStatements, bytes }`，检查：

- 有 `CREATE SCHEMA log4stellar;`
- 有全部 `CREATE TABLE log4stellar.*`
- 结尾有 `PostgreSQL database dump complete`

**注意 pg_dump 18 的行为**：完成标记之后还会追加一个 `\unrestrict <token>` psql 元命令。因此判定不能只看文件最后一行，必须先剥掉尾部的空行、以反斜杠开头的元命令和尾部注释行。这个坑是在真实演练里踩出来的——修复前，任何用 pg_dump 18 生成的**完整** dump 都会被判为截断，真实恢复会被错误拒绝。

`restoreToServices()` 用 `psql --single-transaction --set ON_ERROR_STOP=1` 应用 dump，本机没有 `psql` 时回退到 `docker run --rm --interactive --network host postgres:18 psql`。用 psql 而不是驱动：pg_dump 的 `\restrict` / `\unrestrict` / `\.` 元命令驱动不认。

### 6.4 对象恢复后回读

`restoreObjectBytes()` 对每个对象：解密 → 校验 `sha256` + `size` → `blobs.put()` → 比对返回的 digest/size → **回读并再次 hash 比对**。

最后一步是必要的：一次返回 200 的 PUT 只证明服务端接受了请求，不证明读回来的字节就是写进去的字节。对象通过 `openRustfsBlobs()` 走产品同一条写入路径（`workspaces/<workspaceId>/sha256/<digest>`、`IfNoneMatch: '*'`、`ChecksumSHA256`），所以恢复出来的对象对工作区是可用的，而不是「另一个看起来像对象的键」。

## 7. 运行结果与新鲜度

### 7.1 两个产物

| 文件 | 写法 | 用途 |
|---|---|---|
| `outcomes.jsonl` | 追加 | 完整历史，逐次一行，用于事后追查 |
| `state.json` | 原子重写 | 当前状态，`checkBackupFreshness` 只读它 |

`state.json` 含 `runs`、`failures`、`consecutiveFailures`、`lastSuccess`、`lastFailure`、`lastRun`。

**失败不清空 `lastSuccess`**。一次失败不该让系统忘记上一次成功是什么时候——那会把「最近一次成功是 3 小时前、之后失败了 2 次」这个有信息的描述，退化成「从来没成功过」这个误导性描述。失败另外写 `alert.json`（`raisedAt`、`consecutiveFailures`、`message`、`code`、`backupDir`、`scope`）。

### 7.2 新鲜度三态

`checkBackupFreshness(stateDir, { now, maxAgeMs })`，默认窗口 `defaultMaxAgeMs = 36h`。

| state | 含义 |
|---|---|
| `ok` | 最近一次成功在窗口内 |
| `stale` | 有成功记录但已超期 |
| `never` | 从来没有成功记录 |

返回 `{ state, fresh, overdue, lastSuccessAt, lastSuccessBackupDir, ageMs, ageText, maxAgeMs, maxAgeText, consecutiveFailures, lastFailure, reason }`。`formatDuration` 输出 `45s` / `1m30s` / `2h13m` / `2d2h`。

窗口默认 36 小时而不是 24 小时：每日备份 + 一次正常重试的余量。窗口小于备份间隔会让正常的每日备份每两天报一次假警报。

### 7.3 退出码

`backup-schedule.mjs status` 在 `stale` / `never` 时 **exit 2**，`ok` 时 exit 0。这样它可以直接当监控检查用，不需要解析文本。

## 8. 定时（本机没有 systemd --user，也没有 crontab）

### 8.1 现状

| 机制 | 本机实测 |
|---|---|
| `systemctl --user list-timers` | `Failed to connect to bus: No medium found` |
| `crontab -l` | `no crontab for agent` |

两者都不可用。因此**定时能力由进程自带**，cron/systemd 只是可选外层，不是依赖。

### 8.2 自带定时器

```sh
node apps/web/backup-schedule.mjs daemon \
  --backup-root=/srv/log4stellar/backups \
  --state-dir=/srv/log4stellar/backup-state \
  --key-file=/etc/log4stellar/backup.key
```

| 命令 | 作用 |
|---|---|
| `daemon` | 常驻循环，到点就跑 |
| `run-once` | 到期才跑一次（`--force` 强制） |
| `status` | 打印新鲜度，超期时 exit 2 |
| `list` | 列出可见备份（读不出的标 `UNREADABLE`） |

`nextRunAt({ now, lastSuccessAt, intervalMs })` **从上次成功往前推**，不是从「上次检查」往前推：机器关机 3 天，重启后只补跑一次，不会因为欠了 3 天而立刻连跑 3 次。

### 8.3 单实例

`acquireLock(stateDir)` 用 `open(lockPath, 'wx', 0o600)` 原子创建锁文件，内容是 `{ pid, host, acquiredAt }`：

- 创建成功 = 拿到锁。
- 已存在且 pid 在本机存活 = 另一个备份在跑，返回 `{ acquired: false, holder, reason }`。
- pid 已死 = 僵尸锁，回收后重试一次。
- 锁来自另一台主机 = 视为僵尸（避免 NFS 上永远卡死）。
- `release()` 只删自己 pid 的锁，不会误删别人的。

锁是必需的：两个备份同时往同一个 bucket 写，会得到两份都自称成功的备份和一份被 prune 掉的历史。

### 8.4 可选外层（本机不可用，换到有 cron 的机器时）

```cron
# 每天 03:10 跑一次；进程自己还有锁，所以这层重复调度是安全的
10 3 * * * LOG4STELLAR_BACKUP_KEY_FILE=/etc/log4stellar/backup.key /usr/bin/node /opt/log4stellar/apps/web/backup-schedule.mjs run-once --backup-root=/srv/log4stellar/backups --state-dir=/srv/log4stellar/backup-state >> /var/log/log4stellar/backup.log 2>&1
```

## 9. 过期清理

`pruneBackups(root, { keep = 7, maxAgeMs = 30d, dryRun })`：

- 只处理 `backup-*` 且有**可读清单**的目录；无清单的目录跳过并记入 `skipped`，不动手。
- 按 `createdAt` 降序保留。
- **最新的一个永不删除**，即使它已经超期。没有「因为都太老所以全删掉」这条路径。
- 返回 `{ kept, removed, skipped }`。

## 10. 验收标准与实际结果

| 验收项 | 判定 | 实际结果 |
|---|---|---|
| 备份 → 校验 → 删除副本 → 从备份恢复 → 逐字节比对 | 全部一致 | **19 项检查全部 PASS** |
| 账号库含只存在于 WAL 的提交 | 恢复后仍在 | 201 条 session 完整恢复 |
| PostgreSQL dump 能真正 apply | `psql --single-transaction` 成功 | 应用后 2 workspaces / 3 entries / 5 versions / 1 trash，与清单一致 |
| 对象恢复到**独立**桶并可读回 | hash 一致 | 5/5 对象回读一致 |
| 恢复不写生产 | 来源桶未被改动 | 来源对象仍完整可读 |
| 缺失必需成员 | 明确失败 | `MemberMissing`，目标目录未创建 |
| 密文被改一字节 | 明确失败 | `DigestMismatch`，目标目录未创建 |
| 错误密钥 | 写入前拒绝 | 8 × `DecryptionFailed`，目标目录未创建 |
| 缺失对象 | 明确失败 | `ObjectMissing`，目标目录未创建 |
| 备份时对象不可读（等价于撤权） | 备份失败并告警 | 非零退出，`alert.json` 写出，无备份目录发布 |
| freshness 超期判定 | 能回答「多久、是否超期」 | 50 小时前 → `STALE`，`2d2h ago`，exit 2 |
| 单实例 | 第二个实例拿不到锁 | 返回 holder 与 reason |

## 11. 风险与未完成项

### 11.1 真实的 RustFS 恢复演练仍是欠账

本次演练用的是本机 `docker run minio/minio` 起的独立 S3，不是生产 RustFS 集群本身。生产账号 `user_agent` 对 `192.0.2.9:9000` **只能读**：`HeadBucket` 返回 200，`CreateBucket` / `DeleteBucket` 返回 `403 AccessDenied`。因此**无法用生产凭据开隔离桶**。

要在真 RustFS 上做恢复演练，需要下列任一条件先成立：

1. 运维在生产 RustFS 上预建两个专用桶（如 `log4stellar-drill-backup`、`log4stellar-drill-restore`）并给演练账号读写权限；
2. 在另一台机器上部署一套 RustFS（同样的版本与配置），把备份恢复到那套里；
3. 给演练账号一个**独立 endpoint** 上的 RustFS 实例（S3 协议兼容即可，本机 minio 已证明路径可用）。

在此之前，「恢复到真 RustFS 并让工作区读出来」只能标记为**未验证**。本机 minio 的通过结果证明的是**代码路径**，不是**生产存储的行为**。

### 11.2 定时器需要一个家

`backup-schedule.mjs` 能跑，但**现在没有任何东西在跑它**。补齐方式（按优先级）：

1. 在有 cron 的机器上加 §8.4 那行（最简单，进程自带锁，重复调度安全）。
2. 修好用户级 systemd 总线后写一个 `log4stellar-backup.service` + `.timer`。
3. 交给既有的进程守护（若有）托管 `daemon` 子命令。

无论哪种，都必须同时配上 `status` 的退出码做监控——一个跑了但没人看的定时器，在第一次失败之后就和没跑一样。

### 11.3 密钥轮换未实现

`git-secret` 与账号 `secret` 本身可以换，但**换了之后用旧 `git-secret` 加密的 Git 凭据会解不开**。备份侧的密钥（`backup.key`）同理：换密钥之后旧备份仍可用旧密钥恢复，但没有任何「用新密钥重新加密旧备份」的工具。这部分需要在实现轮换策略时一并设计，本次未做。

### 11.4 PostgreSQL 只读导出依赖 docker

本机没有 `pg_dump` 二进制，`runDump()` 回退到 `docker run postgres:18 pg_dump`。生产机上如果没有 docker，需要安装 `postgresql-client` 并把 `LOG4STELLAR_PG_DUMP=` 指向二进制路径。这条依赖在备份失败时会以「docker 不存在」的形式出现，比在恢复时才发现要好。

### 11.5 备份大小

生产数据现在是 1033 个对象 / 272 MB。全量备份每天一次、保留 7 份 = 约 2 GB。对象是不可变内容寻址的，理论上可以做增量（只备份新增 digest），本次未实现——按当前体量，全量的简单性与可靠性更值得。
