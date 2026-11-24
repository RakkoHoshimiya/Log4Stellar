# Web 离线编辑契约（v1）

本文件是「Web 离线编辑」的实现契约，与 `docs/incremental-sync.md`（同步协议）并列为客户端与服务端的共同判据。凡本文件写明的存储键、状态机、状态码与顺序，实现与测试都必须一致；如需修改契约，先改本文件再改代码。

配套实现：`apps/web/offline-contract.js`（常量与纯校验）、`apps/web/offline-store.js`（IndexedDB）、`apps/web/offline-coordinator.js`（重连回放）、`apps/web/offline-provider.js`（工作台适配层）、`apps/web/offline-ui.js`（界面模型）、`apps/web/offline-client.js`（浏览器入口）、`apps/web/offline-files.mjs`（模块下发）。测试在 `apps/web/offline.test.mjs`，用 `apps/web/test-support/offline-fake-idb.mjs` 驱动真实的 IndexedDB 事务语义。

**优先级说明**：按 `功能开发之外需要处理的事项.md`，本项是 13 项中优先级最低的一项。首版只承诺「不丢字 + 不串号 + 可导出」，不承诺断网时立刻感知撤权，也不承诺自动合并。

## 1. 目标与非目标

| 类别 | 内容 |
|---|---|
| 目标 | 断网时编辑器仍可打开、编辑、保存到本地；恢复连接后按原顺序回放，且一次逻辑保存只产生一个版本；冲突时保留双方内容；同一浏览器换账号后互相不可见 |
| 非目标 | 端到端加密、实时推送、跨工作区同步、内容级自动合并（CRDT / 行级 merge）、多标签页协同编辑 |
| 明确不承诺 | 断网期间立刻感知账号撤权（首版只在**回放前**向服务端确认身份）；离线期间服务端删除文件后的可写性；离线队列跨设备迁移 |

## 2. 数据边界（硬性）

| 规则 | 判据 |
|---|---|
| 绝不持久化凭据 | session Cookie、`Set-Cookie`、`Authorization`、Bearer token、`X-Amz-Signature/Credential/Security-Token` 形式的预签名链接、JWT 形态字符串，全部在写入前拒绝 |
| 拒绝方式 | 抛 `OfflineError(ForbiddenPersistence)`，消息指出**字段路径**，绝不回显值本身 |
| 落点 | 只写 IndexedDB，不写 `localStorage`（除一个不含身份的设备随机串 `log4stellar.offline.device`） |
| 共享浏览器 | `sharedDevice: true` ⇒ `offlineEnabled()` 为假，任何写操作前即拒绝（`OfflineDisabled`）；默认关闭 |
| 登出或撤权 | `lockScope(reason)` 后队列停止回放，草稿保留且可导出 |

实现见 `offline-contract.js` 的 `forbiddenPersistenceKeys`、`forbiddenPersistencePatterns`、`assertPersistable()`。键名大小写不敏感且去掉非字母字符后比较（`apiKey`、`api_key`、`Api-Key` 同一类），值按上面的正则匹配；嵌套对象与数组递归检查，调用方无法用一层包裹把 token "洗白"。

## 3. IndexedDB 结构

数据库名 `log4stellar-offline`，`offlineSchemaVersion = 1`。

| 对象仓 | 主键 | 索引 | 内容 |
|---|---|---|---|
| `scopes` | `key` | — | 每个 (origin, accountId, tenantId, workspaceId) 一条使用记录与离线窗口 |
| `baseDocuments` | `key` | `byScope` | 服务端文档缓存，作为离线编辑的基线版本 |
| `drafts` | `draftId` | `byScope`、`byScopePath` | 每个路径**恰好一条**最新草稿（编辑器缓冲区） |
| `outbox` | `opId` | `byScope` | 待回放操作，`opId` + `idempotencyKey` 在入队时定死 |
| `receipts` | `opId` | `byScope` | 已确认的回执，保留 `seq` / `revisionId` 供核对 |
| `leases` | `leaseKey` | — | 多标签页互斥写锁，30 s 过期可被接管 |

复合键用 `\u0000` 连接：`compoundKey()` 拒绝含分隔符的分量（防止用路径伪造跨作用域键），`extendKey()` 用于在已有 `scopeKey` 后追加路径分量。两个函数的分工是刻意的，混用会直接抛错而不是静默串号。

**升级策略**：只增不删。`openOfflineDatabase()` 只创建缺失的对象仓与索引；若磁盘上的版本高于代码版本（回退到旧版时会发生），抛 `SchemaTooNew` 而不是继续读写——半懂不懂地读一个更新的结构比直接报错更危险。

## 4. 状态机

**草稿**（`draftStates`）：`saved` → `queued` → `synced`，`queued` 可转 `conflict`。

**操作**（`opStates`）：`pending` → `inflight` → 删除（成功）；`pending` → `blocked`（需人工）或 `failed`（重试耗尽）。

| 阻断原因 | 触发 | 用户可见动作 |
|---|---|---|
| `Conflict` | 409 `SyncConflict` | 处理冲突 / 导出草稿 |
| `NoPermissions` | 401 / 403 | 重新登录 / 导出草稿 |
| `ResyncRequired` | 410 | 重新登录 / 导出草稿 |
| `AccountChanged` | 409 `IdempotencyKeyReused` | 重新登录 / 导出草稿 |
| `OfflineExpired` | 超过离线有效期 | 重新登录 / 导出草稿 |
| `Dependency` | 同路径的兄弟操作冲突 | 处理冲突 / 导出草稿 |

不变量：**草稿与它的操作在同一次事务里写入**。只有草稿没有操作 → 用户以为提交了其实永远不上传；只有操作没有草稿 → 既无法回放也无法导出，是最坏的一种"丢失"。

`applyReceipt()` 在**同一事务**里写回执、删 `outbox` 行、必要时把新版本写入 `baseDocuments`；只有当该路径没有其他 `pending`/`inflight` 操作时，草稿才转 `synced`。否则界面会在还有未提交改动时就告诉用户"已保存"。

## 5. 回放

```
drainOutbox() →
  1. scopeRecord.locked          ⇒ 抛 ScopeLocked（不发送任何请求）
  2. verifyReplayScope()         ⇒ AccountChanged / OfflineExpired 时停止
  3. 过期窗口                    ⇒ lockScope(OfflineExpired) 后停止
  4. acquireLease()              ⇒ 未拿到 ⇒ { stopReason: 'lease' }（另一个标签页在跑）
  5. 按 createdMs, opId 排序；跳过 nextRetryAt 未到的
  6. 逐条重读 store.readOperation(opId)：状态不再是 pending 就跳过
  7. commit(op) 使用**存储里的** idempotencyKey
  8. classifyCommit(status, body) ⇒ committed / replayed / conflict / blocked / retry
```

三个不显眼但关键的细节：

1. **第 6 步的重读**：列表是在第一条上传之前读出来的，而 `handleConflict()` 会在循环中途把同路径的兄弟操作改成 `blocked`。不重读就会拿一个已经被作废的 `baseRevision` 去写，那正是把对方的冲突内容覆盖掉的方式。
2. **`replayed: true` 不算新工作**：服务端已提交但响应丢失时，客户端用同一个幂等键重发，服务端回 200 + `replayed: true`。客户端必须把它当作"确认"，不能当成一次新提交（否则本地会多算一个版本）。
3. **`IdempotencyKeyReused` 是硬停**：同一个键回答了不同的内容。重试不可能修复，换个新键则会产生第二个版本，所以只能阻断并要求人工介入。

`maxOperations`（默认 50）限制单次回放的条数：一个标签页不能在一次运行里占着租约跑完所有积压。

## 6. 冲突

服务端在 409 里给出 `conflictPath`、`currentRevision`、`seq`。客户端**不合并**，因为合并 Markdown 会静默丢掉格式与结构，任务书明确禁止静默覆盖。

| 用户选择 | 行为 |
|---|---|
| 保留我的 | 以服务端 `currentRevision` 为新基线重新提交（`resolvePendingConflict` → `action: 'resubmit'`） |
| 保留对方的 | **必须先导出**（`exported === true`），否则返回 `{ ok: false, reason: 'export-first' }`，随后 `action: 'discard'` |
| 合并 | 不支持，返回 `unknown-resolution` |

冲突时同路径的其他 `pending` 操作转为 `blocked/Dependency`；其他路径不受影响，继续回放。

## 7. 离线有效期与重新鉴权

| 项 | 值 | 理由 |
|---|---|---|
| 默认窗口 | 7 天 | 一周的离线队列更像未完成的工作；超过一周更像过期数据 |
| 上限 | 30 天 | 产品决策必须写下来，不能靠默认值暗示 |
| 起算点 | 该作用域**第一次**离线写入 | 再次编辑不得延长窗口，否则天天碰一下就能无限续命 |
| 恢复连接 | 先 `verifyReplayScope()`，再回放 | 首版不承诺断网时立刻感知撤权；重连时必须重新确认身份 |

`verifyReplayScope()` 的四条判据：`authenticate()` 必须返回 `ok: true`；`origin`/`accountId`/`tenantId`/`workspaceId` 必须与队列所属作用域**完全一致**（否则 `AccountChanged`，消息为 "The session belongs to a different account or workspace."）；会话自身的 `expiresMs` 不得已过（否则 `OfflineExpired`）。

## 8. 界面

`offlineBanner()` 只产出视图模型，`renderOfflineBanner()` 才碰 DOM。优先级：`conflict` > `blocked`（锁定 / 过期 / 重试耗尽）> `pending` > `local` > `synced`。

`outboxRows()` 给每行操作中文原因、尝试次数、上限与是否临近放弃（`attempts >= ceiling - 2`）；`canExport` 恒为真——导出是最后一道保险，任何状态下都不能被关掉。

`resolvePendingConflict()`、`exportPendingDrafts()`、`offlineWindowNotice()`、`actionLabel()` 都是纯函数，便于在无 DOM 环境（Node 测试、服务端渲染）中验证。

## 9. 模块下发

| 项 | 值 |
|---|---|
| 路径 | `/api/offline-editing/<module>.js` |
| 允许的模块 | `offline-client.js`、`offline-contract.js`、`offline-coordinator.js`、`offline-provider.js`、`offline-store.js`、`offline-ui.js` |
| 方法 | `GET` / `HEAD`，其他 `405 { error: 'MethodNotAllowed' }` |
| 缓存 | `Cache-Control: no-store`（旧客户端配新服务端必须立刻暴露，而不是等缓存过期） |
| 未知模块 | `404 { error: 'NotFound' }` |
| 鉴权位置 | 在会话门禁**之前**下发，理由与 `/login` 相同：加载不到客户端模块的浏览器连问会话都做不到。这里没有工作区内容 |

## 10. 验收（O01–O04）

| 编号 | 场景 | 判据 |
|---|---|---|
| O01 | 写入草稿后强制终止标签页，重新打开 | 草稿内容与 `opId` 都能恢复（`reloading the tab recovers the draft and its operation ID`；另有一条用例证明事务失败时不留下半条记录） |
| O02 | 服务端已提交但响应丢失，重连 | 用原幂等键确认，服务端只产生一个版本（`a replayed answer commits exactly once`、`a lost response is retried with the same key and lands once`） |
| O03 | 离线期间云端更新同一文件 | 保留双方内容，展示冲突状态，草稿可导出（`a conflict keeps both sides and pauses only that path`） |
| O04 | A 离线保存后切到账号 B 或被撤权 | B 看不到 A 的本地数据；A 的队列不会跨账号提交（`another account in the same browser cannot read the first account data`、`replay refuses a queue written under a different account before sending`） |

## 11. 回退

1. 先停提交：把 `LOG4STELLAR_OFFLINE` 关掉（或不再渲染离线横幅），队列停止回放。
2. **保留 IndexedDB**：清库等于删用户数据；保留期间用户可以导出。
3. 提供导出：`exportAllDrafts()` 不需要网络、不需要未锁定的作用域。
4. 若必须回退到不支持该数据格式的版本，先导出再升级 schema 版本号，绝不静默改结构。

## 12. 已知缺口

| 缺口 | 影响 | 建议 |
|---|---|---|
| 工作台尚未调用 `createOfflineController()` | 模块已下发、已通过测试，但真实编辑器还没有接入 | 在 webview 打开文档的路径上接入（需前端改动） |
| 未做浏览器端到端测试 | O01 的"强制终止标签页"在 Node 里用新建 store 实例模拟，不是真的杀进程 | 复用 `account-security.browser.test.mjs` 的 playwright 骨架 |
| 冲突展示依赖调用方渲染 | `handleConflict()` 只返回状态，不生成 UI | 由工作台把 `outboxRows()` 接到侧边栏 |
| 未处理配额耗尽后的自动清理 | `QuotaExceededError` 只回滚事务 | 加一条"按 updatedMs 清理已 synced 草稿"的策略 |
| 离线期间服务端删除文件 | 回放时才 404 | 首版按任务书不承诺，回放时转 `blocked/Dependency` |
