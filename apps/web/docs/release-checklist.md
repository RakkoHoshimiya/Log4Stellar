# 发布模板：Web 端发布清单

每次产出并切换一个 Web 发布包时复制本文件，按序号执行并留痕（命令、输出、跳过原因、提交范围、
发布影响、回退步骤）。产品能力状态以[仓库根 README 的能力矩阵](../../../README.md#能力矩阵)为准。

## 0. 随功能同步修改的文档

**先做这一步。** 一篇没有随代码更新的文档比没有文档更糟：它让读者按错误的状态做决定。
下表列出「代码变更 → 必须同步修改的文档」，发布前逐项确认要么已改、要么确认本次不涉及。

| 本次改动了什么 | 必须同步修改的文档 |
|---|---|
| 任一能力的状态在 已实现 / 已部署 / 待验收 / 需配置 / 规划中 之间变化（新增、上线、开始验收、降级、暂缓） | [仓库根 README 能力矩阵](../../../README.md#能力矩阵)；若涉及已知限制，同时改[已知限制](../../../README.md#已知限制) |
| 启动参数、必需/可选环境变量、默认值、报错文案 | [apps/web/README.md](../README.md) 的「必需与可选的环境变量」与「故障排查」 |
| 隔离环境启动步骤、建号或成员管理命令 | [apps/web/README.md](../README.md) 的「隔离环境最小启动」「账号与成员」 |
| 测试命令、测试数量、哪些用例默认跳过、`--test-concurrency=1` 的要求 | [apps/web/README.md](../README.md) 的「测试」 |
| 发布包构建、`serverFiles` 数组、指纹校验、`verify-web-release.mjs` 行为 | [apps/web/README.md](../README.md) 的「构建与校验发布包」 |
| 发布、切换、回退步骤或「哪些历史包可回滚」 | [apps/web/README.md](../README.md) 的「发布、切换与回退」 |
| 备份产物、恢复顺序、密钥不可轮换性 | [apps/web/README.md](../README.md) 的「备份与恢复」 |
| 角色、capability 或请求→能力映射 | [工作区权限契约](workspace-access.md) |
| `/sync/v1` 路由、请求头、游标、冲突语义 | [增量同步契约](incremental-sync.md) |
| 第二因素流程、会话、恢复码、账户库 DDL | [账户安全契约](account-security.md) 与[运行时交付](account-security-takeover.md) |
| `/git/v1` 路由、判权、错误码、`LOG4STELLAR_GIT_WORKSPACE_ROOTS` 语义 | [Git 接入契约](git-integration.md) |
| 工作台挂载 URI、多账号/多工作区隔离、旧草稿恢复策略 | [工作区切换迁移](workspace-switch-migration.md) |
| 新增服务端模块 | `apps/web/build-web-release.mjs` 的 `serverFiles` 数组（不是文档，但同属「忘了就线上炸」的一类） |
| 新增 Web 端内置扩展 | `apps/web/web-release.mjs` 的 `webExtensionNames` 与 `build-web-release.mjs` 的 `extensions` |
| 新增第三方依赖 | [仓库根 README 的第三方许可证表](../../../README.md#第三方许可证) |

改完文档后必须跑链接检查，失败即非零退出：

```sh
node apps/web/tools/check-doc-links.mjs
```

## 1. 发布前

- [ ] 在**专用工作树**里构建（构建期会取两次源码指纹，工作树被并发改动即中止）。
- [ ] `export PATH=$HOME/.cache/log4stellar-toolchain/bin:$PATH`（node 24 + pnpm）。
- [ ] `export NODE_OPTIONS=--max-old-space-size=5120`。
- [ ] `node --test apps/web/*.test.mjs` 通过，记录 tests / pass / fail / skipped。
- [ ] 涉及数据库、对象存储或 Git 的改动，另跑一次串行集成测试：
      `LOG4STELLAR_IT=1 LOG4STELLAR_STORAGE_CONFIG=<副本> node --test --test-concurrency=1 apps/web/*.test.mjs`。
- [ ] 涉及第二因素绑定界面的改动，另跑 `LOG4STELLAR_BROWSER_IT=1 node --test apps/web/account-security.browser.test.mjs`。
- [ ] 文档检查通过（第 0 节最后一行）。
- [ ] 上一节的文档对照表已逐项确认。

## 2. 构建与自检

- [ ] `node apps/web/build-web-release.mjs <新的空目录> [vscode-loc 副本]`，目标目录必须不存在。
- [ ] 记录输出里的 `Web release ready:` 与 `Source: <commit> (<fingerprint>)`。
- [ ] `node <release>/server/verify-web-release.mjs <release>` 通过（登录页、未认证 401、敏感路径
      404、语言包、扩展关联）。
- [ ] 检查 `release.json`：`nodeMajor` 与部署机一致、`source.commit` 是预期提交、`fingerprint` 与
      构建输出一致。

## 3. 隔离冒烟

- [ ] 用临时账户库、临时笔记目录、自签证书在**非生产端口**起包内服务。
- [ ] `/login` 返回 200；未认证 `/static/mount/`、`/sync/v1/snapshot`、`/git/v1/repository` 返回 401。
- [ ] 用临时账号登录，确认工作台能挂载、能保存、能看到版本历史。
- [ ] 涉及账户安全的发布，确认第二因素表单出现且能完成绑定与恢复登录。
- [ ] 涉及 Git 的发布，在配置了 `LOG4STELLAR_GIT_WORKSPACE_ROOTS` 的隔离实例上确认仓库关联、
      status、log、fetch、push 与失败码（`422 WorkTreeDirty` / `409 NotFastForward` /
      `502 RemoteUnavailable`）。
- [ ] 冒烟结束后停掉进程并按 PID 结束，不要 `pkill -f serve-demo.mjs`（会杀掉自己的 shell）。

## 4. 切换

- [ ] 演练：`check-release-switch.sh <当前包> <新包>` 输出
      `Verified release files, ...` 与回退演练通过。
- [ ] 确认回滚目标可用：不早于跨租户越权修复；若账户已启用第二因素，回滚目标必须仍执行双因素门禁。
- [ ] 备份：账户库 + `secret` + `git-secret` + 数据库 dump（必要时对象存储侧快照）。
- [ ] `export XDG_RUNTIME_DIR=/run/user/1001`，然后 `activate-web-release.sh <新包>`（原子换软链 →
      重启 → 轮询健康检查 → 失败自动回滚）。
- [ ] 切换后确认 `/login` 200、登录成功、挂载与保存正常。

## 5. 发布后

- [ ] 更新[能力矩阵](../../../README.md#能力矩阵)中受影响行的状态，并注明验证方式。
- [ ] 更新交付索引里的「正式入口当前版本、源提交、回滚目标」。
- [ ] 记录本次回退步骤（回滚目标包名 + 一条命令），便于下一个人直接执行。
- [ ] 已知问题与未完成项写进交付说明，不要只留在会话记录里。

## 回退

```sh
export XDG_RUNTIME_DIR=/run/user/1001
activate-web-release.sh <上一个可用包>
```

回退只换应用代码，**不需要回退数据库**：所有迁移都是纯增量的（`CREATE TABLE IF NOT EXISTS` /
`ADD COLUMN IF NOT EXISTS`），旧版本代码能读新库。若确实还原了迁移前的账户库快照，备份之后的
安全设置变更会丢失，需明确接受该影响。
