# 空库租户与工作区

托管模式使用 PostgreSQL 存账号、会话、租户、工作区权限和文件元数据。RustFS 对象按 `tenants/<tenant-id>/workspaces/<workspace-id>/sha256/<digest>` 存放。账户和工作区授权通过同一 PostgreSQL 数据库事务更新。

## 启动隔离验收

准备空 PostgreSQL 数据库、空 RustFS 桶和专用认证目录。存储配置使用现有的 `LOG4STELLAR_STORAGE_CONFIG` 结构。认证目录中的 `secret` 由部署方生成。配置 HTTPS 证书、`LOG4STELLAR_WEB_ORIGIN` 和 `LOG4STELLAR_DEMO_HOST=127.0.0.1`。首次由部署方运行：

```sh
node apps/web/create-managed-account.mjs "$PLATFORM_USERNAME" --bootstrap-platform < "$PLATFORM_PASSWORD_FILE"
node apps/web/create-managed-account.mjs "$ACCOUNT_USERNAME" < "$ACCOUNT_PASSWORD_FILE"
```

用 `LOG4STELLAR_MANAGED_TENANTS=1` 和 `LOG4STELLAR_STORAGE_BACKEND=rustfs` 启动隔离 Web 服务。无工作区的账户登录后进入租户管理页。有工作区的账户可从工作台命令或 `/account/tenants` 进入。平台账户在该页建租户并指定首次管理员。租户管理员创建工作区、发放邀请并配置成员权限。

## 权限与事务

平台管理员可以管理平台租户，租户管理员可以管理本租户工作区。读取笔记需要工作区角色。工作区创建时内含租户 ID 与首位 owner。幂等键允许创建请求重试。成员授权使用版本校验，撤销租户成员同步撤销其工作区授权，系统保护最后一位租户管理员和工作区 owner。

隔离端到端测试使用 PostgreSQL 和 RustFS 验证同名路径和对象前缀。复验数据库测试时对独立数据库运行 `LOG4STELLAR_MANAGED_IT=1 node --test apps/web/managed-workspaces.test.mjs`。

## 正式环境切换条件

正式部署使用独立 PostgreSQL 数据库、RustFS 桶和认证目录。先从空环境完成首个平台账号初始化，再用与服务相同的 `LOG4STELLAR_MANAGED_TENANTS=1` 配置运行发布检查。部署工具读取 PostgreSQL 的双因素账户数量，只有支持 PostgreSQL 认证的发布包可以在该配置下启用或回滚。

备份由 `backup-data.mjs` 根据 `LOG4STELLAR_MANAGED_TENANTS=1` 打包认证和存储元数据，并加密保存主密钥与被引用对象。恢复需要新的 PostgreSQL 数据库和独立 RustFS 桶。恢复程序在单事务内载入数据库快照，恢复对象后逐个读回核对摘要。

从托管模式退回迁移前的模式时，需要同时恢复原发布包和原服务配置，包括认证存储、账号目录及对象桶。该操作恢复原环境的视图。托管数据保留在专用库和桶中。托管模式内的版本回滚使用同一套环境配置与发布工具。
