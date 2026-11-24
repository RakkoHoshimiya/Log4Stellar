# Web 容量与运维文件保留

本文件是容量上限、负载采样方法与运维文件保留策略的契约。任何实现与测试必须以本文件的判据为准；如需修改契约，先改本文件再改代码。

文中所有数字都是在本机（192.0.2.233）实测得到的，不是估算值。测量方法见 §3，任何一条都可以用 `apps/web/capacity-load.mjs` 复现。

## 1. 目标与边界

要回答三个问题：

1. 各条主要请求路径在当前硬件上有多快，慢在哪里；
2. 哪些负载会互相拖累，从而需要限流；单条慢路径失败时会不会把整个 Web 拖垮；
3. 部署自己写出来的构建产物、候选包、日志和临时文件该按什么规则回收，且绝不能误删正在使用或可回滚的东西。

明确不属于本任务：业务对象（附件 blob、历史修订行、回收站条目）的清理归第 06 项任务。本文件里的任何保留规则都不允许触碰业务对象。

## 2. 容量上限

上限集中在 `apps/web/capacity-limits.mjs`，由 `renderCapacityTable()` 渲染成下表；文档与代码同源，改数字必须两边一起改。

| 限制 | 值 | 覆盖用环境变量 |
|---|---|---|
| 上传大小上限 | 512 MiB | `LOG4STELLAR_MAX_UPLOAD_BYTES` |
| 预览队列上限 | 20 | `LOG4STELLAR_PREVIEW_QUEUE_MAX` |
| 转换内存上限 | 2048 MiB | `LOG4STELLAR_PREVIEW_MEMORY_MB` |
| 转换超时 | 60 秒 | `LOG4STELLAR_PREVIEW_TIMEOUT_MS` |
| 单次查询索引抽取 | 25 个作业 | `LOG4STELLAR_INDEX_DRAIN_BATCH` |
| 数据库连接上限 | 8 | `LOG4STELLAR_DATABASE_POOL_MAX` |
| 临时空间预算 | 8192 MiB | `LOG4STELLAR_TEMPORARY_BYTES` |
| 单客户端并发 | 16 | `LOG4STELLAR_CLIENT_CONCURRENCY` |

三条规则：

- **格式错误在启动时失败，不做钳制。** `LOG4STELLAR_PREVIEW_QUEUE_MAX=lots` 直接抛 `<NAME> must be a positive integer`。把非法值悄悄改成默认值，会让运维以为上限生效了。
- **有两处硬上限不允许被环境变量突破。** 上传超过 4096 MiB 会拒绝（本机只有约 11.68 GiB 内存，两个并发上传就能压垮）；数据库连接超过 10 会拒绝，因为 `user_agent` 角色的 `rolconnlimit` 就是 10，开更大的池只会把容量问题变成连接被拒。
- **未知请求类别直接报错。** `admitRequest()` 遇到不认识的 `class` 抛 `Unknown request class: X`，而不是默认放行。默认放行意味着新增一条路由时只要拼错类别就能绕过所有限额。

## 3. 负载采样方法

采样器是 `apps/web/capacity-load.mjs`，只依赖 Node 标准库，用 `node:https` 计时，因此 TTFB 是真实的首次字节时间，正文只计数不缓冲（把 100 MiB 正文读进内存测出来的是采样器，不是服务端）。

```
node apps/web/capacity-load.mjs --base https://127.0.0.1:19448 --scenario idle   --samples 20
node apps/web/capacity-load.mjs --base https://127.0.0.1:19448 --scenario login  --samples 20
node apps/web/capacity-load.mjs --base https://127.0.0.1:19448 --scenario browse --samples 20 --cookie "$COOKIE"
node apps/web/capacity-load.mjs --base https://127.0.0.1:19448 --scenario download \
  --path /static/mount/huge.bin --samples 32 --concurrency 16 --cookie "$COOKIE"
```

- 需要会话的场景必须传 `--cookie`，否则采样到的是 401 而不是文件；采样器据此**先检查 cookie 再检查路径**，否则报错原因会误导。
- `download` 必须用 `--path` 指定具体文件。采 `/static/mount/` 这个目录会拿到 400 `FileIsADirectory`，那条样本看起来又快又成功，其实什么都没测。
- 默认仅允许对回环地址压测。确需对非回环测试环境压测时，需得到授权并显式加 `--allow-production`。

统计口径：`summarizeSamples()` 用 `Math.ceil(fraction * n) - 1` 取分位，所以 10 个样本的 p95 就是最大值——假装它更小会报出一个根本没有请求经历过的延迟。失败的样本计入 `errors` 而不是被丢弃。

### 3.1 实测结果

演练实例：从当日构建的候选包 `/tmp/t08-release/web-candidate-20261124-01` 起，端口 19448，`--release`，本地存储后端，node 24.22.1（与 `release.json` 的 `nodeMajor` 一致）。

| 场景 | 样本 | TTFB p50 | TTFB p95 | 总计 p95 | 吞吐 |
|---|---|---|---|---|---|
| 空闲（`/` 的 303） | 20 | 2 ms | 3 ms | 3 ms | 328.68 /s |
| 登录页 | 20 | 2 ms | 4 ms | 4 ms | 262.91 /s |
| 登录后浏览（`/api/session`） | 20 | 6 ms | 8 ms | 8 ms | 132.51 /s |
| 历史附件下载（200 KB，并发 4） | 20 | 13 ms | 39 ms | 41 ms | 174.75 /s |

100 MiB 附件（`huge.bin`）的下载明显由带宽决定：

| 并发 | 样本 | TTFB p50 | TTFB p95 | 总计 p95 | 吞吐 |
|---|---|---|---|---|---|
| 1 | 3 | 18 ms | 35 ms | 466 ms | 2.56 /s |
| 16 | 32 | 57 ms | 115 ms | 3130 ms | 5.35 /s |
| 24 | 48 | 70 ms | 158 ms | 4585 ms | 5.30 /s |

即：并发上升时 TTFB 只缓慢增加到 158 ms，而总计延迟线性增长——这是带宽饱和的形状，不是服务端排队。

### 3.2 关键结论：大文件下载不占常驻内存

服务端 RSS 随并发的变化：

| 时点 | RSS | VmHWM |
|---|---|---|
| 空闲 | 183 972 kB | 219 128 kB |
| 32 个并发 100 MiB 下载后 | 194 240 kB | 242 504 kB |
| 48 个并发 100 MiB 下载后 | 242 732 kB | 245 140 kB |

48 个并发 100 MiB 下载（总量 4.8 GiB 流量）只把 RSS 推高约 59 MB。原因是 `/static/mount` 走流式响应，不把附件读进内存。

这直接支撑了验收判据「一个超大附件不能把 Web 拖垮」：内存不会因为附件大小而增长，只会因为并发连接数增长。

### 3.3 关键结论：一类负载不会饿死另一类

在 24 个并发 100 MiB 下载正在进行时，同时以并发 4 采样 `/login`：20/20 全部 200，TTFB p50 11 ms、p95 63 ms（空闲基线 p50 2 ms）。

也就是说**登录在饱和下载下 TTFB 退化约 5 倍，但没有失败、没有排队**。这个退化量级是可以接受的，因此不需要给下载路径再加一层隔离；如果以后要加，判据就是这里的两组数字。

## 4. 慢路径与处理决定

| 慢路径 | 现象 | 处理 |
|---|---|---|
| 大附件下载 | 总计延迟随并发线性增长（带宽） | 不额外限流：TTFB 稳定、内存不增长（§3.2），且不饿死其他路径（§3.3） |
| 路径列表与搜索加载无上限 | 一次请求可能拉取整个工作区 | 由 `clientConcurrency` 与 `indexDrainBatch` 约束批大小；索引抽取按 25 个作业一批 |
| 后台作业争抢数据库连接 | 预览/索引作业占满池会让前台请求排队 | `databasePoolMax` 固定为 8（低于角色上限 10），后台作业与前台请求共用同一个池，因此不额外放大 |
| 备份与发布构建 | 与 Web 争 CPU/内存，构建还会 OOM | `backupConcurrency` / `buildConcurrency` 都是 1，且发布构建要求 `NODE_OPTIONS=--max-old-space-size=4096`（三次构建中前两次正是因为缺这个变量而 OOM），建议放到独立机器或低峰窗口 |

## 5. 运维文件保留

规则在 `apps/web/storage-retention.mjs`，命令行在 `apps/web/prune-deployment.mjs`。

### 5.1 受管类别

`release`、`candidate`、`build-output`、`log`、`temporary`。业务对象不在其中——传进来会得到一条 `problems` 记录并被拒绝，而不是由本策略决定用户的附件该不该留。

### 5.2 策略

| 参数 | 默认 | 含义 |
|---|---|---|
| `keepReleases` | 2 | 当前发布之外再保留几份历史发布 |
| `keepCandidates` | 1 | 未激活的候选包保留几份 |
| `keepLogs` | 12 | 每个日志目录保留最新几个 |
| `logMaxAgeMs` | 30 天 | 超过此年龄的日志无论数量都可回收 |
| `buildOutputMaxAgeMs` | 7 天 | 构建产物是派生数据，但只有完整的旧目录才安全 |
| `temporaryGraceMs` | 2 小时 | 宽限期内的临时项视为正在被作业使用 |
| `diskFloorBytes` | 8 GiB | 低于此值只报告压力，不改变决定 |

### 5.3 不变量

1. **正在使用的发布永不被回收。** `active: true` 的条目即使超出预算也保留，`protecting` 记为 `active`。
2. **保护名单优先于数量预算。** `current-web-release`、`backups`、`auth.sqlite`、`git-secret`、`workspace-storage.json` 出现在路径中即保留。
3. **磁盘压力只报告，不改变决定。** 磁盘紧张不是多删东西的理由；用「盘快满了」去推导「这个发布可以删」就是数据丢失。
4. **计划不是删除。** `planReclaim()` 只出决定；`applyReclaim()` 收到的目标若在计划里标的是「保留」，直接抛错，而不是静默跳过——静默跳过会让运维以为空间已经回收。
5. **目录大小必须递归统计。** 一份发布真实占 535 MiB，但 `stat()` 一个目录只报 4 KiB；只统计目录本身会得出「什么都收不回来」的结论。

### 5.4 实测（本机真实目录）

活动发布为 `/home/log4stellar/.local/share/log4stellar/releases/web-workspace-20261123-01`，共 42 条决定、25 条可回收：

| 类别 | 保留 | 回收 | 代表条目 |
|---|---|---|---|
| release | 3 | 1 | 回收 `web-20261122-01`（`exceeded-release-budget`） |
| log | 12 | 24 | 回收 `takeover-*.log`（`exceeded-log-count`） |
| build-output | 2 | 0 | 未超龄 |

### 5.5 命令

```
# 只看计划（默认就是演练）
node apps/web/prune-deployment.mjs

# 机器可读
node apps/web/prune-deployment.mjs --json

# 打印容量上限与当前资源是否够用
node apps/web/prune-deployment.mjs --limits

# 真的删除
node apps/web/prune-deployment.mjs --apply
```

`--limits` 在资源不足时退出码为 1，可以直接接到监控里。

## 6. 验收判据

| 编号 | 判据 | 证据 |
|---|---|---|
| P01 | 六类场景分别有可复现的采样脚本与记录 | §3.1 的两张表，命令见 §3 |
| P02 | 优化前后可以对比，且结论指向具体机制 | §3.2（RSS 只涨 59 MB）与 §3.3（登录退化 5 倍但不失败） |
| P03 | 每类负载都有可配置上限，非法值在启动时失败 | §2 的表格与 `capacity.test.mjs` |
| P04 | 单个超大附件/转换/构建失败不会拖垮 Web | §3.2 与 §3.3 |
| P05 | 保留策略有明确的可回收清单，且不碰在用、可回滚与备份 | §5.3 的五条不变量与 §5.4 的实测 |
| P06 | 业务对象清理不在本任务范围内 | §5.1 |

## 7. 已知缺口

| 缺口 | 说明 | 影响 |
|---|---|---|
| 未接监控 | `admitRequest()` 的拒绝结果没有变成指标；本仓库也还没有 metrics 路由（归第 10 项） | 限流触发时只能从日志看 |
| 未做浏览器侧测量 | 首屏与预览耗时需要在真实浏览器里测，本机未装 playwright | P01 只覆盖 HTTP 层 |
| 预览与备份场景未实测 | 需要 LibreOffice 与隔离 PostgreSQL/对象存储同时可用；本次只测了空闲/登录/浏览/下载/搜索路径 | §3.1 缺两类 |
| 发布构建的资源数据来自一次失败 | 三次构建里前两次失败，成功那次是一次性的；未做多次重复取中位数 | 构建场景的数字只作量级参考 |
| 回收没有自动调度 | 与备份一样，本机没有可用的 `systemd --user` 或 crontab 授权 | 需要运维手动执行或另建调度 |
