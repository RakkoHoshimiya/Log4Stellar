# Log4Stellar

Log4Stellar 是一套以 Markdown 笔记为核心的自托管协作系统。它在经过裁剪的
[Code - OSS](https://github.com/microsoft/vscode) 工作台之上，提供**远程工作区**（浏览器里的
完整工作台，笔记存放在服务端）、多工作区权限隔离、文件与附件版本历史、回收站、增量同步与
Git 仓库接入，并为 PC 与 Android 提供独立客户端。

所有内容保存在你自己的基础设施里：文件字节在 S3 兼容对象存储（本项目部署使用 RustFS），
归属、路径、版本与变更记录在 PostgreSQL，账号、成员与角色在 SQLite。没有第三方云依赖，
账号体系不外包。

**当前形态**：产品以 **Web 端为主**。浏览器访问服务端工作台即是主用形态；PC 与 Android
客户端已各自实现并通过单元测试，但按 2026-11-24 的优先级安排**暂缓**（详见能力矩阵与
[客户端](#客户端独立仓库)）。

## 快速上手

- **已有部署**。打开部署方提供的 HTTPS 地址，用分配的账号登录。工作台左侧打开笔记，右侧可查看大纲和版本历史。启用 Office 预览后，单击 DOCX、XLSX 或 PPTX 即可连续滚动阅读。
- **第一次自托管**。在开发机或测试机按 [Web 服务端启动步骤](apps/web/README.md) 创建测试账号和独立工作区。先验证能打开示例笔记，再按 [运维手册](apps/web/docs/ops-runbook.md) 准备正式配置并发布。
- **确认部署状态**。将下面的示例地址和 CA 路径替换为该部署的值。登录页与存活探针均应返回 `200`。再用测试账号打开一篇 Markdown，验证工作区本身可读。

  ```bash
  ORIGIN=https://notes.example.test:18990
  CA_CERT=/path/to/ca.crt
  curl --cacert "$CA_CERT" -sS -o /dev/null -w '%{http_code}\n' "$ORIGIN/login"
  curl --cacert "$CA_CERT" -sS -o /dev/null -w '%{http_code}\n' "$ORIGIN/healthz"
  ```

维护服务时，发布、回滚、备份恢复和常见故障的操作均见[运维手册](apps/web/docs/ops-runbook.md)。凭据及正式地址由部署方保管。

## 能力矩阵

状态取值，一个能力只取其中一档：

| 状态 | 含义 |
|---|---|
| **已部署** | 代码在正式入口上运行，且已在新版发布包中实测 |
| **已实现** | 代码与自动化测试就绪，但尚未在正式环境逐项验收 |
| **待验收** | 功能已交付并通过本地测试，验收（真机 / 真实同步 / 安装包）尚未完成 |
| **需配置** | 代码已合并、线上也已接线，但缺一项部署配置才能用 |
| **规划中** | 有任务书或契约，尚未开始实现 |

| 能力 | 状态 | 说明 |
|---|---|---|
| Web 远程工作区（挂载、浏览、编辑、保存） | 已部署 | 浏览器里的完整工作台；自定义 FileSystemProvider 把服务端工作区挂载为工作台文件夹，笔记数据在服务端而非浏览器本地 |
| Markdown 默认预览 | 已部署 | 打开 `.md` 直接进入预览；Diff 编辑器保持源码对照 |
| 文件读写与并发保护 | 已部署 | 写入携带 `If-Match` 修订号，陈旧编辑器覆盖时返回 `412 FileChanged` |
| 文件与附件版本历史 | 已部署 | 图片、Office、视频、二进制与 Markdown 同构；回滚生成新版本而非改写指针 |
| 回收站与恢复 | 已部署 | 批量恢复、同名冲突保留副本、恢复前校验对象完整性 |
| 范围读取（Range） | 已实现 | RFC 9110 单区间、`If-Range`、多区间降级为整体 `200`；有契约测试，线上未逐项走查 |
| 多工作区权限隔离 | 已部署 | owner / editor / viewer 三档能力矩阵，判权只看 capability 不看 URL，跨工作区一律 `403 NoPermissions` |
| 账号安全：密码、TOTP、恢复码、设备会话 | 已部署 | 登录页支持第二因素；工作台左下角原生账户菜单进入「账户安全…」，设置页在 `/account/security` |
| 成员管理（增删成员、改角色） | 已部署 | **只有服务端命令行** `apps/web/workspace-members.mjs`，本版本不开放 HTTP 入口 |
| 增量同步（服务端接口） | 已部署 | 工作区级快照 + 游标、幂等键、变更流、冲突副本保留双方内容；正式入口上 `/sync/v1/*` 已鉴权可达（未认证返回 `401`）。端到端的客户端同步仍待 PC / Android 验收 |
| Git 仓库接入 | 需配置 | 关联仓库、状态、log、分支、fetch/push、检查点关联笔记版本均已实现并随正式包部署；但部署未设置 `LOG4STELLAR_GIT_WORKSPACE_ROOTS`，因此线上 `/git/v1/*` 目前一律返回 `503 GitNotConfigured` |
| 工作区切换与多账号 | 已部署 | 工作台通过 `X-Log4Stellar-Workspace` 选择工作区；浏览器存储按「账号 + 工作区」隔离。挂载 URI 迁移的旧草稿恢复路径仍未实现，见[已知限制](#已知限制) |
| PC 客户端 | 待验收 | Electron 独立工程，Linux 安装包已产出；Windows 安装包、完整入站增量镜像、重启后离线解锁、冲突操作界面仍未完成 |
| Android 客户端 | 待验收 | Kotlin/Gradle 独立工程，APK 可构建；模拟器登录与真实同步未验收；旧账号数据作用域迁移、冲突处理界面、工作区选择仍待开发 |
| 全文搜索（Markdown 正文、中文） | 待验收 | 服务端索引 + `GET /search/v1/query?q=` + 工作台搜索面板已实现；中文按子串匹配（PostgreSQL `simple` 分词会把整句变成一个词，无法命中词内子串）。索引更新是懒执行（每次查询最多补 25 条），无常驻 worker；端到端点选搜索面板尚未在真机走查 |
| 知识关联（双链、标签、反向链接、断链） | 待验收 | Markdown AST 解析出链接与标签，建索引并提供 backlinks / tags / broken 接口与改名重写计划；工作台尚无反向链接、标签和断链面板 |
| Office 文件预览（docx/xlsx/pptx → PDF） | 需配置 | 需开启 `LOG4STELLAR_OFFICE_PREVIEW=1` 并提供 LibreOffice 转换环境。启用后单击文件默认只读预览，加载期间显示进度，页面支持连续滚动 |
| Web 离线编辑（草稿、离线队列、冲突） | 待验收 | IndexedDB 草稿 + 出站队列 + 幂等回放 + 冲突保留双方，离线模块尚未接入工作台编辑器，未做旧版草稿自动迁移 |
| 多租户（租户、成员、邀请、审计） | 已实现 | Web 支持租户切换、成员和邀请管理、审计及有权限的工作区入口。身份与成员在账户库，PostgreSQL 保存工作区与租户映射 |
| 存储对象清理（标记-清扫） | 待验收 | 7 类引用探针 + 7 天宽限期 + CAS 候选状态机 + 恢复副本校验，**默认 dry-run**；尚未接 HTTP 入口、未在真实 RustFS 跑过全链路 |
| 健康探针与指标（healthz/readyz/metrics） | 待验收 | 存活/就绪/Prometheus 三个端点已打入集成候选包，日志带 `requestId`；告警阈值与隔离演练尚未在正式环境验证 |
| 组织级 / 工作区级强制双因素 | 规划中 | 每个受保护面已强制「已验证的第二因素」，但「管理员为整个工作区强制开启 2FA」需要策略存储与管理界面，属独立批次 |
| 旧版未保存草稿的自动迁移与恢复 | 规划中（已知限制） | 见 [已知限制](#已知限制) |

「待验收」不等于「可用」：PC 与 Android 已按优先级暂缓，两端都还没有可交付给终端用户的完整
安装流程。

「已部署」的判据是：该能力的代码在正式入口的发布包内、路由已在线上可达，且其数据在切换时完整
迁移（迁移后笔记条目与历史版本数目不变）；「已实现」则只保证代码与自动化测试就绪，尚未在正式
环境逐项走查。

## 架构

```
                ┌───────────────────────────────────┐
   浏览器 ─────▶│ serve-demo.mjs (HTTPS)             │
                │   ├─ authGateway   (会话/租户/2FA)  │
                │   ├─ /static/mount (文件/版本/回收站)│
                │   ├─ /sync/v1      (增量同步)       │
                │   └─ /git/v1       (Git 接入)       │
                └───────────────┬───────────────────┘
                                │
              ┌─────────────────┼──────────────────┐
              ▼                 ▼                  ▼
        PostgreSQL           RustFS            auth.sqlite
     归属/路径/版本/      文件字节          账号/成员/角色
     变更流/快照                            第二因素/会话
```

客户端（PC / Android）不经过工作台，直接调用 `/static/mount` 与 `/sync/v1`。

三条不变量贯穿全部代码：

1. **工作区 ID 唯一且一致**。`auth.sqlite` 的成员行、`storage_workspaces.id` 与对象存储的键前缀
   使用同一个 ID，改名不换 ID。
2. **权限是唯一的授权单位**。判权只看请求要做什么（`workspace.read` / `.history` / `.write` /
   `.delete` / `.restore` / `.admin`），不看 HTTP 方法或 URL，且判权先于参数校验。
3. **变更流与提交顺序一致**。序列号在工作区行锁内分配并持有到提交，读取方按序应用不会跳号。

## 部署方式

日常操作见[运维手册](apps/web/docs/ops-runbook.md)，部署参数和构建命令见 [Web 服务端说明](apps/web/README.md)。

### 前置

- Node.js **24.x**（发布包在 `release.json` 里校验 `nodeMajor`，其它大版本拒绝启动）
- PostgreSQL 16 及以上，一个可建表的 schema
- S3 兼容对象存储（RustFS / MinIO / AWS S3）
- HTTPS 证书和私钥（自签环境需在验收客户端信任对应证书）
- Git（发布构建与 Git 集成功能需要）

### 构建发布包

```bash
export PATH=$HOME/.cache/log4stellar-toolchain/bin:$PATH   # node 24 + pnpm
export NODE_OPTIONS=--max-old-space-size=5120              # 工作台打包需要 >2GB 堆
node apps/web/build-web-release.mjs <新的空目录> [vscode-loc 本地副本]
```

三个必须注意的点：

- `NODE_OPTIONS` 不设会报 `Ineffective mark-compacts near heap limit` 并以 SIGABRT 退出。
- 第二个参数指向本地 `vscode-loc` 检出可避免构建期从 GitHub 下载语言包（离线环境必须）。
- 构建会在开始与结束各取一次源码指纹（commit + `git diff` + 未跟踪文件摘要），中途有改动即报
  `Source changed during release build. Build again from a stable worktree.`。**因此发布构建应在
  专用工作树里做。**

构建结束时自动执行 `verify-web-release.mjs`：在临时目录启动包内服务、建账号、断言登录页、
未认证 401、敏感路径 404、本地化资源与扩展关联配置存在。

### 运行

```bash
export LOG4STELLAR_AUTH_DIR=/srv/log4stellar/auth      # 必须在笔记工作区之外
export LOG4STELLAR_WEB_ORIGIN=https://notes.example.com
export LOG4STELLAR_TLS_CERT=/srv/tls/server.crt
export LOG4STELLAR_TLS_KEY=/srv/tls/server.key
export LOG4STELLAR_STORAGE_BACKEND=rustfs
export LOG4STELLAR_STORAGE_CONFIG=/srv/log4stellar/workspace-storage.json
export LOG4STELLAR_WORKSPACE_ID=log4stellar-main

node server/serve-demo.mjs log4stellar-main 18990 --release
```

首次运行前需要生成 `$LOG4STELLAR_AUTH_DIR/secret`（`openssl rand -hex 32`，`umask 077`），并用
`node server/create-account.mjs <用户名> <工作区 ID>` 建号。**建号时必须显式给出工作区 ID**
（位置参数或 `LOG4STELLAR_WORKSPACE_ID`），否则账号会落到默认工作区而不是当前部署服务的工作区；
命令会打印 ID 的来源，回落到默认值时给出警告。

`workspace-storage.json` 形如（所有值都是占位符）：

```json
{
  "s3": { "endpoint": "https://storage.example", "region": "us-east-1", "bucket": "log4stellar",
          "accessKeyId": "<application access key>", "secretAccessKey": "<application secret>" },
  "postgres": { "host": "database.example", "port": 5432, "database": "log4stellar",
                "user": "log4stellar_app", "password": "<database password>", "ssl": true }
}
```

对象存储的 spool 目录由该文件的**所在目录**推导，因此配置文件目录必须可写；生产配置与 spool 是
兄弟目录，把它复制到别处时会把 spool 一起搬走，隔离测试请复制配置再改内容。

### 升级与回滚

按[运维手册](apps/web/docs/ops-runbook.md)执行预检、备份和切换。发布工具校验候选包、管理当前与上一版本指针，并检查切换后的 HTTPS 入口。回滚前核对目标版本的数据库兼容性和双因素门禁，具体规则见[部署与回退](apps/web/docs/deploy-and-rollback.md)。

## 数据与备份

| 数据 | 位置 | 是否可重建 |
|---|---|---|
| 笔记文件字节 | 对象存储 `workspaces/<id>/sha256/<摘要>` | 否，必须备份 |
| 归属 / 路径 / 版本 / 变更流 | PostgreSQL `log4stellar` schema | 否，必须备份 |
| 账号 / 成员 / 角色 / 第二因素 / 会话 | `auth.sqlite` | 否，必须备份 |
| TOTP 种子与恢复码的加密根 | `$LOG4STELLAR_AUTH_DIR/secret`（0600） | 否，**不可轮换、不可丢失** |
| Git 仓库凭证的加密根 | 存储配置同目录的 `git-secret`（0600，64 hex） | 否，**不可轮换、不可丢失** |
| 工作台构建产物 | `releases/<名字>` | 是，从 Git 重建 |

`sha256` 内容寻址意味着恢复时可用摘要逐对象校验；`storage_file_versions` 保存每个版本的摘要
与长度，是对象存储恢复的对照基准。

完整备份包含账户库、两个密钥、数据库快照、逐对象摘要及笔记历史字节。维护窗口内暂停写入后，
使用可读取所有相关工作区前缀的备份凭证执行：

```bash
LOG4STELLAR_BACKUP_BLOBS=1 node apps/web/backup-data.mjs /path/to/new-backup
node apps/web/restore-backup-objects.mjs /path/to/new-backup /path/to/isolated-storage.json
```

恢复命令先验证清单和全部本地对象，再写入独立目标。数据库 SQL 和账户库应在隔离环境恢复，应用
启动前核对目标配置与回滚兼容性。默认的元数据备份需要配套的对象存储备份；若生产凭证被限制在单个
工作区前缀且禁止删除对象，则对象侧无法做桶级备份，需额外的只读凭证或存储卷级快照。

密钥文件只允许记录**路径、用途与权限要求**，任何情况下不要把内容写进文档、提交或工单。

## 仓库目录与入口

```
README.md                      本文件：定位、能力矩阵、部署与数据
apps/web/                      服务端：网关、鉴权、文件、版本、同步、Git、发布打包
  README.md                    部署与测试入口（含隔离启动、发布、回退、排障）
  docs/                        协议与设计文档（权限、同步、账户安全、Git、工作区切换）
  tools/                       仓库工具（相对链接检查）
  workspace-extension/         Web 端的 workspace-files 扩展（挂载与搜索提供者）
  *.test.mjs                   27 个测试文件（单元 + 需显式开启的集成测试）
extensions/markdown-*/         Markdown 预览、大纲、版本历史与回收站面板、Mermaid、主题
src/vs/                        Code - OSS 工作台源码（账户菜单等品牌化改动在此）
build/, scripts/               上游工作台构建与打包脚本
```

入口一览：

| 入口 | 是什么 |
|---|---|
| `/login` | 登录页，含第二因素表单 |
| `/account/security` | 账户设置（改密、TOTP、恢复码、设备会话），从工作台左下角账户菜单打开 |
| `/static/mount/` | 工作台挂载的文件系统后端（列表、读写、版本、回收站、Range） |
| `/sync/v1/*` | 增量同步接口（快照、变更流、冲突） |
| `/git/v1/*` | Git 仓库接入接口（需 `LOG4STELLAR_GIT_WORKSPACE_ROOTS`） |
| `apps/web/serve-demo.mjs` | 唯一服务进程入口 |
| `apps/web/build-web-release.mjs` | 发布包构建入口 |

## 客户端（独立仓库）

PC 与 Android 客户端**不在本仓库内**：它们是各自独立的 Git 仓库，所以在本仓库里
`clients/` 目录并不存在，`git ls-files` 也查不到这两个工程。请不要在本仓库找它们的源码。

| 工程 | 独立仓库位置（开发机） | 分支 | 技术栈 | 状态 |
|---|---|---|---|---|
| PC | `clients/pc`（独立 Git 仓库） | `feat/pc-remote-sync` | Electron + esbuild + markdown-it | 待验收 |
| Android | `clients/android`（独立 Git 仓库） | `feat/android-client` | Kotlin + Gradle（compileSdk 34 / minSdk 26） | 待验收 |

两端都通过 `/static/mount` 与 `/sync/v1` 直连服务端，不经过工作台。构建与验收步骤以各自仓库内的
说明为准（Android 工程的 `README.md` 尚未补，交付说明里记录了构建与验收方式）。按当前优先级，
两端暂缓，Web 端优先。

## 文档索引

新增或变更功能时，**下面这些文档必须随代码一起改**，否则读者会得到与实现相反的结论：

| 文档 | 何时必须同步修改 |
|---|---|
| 本文件 [能力矩阵](#能力矩阵) | 任何能力的状态在 已实现/已部署/待验收/需配置/规划中 之间变化时 |
| [apps/web/README.md](apps/web/README.md) | 启动参数、必需环境变量、发布/回退步骤、测试开启方式变化时 |
| [工作区权限契约](apps/web/docs/workspace-access.md) | 角色、capability 或请求→能力映射变化时 |
| [增量同步契约](apps/web/docs/incremental-sync.md) | `/sync/v1` 路由、请求头、游标或冲突语义变化时 |
| [账户安全契约](apps/web/docs/account-security.md) | 第二因素流程、会话、恢复码、DDL 变化时 |
| [账户安全运行时交付](apps/web/docs/account-security-takeover.md) | 账户安全的分支范围、验收入口变化时 |
| [Git 接入契约](apps/web/docs/git-integration.md) | `/git/v1` 路由、判权、错误码或部署配置变化时 |
| [工作区切换迁移](apps/web/docs/workspace-switch-migration.md) | 工作台挂载 URI 或旧草稿恢复策略变化时 |
| [发布清单模板](apps/web/docs/release-checklist.md) | 每次产出并切换发布包时；它本身也维护着上面这张对照表 |
| [构建与持续集成](apps/web/docs/build-and-ci.md) | 构建入口、CI 入口、`.nvmrc` 或发布包清单（`serverFiles`）变化时 |
| [运维手册](apps/web/docs/ops-runbook.md) | 启动、发布、监控、备份恢复或故障处置步骤变化时 |
| [部署与回退](apps/web/docs/deploy-and-rollback.md) | 发布包切换、回退策略、双因素回退约束或开机拉起方式变化时 |
| [备份与恢复](apps/web/docs/backup-restore.md) | 备份成员契约、加密信封、恢复顺序或保留策略变化时 |
| [运行监控](apps/web/docs/monitoring.md) | 探针端点、指标名/单位、告警阈值或日志字段变化时 |
| [容量与保留](apps/web/docs/capacity.md) | 并发上限、队列深度、超时或磁盘回收规则变化时 |
| [多租户](apps/web/docs/multi-tenant.md) | 租户/成员/邀请/审计接口或 `tenant_id` 映射语义变化时 |
| [Web 离线编辑](apps/web/docs/web-offline.md) | IndexedDB 结构、离线有效期、回放或冲突语义变化时 |
| [权限与供应链](apps/web/docs/supply-chain.md) | 凭证清单、TLS 到期、依赖固定或密钥扫描规则变化时 |

另外两条机械约束，改代码时容易漏：

- **新增服务端文件必须加进 `apps/web/build-web-release.mjs` 的 `serverFiles` 数组**，否则发布包
  里没有该文件，线上启动时才报错。
- **改完文档跑一次相对链接与锚点检查**：

  ```bash
  node apps/web/tools/check-doc-links.mjs        # 失败非零退出
  node apps/web/tools/check-doc-links.mjs --list # 列出每条解析成功的链接
  ```

  脚本只校验仓库内的相对链接与 GitHub 风格锚点，外部链接只计数不抓取，因此可离线运行。

## 已知限制

**旧版未保存草稿不能自动迁移。** 旧版本的工作台用 `vscode-test-web://mount-<账号>/` 表示当时
默认的工作区，这个 URI 不记录工作区 ID，而默认工作区在成员被撤销后会变化，因此「当前选中的工作区」
不能作为旧草稿来源的证据。当前版本改用 `mount-<账号>.<工作区>` 并拒绝 legacy 与空 authority。
旧草稿需要独立的、非破坏性的恢复流程（枚举旧备份、允许导出或显式放置、保留原件，并用成员变更、
多账号、取消恢复与回滚来验证），**该流程尚未实现**；在此之前不要删除浏览器数据，也不要假设旧草稿
会被自动搬进当前工作区。详见
[工作区切换迁移说明](apps/web/docs/workspace-switch-migration.md)。

其它已知限制：

- **集成候选包**支持当前工作区内的 Markdown 正文搜索。浏览器内从搜索结果跳到匹配处仍需验收。
- **组织级强制双因素**未实现：目前是「每个受保护面强制已验证的第二因素」，不是「管理员为整个
  工作区强制所有成员开通 2FA」。
- **Git 集成为按部署可选项**：未配置 `LOG4STELLAR_GIT_WORKSPACE_ROOTS` 时 `/git/v1/*` 恒返回
  `503 GitNotConfigured`，且不能关联任何仓库。
- **工作区成员管理没有 HTTP 入口**，只能由运维在服务端执行命令行。
- 工作台浏览器存储键随 `applicationName` 变化，品牌化之后旧 profile 的工作台布局状态不会继承
  （笔记内容不受影响）。

## 参考来源

产品在同步与冲突体验上参考了 [Joplin](https://github.com/laurent22/joplin)，
在目录导航与 Markdown 交互上参考了 [Logseq](https://github.com/logseq/logseq)。
代码为独立实现，未引入上游源码。

## 第三方许可证

本项目基于 MIT 许可的 Code - OSS 修改而来，上游版权与许可见 [LICENSE.txt](LICENSE.txt)
与 [ThirdPartyNotices.txt](ThirdPartyNotices.txt)。在此之上新增的依赖：

**服务端（`apps/web`）**

| 依赖 | 版本 | 许可 |
|---|---|---|
| @aws-sdk/client-s3 | 3.1173.0 | Apache-2.0 |
| @node-rs/argon2 | 2.2.2 | MIT |
| @vscode/test-web | 0.0.81 | MIT |
| better-auth | 1.7.27 | MIT |
| pg | 8.23.1 | MIT |
| qrcode-generator | 2.0.4 | MIT |

`qrcode-generator` 用于在服务端本地生成第二因素绑定二维码，不调用外部二维码服务。

**PC 客户端（`clients/pc`）**

| 依赖 | 版本 | 许可 |
|---|---|---|
| dompurify | ^3.2.4 | MPL-2.0 OR Apache-2.0 |
| markdown-it | ^14.1.0 | MIT |
| electron（开发） | 38.8.6 | MIT |
| electron-builder（开发） | ^25.1.8 | MIT |
| esbuild（开发） | ^0.24.2 | MIT |

注意 `dompurify` 是双许可（MPL-2.0 或 Apache-2.0），分发时需保留其许可声明。

**Android 客户端（`clients/android`）**

| 依赖 | 版本 | 许可 |
|---|---|---|
| androidx.core:core-ktx | 1.13.1 | Apache-2.0 |
| androidx.appcompat:appcompat | 1.7.0 | Apache-2.0 |
| com.google.android.material:material | 1.12.0 | Apache-2.0 |
| androidx.recyclerview:recyclerview | 1.3.2 | Apache-2.0 |
| androidx.lifecycle:lifecycle-runtime-ktx | 2.8.4 | Apache-2.0 |
| androidx.activity:activity-ktx | 1.9.1 | Apache-2.0 |
| org.jetbrains.kotlinx:kotlinx-coroutines-android | 1.8.1 | Apache-2.0 |
| com.squareup.okhttp3:okhttp | 4.12.0 | Apache-2.0 |

Android 侧的 `junit`、`mockwebserver`、`kotlinx-coroutines-test` 仅用于测试，不随 APK 分发。

## 许可

上游 Code - OSS 部分：Copyright (c) Microsoft Corporation，MIT 许可。

本项目新增部分：同样以 MIT 许可发布，详见 [LICENSE.txt](LICENSE.txt)。
