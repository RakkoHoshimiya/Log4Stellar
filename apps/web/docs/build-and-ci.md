# 构建与持续集成契约

本文件是「Web 服务的构建与持续集成」的实现契约，与 `docs/deploy-and-rollback.md`、`docs/multi-tenant.md` 并列为发布前的共同判据。凡本文件写明的命令、环境变量、作业划分与产物要求，实现与测试都必须一致；如需修改契约，先改本文件再改代码。

配套实现：`apps/web/ci-workflow.mjs`（CI 契约与纯校验）、`apps/web/ci-baseline.mjs`（基线、来源追踪、构建资源）、`apps/web/verify-ci-flow.mjs`（本地演练 CLI）、`.github/workflows/web.yml`（唯一的 Web 流水线入口）。测试：`apps/web/ci-workflow.test.mjs`。

## 1. 为什么 Web 不走 `pr.yml`

上游 Code OSS 的 `pr.yml` 是单一汇聚入口，扇出到 Electron 的 Linux / Windows / macOS 作业，并用 `detect-changes` 决定跳过哪些平台。Web 服务端不在这条链路里：

| 事实 | 后果 |
|---|---|
| `pr.yml` 及其 `workflow_call` 子流程全部使用 `vscode-large-runners-*`、`macos-26`、`windows-2025` 等 GitHub 托管或注册 runner | 这些作业运行 Electron 测试，与 `apps/web` 无关 |
| Web 服务端只依赖 Node、PostgreSQL、S3 与 LibreOffice | 放进 `pr.yml` 会让 Web 测试被 Electron 作业的失败淹没，或反之让 Web 的失败被当作平台测试噪声 |
| `pr.yml` 的必过状态是一个 "PR Gate" 汇总检查 | 把 Web 结果塞进去，就无法在分支保护里单独要求 "Web 必过" |

因此 Web 有独立入口 `web.yml`，只跑 Web，并且同样用 gate 作业汇聚成一个必过状态。两条流水线互不依赖，任何一个都不可能替另一个放行。

## 2. 作业划分

`web.yml` 有四个测试作业加一个 gate，**互相之间不共享状态**，任何一个失败都不会被另一个的成功掩盖。

| 作业 id | 名称 | 触发条件 | 用途 |
|---|---|---|---|
| `static` | Web / Static | PR、手动 | 语法、CI 契约、工作流清单、构建资源 |
| `unit` | Web / Unit | PR、手动 | 纯单元测试（不需要数据库与对象存储） |
| `integration` | Web / Integration | PR、手动 | 真实 PostgreSQL + 真实对象存储的集成测试 |
| `browser` | Web / Browser | PR、手动 | Playwright 浏览器端到端 |
| `gate` | Web / Gate | 始终（`if: always()`） | 把四个结果汇聚成单一必过状态 |

不变量：

1. **gate 的 `needs` 必须等于四个作业 id 的全集。** 少列一个就等于允许那个作业随便红。
2. **gate 必须在 `if: always()` 下运行。** 否则上游作业失败时 gate 会被跳过，而"被跳过"在某些分支保护配置下等于通过。
3. **gate 只在四个结果全是 `success` 时退出 0。** 其余任何组合（`failure` / `cancelled` / `skipped`）都必须打印 `::error::` 并以 1 退出。这条由 `ci-workflow.test.mjs` 把 `web.yml` 里的 shell 片段抽出来、替换 `${{ needs.*.result }}` 后真实执行来验证，而不是靠读文本。
4. **`unit` 作业内不得出现 `LOG4STELLAR_IT`。** 出现就意味着单元作业在偷偷跑集成，用它作必过门槛会让"没跑集成"看起来像"集成通过"。

## 3. 命令契约

`ciPlan` 把每个作业必须执行的命令写成了数据，`compareWorkflowWithPlan()` 比对提交的 `web.yml`；少一条、顺序错、被改写成 `true`，都会在 `static` 作业里失败。

| 作业 | 必须出现且顺序一致的命令 |
|---|---|
| `static` | `node --check`、`node apps/web/verify-ci-flow.mjs --static` |
| `unit` | `pnpm install --frozen-lockfile`、TAP 采集的 `node --test --test-reporter=tap --test-reporter-destination=web-tap.txt apps/web/*.test.mjs`、普通 `node --test apps/web/*.test.mjs`、`node apps/web/verify-ci-flow.mjs --tap web-tap.txt` |
| `integration` | `pnpm install --frozen-lockfile`、`node apps/web/verify-ci-flow.mjs --isolated-storage`、`LOG4STELLAR_IT=1 node --test --test-concurrency=1 apps/web/*.test.mjs` |
| `browser` | `pnpm install --frozen-lockfile`、`pnpm exec playwright install --with-deps chromium`、`LOG4STELLAR_BROWSER_IT=1 node --test apps/web/*.browser.test.mjs` |

三条命令的理由：

1. **`node --check` 是循环执行的。** 早期版本把它写成"检查某一个文件"，改了任何其它模块都不会被发现。现在作业遍历 `apps/web/*.mjs apps/web/*.js`。
2. **集成必须 `--test-concurrency=1`。** 数据库角色 `user_agent` 的 `rolconnlimit` 是 10，而测试池是 `max: 4` 与 `max: 2`；默认并行会随机报 `too many connections for role "user_agent"`，表现为 8–12 个互不相关的失败。它不是稳定性问题，是连接数问题。
3. **TAP 采集与 `--tap` 校验成对出现。** 73 个跳过用例全部来自环境变量门控（`LOG4STELLAR_IT`、`LOG4STELLAR_BROWSER_IT`）；一次"全绿但全跳过"的运行与"真的跑过"输出完全一样。TAP 是唯一能观察到跳过原因的地方（`ok N - 名称 # SKIP 原因`），所以 `unit` 作业必须产出一个 TAP 文件，并由 `--tap` 断言每一条跳过都带原因。

## 4. 环境变量与隔离

| 变量 | 作用 | 不在 CI 里设置时的后果 |
|---|---|---|
| `LOG4STELLAR_IT=1` | 打开四个集成测试文件 | 全部跳过，看起来像通过 |
| `LOG4STELLAR_STORAGE_CONFIG` | 指向存储配置 JSON | 集成文件在 import 期抛错 |
| `LOG4STELLAR_BROWSER_IT=1` | 打开浏览器端到端 | 跳过 |
| `LOG4STELLAR_OFFICE_PREVIEW` | Office 预览开关（默认关） | 预览相关集成不跑 |

**隔离是硬约束。** `productionMarkers` 把生产标识写成了常量：主机 `192.0.2.9` 与 `192.0.2.233`、数据库 `log4stellar`、桶 `log4stellar`、账户目录 `/home/log4stellar/.config/log4stellar`、认证目录 `/home/log4stellar/.cache/log4stellar-demo/auth`。`validateWebWorkflow()` 与 `assertIsolatedStorageConfig()` 会在出现任何一个时失败：

- 工作流文本里出现生产主机、生产凭据目录 → `static` 作业失败；
- 存储配置里 `postgres.host` / `s3.endpoint` 指向生产 → `--isolated-storage` 失败；
- 配置里 `database` / `bucket` 用了生产名 → 同上。

集成作业自带服务容器（`postgres:18-alpine` 与 `minio/minio`），全部走 `127.0.0.1`。`--isolated-storage` 会生成一份临时配置并输出 `export LOG4STELLAR_STORAGE_CONFIG=<path>` 供后续步骤采纳；这一步写在 `>> $GITHUB_ENV` 之前，所以配置校验失败时集成作业不会开始下载依赖。

## 5. 基线、来源与产物

### 5.1 基线

`describeRepositoryBaseline()` 记录四个事实：当前分支、当前 commit、`main` 的位置、发布分支的位置。Web 服务端的现实是：

| 关系 | 实测 |
|---|---|
| `takeover/task1-web-workspace-switch` 与 `main` | 领先 39 个提交，落后 0 |
| 生产 release 的 `source.commit` | 等于发布分支 HEAD `0894060b906…`（与 `release.json` 一致） |
| 待合并分支 | 每个功能分支相对发布分支 +1 提交 |

因此"从 `main` 构建"对 Web 服务端是不可能成立的 —— `main` 缺 `apps/web/git-*.mjs` 整整一批文件。基线作业的判据是：**构建分支必须等于发布分支，且不得落后 `main`**；两者任一不成立就报错，而不是让人在日志里自己发现。

### 5.2 合并演练

`planIntegration()` 用 `git merge-tree --write-tree --name-only <base> <branch>` 逐个演练待合并分支，只读、不移动任何 ref。干净的分支返回结果树 oid，冲突的分支返回以 `CONFLICT` 开头的行。`--baseline` 会把两条信息一起打印：**哪些分支可以无冲突合入**，以及每个分支领先多少提交。当前十个待合并分支全部报告 `clean`。

### 5.3 候选产物

`traceCandidate()` 校验一个 release 目录能否追溯到确定的来源：

| 检查 | 失败信息 |
|---|---|
| `marker.format === 1` | `the release marker format must be 1` |
| `marker.source.commit` 是完整 40 位 | `the release marker carries no source commit` |
| `marker.source.fingerprint` 是 64 位 | `the release marker carries no source fingerprint` |
| commit 在本仓库里确实存在 | `<commit> is not in this repository` |
| `marker.nodeMajor` 等于生产 node 主版本 | `the release was built on node <x> but production runs node 24` |
| `marker.files` 非空 | `the release inventory is empty` |

`candidateDigest()` 对 `format/platform/arch/nodeMajor/commit/fingerprint` 加上排序后的清单逐项哈希，**刻意排除 `builtAt`**：同一提交重建两次必须得到同一个摘要，否则摘要无法用来回答"这两个候选包是不是同一个东西"。

### 5.4 工具链

`.nvmrc` 必须写精确版本（`24.22.1`），不能写 `lts/*` 或 `24`。`readWebRelease()` 校验 `nodeMajor === process.versions.node` 的主版本，本机 shell 的 node 是 26 而生产 runner 是 24，用 26 构建出的包在生产上根本加载不了。`checkToolchain()` 同时比对 `.nvmrc` 与已部署的 `release.json`，任一处主版本不是 24 就失败。

## 6. 发布包闭包

`build-web-release.mjs` 的 `serverFiles` 数组是发布包的**显式清单**。不在清单里的模块不会进入 `server/`，运行时才以 `ERR_MODULE_NOT_FOUND` 暴露 —— 这正是本仓库实际发生过的事故类型。

`verifyReleaseClosure()` 从 `serve-demo.mjs` 出发沿静态 `import`/`export ... from`、动态 `import()`、`new URL('./x', import.meta.url)` 与 `readFile(join(app, 'x'...))` 走一遍，产出两类问题：

| 类别 | 含义 |
|---|---|
| `missing` | 被引用但不在 `serverFiles` 里 —— 会漏发 |
| `unknown` | 在 `serverFiles` 里但文件不存在 —— 清单本身错了 |

当前闭包：从 `serve-demo.mjs` 可达 32 个模块，清单里列了 40 项。差集是入口不可达但仍然必须发布的文件（CLI、迁移、SQL、浏览器端模块）。

## 7. 构建资源与失败路径

`describeBuildResources()` 在 `static` 与 `--resources` 里读取 `/proc/meminfo` 和 `statfsSync(repo)`，在以下任一情况下报错：

| 条件 | 理由 |
|---|---|
| 可用内存 < 2048 MiB | 过去的构建因为 OOM 失败过，Web 打包是内存峰值环节 |
| swap 使用 > 90% | 说明机器已经在换页，构建会把一切都拖垮 |
| 磁盘可用 < 8 GiB | 一次 prepare 需要约 535 MiB，还要留回滚与备份空间 |

**失败路径是被验证过的，不是假设的。** `ci-workflow.test.mjs` 里有两个真实执行的测试：

1. 从 `web.yml` 抽出 gate 的 shell 片段，替换结果为 `failure`/`cancelled`/`skipped` 后执行，四种都必须以 1 退出并打印对应信息；
2. 在一个临时目录里放一个通过的测试文件与一个故意失败的测试文件，用作业里的命令跑一遍，确认退出码为 1。

第 2 条测试有一个必须记住的陷阱：`node --test` 会给子进程设置 `NODE_TEST_CONTEXT`，继承它会让嵌套的 `node --test` 打印 "node:test run() is being called recursively within a test file. skipping running files." 并**以 0 退出** —— 测试会因为错误的原因通过。任何在测试里 spawn 测试运行器的代码都必须 `delete env.NODE_TEST_CONTEXT`。

## 8. 本地演练

`verify-ci-flow.mjs` 是流水线的本地等价物，不需要 GitHub、不需要容器：

```
node apps/web/verify-ci-flow.mjs --static            # 工作流 vs 契约、node 主版本、发布包闭包
node apps/web/verify-ci-flow.mjs --inventory         # 所有工作流的触发表格
node apps/web/verify-ci-flow.mjs --baseline          # 基线与合并演练
node apps/web/verify-ci-flow.mjs --isolated-storage  # 校验/生成隔离存储配置
node apps/web/verify-ci-flow.mjs --resources         # 内存、swap、磁盘
node apps/web/verify-ci-flow.mjs --candidate <dir>   # 追溯一个候选包
node apps/web/verify-ci-flow.mjs --tap <file>        # 每条跳过都必须带原因
```

任何一项有问题都以 1 退出，用法错误以 2 退出。`--static` 是把 `web.yml`、`.nvmrc`、`release.json`、`build-web-release.mjs` 联系起来的那条命令：**提交前跑它**。

## 9. 验收判据（对应任务书）

| 编号 | 判据 | 对应实现与测试 |
|---|---|---|
| C01 | 同一提交从干净工作树可以复现出可追溯的候选包 | `traceCandidate()` / `candidateDigest()`、`--candidate`；摘要不含 `builtAt` |
| C02 | 故意失败的测试会挡住流水线 | `ci-workflow.test.mjs` 里真实 spawn 的失败测试；gate 脚本真实执行 |
| C03 | 产物可以追溯到提交；失败日志可复现；跳过原因是可见的 | `marker.source.{commit,fingerprint}`、`--tap` 与 TAP 采集命令 |
| C04 | 记录基线、待合并范围、工具链版本、构建资源、清单与 SHA-256 | `--baseline`、`--resources`、`--candidate`、`.nvmrc` 校验 |

## 10. 已知缺口

| 缺口 | 现状 | 影响 |
|---|---|---|
| 真实 GitHub Actions 运行 | 从未在 GitHub 上跑过这条流水线 | 容器服务、playwright 下载、pnpm store 恢复都只在本地验证过形态 |
| 浏览器端到端 | 依赖 `playwright` 与 `@vscode/test-web`，本机未安装 | `browser` 作业在 CI 里是首次运行 |
| 构建机 | 当前主机 swap 曾打满，构建与生产同机 | `--resources` 会在资源不足时拒绝，但没有独立构建机 |
| xlsx 分页、Office 预览的真实桶验证 | 属于任务 05 的缺口 | 与本契约的 CI 入口无关，但会影响 `integration` 作业时长 |
| 覆盖率门槛 | 未设置 | 新增测试只能靠 review 保证，没有数字下限 |
