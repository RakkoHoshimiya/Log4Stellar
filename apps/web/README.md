# Log4Stellar Web 服务端

这是 Log4Stellar 的 Web 端服务：一个基于 Code - OSS 裁剪改造的浏览器工作台，加上它的
认证网关、文件与版本后端、增量同步接口、Git 接入与发布打包工具。本文件是**部署与测试入口**；
产品定位与能力状态见[仓库根 README](../../README.md)。

协议细节不在本文件重复，看各自的契约文档：

| 主题 | 文档 |
|---|---|
| 工作区、角色与 capability 判权 | [docs/workspace-access.md](docs/workspace-access.md) |
| Web 租户管理、邀请与审计 | [docs/multi-tenant.md](docs/multi-tenant.md) |
| 托管模式初始化 | [docs/managed-workspaces.md](docs/managed-workspaces.md) |
| 租户强制双因素、独立桶与迁移 | [docs/tenant-advanced.md](docs/tenant-advanced.md) |
| 历史版本、附件正文与 OCR | [docs/extended-search.md](docs/extended-search.md) |
| 大附件断点续传 | [docs/resumable-uploads.md](docs/resumable-uploads.md) |
| 增量同步（快照、游标、冲突） | [docs/incremental-sync.md](docs/incremental-sync.md) |
| 账户安全与双因素 | [docs/account-security.md](docs/account-security.md)、[运行时交付](docs/account-security-takeover.md)、[接线方案](docs/account-security-wiring.md) |
| Git 仓库接入 | [docs/git-integration.md](docs/git-integration.md) |
| 工作区切换与旧草稿限制 | [docs/workspace-switch-migration.md](docs/workspace-switch-migration.md) |
| 发布清单（含「改什么代码要同步改哪些文档」） | [docs/release-checklist.md](docs/release-checklist.md) |

## 目录结构

```
apps/web/
  serve-demo.mjs             唯一服务进程入口（HTTPS 网关 + 工作台静态资源）
  auth.mjs                   本地 SQLite 账号、会话、闲置过期
  managed-auth.mjs           托管 PostgreSQL 账号、会话与租户管理
  auth-gateway.mjs           网关中间件：登录页、工作区选择、各后端的路由与判权
  login-page.mjs             登录页与第二因素表单的 HTML
  account-security*.mjs      账户安全运行时、DDL、页面、纯校验函数
  workspace-*.mjs            后端工厂（本地目录 / RustFS）、能力矩阵、请求契约、文件 API
  local-workspace.mjs        本地目录后端（无数据库时也可跑）
  rustfs-workspace.mjs       对象存储 + PostgreSQL 后端（版本、回收站、Range、搜索）
  rustfs-blobs.mjs           对象存储读写与 spool
  sync-*.mjs                 增量同步契约、路由、存储、迁移
  git-*.mjs                  Git 契约、路由、仓库操作、凭证加密、迁移
  create-account.mjs         建号（命令行，密码走 stdin）
  workspace-members.mjs      本地或旧版工作区成员管理
  create-managed-account.mjs 托管账号与平台初始化
  import-workspace.mjs       把目录导入为新的存储工作区
  backup-data.mjs            加密备份和对象清单
  restore-backup.mjs         验证、解密并恢复到独立目标
  build-web-release.mjs      构建自包含发布包
  verify-web-release.mjs     发布包隔离自检（临时 HTTPS + 临时账户库）
  web-release.mjs            发布包清单、指纹与 nodeMajor 校验
  build-locales.mjs          语言包产物生成
  docs/                      契约与设计文档
  test-support/              测试替身（目录型对象存储、验收脚本样例）
  tools/check-doc-links.mjs  文档相对链接与锚点检查
  workspace-extension/       Web 端 workspace-files 扩展（挂载与搜索提供者）
  *.test.mjs                 单元与集成测试
```

## 依赖与运行时

- Node.js **24.x**。发布包在 `release.json` 里记录 `nodeMajor`，用错大版本启动会抛
  `Incompatible Log4Stellar Web release: <root>`。
- `pnpm` 安装本目录依赖。仓库根的工作台构建还要求完整的上游工具链（见根 README）。

```sh
pnpm --dir apps/web --ignore-workspace install --frozen-lockfile
```

`--ignore-workspace` 让安装停留在 `apps/web`，不要提升到仓库根的 workspace。

服务端运行依赖以 [package.json](package.json) 与锁定文件为准。历史与附件搜索使用 PDF.js 提取 PDF 文本，用 Python 3 提取 OOXML。扫描件 OCR 和旧版 Office 依赖另行配置的转换沙箱。

## 隔离环境最小启动

先按[仓库根 README](../../README.md#构建测试与发布)构建发布包。以下示例用目录后端与 SQLite，适合试用工作台。请在 Bash 下执行。默认读取根 README 示例的发布目录，也可用 `LOG4STELLAR_LOCAL_RELEASE` 指向已有发布包。

```bash
umask 077
release="${LOG4STELLAR_LOCAL_RELEASE:-$PWD/.build/log4stellar-web-release}"
trial=$(mktemp -d)
notes="$trial/notes"
export LOG4STELLAR_AUTH_DIR="$trial/auth"
mkdir -p "$notes" "$LOG4STELLAR_AUTH_DIR"
printf '# 第一篇笔记\n' > "$notes/Welcome.md"
openssl rand -hex 32 > "$LOG4STELLAR_AUTH_DIR/secret"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=Log4Stellar local' -addext 'subjectAltName=IP:127.0.0.1' \
  -keyout "$trial/server.key" -out "$trial/server.crt"

export LOG4STELLAR_WEB_ORIGIN=https://127.0.0.1:18991
export LOG4STELLAR_TLS_CERT="$trial/server.crt"
export LOG4STELLAR_TLS_KEY="$trial/server.key"
export LOG4STELLAR_STORAGE_BACKEND=local
export LOG4STELLAR_WORKSPACE_ID=workspace-demo

read -rsp 'Test account password: ' account_password
printf '\n'
printf '%s' "$account_password" | node "$release/server/create-account.mjs" alice workspace-demo
unset account_password
node "$release/server/serve-demo.mjs" "$notes" 18991 --release
```

从浏览器打开 `https://127.0.0.1:18991`。测试浏览器需要信任示例生成的证书。使用刚才创建的账号 `alice` 登录，在资源管理器中打开 `Welcome.md`。完整的租户和文件版本功能使用[托管模式](docs/managed-workspaces.md)。

### 从检出运行工作台（不走发布包）

`serve-demo.mjs` 的第三个参数既可以指向发布包内的 `web/`，也可以指向一个从当前检出构建出来的
工作台目录。后者用于改工作台源码时的验证，需要三步产物就位：

```sh
export NODE_OPTIONS=--max-old-space-size=5120

# 1) 干净工作树先补齐依赖与 gitignore 的构建产物（见下方说明）
node build/next/index.ts bundle --out .build/log4stellar-web/out --target web --nls
# 2) 生成语言包清单：第二个参数给本地 vscode-loc 检出，否则会去 GitHub 拉
node apps/web/build-locales.mjs .build/log4stellar-web/out /path/to/vscode-loc
# 3) 起服务，第三个参数指向 .build/log4stellar-web（不是 .build/log4stellar-web/out）
node apps/web/serve-demo.mjs "$notes" 18991 .build/log4stellar-web
```

工作台打包约 3.5 分钟（13 个 bundle），成功标志是 `[bundle] Done in ... (13 bundles)` 与
`Total: ...`。`serve-demo.mjs` 会从 `<该目录>/out/nls.locales.json` 读语言包清单，缺这一步会报
`ENOENT ... nls.locales.json`；它还会自己把 `vscode-oniguruma`/`vscode-textmate` 的 `release`
目录复制进去，所以这两项必须已经安装在仓库根的 `node_modules` 里。

**新工作树容易卡住的两处**，都不是代码问题：

- 仓库根 `node_modules` 在多个工作树之间共享时，各 workspace 的 `node_modules`（尤其
  `build/node_modules`，工作台打包通过它解析 `esbuild`）没有一起进来，会报
  `Cannot find package 'esbuild' imported from .../build/next/index.ts`。
- `codicon.ttf` 与各扩展的 `markdown-editor-out`/`notebook-out`/`markdown-preview-out` 是
  gitignore 的生成产物，干净检出里没有，工作台打包会在第一个 `Could not resolve "./codicon.ttf"`
  处停下。

两者都有现成脚本（在仓库根执行，参数是工作树目录名）。它们**必须复制而不能 symlink**：发布
清单校验会拒绝 realpath 逃出包外的条目，链接进来的产物会让构建报
`Release link points outside the package`。

```sh
sh worktree-link-modules.sh   <worktree-name>   # 各 workspace 的 node_modules
sh worktree-link-artifacts.sh <worktree-name>   # codicon.ttf 与扩展产物（复制）
```

### 必需与可选的环境变量

必需（缺任一项进程直接抛错退出）：

| 变量 | 作用 | 缺省时的报错 |
|---|---|---|
| `LOG4STELLAR_AUTH_DIR` | 账户库与 `secret` 所在目录，必须可写且**在笔记目录之外** | `Set LOG4STELLAR_AUTH_DIR and LOG4STELLAR_WEB_ORIGIN to run the Web service.` |
| `LOG4STELLAR_WEB_ORIGIN` | 站点规范 HTTPS origin，决定 cookie 域与重定向 | 同上；非规范 HTTPS origin 报 `LOG4STELLAR_WEB_ORIGIN must be a canonical HTTPS origin.` |
| `LOG4STELLAR_TLS_CERT` | 服务端证书 | `Set LOG4STELLAR_TLS_CERT and LOG4STELLAR_TLS_KEY to serve notes over HTTPS.` |
| `LOG4STELLAR_TLS_KEY` | 服务端私钥 | 同上 |

可选：

| 变量 | 默认 | 作用 |
|---|---|---|
| `LOG4STELLAR_STORAGE_BACKEND` | `local` | `local` 或 `rustfs`；其它值报 `LOG4STELLAR_STORAGE_BACKEND must be local or rustfs.` |
| `LOG4STELLAR_STORAGE_CONFIG` | 无 | `rustfs` 后端的存储配置 JSON 路径 |
| `LOG4STELLAR_MANAGED_TENANTS` | 关闭 | 设为 `1` 并使用 `rustfs` 后端时，账号、会话、租户和权限使用 PostgreSQL |
| `LOG4STELLAR_WORKSPACE_ID` | `log4stellar-main` | 本部署服务的存储工作区 ID（`rustfs` 后端下位置参数优先） |
| `LOG4STELLAR_DEMO_HOST` | `127.0.0.1` | 监听地址；对外提供服务时改成对外地址 |
| `LOG4STELLAR_DEMO_CLIENTS` | 无 | 逗号分隔的客户端 IP 白名单，命中不到直接 `403` |
| `LOG4STELLAR_WEBVIEW_HOST` | 无 | Markdown 预览 iframe 的通配 DNS 后缀，必须是纯后缀（`LOG4STELLAR_WEBVIEW_HOST must be a DNS suffix without a scheme or port.`） |
| `LOG4STELLAR_IDLE_SECONDS` | `86400` | 会话闲置过期秒数 |
| `LOG4STELLAR_MAX_UPLOAD_BYTES` | `536870912`（512 MiB） | 单文件上传上限 |
| `LOG4STELLAR_GIT_WORKSPACE_ROOTS` | 未设置 | 允许关联的仓库根目录列表；**不设则 `/git/v1/*` 恒为 `503 GitNotConfigured`** |
| `LOG4STELLAR_GIT_TIMEOUT_MS` | `60000` | 单次 Git 操作超时，取值须在 1000–600000 之间，超出范围回到默认 |

正式主机的具体取值属于运维信息，记录在运维记录的运行手册里，不要提交进仓库。

### 端口与 TLS

- 位置参数第二项是端口，必须显式给（示例用 `18991`；生产用 `18990`）。
- 证书必须被访问方信任：内网自签证书用 `curl --cacert` 或把 CA 装进浏览器。
- `LOG4STELLAR_WEB_ORIGIN` 里的 origin 必须与浏览器地址栏完全一致，否则登录后的重定向与
  cookie 会失效。
- 所有非 GET 请求必须带同源 `Origin` 头，否则网关在路由前就返回裸 `403`——手工用 curl 调
  `/sync/v1`、`/git/v1` 时很容易误判成功能坏了。

## 账号与成员

托管模式按[空库初始化](docs/managed-workspaces.md)创建平台管理员和账号，在「租户管理」中创建工作区、发放邀请并分配角色。租户安全策略和跨租户迁移见[高级租户管理](docs/tenant-advanced.md)。

下列命令用于目录后端或旧版账号模式。

```sh
# 建号：密码走 stdin，第二个参数是工作区 ID（省略则用 LOG4STELLAR_WORKSPACE_ID，再退内置默认）
read -rsp 'Application password: ' account_password; printf '\n'
printf '%s' "$account_password" | node apps/web/create-account.mjs example_user example-workspace
unset account_password

# 本地或旧版工作区成员管理
node apps/web/workspace-members.mjs list --workspace example-workspace
node apps/web/workspace-members.mjs workspaces
node apps/web/workspace-members.mjs add example_editor --role editor --workspace example-workspace
node apps/web/workspace-members.mjs set-role example_editor --role viewer --workspace example-workspace
node apps/web/workspace-members.mjs remove example_editor --workspace example-workspace
```

`--workspace` 指向要读写的存储工作区，不是「本部署所在的工作区」；命令本身以部署身份
（`LOG4STELLAR_WORKSPACE_ID` 或内置默认）打开账户库，只把目标 ID 传给成员操作，这样一次性的
历史占位行归属就落在部署而不是手打的 ID 上。占位 ID `default` 不是存储工作区，会被拒绝。
目标工作区必须**先存在于存储后端**：给一个从未导入过的工作区加成员，会让账号能登录、但每次挂载
都 `403`。

移除成员立即生效且不会自动恢复。账号在所有工作区都没有成员关系时，会在登录页被拒绝——但只要有
**任意一个**工作区还有成员关系就能登录，所以撤权要撤干净所有工作区。

角色等级：`1` viewer、`2` editor、`3` owner。能力矩阵与请求→能力映射见
[工作区权限契约](docs/workspace-access.md)，迁移细节见[第 7 节](docs/workspace-access.md#7-迁移)。

## 存储后端：本地目录与 RustFS

`local` 后端把笔记放在一个目录里，写入用同目录的临时文件再原子安装，因此笔记目录与其父目录必须
在同一可写文件系统上。它只服务 `LOG4STELLAR_WORKSPACE_ID` 指定的那一个工作区。

`rustfs` 后端把字节放进 S3 兼容存储（按 SHA-256 内容寻址），元数据放进 PostgreSQL 的
`log4stellar` schema。配置文件放在仓库与笔记目录之外，权限 `0600`：

```json
{
  "s3": {
    "endpoint": "https://storage.example",
    "region": "us-east-1",
    "bucket": "log4stellar",
    "accessKeyId": "<application access key>",
    "secretAccessKey": "<application secret>"
  },
  "postgres": {
    "host": "database.example",
    "port": 5432,
    "database": "log4stellar",
    "user": "user_agent",
    "password": "<database password>",
    "ssl": true
  }
}
```

对象存储的上传 spool 目录由**配置文件所在目录**推导，所以该目录必须可写，且生产配置与 spool 是
兄弟目录：把配置文件复制到别处时，要么只复制文件、要么连 spool 一起接受，不要原地复用生产配置。

导入一个已有目录为新的工作区：

```sh
export LOG4STELLAR_STORAGE_CONFIG=/path/to/storage.json
node apps/web/import-workspace.mjs "/path/to/notes" example-workspace --owner example_user
LOG4STELLAR_STORAGE_BACKEND=rustfs node apps/web/serve-demo.mjs example-workspace 18990 --release
```

导入器跳过符号链接、拒绝已存在的目标 ID、先上传字节再发布元数据，最后打印文件/目录/字节/跳过
的计数。新导入的工作区没有任何成员，**不加 `--owner` 就没人能访问**；不加时它会打印后续要执行的
`workspace-members.mjs` 命令。导入源目录里不能包含 `LOG4STELLAR_STORAGE_CONFIG` /
`LOG4STELLAR_AUTH_DIR` / `LOG4STELLAR_TLS_KEY` 指向的文件。

## Git 集成

Git 集成是**按部署开启**的：接口、判权、仓库操作与迁移都已实现并随包部署，但只要没设置
`LOG4STELLAR_GIT_WORKSPACE_ROOTS`，`/git/v1/*` 就是常量 `503 GitNotConfigured`，也无法关联任何
仓库。启用方式：把允许关联的仓库根目录配进该变量后重启，关联的仓库与 file 类型远端必须落在允许
根目录内，否则 `400 InvalidPath`。

几个容易踩的点：

- 关联本地路径的字段名是 `path`（不是 `localPath`）；关联笔记版本用 `notePath`，`note` 只是自由
  备注。
- 远端不可达是 `502 RemoteUnavailable`，不是 `401/403`；凭证失效是 `502
  RemoteAuthenticationFailed`。不要用 401 判断「远端认证失败」。
- 非快进推送 `409 NotFastForward`；工作树脏且切换会覆盖内容 `422 WorkTreeDirty`；同一工作区并发
  操作 `409 RepositoryBusy`。
- 仓库凭证用 `git-secret`（AES-256-GCM，一文件一密钥）加密，文件放在 `LOG4STELLAR_STORAGE_CONFIG`
  **同目录**，`0600`、64 个十六进制字符。它由运维显式创建，服务端不会在首次使用时偷偷生成：

  ```sh
  node apps/web/git-credentials.mjs secret --create <storage.json>   # 创建
  node apps/web/git-credentials.mjs secret --status <storage.json>    # 检查
  ```

  该密钥是凭证的加密根，本版本不支持双密钥，**不可轮换、不可丢失**——丢了等于所有已存凭证全部
  作废。它必须与账户库、存储配置一起备份。
- 路由判权按 `method + path` 查表，表里没有的组合返回 `404` 而不是默认放行。

详见 [Git 接入契约](docs/git-integration.md)。

## Office 文件预览

工作台可以把 `.docx` / `.xlsx` / `.pptx` 渲染成 PDF 而不写回原文件。该功能**默认关闭**：
不设置 `LOG4STELLAR_OFFICE_PREVIEW=1` 时既没有路由、也不建表、也不起进程（网关只有在开启时
才会拿到 `openOfficePreview`，所以 `/api/v1/office-previews` 会像任何未知路径一样落到静态应用）。

```sh
export LOG4STELLAR_OFFICE_PREVIEW=1
export LOG4STELLAR_OFFICE_SOFFICE=/usr/bin/soffice
export LOG4STELLAR_OFFICE_CACHE_DIR=/var/lib/log4stellar/office-previews   # 默认在临时目录
```

大小、队列深度、超时与缓存预算都是运维参数，默认值来自任务书：输入 25 MiB、输出 100 MiB、
超时 60 秒、排队 20 个、每个工作区 5 GiB 缓存。对应变量是
`LOG4STELLAR_OFFICE_MAX_INPUT_BYTES`、`_MAX_OUTPUT_BYTES`、`_TIMEOUT_MS`、`_MAX_QUEUED`、
`_CACHE_BYTES`；重试上限与租约是 `_MAX_ATTEMPTS`（3）和 `_LEASE_MS`（120000）。值写坏会退回
默认值而不是让部署失败。

缓存放在**独立目录**（`LOG4STELLAR_OFFICE_CACHE_DIR`，默认临时目录），既不在笔记桶里，也不在
原文件旁边。对象键是 `office-previews/<xx>/<key>/<attempt>.pdf`，其中 `<key>` 由工作区、文件、
确切版本、源文件摘要和转换器指纹共同决定。改 LibreOffice 版本或字体时设置
`LOG4STELLAR_OFFICE_SOFFICE_VERSION` / `_FONTS`，会得到新的指纹，因此产生新缓存条目，而不是
悄悄返回旧渲染结果。迁移执行一次：`node apps/web/office-preview-migrate.mjs "$LOG4STELLAR_STORAGE_CONFIG"`。

转换本身是**独立进程**，用参数数组启动（从不经 shell），带 `-env:UserInstallation=file://<job>/profile`、
自己的临时目录、不含凭证的环境变量和独立进程组，超时时能把 LibreOffice fork 出来的子进程一起带走。
输出必须以 `%PDF-` 开头且不超过输出预算才会上传。同一部署只允许一个转换在跑：worker 抢占
`office_previews_slots` 里的一行和 `office_previews` 里的租约，因此另一台机器上的 worker 会等待
而不是再起一个 `soffice`。预览的生成与淘汰**不产生文件版本、不写原对象、不触碰原文件的清理逻辑**，
集成测试用版本计数来验证这一点。

开关打开时预览 worker 由 `serve-demo.mjs` 启动；需要独立进程时用
`node apps/web/office-preview-runner.mjs <workspace-id>`，它需要同一份存储配置并循环到收到 `SIGTERM`。

验收套件要跑真实 LibreOffice、真实 PostgreSQL 和目录式对象存储，所以只在 `LOG4STELLAR_IT=1`
且有存储配置时运行：

```sh
LOG4STELLAR_STORAGE_CONFIG=/tmp/l4s-integration-storage.json LOG4STELLAR_IT=1 \
    node --test --test-concurrency=1 apps/web/office-preview.integration.test.mjs
```

它会创建 `l4s-it-office-*` 工作区、结束后删掉相应行和对象，并要求 `soffice` 可执行。默认的
`node --test apps/web/*.test.mjs` 覆盖路由、状态机、进程外壳和扩展入口，不需要数据库或 LibreOffice。

## 测试

单元测试不需要数据库、不需要对象存储，裸检出即可通过：

```sh
node --test apps/web/*.test.mjs
```

在 `apps/web` 目录内也可以用 `pnpm --dir apps/web test`。

### 集成测试必须串行

集成测试跑真实 PostgreSQL 与对象存储，默认关闭，需显式开启。开启时**必须加
`--test-concurrency=1`**：

```sh
cp /path/to/workspace-storage.json /tmp/l4s-integration-storage.json
chmod 600 /tmp/l4s-integration-storage.json

LOG4STELLAR_IT=1 LOG4STELLAR_STORAGE_CONFIG=/tmp/l4s-integration-storage.json \
    node --test --test-concurrency=1 apps/web/*.test.mjs
```

原因是数据库角色 `user_agent` 的 `rolconnlimit` 只有 10：`node --test` 默认并行跑多个测试文件，
各自的连接池会一起抢这 10 个连接，报 `too many connections for role "user_agent"`，表现是随机
8–12 个用例失败。**不加参数得到的「部分失败」是容量问题，不是代码缺陷。**

`apps/web/package.json` 里的 `test` 与 `test:integration` 两个脚本都**没有**带
`--test-concurrency=1`，用它们跑全量时需要自己补上该参数。

测试配置文件要复制到可写目录再改，因为服务端从配置文件位置推导 spool 目录，生产配置目录通常对
测试用户不可写。每个场景创建临时 `l4s-test-*` 工作区并在结束后清理行与对象，因此同一套数据库与
桶可以反复使用。

默认全量跑会跳过需要 `LOG4STELLAR_IT=1` 的用例——**绿色默认结果不代表集成分支被覆盖**。浏览器
流程（第二因素绑定与恢复）另需 Playwright 与 Chromium，未安装时同样跳过：

```sh
LOG4STELLAR_BROWSER_IT=1 node --test apps/web/account-security.browser.test.mjs
```

当前基线（`node --test apps/web/*.test.mjs`，27 个测试文件）：**tests 486 / pass 413 /
fail 0 / skipped 73**。73 个跳过项就是上面两类显式开启的用例。

### 文档检查

```sh
node apps/web/tools/check-doc-links.mjs        # 相对链接与锚点，失败非零退出
node apps/web/tools/check-doc-links.mjs --list # 列出每条成功解析的链接
```

## 构建与校验发布包

```sh
export NODE_OPTIONS=--max-old-space-size=7168

release="$HOME/.local/share/log4stellar/releases/web-$(date +%Y%m%d-%H%M)"
node apps/web/build-web-release.mjs "$release" /path/to/vscode-loc
node "$release/server/verify-web-release.mjs" "$release"
```

构建流程与硬约束：

1. **目标目录必须尚不存在**。已存在会抛 `Release directory already exists: <path>`；暂存目录
   是 `dirname(target)/.log4stellar-web-stage-*`。
2. **构建前先跑全部 Web 测试**，失败即中止。
3. 打工作台 bundle（`--target web --nls`）、生成语言包产物、拷 5 个内置 Web 扩展与
   `workspace-files` 扩展、按 `serverFiles` 数组拷服务端文件、用 pnpm 装生产依赖。
4. **开始与结束各取一次源码指纹**，中途有改动即抛 `Source changed during release build. Build again
   from a stable worktree.`。因此发布构建要在专用工作树里做。
5. 写 `release.json`（`format`、`platform`、`arch`、`nodeMajor`、`source.commit`、`fingerprint`、
   文件摘要），再跑隔离自检，最后原子 `rename` 到目标目录并打印
   `Web release ready: <目标>` 与 `Source: <commit> (<fingerprint>)`。

**最容易漏的一条**：`build-web-release.mjs` 顶部有一个 `serverFiles` 数组，**新增任何服务端文件都
必须加进去**。它不在数组里，构建不会报错，包也能起来，但线上调用该模块时才 `ERR_MODULE_NOT_FOUND`。
同理，新增 Web 端内置扩展要同时改 `webExtensionNames` 与扩展清单。

`verify-web-release.mjs` 做的是真实自检：建临时目录与临时账户库、生成自签证书、选空闲端口、启动
包内服务，断言登录页可访问、未认证 401、敏感路径 404、语言包齐全、扩展关联正确，结束后清理。
它不需要生产数据库，因此可以在发布前任意跑。

## 发布、切换与回退

发布包是自包含的（`server/` + `web/` + `extensions/` + `release.json`）。部署侧只需维护一个
`current-web-release` 软链指向当前包，切换与回退都是原子替换该软链后重启进程。

`apps/web/deploy-release.mjs` 把这套流程固化下来，带齐切换前必须的护栏：切换前校验候选包、
TLS/磁盘/数据库/对象存储预检、切换前数据备份、双因素回滚策略、加锁原子切换、切换后校验与审计
记录。没有 user bus 的主机上用受监管的启动器替代 systemd user unit：

```sh
node apps/web/deploy-release.mjs verify "$release"
node apps/web/deploy-release.mjs prepare "$release" --name web-20261124-01
node apps/web/deploy-release.mjs activate "$HOME/.local/share/log4stellar/releases/web-20261124-01"
node apps/web/deploy-release.mjs rollback --reason "revert the affected release"
node apps/web/deploy-release.mjs status
```

在真机上使用这些命令之前先读[部署与回退手册](docs/deploy-and-rollback.md)：它解释了本机为什么
`systemctl --user` 不可用（`Failed to connect to bus: No medium found`）、`release-supervisor.mjs`
如何用 pid 文件提供启动/停止/重启、如何用 cron 开机拉起服务，以及当某个账号依赖双因素时回退会
拒绝做什么。

每次发布请走[发布清单模板](docs/release-checklist.md)：它把「改了什么代码 → 必须同步改哪些文档」
和切换前的检查项列成可勾选列表，避免文档与实现脱节。

```sh
# 启动（示例路径，按运维记录取值）
export LOG4STELLAR_AUTH_DIR=/srv/log4stellar/auth
export LOG4STELLAR_WEB_ORIGIN=https://notes.example.com
export LOG4STELLAR_TLS_CERT=/srv/tls/server.crt
export LOG4STELLAR_TLS_KEY=/srv/tls/server.key
export LOG4STELLAR_STORAGE_BACKEND=rustfs
export LOG4STELLAR_STORAGE_CONFIG=/srv/log4stellar/workspace-storage.json
export LOG4STELLAR_WORKSPACE_ID=log4stellar-main
node "$release/server/serve-demo.mjs" log4stellar-main 18990 --release
```

回退要点：

- **不需要回退数据库**。所有迁移都是纯增量的（`CREATE TABLE IF NOT EXISTS` /
  `ADD COLUMN IF NOT EXISTS`），旧版本代码能读新库；已用旧包对已迁移库做过回归。
- **不是每个历史包都能当回滚目标**。早于跨租户越权修复的中间包不可用于回滚；启用双因素后，回滚
  目标必须仍然执行双因素门禁，更早的包只允许在隔离环境演练。
- 迁移可以单独重放，幂等且并发安全：`node <release>/server/sync-migrate.mjs <storage.json>`。
- 回退**不涉及**账户库与对象存储的还原；如果你确实还原了迁移前的账户库快照，备份之后的安全设置
  变更会丢失。

## 备份与恢复

准备权限受限的备份密钥文件和独立的恢复目标。完整备份包含加密的账户与存储元数据、Git 凭据封存密钥和被引用的文件版本对象。托管模式的账户数据在 PostgreSQL 快照中。SQLite 模式额外生成账户库快照。

```sh
node apps/web/backup-data.mjs "$BACKUP_DIR" --scope=full --key-file="$BACKUP_KEY_FILE"
node apps/web/restore-backup.mjs "$BACKUP_DIR" "$RESTORE_DIR" \
  --key-file="$BACKUP_KEY_FILE" --objects-config="$ISOLATED_STORAGE_CONFIG"
```

恢复工具校验加密清单与对象，并把 SQL、账户相关文件及对象写入独立目标。随后按[备份与恢复手册](docs/backup-restore.md)导入隔离数据库，复验登录、文件版本、权限和回收站。定时备份与恢复验收见[运维手册](docs/ops-runbook.md)。

## 运行监控与探针

服务端在认证网关**之前**挂了三个端点，因此不带 cookie、不带工作区头的探针不会被
`421` 顶回来：

```sh
curl --silent --cacert "$SERVER_CA_FILE" https://192.0.2.10:18990/healthz   # 存活，永远 200
curl --silent --cacert "$SERVER_CA_FILE" https://192.0.2.10:18990/readyz    # 就绪 200，不就绪 503
curl --silent --cacert "$SERVER_CA_FILE" https://192.0.2.10:18990/metrics   # Prometheus 文本格式
```

`/healthz` 只看进程自身，PostgreSQL 或对象存储挂了它仍然是 `200` —— 跟随依赖的存活探针会去重启
一个本来健康的进程，而依赖并没有因此修好。`/readyz` 会探测 PostgreSQL、对象存储、剩余磁盘与备份
新鲜度，不就绪时返回 `503` 并附带逐项结果与耗时，**从不回显连接串或凭证**。`/readyz` 与
`/metrics` 对 loopback 和 `LOG4STELLAR_MONITOR_CLIENTS` 之外的客户端返回 `403`。

探针超时默认 1500 ms、结果缓存 5000 ms，并发轮询共用同一轮探测。这是有意的：`user_agent` 的
`rolconnlimit` 只有 10，每次轮询都拨库的探针自己就能把连接预算吃光。每轮探测各自用 `max: 1`
的连接池，并在 `finally` 里关掉。

```sh
export LOG4STELLAR_MONITOR_CLIENTS=127.0.0.1,192.0.2.0/24
export LOG4STELLAR_MONITOR_PROBE_TIMEOUT_MS=1500
export LOG4STELLAR_MONITOR_PROBE_CACHE_MS=5000
export LOG4STELLAR_MONITOR_DISK_MIN_FREE_RATIO=0.05
export LOG4STELLAR_MONITOR_DISK_MIN_FREE_BYTES=536870912
export LOG4STELLAR_BACKUP_DIR=/path/to/backups
```

磁盘下限与 `LOG4STELLAR_MONITOR_BACKUP_MAX_AGE_SECONDS` 默认关闭，按部署自行设置。
`LOG4STELLAR_MONITOR_DISK_REQUIRED=1`、`LOG4STELLAR_MONITOR_BACKUP_REQUIRED=1` 会把「降级」变成
「不就绪」，用于「这时候就该把这台机器摘出轮转」的场景。

日志是每行一个 JSON 打到 stdout，`ts` 恒为 UTC，每个请求带一个同时以 `X-Request-Id` 返回的
`requestId`。凭证形状的字段会被脱敏，笔记正文永不入日志。指标名与单位、建议告警阈值、故障定位表
以及隔离演练（PostgreSQL 挂、对象存储挂、磁盘压力）见[监控指南](docs/monitoring.md)。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 启动报 `Set LOG4STELLAR_AUTH_DIR and LOG4STELLAR_WEB_ORIGIN ...` | 必需变量没导出，或 `LOG4STELLAR_WEB_ORIGIN` 不是规范 HTTPS origin |
| 启动报 `Keep authentication data and the TLS private key outside the notes workspace.` | 账户目录或 TLS 私钥落在笔记目录内，挪出去 |
| 启动报 `Incompatible Log4Stellar Web release: <root>` | 当前 node 大版本与 `release.json` 的 `nodeMajor` 不符，换 24.x |
| curl 调接口返回裸 `403` | 非 GET 请求缺同源 `Origin` 头 |
| 接口返回 `401 ChallengeRequired` | 没有会话，先走 `/login` |
| 接口返回 `TwoFactorPending` | 会话处于半认证态，需要通过第二因素 |
| `/git/v1/*` 恒 `503 GitNotConfigured` | 未配置 `LOG4STELLAR_GIT_WORKSPACE_ROOTS` |
| 集成测试随机 8–12 个失败，报 `too many connections for role "user_agent"` | 缺 `--test-concurrency=1` |
| `listFiles('/', '*')` 返回 0 条 | pattern 是**单层文件名**子串匹配，递归列举要传空 pattern |
| 工作台挂载 `403 NoPermissions` | 账号在该工作区没有成员关系，或成员行指向一个未导入的工作区 |
| 品牌化/升级后工作台布局丢失 | 浏览器存储键随 `applicationName` 变化，笔记内容不受影响 |

`pkill -f "serve-demo.mjs"` 会把发起命令的 shell 一起杀掉，按 PID 停进程。

## 搜索历史版本和附件

工作台命令「历史版本与附件搜索」可查历史版本、Office 与 PDF 正文。扫描 PDF 和旧版 Office 需配置可选的限时转换沙箱，详见[历史版本与附件正文搜索](docs/extended-search.md)。
