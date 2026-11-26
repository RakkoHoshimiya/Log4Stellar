# Log4Stellar

Log4Stellar 是一个基于 [Code - OSS](https://github.com/microsoft/vscode) 的自托管 Web 笔记工作台。左侧浏览工作区文件，中间阅读或编辑 Markdown，右侧查看大纲、版本历史和回收站。一个工作区可以同时保存笔记、Office 文档、图片、视频和其他附件。

这是项目的 Web 发布分支。本仓库包含 Web 工作台、服务端、发布工具和部署文档。PC、Android 和客户端端到端同步暂缓交付。

## 快速上手

- **已有部署**。打开部署方提供的 HTTPS 地址并登录。单击 Markdown 默认进入预览，编辑时可以切到源码；工作台搜索可查当前笔记正文。
- **本地试用**。按 [Web 服务端说明的隔离环境最小启动](apps/web/README.md#隔离环境最小启动) 创建本地目录、测试账号和 HTTPS 证书。这个模式适合试用工作台。
- **自托管部署**。采用 PostgreSQL 和 RustFS，按[空库租户与工作区](apps/web/docs/managed-workspaces.md) 初始化首个平台管理员，然后在「租户管理」中创建租户、工作区和成员授权。

## 能力矩阵

| 能力 | 当前范围 |
| --- | --- |
| Markdown 编辑与阅读 | Markdown 默认预览，支持源码切换、标题大纲跳转、标准相对链接和部分 Obsidian 双链。 |
| 文件与附件版本 | 可查看历史、比较 Markdown 差异并逐处跳转。恢复旧版会生成一个新版本。回收站支持批量恢复及同名冲突处理。 |
| 大附件上传 | Web 支持分片、进度、暂停、取消及断点续传。刷新后重选原文件可继续上传。 |
| 当前笔记与知识关联 | 工作台全文搜索涵盖标题和 Markdown 正文，支持中文命中。反向链接、标签及断链面板支持更新和分页。 |
| 历史与附件搜索 | 在命令面板运行「Log4Stellar: 历史版本与附件搜索」。支持历史 Markdown、纯文本及 PDF、DOCX、XLSX、PPTX 正文。启用额外提取器后，也可查扫描 PDF 与旧版 DOC、XLS、PPT。 |
| Office 只读预览 | 启用 LibreOffice 转换后，DOCX、XLSX、PPTX 可在工作台预览，支持加载反馈、滚轮连续翻页和键盘滚动。 |
| 工作区与租户管理 | Web 界面支持租户、工作区、邀请、成员授权及审计。可为租户配置独立存储桶，运维可在维护窗口迁移或回迁工作区。 |
| 登录与账户安全 | 账密登录、闲置过期、TOTP、恢复码、设备会话管理，以及按租户强制双因素验证。 |
| 代码仓库接入 | 可绑定已授权的 Git 仓库，查看状态和提交，切换分支并通过 HTTPS 或 SSH 拉取和推送。 |
| 主题与界面语言 | 深色与明亮主题可切换。主要界面支持简体中文、繁体中文、英语和日语，可按浏览器语言设置，也可在设置中选择。 |

## 架构

| 组件 | 职责 |
| --- | --- |
| Web 工作台与 HTTPS 网关 | 提供编辑、预览、文件导航和会话入口，按租户及工作区权限处理请求。 |
| PostgreSQL | 托管模式下存放账号、会话、租户与工作区权限，以及文件路径、版本、回收站和增量变更。 |
| RustFS | 存放文件与各版本的对象内容。历史版本记录引用对应对象，多个版本可复用同一份内容。 |
| Git | 管理代码提交、分支与标签。本项目的代码远端在 GitHub。 |

目录后端适合隔离试用，使用本地文件目录和 SQLite 账号库。托管模式使用 PostgreSQL 账户体系和 RustFS 存储，提供完整的租户及文件版本功能。

## 构建、测试与发布

在仓库根目录使用 [`.nvmrc`](.nvmrc) 指定的 Node.js 和 [`package.json`](package.json) 指定的 pnpm 版本。安装根目录与 Web 服务端各自的锁定依赖。

```sh
pnpm install --frozen-lockfile
pnpm --dir apps/web --ignore-workspace install --frozen-lockfile

node --test apps/web/*.test.mjs
node apps/web/verify-ci-flow.mjs --static
node apps/web/tools/check-doc-links.mjs
```

构建发布包时使用新的输出目录。下面以已检出对应版本的本地 `vscode-loc` 为例。

```sh
export NODE_OPTIONS=--max-old-space-size=7168
release="$PWD/.build/log4stellar-web-release"
node apps/web/build-web-release.mjs "$release" /path/to/vscode-loc
node "$release/server/verify-web-release.mjs" "$release"
```

构建工具会先运行 Web 测试，再生成工作台、语言资源和服务端文件，最后启动临时 HTTPS 实例校验发布包。正式上线与回退见[运维手册](apps/web/docs/ops-runbook.md)。在获准的探针来源检查 `/login`、`/healthz` 和 `/readyz`，再用验收账号打开工作区文件。

## 已知限制

- 扫描 PDF OCR 覆盖无文本层 PDF 的前三页。混合型 PDF 优先使用已有文本层。旧版 Office 正文提取与 OCR 需要配置转换沙箱。[搜索配置与限制](apps/web/docs/extended-search.md)
- Web 断网时可阅读当前页面已加载的内容。刷新页面和打开未加载文件需要联网。
- 增量同步服务端接口已实现，客户端端到端同步仍处于暂缓范围。[增量同步协议](apps/web/docs/incremental-sync.md)

## 文档索引

| 主题 | 文档 |
| --- | --- |
| 隔离启动、环境变量与构建 | [Web 服务端说明](apps/web/README.md) |
| 租户初始化、独立桶、强制双因素及工作区迁移 | [托管工作区](apps/web/docs/managed-workspaces.md) · [租户高级管理](apps/web/docs/tenant-advanced.md) |
| 历史版本、附件搜索与 OCR | [搜索说明](apps/web/docs/extended-search.md) |
| 大附件上传与知识关联 | [断点续传](apps/web/docs/resumable-uploads.md) · [知识关联](apps/web/docs/knowledge-links.md) |
| Git 绑定与 HTTPS／SSH 配置 | [Git 接入](apps/web/docs/git-integration.md) |
| 发布、回滚、加密备份与恢复 | [运维手册](apps/web/docs/ops-runbook.md) · [备份与恢复](apps/web/docs/backup-restore.md) |

## 第三方许可证

工作台基于 Microsoft Code - OSS，按 MIT 许可使用并保留上游声明。第三方依赖声明见 [ThirdPartyNotices.txt](ThirdPartyNotices.txt)。Web 服务端依赖及锁定版本见 [package.json](apps/web/package.json) 和 [pnpm-lock.yaml](apps/web/pnpm-lock.yaml)。发布包内附 PDF.js 和 vscode-loc 的许可文件。

## 许可

本项目按 [MIT 许可](LICENSE.txt)发布。
