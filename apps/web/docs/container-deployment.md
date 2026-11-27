# Docker 与 Podman 部署

两个 OCI 镜像共用同一份 Web 发布包和托管数据模型。当前构建入口面向 Linux amd64。

| 镜像目标 | 容器内服务 | 所需挂载 |
| --- | --- | --- |
| web | Web、Office／OCR 工具 | /data、只读存储配置、可选 HTTPS 与首次管理员文件 |
| standalone | Web、PostgreSQL 18、RustFS、Office／OCR 工具 | /data、可选 HTTPS 和首次管理员文件 |

## 构建

先根据[仓库 README](../../../README.md)构建并验证 Web 发布包。使用仓库 .nvmrc 指定的 Linux Node.js，且与发布包构建架构一致。在仓库根目录运行以下命令。也可以把命令开头的 docker 换成 podman。

```sh
bash apps/web/container/build.sh docker "$RELEASE_DIR" web log4stellar:web
bash apps/web/container/build.sh docker "$RELEASE_DIR" standalone log4stellar:standalone
```

构建把已验证的发布包和运行时装进镜像。PostgreSQL 与 RustFS 的基础镜像摘要固定在 Dockerfile。构建使用 Debian 软件源的签名索引，部署方可用 LOG4STELLAR_DEBIAN_MIRROR 指定可访问的镜像站。

## 使用已有 PostgreSQL 和 RustFS

准备独立的空数据库及拥有建表和迁移权限的应用角色。准备对象桶和只允许访问本应用前缀的 S3 凭据。容器需能访问提供的端点。容器中的 127.0.0.1 指向容器本身。连接信息写入只对操作者可读的 JSON 文件。

```json
{
  "postgres": {
    "host": "db.example.test",
    "port": 5432,
    "database": "log4stellar",
    "user": "log4stellar_app",
    "password": "<database-password>"
  },
  "s3": {
    "endpoint": "https://storage.example.test",
    "region": "us-east-1",
    "bucket": "log4stellar",
    "accessKeyId": "<application-key-id>",
    "secretAccessKey": "<application-secret>"
  }
}
```

示例用环回地址对外发布 8443。用正式域名提供服务时，调整发布地址和 LOG4STELLAR_WEB_ORIGIN，并挂载该域名对应的证书和私钥。

```sh
mkdir -p ./web-data
docker run -d --name log4stellar-web --stop-timeout 60 --restart unless-stopped \
  -p 127.0.0.1:8443:8443 \
  -v "$PWD/web-data:/data" \
  -v "$STORAGE_CONFIG:/run/secrets/log4stellar-storage.json:ro" \
  -v "$ADMIN_PASSWORD_FILE:/run/secrets/platform-password:ro" \
  -e LOG4STELLAR_ADMIN_PASSWORD_FILE=/run/secrets/platform-password \
  -e LOG4STELLAR_WEB_ORIGIN=https://127.0.0.1:8443 \
  log4stellar:web
```

Web 检查应用 PostgreSQL 角色和对象桶，应用迁移并按需初始化平台管理员。连接配置、TLS 和初始化密码使用只读挂载。数据库和对象桶由部署方准备与管理。

## 单容器启动

新建专用数据目录和权限为 0600 的密码文件，写入至少 8 位的独立管理员密码。默认管理员用户名为 admin，可通过 LOG4STELLAR_ADMIN_USERNAME 指定。第一次运行完成后，后续重建可省去密码挂载和对应环境变量。

```sh
mkdir -p ./log4stellar-data
docker run -d --name log4stellar --stop-timeout 60 --restart unless-stopped \
  -p 127.0.0.1:8443:8443 \
  -v "$PWD/log4stellar-data:/data" \
  -v "$ADMIN_PASSWORD_FILE:/run/secrets/platform-password:ro" \
  -e LOG4STELLAR_ADMIN_PASSWORD_FILE=/run/secrets/platform-password \
  -e LOG4STELLAR_WEB_ORIGIN=https://127.0.0.1:8443 \
  log4stellar:standalone
```

使用 rootless Podman 时，把 docker 替换成 podman，并保证宿主目录由执行 podman 的用户创建。在启用了 SELinux 的系统，给专用的绑定挂载加 :Z 或 :ro,Z。开机自启可交给宿主的 Podman Quadlet 或 systemd。镜像内的 PostgreSQL 和 RustFS 仅监听容器环回接口，宿主仅发布 Web 端口。

首次自签证书写入数据目录 config/tls；浏览器要信任证书。正式证书可通过 LOG4STELLAR_TLS_CERT 和 LOG4STELLAR_TLS_KEY 指定挂载路径。私有 CA 可通过 LOG4STELLAR_HEALTH_CA 提供给容器健康检查。通过可信的 Webview 域名部署时，按[Web 服务端说明](../README.md#必需与可选的环境变量)设定 LOG4STELLAR_WEBVIEW_HOST。

## 初始化与升级

- 启动进程对 /data 持有独占锁。实例凭据先原子写入，再初始化 PostgreSQL 和配置 RustFS。首次应用角色和库若已创建，会核对并复用。RustFS 独立生成管理凭据与应用凭据，应用角色仅有租户对象的读写权限。Web 启动前校验应用连接。
- /data/postgres 保存 PostgreSQL 数据，/data/rustfs 保存对象，/data/config 保存系统初始化状态，/data/web 保存认证和应用秘密，/data/backups 保存备份。/data/cache 是可重建的缓存。宿主目录和密钥文件需限制访问。初始化调整专用数据目录与其服务子目录的权限和所有权。Docker 默认使用容器 UID 18021–18023。rootless Podman 会映射到宿主的子 UID。
- 同主版本升级先备份，再停止进程、换镜像并挂载原目录。初始化程序拒绝不匹配的 PostgreSQL 主版本和部署模式。同模式完整回退可在停机后恢复整个 /data 的一致快照，保留原有权限、所有权、密钥和证书。跨模式迁移先在独立空数据库和对象桶走通[备份恢复](backup-restore.md)，再决定切换。
- 镜像默认尝试启用 Office／OCR，转换依赖 Linux Landlock ABI 3、seccomp 和可用的转换程序。启动前验证沙箱可以建立。兼容性受限的运行环境可以明确设 LOG4STELLAR_CONTAINER_CONVERSION=0。转换子进程无网络访问，并限制文件访问、时间和内存。运行无需宿主容器引擎 socket。
- 使用 docker logs 或 podman logs 查询启动阶段。核心服务退出时，容器退出并由宿主重启。存活与就绪检查见[部署与回退](deploy-and-rollback.md)。

## 容器内加密备份

单容器镜像带相同主版本的 pg_dump。以下命令由 Web 用户执行，目标目录须尚不存在。

```sh
docker exec --user 18023:18023 log4stellar env \
  TMPDIR=/data/cache \
  LOG4STELLAR_MANAGED_TENANTS=1 \
  LOG4STELLAR_STORAGE_CONFIG=/data/web/storage.json \
  LOG4STELLAR_AUTH_DIR=/data/web/auth \
  node /opt/log4stellar/release/server/backup-data.mjs \
  "/data/backups/backup-$(date -u +%Y%m%dT%H%M%SZ)" --scope=full --key-file=/data/web/backup.key
```

加密产物和解密密钥分开保存。通过新的数据库和桶做恢复演练。仅复制运行中的数据目录可能得到不一致快照。Web 独立镜像连接外部服务，逻辑备份在安装了兼容 pg_dump 的独立运维环境运行，或由外部数据库和对象存储的备份机制负责。

## 本地验收

构建单容器镜像后，在有 Node.js 24、curl 和 OpenSSL 的 Linux 主机使用空闲端口运行冒烟测试。脚本只使用临时卷和随机测试口令。它验证首次登录、版本保存、同一目录互斥、初始化中断后的重跑、容器重建、历史读取和加密备份。

    bash apps/web/container/smoke-standalone.sh podman log4stellar:standalone 19482
