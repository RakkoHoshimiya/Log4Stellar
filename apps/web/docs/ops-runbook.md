# Log4Stellar Web 运维手册

本文适用于运行 RustFS 或其他 S3 兼容存储加 PostgreSQL 的 Web 部署。命令里的地址、端口、路径和角色都是示例。先用独立账号库、数据库和对象桶预演，再用于正式环境。

## 首次部署

1. 按 [Web 服务端说明](../README.md) 安装锁定版本的 Node.js 和 pnpm，构建发布包，或取得已经通过校验的候选包。
2. 为服务准备独立的账号目录、TLS 证书和存储配置。把密钥及配置文件限制在服务用户可读范围。备份解密密钥单独保管。账号目录和私钥应在笔记工作区之外。
3. 导入现有文件时，显式给出工作区 ID 和拥有者。建号和导入方式见[服务端说明](../README.md)。首次验证使用测试账号和测试笔记。
4. 在服务管理器中注入部署配置。使用仓库的发布工具接管进程时，先确认目标端口由该工具管理或尚未占用。接管现有服务前记录旧进程的启动命令和回退入口。

## 发布与回退

在仓库根目录执行。示例假定服务已配置 `LOG4STELLAR_AUTH_DIR`、`LOG4STELLAR_TLS_CERT`、`LOG4STELLAR_TLS_KEY`、`LOG4STELLAR_STORAGE_CONFIG`、`LOG4STELLAR_WORKSPACE_ID` 和 `LOG4STELLAR_BACKUP_KEY_FILE`。用本部署可绑定且与 TLS 证书匹配的地址配置 `LOG4STELLAR_DEPLOY_HOST`，目标端口配置在 `LOG4STELLAR_PORT`。同一组参数用于切换、状态查询和回滚。

```bash
STATE_DIR="$HOME/.config/log4stellar"
RELEASES="$HOME/.local/share/log4stellar/releases"
BACKUP_ROOT="$HOME/.local/share/log4stellar/backups"
RELEASE_NAME=web-example-01
CANDIDATE=/path/to/candidate
deploy() {
  local command="$1"
  shift
  node apps/web/deploy-release.mjs "$command" "$@" \
    --state-dir "$STATE_DIR" --releases-root "$RELEASES" --backup-root "$BACKUP_ROOT"
}
deploy verify "$CANDIDATE"
deploy prepare "$CANDIDATE" --name "$RELEASE_NAME"
deploy activate "$RELEASES/$RELEASE_NAME"
deploy verify-installation --expect "$RELEASES/$RELEASE_NAME"
deploy status
deploy history
```

切换前确认有可读取的全量备份及可用回退包。切换后检查登录、笔记读取和随本次发布变更的操作。需要回退时记录原因并复验相同入口。

```bash
deploy rollback --reason "login or workspace smoke failed"
deploy status
```

回退目标必须能读取当前数据库并保持账户安全策略。常规发布回退保留数据。进程监管、开机拉起与双因素回退限制见[部署与回退](deploy-and-rollback.md)。

## 健康检查

| 路径 | 期望值 | 失败后的检查 |
| --- | --- | --- |
| `/login` | HTTPS 返回 200 | 监听端口、证书链、主机白名单和发布进程 |
| `/healthz` | 200 | 进程存活和 HTTP 响应 |
| `/readyz` | 获准的探针返回 200 | 503 时查看依赖分类，403 时核对探针来源和白名单 |
| `/metrics` | 获准的采集端返回指标 | 核对 `LOG4STELLAR_MONITOR_CLIENTS` 与采集配置 |
| `/static/mount/` | 匿名访问返回 401 | 核对认证网关，随后用测试账号打开一篇已知笔记 |

以 `requestId` 关联请求与结构化日志。依赖探针、采集与告警规则见[运行监控](monitoring.md)。配置告警后需要实测触发、送达和恢复。

## 备份与恢复演练

```bash
# 使用一个新的目录。密钥和连接配置由运行环境提供。
node apps/web/backup-data.mjs "$BACKUP_ROOT/backup-$(date -u +%Y%m%dT%H%M%SZ)" --scope=full --state-dir="$STATE_DIR/backup-state"
node apps/web/backup-schedule.mjs status --state-dir="$STATE_DIR/backup-state"
```

选择 [备份调度器](backup-restore.md) 的 `run-once` 配合定时器，或由服务管理器托管 `daemon`。监控最近成功时间，并把加密备份同步到独立位置。文件对象读取遇到 403 时先核对备份身份对对象前缀的读取权限。仅元数据快照无法恢复丢失的文件内容。

在独立实例验收恢复时，使用新的目标目录、数据库和对象桶。先运行恢复工具导出已验证的账号库、SQL 和对象，再按[备份恢复手册](backup-restore.md)导入独立数据库。记录恢复时长，验证账号登录、原文件和历史版本的字节及抽样的回收站恢复。保留演练结果与实际恢复目标，避免把恢复配置误用于正式存储。

## 常见故障

- 登录可用但文件树加载失败。检查测试账号的工作区归属和权限，再检查 PostgreSQL、对象存储与连接池。
- Office 文件打不开。先确认预览开关与转换进程，再检查预览请求是否返回有效 PDF。接口正常时检查浏览器的 Webview、证书和预览资源加载。资源上限与转换前提见[服务端说明](../README.md)。
- 磁盘空间紧张。先查看[容量与保留](capacity.md)中的试运行清单，逐项核对活跃包、回退包、备份与对象引用，再启用清理。
