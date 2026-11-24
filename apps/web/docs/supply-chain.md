# 权限与供应链维护契约（v1）

本文件是「权限与供应链维护」任务的契约。任何实现与测试必须以本文件的判据为准；如需修改契约，先改本文件再改代码。实现位于 `apps/web/supply-chain.mjs`（纯函数）与 `apps/web/audit-supply-chain.mjs`（命令行入口）。

## 1. 凭证清单

清单是部署与代码之间的契约：路径或权限变了，审计必须跟着变，而不是默默报"通过"。下表由 `describeCredentialInventory({ configDir, authDir, demoDir })` 生成，路径随传入根目录变化，因此同一张清单可以指向生产的真实目录，也可以指向 `/tmp` 下的隔离演练目录。

| 凭据 | 路径 | 敏感级别 | 要求权限 | 用途 | 轮换 / 恢复 |
|---|---|---|---|---|---|
| 账号库目录 | `<authDir>` | directory | `0700` | 包住 SQLite 账号库、WAL、共享内存与签名密钥 | 迁移账号库时整体重建 |
| 账号库 | `<authDir>/auth.sqlite` | config | `0600` | 用户、会话、工作区成员、MFA 材料 | 用 `VACUUM INTO` 复制迁移，见 `backup-data.mjs` |
| 会话签名密钥 | `<authDir>/secret` | secret | `0600` | better-auth 会话签名；持有者可以伪造会话 Cookie | 与"作废全部会话"同时轮换 |
| Git 签名密钥 | `<configDir>/git-secret` | secret | `0600` | 签发 Git 凭据与 OAuth state | 发新密钥并作废在途凭据；回滚到旧密钥会让已签发凭据全部失效 |
| 存储配置 | `<configDir>/workspace-storage.json` | secret | `0600` | 对象存储（S3/RustFS）与 PostgreSQL 连接串，含口令 | 数据库角色口令与对象存储密钥一起轮换，必须重启 |
| 客户端白名单 | `<configDir>/web-clients` | config | `0600` | Web 源站准入的地址白名单 | 按部署编辑；本身不是密钥，但决定谁能访问源站 |
| 上传暂存目录 | `<configDir>/spool` | directory | `0700` | 对象上传与范围读取的临时落盘 | 不停数据：停机时清空即可 |
| TLS 私钥 | `<demoDir>/tls/server.key` | secret | `0600` | HTTPS 源站私钥 | 与证书同周期，每 12 个月重签并重新信任 |
| TLS 证书 | `<demoDir>/tls/server.crt` | config | `0600` | 对外证书，按 §2 检查到期 | 与私钥同周期 |

**判据**：敏感级别决定期望权限（secret/config → `0600`，directory → `0700`），不存在"全局默认权限"。`required: true` 的条目缺失即失败；可选条目缺失只跳过。

**不落在文件里的两类身份**（因此不进清单，但必须写在部署文档里）：

| 身份 | 存放位置 | 说明 |
|---|---|---|
| PostgreSQL `user_agent` | 服务启动时的连接串 | 只能访问 `log4stellar` schema 内的表，不能建库建 schema |
| RustFS 访问密钥 | 同上 | 只授权 `log4stellar` 这一个 bucket |

## 2. 证书到期

`checkTlsCertificate({ certificate, now, warnBeforeDays })` 返回 `daysRemaining` 与 `problems`：

- 剩余天数 `< 0`：报告"已过期 N 天"；
- 剩余天数 `< warnBeforeDays`（默认 30）：报告"将在 N 天内过期"；
- `validFrom` 晚于当前时间：报告"尚未生效"。

时刻由调用方注入，因此判定可重复；传入非有限时间戳或负的告警窗口会直接抛错，而不是返回"通过"。

## 3. 版本钉住与许可义务

`checkPinnedVersions` 只接受**完全相等**的版本号。caret / tilde 范围一律算漂移：发布物必须与演练过的版本一致。缺包报 `Missing`，版本不符报 `Drift`，两类分开报。

`licenseObligations` 记录随发布物分发的第三方组件义务，当前 8 条：Code - OSS（MIT，必须随发布物带 `LICENSE.txt` 与 `ThirdPartyNotices.txt`）、`@vscode/test-web`、`vscode-oniguruma` / `vscode-textmate`、`@node-rs/argon2`、`better-auth`、`pg`、`@aws-sdk/client-s3`（**Apache-2.0**，必须附许可证正文与包内 NOTICE），以及 LibreOffice（MPL-2.0，作为独立程序通过进程边界调用、不随发布物分发，但必须记录版本）。`checkLicenseArtifacts` 检查 `LICENSE.txt` 与 `ThirdPartyNotices.txt` 是否真的在仓库里。

## 4. 敏感内容扫描

`scanForSecrets` 扫六类模式：私钥块、AWS access key、JWT、URL 内嵌口令、`password/secret/token/api_key = <值>` 赋值、64 位十六进制串。

三条硬约束：

1. **绝不回显原值**。命中只报 `pattern / line / column / preview`，`preview` 是"前 4 字符 + `…` + 原长度"，例如 `hunt…/14`。4 个字符无法还原 64 位密钥，但足够让阅读报告的人区分两条命中。
2. **行号列号指向真实位置**，可以直接跳到那一行。
3. **抑制要精确**。`allow` 是完整匹配串的白名单；`allowPatterns` 是"这段区域是出处而非凭据"的声明——发布日志里 `Source: <commit> (<sha256>)` 这类指纹必须能被审计比对，误报会训练运维忽略告警，所以按区域抑制，而不是整类关闭 `hex-64`。

`scanDocuments` 汇总多份文档。**读不到的文档单独报告并使闸门失败**：因为"没检查"而通过的闸门比没有闸门更危险。

## 5. 职责分离

`operationalCapabilities` 把能力分成四组：`read`（`workspace.read/history`）、`write`（`workspace.write/delete/restore/git.write`）、`publish`（`release.publish/rollback`）、`restore`（`backup.restore`）。

`checkSeparationOfDuties` 的唯一判据：**同时持有 `read` 与 `publish` 的身份即违规**。因为把两者放在一个账号上，正是"读泄露"升级成"供应链泄露"的方式。注意 `backup.restore` 属于 `restore` 而非 `publish`：备份恢复本来就需要写工作区内容，把它算成发布能力会让这条判据失去意义。

## 6. 命令行入口

```
node apps/web/audit-supply-chain.mjs [--json] [--config <dir>] [--auth <dir>] [--demo <dir>]
```

根目录可用环境变量 `LOG4STELLAR_CONFIG_DIR` / `LOG4STELLAR_AUTH_DIR` 覆盖，默认指向文档化的单机部署位置。命令只读、不联网、不打印任何凭据值，因此可以放进发布脚本，也可以把输出直接贴到工单里。

执行六项检查：凭证权限、证书到期、版本钉住、许可文件、敏感内容、职责分离。**任何一项有问题，退出码为 1**；检查项本身跑不起来（目录读不到）也计入失败。

扫描范围：`README.md`、`docs/workspace-access.md`、`docs/incremental-sync.md`、`docs/account-security.md`，加上 `<configDir>/logs` 与 `<demoDir>` 下最新的 20 个 `.log`。日志目录不存在不算失败。

## 7. 验收判据

| 编号 | 判据 |
|---|---|
| S01 | 清单覆盖部署实际使用的每一项凭据，每项都有用途、路径、权限、轮换与责任人 |
| S02 | 权限漂移、类型互换、空密钥、必需项缺失都被报出，且每条发现可单独处理 |
| S03 | 证书到期按注入时刻计算，过期与告警窗口分开报告，非法输入直接抛错 |
| S04 | 版本钉住不接受范围号；许可义务覆盖全部随发布物分发的组件 |
| S05 | 扫描结果不含任何凭据原值；读不到的文档使闸门失败 |
| S06 | 同时读内容与发布的两用身份被拒绝；备份恢复不被误判为发布能力 |
| S07 | 在真实部署上运行命令退出码为 0，且输出中不含任何凭据值 |

## 8. 已知待办

- 生产 `~/.local/share/log4stellar/releases` 目录权限为 `0755`，发布物本身可被同组与其他用户读取。本契约只覆盖凭据文件，发布目录权限的收紧与 item 09（部署与回滚）一起做。
- 生产环境的 `log4stellar-web.service` 是瞬时单元（`/run/user/1001/systemd/transient/`），没有版本化的 unit 文件。若要让"谁能发布"变成可审计的约束，需要连同 item 09 一起落盘。
