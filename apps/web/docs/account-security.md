# 账户安全与双因素登录契约（v1，提案）

本文件是「账户安全与双因素登录」（任务单第 4 项）的实现契约，与
[`workspace-access.md`](./workspace-access.md)（权限）和
[`incremental-sync.md`](./incremental-sync.md)（同步）同级。它描述**协议与判据**，
不描述实现。

配套模块：[`../account-security.mjs`](../account-security.mjs)
配套测试：[`../account-security.test.mjs`](../account-security.test.mjs)

交付形态与同步契约一致：**契约先落地，实现后接线**。本批次不改
`auth.mjs` / `auth-gateway.mjs` / `serve-demo.mjs` 任何一行，不挂路由，不执行 DDL，
不连接数据库与对象存储。所有交付物都是常量表与纯函数，可在裸检出上跑通测试。

如需修改契约，先改本文件，再改代码，最后改测试。

---

## 1. 不变量

以下五条是不可协商的，任何实现方案都必须同时满足。后文的每个取舍都从它们推导。

| # | 不变量 | 判据 |
|---|---|---|
| I1 | 密码通过但第二因素未完成时，账号读不到任何笔记字节 | 所有 `notes` 面（`/`、`/api/session`、`/static/mount/*`）对该状态返回 403/303，且响应体不含笔记数据 |
| I2 | 半认证态的存续时间远短于闲置过期时间 | 600s vs 86400s，比值 144 |
| I3 | 同一时间步的 TOTP 只能被接受一次 | 第二次使用同一 step 返回 `TotpCodeReplayed` |
| I4 | 恢复码一次性，重新生成后旧码全部失效 | 消费后集合减一；轮换后新旧集合交集为空 |
| I5 | 只允许新增表/列/索引，绝不删改现有列 | 迁移语句全部通过 `assertAdditiveMigration` |

---

## 2. 身份模型（复用既有定义，不新增层级）

`workspace-access.md` §1 定义的四层身份**完全不变**，本契约只在最外层补一个状态：
会话本身的「完成度」。

| 层 | 值 | 本契约的动作 |
|---|---|---|
| `tenant_id` | `'default'` | 不涉及 |
| `workspace_id` | 单一权威 ID | 不涉及 |
| member（角色） | owner=3 / editor=2 / viewer=1 | 不涉及 |
| **session（完成度）** | **`full` / `half` / `anonymous`** | **本契约新增** |

关键约束：**`half` 不是弱化的 `session`，而是「没有 session 行」**。better-auth 在
判定需要二次验证时，会主动删除刚创建的会话行并清空会话 cookie（见 §4.5）。因此
`half` 无法被任何从 session 出发的代码路径复用——这正是 I1 能成立的机制，而不是
依赖每个 handler 记得检查。

`authStateRank` 给三种状态一个数序（anonymous=0 < half=1 < full=2），「至少半认证」
这类判断退化为一次整数比较。

---

## 3. 威胁模型与信任边界

### 3.1 资产与保护对象

| 资产 | 存储位置 | 它保护什么 | 泄露后果 | 本契约可做的 |
|---|---|---|---|---|
| 会话 cookie | 浏览器，`HttpOnly` + `Secure` + `SameSite=Lax` | 一次已认证的访问权 | 攻击者获得完整账号（等价于本人） | 半认证态不签发会话；闲置 24h 过期；改密撤销其它会话 |
| 会话 token | `session.token`（SQLite） | 同上 | 同上 | **绝不返回给前端**，对外只给 22 字符摘要 ID |
| 密码 | `account.password`（argon2id，m=19456, t=2, p=1） | 第一因素 | 攻击者仍需第二因素 | 改密需当前密码 + 撤销其它会话 |
| TOTP 种子 | `twoFactor.secret`（better-auth 对称加密） | 第二因素 | 攻击者可离线生成任意验证码，第二因素永久失效 | 种子从不出库、不回显；显示待绑定态直到首次验证成功 |
| 恢复码 | `twoFactor.backupCodes`（同密钥加密） | 第二因素的备用通道 | 同上，且绕过重放防护 | 一次性、常量时间比较、只显示一次 |
| `<authDir>/secret` | 磁盘文件 | 加密上述两者的根密钥 | **同时**泄露种子与恢复码，并伪造所有签名 cookie | 纳入备份/迁移清单，不轮换 |

`secret` 文件是所有加密与签名的根。它的存在意味着：**TOTP 种子不是「存在数据库里」，
而是「存在数据库里、但只在拥有 secret 文件的进程里可读」**。备份 `auth.sqlite`
而不备份 `secret`，等于备份了一堆无法解密的种子；反过来，只泄露 `secret` 而不泄露
`auth.sqlite` 也并不能直接算出种子。这两者必须一起保护，见 §10。

### 3.2 攻击者能力假设

设计时假设攻击者可以：

- 拿到数据库文件的一份拷贝（`auth.sqlite` + `-wal` + `-shm`），但**没有** `secret` 文件；
- 看到用户屏幕上的一次验证码（肩窥、录屏、截屏、同事）；
- 在登录过程中做实时中继（钓鱼页面把验证码转发给真实服务器）；
- 无限次重放任何一次观察到的 HTTP 请求（但不改签名）；
- 控制 User-Agent 与任意请求头，向账号页注入任意文本。

假设攻击者**不能**：

- 读取服务器文件系统或环境变量（那已经等于完全失陷，见 §3.3）；
- 绕过 TLS 终止点；
- 在 10 分钟内同时持有会话 cookie 与挑战 cookie（否则直接按 I1 失败处理）。

### 3.3 信任边界

| 边界 | 内侧 | 外侧 | 穿越方式 |
|---|---|---|---|
| B1 浏览器 ↔ 服务器 | 服务器进程（持有 secret） | 任意客户端 | TLS；所有 cookie 签名 |
| B2 网关 ↔ better-auth | 网关中间件 | `auth.handler()` | 进程内调用，不经过网络 |
| B3 服务器 ↔ 数据库 | 进程内 `DatabaseSync` | 磁盘文件 | 无（同机），因此数据库文件按「可能泄露」设计 |
| B4 上传路径 | 校验后的路径 | 文件系统 | `normalizeWorkspacePath` |

B3 的形状决定了 §4.4 的存储选择：既然我们假设数据库文件可能泄露，种子就必须
在数据库里是密文，而不是「反正数据库不会被看到」。

---

## 4. 第二因素

### 4.1 方案选择

需求是「Authenticator 兼容的 TOTP」。逐项对照任务单的非目标（§12）：

| 方案 | 采用 | 理由 |
|---|---|---|
| TOTP（RFC 6238） | **是** | 无需联网、无需服务端发起、用户已有 App、离线可用；better-auth 1.7.27 原生支持 |
| WebAuthn / passkey | 否 | 需要 origin 绑定的凭据管理，当前部署是自签 HTTPS + IP，无 RP ID 可用 |
| 短信 OTP | 否 | 需要短信通道与成本，且 SIM 交换是已知攻击 |
| 邮件 OTP | 否 | 邮箱是 `` `<user>@log4stellar.invalid` `` 合成地址，不存在真实邮箱 |
| 推送确认 | 否 | 需要移动端 App |

TOTP 的唯一硬伤是「种子是共享秘密」——一旦种子泄露，第二因素永久失效。这由
§4.4 的加密存储和 §8 的解绑确认部分承担，不接受「种子明文入库换取简单」。

### 4.2 TOTP 参数

| 参数 | 值 | 理由 |
|---|---|---|
| 算法 | **SHA-1** | RFC 6238 §1.2 明确保留 SHA-1 用于兼容；`@better-auth/utils` 的 `generateHOTP` 硬编码 `createHMAC("SHA-1")`，且其 QR 生成器**不输出 `algorithm` 参数**，因此所有 App 都会用 SHA-1 计算。写 SHA-256 会让文档与服务器不一致 |
| 位数 | **6** | RFC 6238 §5.3 推荐；10⁶ 配合 5 次尝试上限 + 账号锁定，爆破成功概率 < 5×10⁻⁶ |
| 步长 | **30s** | RFC 6238 §5.1 默认；better-auth 默认同值 |
| 允许偏移 | **±1 步** | RFC 6238 §5.2「一个时间步」的容差；手机时钟漂移与「踩着步边界输入」都会产生 off-by-one |
| 种子长度 | **32 字符**（=160 bit，base32 后 32 符号） | RFC 6238 §5.1 要求 ≥128 bit 且推荐 160 bit；better-auth 的 `generateRandomString(32)` 正好满足 |
| 签发者 | `Log4Stellar` | QR 中显示的发行方，避免与其它站点混淆 |
| 信任设备 | **禁用** | better-auth 支持 30 天 `trust_device` 免二次验证，但那把双因素降级为单因素整整一个月，直接违反需求 3 |

**为什么算法不能是 SHA-256。** 这不是偏好问题。`createOTP(secret, {digits, period})`
的签名里根本没有 `algorithm`，而 `generateHOTP` 内部是 `createHMAC("SHA-1")`；
`generateQRCode` 生成的 URI 形如
`otpauth://totp/Log4Stellar:<account>?secret=<base32>&issuer=Log4Stellar&digits=6&period=30`
——**没有 `algorithm=` 段**。按 RFC 6238，缺省即 SHA-1。如果文档声称 SHA-256，
则服务器与用户 App 会算出不同的码，绑定永远无法完成。这是一条从源码读出的事实，
不是从印象写出。

### 4.3 重放防护（本契约新增的核心逻辑）

**结论：同一时间步的验证码只接受一次，第二次拒绝，错误码 `TotpCodeReplayed`（401）。**

#### 为什么必须拒绝

1. **TOTP 是持有型凭据（bearer），不是挑战-应答。** 验证码本身就是第二因素。
   与签名不同，重放它每次都同样地「证明」了持有，因此重放永远是有效的——除非
   服务端记账。协议层面不存在「验证码用过一次就自然失效」的性质。

2. **±1 窗口把窗口放大到 90 秒。** 一个码属于 step S，服务器在 [S-1, S+1] 三个
   步内都接受它。若不做记账，从「用户输入」到「step S+1 结束」之间最多约 90 秒
   内，旁观者可以无限次复用同一个码。窗口本身不可去掉（时钟漂移是现实），所以
   记账是唯一能收窄杀伤面的手段。

3. **否则「实时中继钓鱼」没有输家。** 攻击者搭一个假登录页，用户输入密码和验证码，
   攻击者把两者转发给真服务器。若服务器允许码复用，攻击者可以在用户之后**再登录
   一次**，建立自己的会话——用户完全没有察觉，因为他也成功登录了。一旦 server-side
   记 step，先到者赢，后到者收到 401，用户至少有机会看到一次失败。

4. **否则「一次观察 = 无限会话」。** 肩窥到一个码，攻击者可以在有效期内开任意多个
   会话。每个会话都是一份独立的、24 小时的有效访问权，并且出现在设备列表里——
   用户需要逐个撤销。记账把「一次观察」压缩成「零或一次」，且这一次要抢在用户之前。

5. **它让窗口宽度不再是安全问题。** 有记账时，窗口只影响**接受范围**，不影响
   **可复用次数**（恒为 1）。没有记账时，加宽窗口会线性放大重放机会。这条性质
   意味着将来若必须放宽窗口（例如某些 App 时钟很差），安全论证不需要重写。

#### 机制

`account_totp_replay(user_id PRIMARY KEY, last_used_step INTEGER NOT NULL, updated_at INTEGER NOT NULL)`

- 校验顺序：先算 `currentStep = totpStepFor(now)`，检查提交码所属 step 落在
  `[currentStep-1, currentStep+1]` 内（否则 `InvalidTotpCode`），再比较
  `step > last_used_step`（否则 `TotpCodeReplayed`）。
- 比较必须是 **`>` 而不是 `>=`**：接受即消费，同一 step 立即作废。
- 写入必须是 **compare-and-set**：`UPDATE account_totp_replay SET last_used_step = :step,
  updated_at = :now WHERE user_id = :user AND last_used_step < :step`。受影响行数为 0
  即视为失败。否则两个并发请求可以同时通过读检查。
- 该写与「创建会话」必须在同一事务里；会话创建失败则 step 不消费（宁可让用户重试，
  也不要吃掉一个有效时间步）。
- 时钟回拨不会复活已消费的 step，因为判据是持久化的 `last_used_step` 而非「当前时间」。

**为什么不用「最近 N 个码」的内存缓存。** 进程重启即丢失，且多实例部署时各存一份，
两者都会让记账静默失效；静默失效的安全机制比没有更危险。

**为什么 better-auth 不做这件事。** 1.7.27 的 `verifyTOTP` 是在窗口内循环比对，
匹配即返回，没有任何「已消费 step」的概念；插件也没有相关表。这是本契约必须
自己补上的部分，见 §4.5 冲突表第 1 行。

### 4.4 种子与恢复码的存储形态

| 对象 | 数据库中的形态 | 密钥 | 前端可见性 |
|---|---|---|---|
| TOTP 种子 | `twoFactor.secret`，better-auth `symmetricEncrypt` 的 `$ba$1$<hex>` 信封（XChaCha20-Poly1305，managed nonce） | `SHA-256(<authDir>/secret 的内容)` | 绑定时通过 QR/URI 一次性展示；此后**永不返回**（字段 `returned:false`） |
| 恢复码 | `twoFactor.backupCodes`，同一密钥加密的 JSON 数组 | 同上 | 生成时一次性展示；此后**永不返回** |
| 重放游标 | `account_totp_replay.last_used_step`，明文整数 | 无（不含秘密） | 不返回 |

不使用明文的原因很直接：§3.2 假设数据库文件可能被拷走。加密后，拷贝者仍需
`secret` 文件才能还原种子；而 `secret` 文件不在同一个目录（它在 auth 目录下，
但代码注释与 README 都把「备份 auth.sqlite」和「备份 secret」分开描述，运维很容易
只备份后者）。这是纵深防御，不是「数据库已经泄露就完了」的托词——两者同时泄露
才是完全失陷，只泄露一个是常见事故。

**密钥轮换的后果必须写清楚：轮换 `<authDir>/secret` 会让所有已绑定的 TOTP 种子与
恢复码永久不可读**（解密失败，无法迁移）。因此 `secret` 是本契约里唯一
**不可轮换**的密钥。需要轮换时，正确流程是：先让所有用户解绑 2FA → 轮换 →
重新绑定。这一点必须在运维文档里显著标注，§10 给出了迁移/回滚约束。

**为什么不用独立的 `LOG4STELLAR_TOTP_KEY`。** 那会引入第二个必须备份的密钥，
而它保护的东西与 `secret` 保护的东西高度重叠（`secret` 同时是 cookie 签名密钥）。
多一个密钥 = 多一次配错的机会，收益只是「轮换时少影响一点」——但轮换本来就不可行。
维持单密钥。

**恢复码补充：显式注入生成器。** better-auth 默认用 `a-zA-Z0-9` 生成 10 位码，
并按 `XXXXX-XXXXX` 分组。该字符集**无法规范化**（`l`/`1`、`O`/`0` 在视觉上无法
区分，而输入方无法安全折叠大小写——`Array#includes` 是逐字节比较）。本契约改用
30 符号的 Crockford 风格字符集（去掉 `I L O U 0 1`），通过
`backupCodeOptions.customBackupCodesGenerate` 注入。这样 `normalizeRecoveryCode`
可以安全地大小写折叠、去掉空白与连字符，而不会把两个不同输入映射到同一个码。

### 4.5 better-auth 1.7.27 事实清单与冲突点

以下全部来自阅读 `node_modules/better-auth/dist/plugins/two-factor/*` 与
`dist/api/routes/session.mjs`，不是推测。

| # | 事实 | 与本项目的冲突 | 处理建议 |
|---|---|---|---|
| 1 | `verifyTOTP(otp, {window: 1})` 在 ±1 步内循环比对，**不记录已消费 step**，同一码可重复验证 | 违反 I3 | 新增 `account_totp_replay` 表（§4.3）。**这是必须新增的唯一一张表** |
| 2 | `verifyBackupCode` 用 `codes.includes(data.code)` 比较，短路、非常量时间 | 恢复码路径可被计时探测 | 在网关侧用 `matchRecoveryCode` 先做常量时间比对，命中后才调用插件；插件侧比较退化为「必然命中」 |
| 3 | 默认恢复码字符集 `a-zA-Z0-9`，10 位 | 无法规范化输入 | 通过 `backupCodeOptions.customBackupCodesGenerate` 注入 §4.4 的字符集 |
| 4 | **`/api/auth/list-sessions` 返回每个会话的原始 `session.token`**（该字段没有 `returned:false`） | 会话列表页若直接代理该端点，等于把每个设备的 bearer 凭证交给前端 | **不代理**。网关自己查 `session` 表，用 `describeSession` 基于白名单构造描述符，token 只以 22 字符摘要 `sessionIdFor(token)` 出现 |
| 5 | 二次验证期间：删除会话行、`deleteSessionCookie`、`setNewSession(null)`，然后返回 `200 {twoFactorRedirect: true, twoFactorMethods}` | 无冲突——**这正是 I1 所需的机制** | 复用。半认证态由插件的 `two_factor` cookie + `verification` 行承载，无需自建半认证会话 |
| 6 | 挑战 cookie：`__Secure-better-auth.two_factor`，`maxAge` 默认 600s；对应 `verification` 行 `2fa-<20>` → userId 与 `2fa-attempts-2fa-<20>` → `"0"` | 与本契约 600s 一致 | 复用；把数值钉进 `challengePolicy` 并由 `verifySecurityInvariants` 断言 |
| 7 | `beginAttempt(5)`：单次挑战 5 次尝试；`accountLockout` 默认 10 次失败 / 900s | 无冲突 | 复用，并在文档与 UI 里明确「5 次后需重新登录」 |
| 8 | 插件 rateLimit：`/two-factor/*` 10 秒内 3 次 | 无冲突 | 复用；等于每分钟 18 次，配合 5 次尝试上限已足够 |
| 9 | `trust_device` cookie 30 天 | 违反需求 3（把双因素降级为单因素一个月） | **不启用**。`challengePolicy.trustDeviceEnabled = false`，且不传 `trustDevice: true` |
| 10 | 插件需要 `user.twoFactorEnabled` 列与 `twoFactor` 表；由 better-auth 自身的 `getMigrations().runMigrations()` 创建 | 与现有迁移机制一致（`auth.mjs` 每次启动都跑） | 不手写这两者的 DDL；由插件迁移负责。本契约只新增 §4.3 的一张表 |
| 11 | 绑定流程：`/two-factor/enable` 存 `secret` 且 `verified: false`，直到第一次 `verify-totp` 成功才置 `twoFactorEnabled: true` | 无冲突 | 复用。这提供了「绑到一半放弃不会把账号锁死」的安全网 |
| 12 | `/two-factor/disable` 需要密码，删除 `twoFactor` 行、置 `twoFactorEnabled: false`、**重建会话并删除旧会话**、清 `trust_device` | 与「解绑后其它会话是否失效」相关 | 复用其重建会话行为；见 §9 |
| 13 | 插件端点全部挂在 `/api/auth/*` 下，与网关现有的 `/api/session` 分类不同 | 网关只对 `/api/session*` 做专门处理 | `/api/auth/*` 目前是「非认证路径」直接 `await next()`；接线时必须显式收口（§13 未完成项） |

**结论：不需要额外表来描述「半认证会话」。** 插件已经用 `verification` 承载挑战，
并且已经删掉了会话行。额外加一张「半认证会话表」只会带来第二份真相。本契约
只新增一张**重放游标**表，因为那是插件唯一真正缺失的能力。

---

## 5. 登录状态机

### 5.1 三态

```
                  POST /login (密码正确, 未启用 2FA)
   anonymous ───────────────────────────────────────────► full
       │                                                   ▲
       │ POST /login (密码正确, 已启用 2FA)                 │ POST /api/auth/two-factor/verify-totp
       │   插件删除会话行 + 下发 two_factor cookie          │   (或 verify-backup-code)
       ▼                                                   │
      half ─────────────────────────────────────────────────┘
       │
       │ cookie 过期(600s) / 尝试用尽 / 主动登出
       ▼
   anonymous
```

| 状态 | 判据 | 携带的凭据 | 有效期 |
|---|---|---|---|
| `full` | `get-session` 返回带 `user` 且 `session.expiresAt > now` | 会话 cookie | 闲置 24h，活动续期 |
| `half` | 无会话行，且 `two_factor` cookie 验签通过、其 `verification` 行存在且未过期、`value === userId` | 挑战 cookie | **600s 固定，不续期** |
| `anonymous` | 其它一切 | — | — |

`classifyAuthState({session, challenge, nowMs})` 是唯一判定点。**已过期的 session
与不存在的 session 同等对待**（`expiresAt > now` 严格大于），避免时钟抖动带来的
短暂越权。`challenge` 必须是**服务端已验证**的挑战描述符（验签 + 查
`verification` 行），本函数不看 cookie 原文——验签需要 `secret`，不能放在纯函数里。

### 5.2 半认证态用什么标识

三个候选，逐个否决：

| 方案 | 优点 | 致命问题 | 结论 |
|---|---|---|---|
| **独立 cookie（插件已有）** | 无状态、无需新表、插件已实现并且已删除会话行 | 无 | **采用** |
| session 表加列（`two_factor_pending`） | 一个对象 | (a) 违反 I5 的「不改现有列」；(b) 危险：任何只查 `session` 表就放行的代码（`/api/session`、`/mounted`、`serve-demo` 的 HTML 注入）都会把 pending 行当作有效会话 —— I1 立刻失守；(c) 需要自己清理过期行 | 否决 |
| 短时效 token 表 | 可控 | 与插件并存时有两套挑战语义（插件的 `verification` 行 + 自建行），两份真相必然漂移；且仍要新增表 | 否决 |

**为什么「session 表加列」是本设计里最危险的诱惑。** 它看起来最省事，但它把
「半认证」塞进了唯一一个已经被所有路径信任的对象里。现有代码里至少三处
`get-session` 之后直接 `await next()` 或直接读文件；这些地方没有理由知道
`two_factor_pending` 这个新列。任何一处漏改就是笔记泄露。反过来，插件的方案
把半认证态放在**完全不同的对象**里，与会话行互斥，于是 I1 由结构保证，而不是
由「我们记得改每一个地方」保证。

### 5.3 半认证态能拿到什么（I1 的证明）

| 请求 | `full` | `half` | `anonymous` |
|---|---|---|---|
| `GET /`（工作台 HTML） | 200 | **303 → `/login?twofactor=1`** | 303 → `/login` |
| `GET /api/session` | 200 `{remainingMs, workspaceId}` | **403 `TwoFactorPending`** | 401 |
| `POST /api/session/activity` | 200（续期） | **403 `TwoFactorPending`** | 401 |
| `GET /static/mount/*` | 200 文件字节 | **403 `TwoFactorPending`** | 401 |
| `GET /static/mount/` | 200 目录索引 | **403** | 401 |
| `GET /session-client.js` | 200 | 200 | 200（登录页需要） |
| `GET /static/build/*` | 200 | 200 | 200（工作台静态资源） |
| `GET /login` | 200 | 200（切换账号） | 200 |
| `POST /login` | — | 允许（重新走密码） | 允许 |
| `POST /api/account-security/two-factor/verify` | 409 `TotpNotEnrolled` 语境的拒绝 | **允许** | 允许（无 cookie 时 401 `TwoFactorChallengeRequired`） |
| `POST /api/account-security/*`（其它） | 允许 | **403 `TwoFactorPending`** | 401 |
| `POST /api/session/logout` | 200 | **200**（可以放弃挑战） | 401 |

三条支撑论据：

1. **结构上无会话行。** `half` 状态下 `session` 表里没有该用户的任何行，因此
   「查会话 → 放行」的路径查到了空。这不是靠判权函数拦下来的，是数据不存在。
2. **判权先于参数校验。** 与 `workspace-access.md` §3 同一原则：半认证用户对
   `POST /api/account-security/password` 发送畸形 body，得到的是 403
   `TwoFactorPending`，而不是 400 `InvalidPasswordInput`。后者会暴露
   「你的 payload 到达了校验器」，也就暴露了「这个端点对你是开放的」。
3. **工作台 HTML 不可见。** 即使只静态地看 HTML，也能看出账号名与工作区结构
   （`serve-demo.mjs` 会注入 `log4stellarWebAccount` 与 `folderUri.authority`）。
   因此 `/` 对 `half` 是 303，不返回任何 HTML 字节。

**`/static/build/*` 与 `/session-client.js` 为什么对 `half` 放行。** 它们是 VS Code
前端的静态资源与轮询脚本，本身不含任何用户数据（构建产物按发布包哈希命名）。
挡住它们只会让挑战页面加载失败。它与会话无关的性质由「不含用户数据」保证，而不是
由认证保证。`/static/mount/*` 则相反：那里就是笔记本身。

### 5.4 状态迁移矩阵

| 当前 | 事件 | 结果 | 副作用 |
|---|---|---|---|
| anonymous | 密码正确，未启用 2FA | full | 创建会话；`expiresAt = now + 24h` |
| anonymous | 密码正确，已启用 2FA | half | 插件删除会话行、下发挑战 cookie（600s） |
| anonymous | 密码错误 | anonymous | 计入限速（8 次/60s） |
| half | TOTP 正确 + step 未消费 | full | 消费 step（CAS）、创建会话、清挑战 cookie |
| half | TOTP 正确但 step 已消费 | half | `TotpCodeReplayed`；计入尝试 |
| half | TOTP 错误 | half | `InvalidTotpCode`；`beginAttempt` 消耗 1 次（共 5 次） |
| half | 恢复码正确 | full | 消费一个恢复码、创建会话 |
| half | 恢复码错误 | half | `InvalidRecoveryCode` |
| half | 尝试用尽 / 挑战 cookie 过期 | anonymous | 需重新输入密码 |
| half | `POST /api/session/logout` | anonymous | 清挑战 cookie |
| full | 闲置 24h | anonymous | 会话过期 |
| full | 改密且 `revokeOtherSessions` | full（其它会话 anonymous） | 当前会话被重建 |
| full | 解绑 2FA | full | 删除 `twoFactor` 行；会话被重建 |

### 5.5 过期语义

- **挑战期固定 600s，不续期。** 「续期」只对 `full` 有意义（需求 4 的前台活动续期）。
  半认证态若能续期，攻击者只要保持活动就能无限拖延一个已泄露的密码，把
  「需要第二因素」变成「需要第二因素，随时可以」。
- **第二因素完成时才起算 24h。** `sessionExpiryAfterSecondFactor({completedAtMs})`
  从挑战完成时刻加 `idleSeconds`，而不是从密码通过时刻。否则用户在验证码输入框上
  犹豫 20 分钟，会话就只剩 23h40m——由一个与安全无关的因素决定。
- 半认证态的绝对上限（`maxHalfAuthLifetimeSeconds`）等于 cookie 生命期，
  `verifySecurityInvariants` 断言它至少比闲置窗口小 24 倍（I2）。

---

## 6. 设备会话

### 6.1 识别

会话是 `session` 表的一行，主键是随机 token。**识别符取自 token 的摘要，不取自
token 本身**：

```
sessionId = base64url(SHA-256(token))[0..22]
```

22 字符 = 132 bit，碰撞不可行；单向，无法从 ID 反推 token。为什么必须这样：
better-auth 的 `/list-sessions` 直接返回每个会话的 `token`（插件事实表第 4 行），
而 token 就是 bearer 凭证——一个能打开「我的设备」页的 XSS 就能读走所有设备的
凭证，比不做这个功能还糟。

### 6.2 标签来源

两层，用户命名优先：

1. **用户自定义标签**（`normalizeDeviceLabel`）：1–40 字符，控制字符与双向文本
   覆盖符（U+202A–U+202E, U+2066–U+2069）被替换为空格。理由：标签会作为文本渲染
   进账号菜单；一个含 RTL override 的标签可以让「另一个会话」看起来像别的东西，
   是现成的钓鱼面。
2. **UA 派生的兜底**（`describeUserAgent`）：只从固定表里挑浏览器名 + 主版本号
   与平台名，拼成 `平台 · 浏览器`。无法识别时使用 `未知设备`。

**原始 User-Agent 永不展示。** 它完全由客户端控制，可以包含任意 HTML/脚本；把它
渲染进账号页是自造的 XSS 面。`describeUserAgent` 只做「匹配固定表」，输出必然属于
一个有限的字符串集合，因此天然安全。

### 6.3 可以给用户看的字段

`describeSession` **按白名单逐个赋值**（绝不对整行做 `...spread`——那正是新增一列
就把 `token` 带进响应的经典事故）：

| 字段 | 内容 |
|---|---|
| `id` | 22 字符摘要 |
| `device` | 用户标签或派生标签 |
| `browser` / `platform` | 固定表里的名字 |
| `current` | 是否当前设备 |
| `createdAtMs` / `lastActiveMs` / `expiresAtMs` | 毫秒时间戳 |
| `expiresInMs` | 距闲置过期的剩余毫秒（≥0） |
| `network` | **仅当显式 `includeNetwork:true`**：脱敏网络（IPv4 → `/24`，IPv6 → `/48`） |

### 6.4 绝对不能泄露的

`sessionDescriptorWithheldFields` 显式列出：`token`、`ipAddress`、`userAgent`、
`userId`、`impersonatedBy`、`secret`、`backupCodes`、`password`。

| 字段 | 泄露后果 |
|---|---|
| `token` | 直接冒用该设备 |
| `userId` | 内部主键外泄，便于跨系统关联 |
| `impersonatedBy` | 暴露管理员是否在冒充（本身是敏感运维事实） |
| `ipAddress`（完整） | 定位到具体地址；截图账号页即泄露位置信息。故只给 `/24`、`/48` |
| `userAgent`（原始） | XSS 面 + 精确指纹 |

**为什么连脱敏网络都要 opt-in。** 会话列表的核心问题只有「这个是不是我」。
网络段对回答它帮助有限，而默认展示会让每个用户账号页都成为一份位置披露。默认关闭，
由部署方按需打开。

---

## 7. 恢复码

| 属性 | 值 | 理由 |
|---|---|---|
| 数量 | 10 | better-auth 默认；足以覆盖「换手机 + 弄丢一台」的场景 |
| 长度 | 10 符号，分两组 `XXXXX-XXXXX` | 30⁵ ≈ 14.3 bit × ... 总计 ~49 bit；配合锁定，离线爆破不可行 |
| 字符集 | `ABCDEFGHJKMNPQRSTVWXYZ23456789`（30 符号） | 去掉 `I L O U 0 1`，可安全大写折叠 |
| 一次性 | 是 | 消费即从集合移除；写入用旧密文的 compare-and-set，防止并发双花 |
| 存储 | `twoFactor.backupCodes`，加密 | 同 §4.4 |
| 展示 | 仅在生成时一次性展示 | 之后接口返回 `returned:false`，不可回读 |
| 比较 | **常量时间**（`timingSafeEqual` over SHA-256 摘要） | 见下 |

**为什么必须常量时间。** 恢复码是唯一一条「攻击者持有候选值并能反复重试」的路径——
用户丢了手机时，攻击者可能同时持有密码。`Array#includes` 短路会让响应时间随匹配
位置变化；泄露「第几个码接近正确」并不能直接给出码，但它把猜测从盲搜变成了
有反馈的搜索，而消除它是免费的。实现上先算候选摘要，再对**所有**存储摘要做
`timingSafeEqual` 并只取第一个命中，不提前 break。

**规范化。** 大小写折叠、去掉所有空白与连字符、长度必须恰为 10、字符必须全部
落在字符集内。**折叠前先做字符集预筛**（只允许 `[A-Za-z0-9\s-]`），因为
`toUpperCase()` 不是双射：U+017F（`ſ`）会折叠成 `S`，而 `S` 在字符集里。两个不同
输入映射到同一个码，正是「拒绝歧义输入」要排除的情形。

**重新生成时的语义：旧的 10 个码全部立即失效。** 不采用「新旧并存一个过渡期」：
用户主动重新生成，通常意味着「我认为旧的泄露了」；此时让旧码继续有效，恰好把
风险窗口延长到最长。`recoveryCodeRotation = {invalidatesPrevious: true,
requiresPassword: true, requiresSecondFactor: true, showsCodesOnce: true}`。

**恢复码用尽。** 消费时若集合已空，返回 409 `RecoveryCodesExhausted`（而不是
401），因为这不是「码错了」，而是「没有码了」——UI 应引导生成新码或走管理员流程。
同理，剩余 3 个时给出提示。

---

## 8. 修改密码

| 项 | 值 | 理由 |
|---|---|---|
| 端点 | `POST /api/account-security/password` | 网关收口，不直接暴露 better-auth 的 `/api/auth/change-password` |
| 需要当前密码 | 是 | 会话被劫持时，攻击者不能单方面改密把真正的主人踢出去 |
| 长度 | 8–128 | 与 better-auth 的 `minPasswordLength/maxPasswordLength` 及登录侧校验一致 |
| 不得等于用户名 | 是 | 最廉价的一类弱口令 |
| 撤销其它会话 | **默认是** | 见下 |
| 当前会话 | 保留（重建） | 用户不应被踢下线 |

**`revokeOtherSessions` 默认开启的理由。** 改密是「我怀疑密码泄露」的标准动作。
如果改完后其它设备上的会话仍然有效，这次改密就完全没有达到目的——攻击者的会话
继续工作，直到 24h 闲置过期。**保留当前会话**是因为：把用户从正在使用的设备上
登出，只会让他在同一台设备上重新登录，纯属摩擦，而且此时会话 cookie 刚刚
通过 `sensitiveSessionMiddleware` 验证过当前密码，可信度高于其它设备。

**与 `revokeSessionsOnPasswordReset: true` 的关系（`auth.mjs` 现有配置）。**
两者意图一致、机制不同，**不需要也不应该改成一样**：

- reset 路径（管理员/未来自助重置）没有「当前会话」可言——用户此刻没有可信会话。
  因此 `revokeSessionsOnPasswordReset: true` 让所有会话失效，正确。
- change 路径（本契约）有一个刚刚重新验证过密码的当前会话，值得保留。

强行让 change 也撤销所有会话，会让 `POST /change-password` 在成功时把自己踢掉，
用户必须立刻重新登录——把「改密」变成「改密 + 强制重新登录」，而重新登录本身
需要密码（他刚要改的那个）与 2FA，体验代价大且没有安全收益。**因此本节保留现状，
不修改 `auth.mjs`。** 这是 §11 的待拍板项之一。

**先算后写。** `planPasswordChangeSessions` 在写密码之前算出要撤销哪些会话 ID，
这样一次失败可以在不改动任何状态的前提下重试，而不是「会话已经踢了、密码没改」。

---

## 9. 解绑第二因素

| 项 | 值 | 理由 |
|---|---|---|
| 需要密码 | 是 | 会话被劫持时，攻击者不能单方面摘掉第二因素 |
| 需要当前 TOTP 或恢复码 | **是（本契约加强）** | better-auth 只校验密码。仅凭密码就能解绑，等于「拿到密码 = 永久摘掉第二因素」 |
| 二次确认 | 是（UI 需输入用户名或勾选确认） | 防误触；解绑是不可逆的安全降级 |
| 其余会话 | 撤销 | 解绑是安全后撤，其它设备上的会话应在同一时刻失效 |
| 当前会话 | 保留（重建） | 同 §8 |

**为什么本契约要求「密码 + 第二因素」而插件只要求密码。** 插件的行为是
`/two-factor/disable` 只验证密码。若直接代理，则攻击场景变成：攻击者窃取密码
（钓鱼、复用、泄露库）→ 登录需要 2FA，卡住 → **但改密/解绑端点在会话内只查密码**。
问题在于要到达「会话内」仍需要 2FA，所以这不是直接的洞；但一旦出现任何
「半可信会话」路径（记住设备、恢复流程、管理员代操作），它立即变成「密码足够」。
多要求一个当前有效的 TOTP/恢复码，代价是一次输入，收益是让解绑与登录同级。
实现方式：网关在调用插件 `/two-factor/disable` 之前，先用同一套校验器验证一次
当前码（复用 §4.3 的 step 消费逻辑；解绑也应消耗 step，否则解绑请求的码可被
重放去登录）。

**解绑后 `twoFactor` 行被删除**，`user.twoFactorEnabled` 置 0。下一次登录直接进入
`full`。已消费的 `last_used_step` 行保留（无害，且重新绑定时会被新 step 覆盖），
不删除的原因是「删除会写库」，而本批次零运行时改动。

---

## 10. 迁移与回滚

### 10.1 新增的表

```sql
CREATE TABLE IF NOT EXISTS account_totp_replay (
  user_id        TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  last_used_step INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS account_totp_replay_updated_idx
  ON account_totp_replay (updated_at);
```

### 10.2 由 better-auth 插件迁移创建的对象（我们不手写 DDL）

| 对象 | 形态 | 来源 |
|---|---|---|
| `user.twoFactorEnabled` | `INTEGER`（boolean） | `getMigrations(auth.options).runMigrations()` |
| `twoFactor` 表 | `id, secret, backupCodes, userId, verified, failedVerificationCount, lockedUntil` | 同上 |

`auth.mjs` 每次启动都会跑插件迁移，因此这两者在启用 `twoFactor()` 插件后的首次
启动即存在，与现有 `migrateWorkspaceMembers` 的顺序（先插件迁移，再自有迁移）一致。

### 10.3 旧库能否直接升

**能。** 全部变更是加表、加索引、加列：

- `account_totp_replay` 是新表，`STRICT`，外键 `ON DELETE CASCADE` 到 `user(id)`。
- `user.twoFactorEnabled` 有 `defaultValue: false`，旧行自动为 0。
- `twoFactor` 是新表，旧库无数据。
- **没有任何 `DROP` / `RENAME` / `ALTER ... DROP`。** `accountSecuritySchema.ownColumns`
  是空数组，并由 `verifySecurityInvariants` 断言；每条自有语句都过
  `assertAdditiveMigration`（测试覆盖了 `DROP TABLE`、`DROP INDEX`、
  `ALTER TABLE ... DROP COLUMN`、`RENAME COLUMN` 四种模式）。

迁移时机：与会话门禁无关，可在维护窗口执行；无锁表，`STRICT` 表创建是元数据操作。

### 10.4 回滚到上一版发布包

**库兼容，无需回滚 DDL。** 上一版代码：

- 不读 `account_totp_replay` —— 多一张表无害；
- 不读 `user.twoFactorEnabled`、不读 `twoFactor` 表 —— 插件未注册时这些对象被忽略；
- 对所有用户按「只验证密码」放行 —— 功能降级为单因素，但**不会报错、不会锁死**。

这正是「只能新增」这条硬约束的价值：回滚只需切回发布包。**但必须记录一个安全事实：
回滚期间所有已启用 2FA 的账号会退化为单因素登录。** 因此回滚是一次安全降级，
应在变更记录里注明，并尽快切回。

数据侧：`auth.sqlite` 及其 `-wal`/`-shm` 必须整体备份（WAL 模式下单独拷主文件会
丢已提交事务）。`<authDir>/secret` **必须与数据库一起备份**——否则恢复后所有 TOTP
种子与恢复码都无法解密（§4.4）。不要手工清理 `account_totp_replay`：它是安全状态，
手工删除会让一次已消费的验证码重新可用。

### 10.5 已绑定用户的密码策略兼容

绑定 2FA 不改变密码哈希（仍为 argon2id，参数不变），因此不存在「升级后无法登录」
的迁移问题。

---

## 11. 与闲置过期、活动续期的交互

现有行为（`auth.mjs` 与 `auth-gateway.mjs`，均不改动）：

- `session.expiresIn = LOG4STELLAR_IDLE_SECONDS`（默认 86400）
- `updateAge: 0` + `deferSessionRefresh: true`：`GET /api/session` 只读不写，
  `POST /api/session/activity` 才刷新 `expiresAt` 并重发 cookie
- `GET /api/session` 返回 `{remainingMs, workspaceId}`，前端据此决定下一次轮询间隔
  （`Math.max(200, Math.min(remainingMs + 100, 60_000))`）
- 前台活动（keydown/pointerdown/wheel/visibilitychange）以 1500ms 节流触发续期

本契约只加两条规则：

1. **`remainingMs` / `activity` 只对 `full` 生效。** `half` 对这两个端点都是 403
   `TwoFactorPending`，所以半认证态**不会**被续期（§5.5）。
2. **`expiresAt` 从第二因素完成时刻起算。** `sessionExpiryAfterSecondFactor`。

`clampIdleSeconds` 把配置值限制在 `[300, 2592000]`，越界回落默认值 86400。理由：
`LOG4STELLAR_IDLE_SECONDS=1` 会让会话立刻过期（表现为随机登出），
`=1e12` 则让闲置过期形同不存在。现有 `auth.mjs` 只检查「正整数」，本契约的
clamp 是更严格的建议值，属于接线时的改动项（§13）。

**24h 与 2FA 的组合含义。** 24h 是**闲置**上限，不是绝对上限；持续活动的会话可以
长期有效。这与双因素并不冲突：第二因素在每次**新登录**时验证，同一会话内的持续
活动不需要重复验证。若将来要加「绝对上限」，需要独立设计（非目标）。

---

## 12. 非目标

`twoFactorNonGoals` 与本节同源：

| 非目标 | 说明 |
|---|---|
| 短信 OTP | 无通道、成本高、SIM 交换攻击 |
| WebAuthn / passkey | 需要 RP ID 与可验证的 origin；当前是自签证书 + IP |
| 信任设备 30 天免验证 | 把双因素降级为单因素一个月，违反需求 3 |
| 组织级 / 工作区级强制 2FA | 需要 `workspace_meta` 上的策略存储与管理员 UI，属独立批次 |
| TOTP 种子导出 | 无正当用例，且导出即等于泄露 |
| 邮件 OTP 兜底 | 邮箱是 `.invalid` 合成地址 |
| 恢复码之外的找回通道 | 丢失全部因素时的流程属于运维流程，不是本契约 |
| 绝对会话上限（非闲置） | 见 §11 |
| 多设备 TOTP（每设备一个种子） | 与 Authenticator 的「一个账号一个条目」模型冲突 |

---

## 13. 验收矩阵

每行是「请求 → 期望 → 判据」，可直接写成测试。`S` 表示会话 cookie，`C` 表示挑战
cookie，`R` 表示恢复码。

### 13.1 半认证态读不到笔记（需求 3，最关键）

| # | 请求序列 | 期望状态码 | 判据 |
|---|---|---|---|
| A1 | 已启用 2FA 的账号 `POST /login`（正确密码） | 200，`Set-Cookie` 含挑战 cookie **且不含会话 cookie** | 响应体 `twoFactorRedirect: true`；`session` 表无该用户新行 |
| A2 | 紧接 A1，`GET /`（带 C，不带 S） | 303，`Location: /login?twofactor=1` | 响应体**不含** `log4stellarWebAccount`、`folderUri` |
| A3 | 紧接 A1，`GET /api/session` | 403 `{error: "TwoFactorPending"}` | 响应体**不含** `remainingMs` |
| A4 | 紧接 A1，`GET /static/mount/<任意笔记路径>` | 403 `{error: "TwoFactorPending"}` | 响应体**不含**任何笔记字节 |
| A5 | 紧接 A1，`GET /static/mount/`（目录） | 403 | 同上 |
| A6 | 紧接 A1，`POST /api/session/activity` | 403 `TwoFactorPending` | 会话**不得**被续期 |
| A7 | 紧接 A1，`GET /session-client.js` | 200 | 静态资源对半认证开放（不含用户数据） |
| A8 | 紧接 A1，`POST /api/account-security/password`（畸形 body） | **403 `TwoFactorPending`**，不是 400 | **判权先于参数校验** |
| A9 | 紧接 A1，`GET /api/account-security/sessions` | 403 `TwoFactorPending` | 半认证不能看设备列表 |
| A10 | 紧接 A1，`POST /api/session/logout` | 200 | 允许放弃挑战；响应后挑战 cookie 被清 |
| A11 | 伪造任意 `C` 值（改一个字符） | 401 `TwoFactorChallengeRequired` | 验签失败 → anonymous |
| A12 | 等待 601 秒后 `GET /`（带 C） | 303 → `/login` | 挑战过期 → anonymous |

### 13.2 TOTP 验证与重放

| # | 请求序列 | 期望 | 判据 |
|---|---|---|---|
| B1 | A1 后 `POST .../two-factor/verify`，body `{code: 当前码}` | 200 + 会话 cookie | `session` 表新增一行；挑战 cookie 被清 |
| B2 | 立刻用**同一个码**再登录一次（密码 → 验证） | 401 `TotpCodeReplayed` | `last_used_step` 未变化 |
| B3 | 用**同一 step 的另一个码**（若可生成） | 401 `TotpCodeReplayed` | 判据是 step，不是码字符串 |
| B4 | 提交 `step-2` 的码 | 401 `InvalidTotpCode` | 超出 ±1 窗口 |
| B5 | 提交 `step+1` 的码（新账号，无历史） | 200 | 正向窗口接受时钟漂移 |
| B6 | 提交 `step+2` 的码 | 401 `InvalidTotpCode` | 超出正向窗口 |
| B7 | 提交 `"12345"` / `"1234567"` / `"123 456"` / `"123-456"` | 400 `InvalidTotpInput` | 歧义输入一律拒绝 |
| B8 | 提交 `" 123456 "` | 200 | 首尾空白被裁剪 |
| B9 | 连续 5 次错误码，第 6 次 | 前 5 次 401，其后挑战失效需重新登录 | `beginAttempt(5)` |
| B10 | 5 次错误后重新 `POST /login` + 正确码 | 200 | 新挑战重置尝试计数 |
| B11 | `/two-factor/*` 在 10 秒内请求 4 次 | 第 4 次 429 | 插件 rateLimit 3/10s |
| B12 | 启用 2FA 的 `full` 用户 `GET /`, `GET /api/session` | 200 | 第二因素只影响登录，不影响既有会话 |

### 13.3 恢复码

| # | 请求序列 | 期望 | 判据 |
|---|---|---|---|
| C1 | A1 后 `POST .../verify-recovery-code`，body `{code: R1}` | 200 + 会话 cookie | `backupCodes` 少一项（仍加密） |
| C2 | 再用 R1 登录 | 401 `InvalidRecoveryCode` | 一次性 |
| C3 | 提交 `R1` 的小写 + 无连字符形式 | 200（若未消费） | 规范化折叠 |
| C4 | 提交含 `I`/`O`/`0`/`1` 的码 | 400 `InvalidRecoveryCodeInput` | 字符集预筛 |
| C5 | 提交 `ſ`（U+017F）混入的码 | 400 `InvalidRecoveryCodeInput` | 折叠前预筛，避免歧义折叠 |
| C6 | 耗尽 10 个码后再提交 | 409 `RecoveryCodesExhausted` | 不是 401 |
| C7 | `full` 下 `POST /api/account-security/recovery-codes`（需密码） | 200，返回 10 个新码 | 旧码全部失效（C2 对旧码返回 401） |
| C8 | 无密码调用 C7 | 401/403 | `requiresPassword: true` |
| C9 | 重新生成后立刻用旧码 R5 | 401 | 轮换即全废 |

### 13.4 会话列表与脱敏

| # | 请求序列 | 期望 | 判据 |
|---|---|---|---|
| D1 | `full` 下 `GET /api/account-security/sessions` | 200，数组，当前设备在首位 | `current: true` 项排第 0 |
| D2 | 检查 D1 响应体 | 不含 `token`/`ipAddress`/`userAgent`/`userId` | 逐字段断言 |
| D3 | 检查每项的 `id` | 匹配 `^[A-Za-z0-9_-]{22}$` | 且不等于任何 `session.token` |
| D4 | 设置标签 `POST .../sessions/:id/label` `{label: "我的台式机"}` | 200 | D1 中该项 `device === "我的台式机"` |
| D5 | 标签含 `\n` / `\u202E` | 清洗为空格 | `device` 中不含这些字符 |
| D6 | 标签长度 41 | 400 `InvalidDeviceLabel` | |
| D7 | `POST .../sessions/<伪造 id>/revoke` | 404 `SessionNotFound` | 不能撤销别人的会话 |
| D8 | `POST .../sessions/<当前 id>/revoke` | 200 | 当前会话也允许撤销（等价登出） |
| D9 | `GET /api/auth/list-sessions` 直连 | **不应可达**（网关未放行） | 防止原始 token 泄漏 |
| D10 | `includeNetwork: false` 时检查响应 | 无 `network` 字段 | 默认不披露网络 |

### 13.5 修改密码

| # | 请求序列 | 期望 | 判据 |
|---|---|---|---|
| E1 | 设备 A、B 均已登录，A 上 `POST /api/account-security/password` `{current, new}` | 200 | A 仍在线 |
| E2 | 紧接 E1，B 上 `GET /api/session` | 401 | 其它会话被撤销 |
| E3 | E1 后 A 上 `GET /` | 200 | 当前会话保留 |
| E4 | 用新密码登录 | 200 | 密码确实已改 |
| E5 | 用旧密码登录 | 401 | |
| E6 | `{current: 错误}` | 401/403 | 需当前密码 |
| E7 | `new` 长度 7 / 129 | 400 `PasswordTooShort` / `PasswordTooLong` | |
| E8 | `new === username` | 400 `PasswordMatchesUsername` | |
| E9 | `new` 含 `\u0000` | 400 `InvalidPasswordInput` | |
| E10 | `new` 首尾含空格 | 200，且之后必须用**带空格**的密码登录 | 密码不做规范化 |
| E11 | `half` 状态下任意 `POST /api/account-security/password` | 403 `TwoFactorPending` | 与 A8 同 |

### 13.6 绑定与解绑

| # | 请求序列 | 期望 | 判据 |
|---|---|---|---|
| F1 | `full` 下 `POST .../two-factor/enroll` `{password}` | 200，返回 `totpURI` 与 10 个恢复码 | URI 含 `secret=`、`digits=6`、`period=30`，**不含** `algorithm=SHA256` |
| F2 | 用错误密码调 F1 | 401 | |
| F3 | F1 后未 confirm，`GET /api/session` | 200 | `twoFactorEnabled` 仍为 false |
| F4 | F1 后 `POST .../confirm` `{code: 正确码}` | 200 | `user.twoFactorEnabled === 1` |
| F5 | F4 后重新登录 | 需要第二因素 | 进入 `half` |
| F6 | 已启用后再调 F1 | 409 `TotpAlreadyEnrolled` | |
| F7 | `POST .../disable` `{password}` **不给码** | 403/401 | 本契约要求第二因素 |
| F8 | F7 改为 `{password, code: 正确码}` | 200 | `twoFactorEnabled === 0`；其它会话 401 |
| F9 | F8 后用被消费的码再登录 | 401 `TotpCodeReplayed` | 解绑也消费 step |
| F10 | F8 后登录 | 直接 `full` | 单因素 |

### 13.7 闲置过期与续期

| # | 请求序列 | 期望 | 判据 |
|---|---|---|---|
| G1 | `full`，`POST /api/session/activity` | 200 + 新 cookie | `expiresAt` 延后 24h |
| G2 | `half`，`POST /api/session/activity` | 403 | 半认证不续期（与 A6 同） |
| G3 | 24h 无活动后 `GET /api/session` | 401 | 闲置过期仍生效 |
| G4 | `LOG4STELLAR_IDLE_SECONDS=3600`，登录后 `GET /api/session` | `remainingMs <= 3600000` | 配置生效 |
| G5 | A1 后等 601 秒 | 挑战失效 | 半认证上限远短于 24h |

### 13.8 迁移与回滚

| # | 判据 |
|---|---|
| H1 | `accountSecuritySchema.ownColumns` 为空数组 |
| H2 | 全部自有 DDL 通过 `assertAdditiveMigration` |
| H3 | `DROP TABLE` / `DROP INDEX` / `ALTER TABLE ... DROP COLUMN` / `RENAME COLUMN` 均被拒绝 |
| H4 | `verifySecurityInvariants()` 返回空数组 |
| H5 | 旧库（无 `account_totp_replay`）启动后表被创建，现有用户可登录 |
| H6 | 切回上一版发布包，登录仍可用（2FA 降级为单因素） |

---

## 14. 需要复核的取舍

诚实列出本契约里最容易被质疑的三处。

### 14.1 禁用「信任设备 30 天」

better-auth 原生支持，用户也确实会抱怨「每台设备每天输验证码」。

**代价**：每台设备每天至少一次完整验证。

**理由**：`trust_device` 是一个 30 天的 bearer cookie，本质上把「2FA」变成
「每 30 天一次 2FA」。需求 3 验收的是「启用双因素后密码通过到二次验证完成之间
读不到笔记」——启用免验证后，这个中间态根本不存在，验收无法通过。

**若需要放宽建议**：把 `trustDeviceMaxAge` 设成小时级（例如 12 小时，覆盖一个
工作日），而不是 30 天。这仍然是安全降级，需要显式决策。

### 14.2 半认证态放行 `/static/build/*` 与 `/session-client.js`

看起来与 I1（「拿不到任何笔记字节」）紧张：既然半认证不可信，为什么给静态资源？

**理由**：这两者是 VS Code 前端的构建产物与轮询脚本，按发布包哈希命名，
**不含任何用户数据**。挡住它们会让挑战页白屏，用户无法输入验证码，功能直接不可用。
判据是「响应体是否含用户数据」，不是「路径是否在认证后」。

**若被质疑**：可改成对 `half` 只放行 `/session-client.js`，`/static/build/*` 仅在
挑战页需要的白名单子集上放行。这需要前端构建清单，属实现期决策。

### 14.3 解绑要求第二因素（比插件严格）

better-auth 的 `/two-factor/disable` 只校验密码。本契约要求再加一次 TOTP 或恢复码。

**代价**：用户丢手机时无法自助解绑，必须走管理员/恢复流程（本批次未设计）。

**理由**：仅凭密码就能摘掉第二因素，等于「密码泄露 = 双因素永久失效」。这正好
把第二因素要防的那一类攻击（密码已泄露、攻击者正在尝试登录）变成一条捷径——
虽然当前要到达解绑端点仍需先过 2FA，但把这个唯一门槛交给一个未来的「半可信会话」
路径太脆弱。

**未解决的缺口**：丢手机的恢复流程。这正是需要用户拍板的一点——接受「必须联系
管理员」，还是提供一条「恢复码 + 冷静期（例如 72 小时内所有登录告警）」的
半自动通道。

### 14.4 不使用 better-auth 默认的恢复码字符集

**代价**：需要注入自定义生成器，且已生成的旧码（如果有）与新的规范化规则不兼容。

**理由**：默认的 `a-zA-Z0-9` 无法安全规范化（`l`/`1`、`O`/`0` 视觉混淆，而大小写
折叠会让 `I`↔`i` 之外的映射变得不可预测：`ſ`→`S`）。既然恢复码要在丢失手机时
手抄输入，可规范化是硬需求。

**兼容性说明**：本批次是全新功能，不存在「已生成的旧码」，因此没有迁移负担。
若将来要退回默认字符集，规范化函数必须同步改回「逐字节比较」。

---

## 15. 接线时需要改动的文件（本批次不做）

| 文件 | 改动 | 风险 |
|---|---|---|
| `apps/web/auth.mjs` | 注册 `twoFactor({...})` 插件；注入 `backupCodeOptions.customBackupCodesGenerate`；`accountLockout` 显式配置 | 中：`runMigrations()` 会新增列与表 |
| `apps/web/auth-gateway.mjs` | 收口 `/api/auth/two-factor/*`；新增 `/api/account-security/*` 路由；对 `half` 做 §5.3 的拦截；`/login` 的 `twoFactorRedirect` 分支 | **高**：这是 I1 唯一的执行点 |
| `apps/web/serve-demo.mjs` | 无（HTML 注入依赖 `ctx.state.sessionUserId`，`half` 下该值不会被设置） | 低 |
| `apps/web/login-page.mjs` | 增加验证码输入态与恢复码入口 | 低 |
| `apps/web/session-client.js` | 处理 403 `TwoFactorPending` | 低 |
| `apps/web/account-security.mjs` | 新增 DDL 执行函数（目前只有语句字符串） | 低 |
| `apps/web/workspace-schema.sql` | 追加 `account_totp_replay` | 低（纯新增） |

网关是唯一的高风险点，因为它是「半认证读不到笔记」的唯一执行位置。任何绕过它的
路径（例如把 `/static/mount` 挂到别的中间件、或让 `half` 落到 `await next()`）都会
直接破坏 I1。接线时必须先写 A1–A12 的集成测试。
