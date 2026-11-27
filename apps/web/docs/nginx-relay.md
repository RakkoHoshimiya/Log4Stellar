# Nginx 与 SSH 公网中转

浏览器只访问 Log4Stellar 对外的 HTTPS 工作台。登录、权限校验、文件读取和预览由 Web 后端处理。PostgreSQL 存文件元数据和版本，RustFS 存原件。只要 Web 后端能访问配置的 RustFS，浏览器就可以通过 Web 读取文件，RustFS API 和管理端口继续留在内网。

    浏览器 → 云端 Nginx / OpenResty → SSH 反向隧道 → 内网 Nginx → Log4Stellar Web
                                                                   ├── PostgreSQL
                                                                   └── RustFS / NAS

Word、Excel、PowerPoint 的预览由后端读取原件并转换成 PDF。PDF 原件直接走受鉴权的工作区文件接口，再由工作台的 PDF.js 渲染。中转只发布 Log4Stellar，接入同一 NAS 上的其他服务需要独立配置。

## 域名、端口和证书

1. 主域名示例为 notes.example.net，Webview 域名后缀为 preview.notes.example.net。主域名和 *.preview.notes.example.net 的 DNS 指向云主机，证书覆盖这两类名称。
2. 示例公开 TCP 5443，内网 Nginx 监听环回 19443，云端 SSH 隧道只监听环回 15443。云端安全组对客户端开放 5443，另允许内网主机访问云端 SSH。数据库、对象存储、内网 Web 端口和云端隧道端口均无须放开。
3. 内网 Nginx 持有公网证书和私钥，云端按 TCP 原样转发。内网 Nginx 到 Log4Stellar 另走 HTTPS。配置 origin-ca.crt 信任后端证书的签发方，并使 proxy_ssl_name 匹配后端证书的 SAN。
4. Log4Stellar 以公网 URL 接收请求，把下面两个值加入 Web 服务环境。反代原样保留 Host 和端口，网关继续核对 Origin、登录状态和工作区权限。

       LOG4STELLAR_WEB_ORIGIN=https://notes.example.net:5443
       LOG4STELLAR_WEBVIEW_HOST=preview.notes.example.net

同时保留 LAN 原生入口时，可用同一版本的独立 Web 进程承接公网 Origin。共享部署的数据连接和账号签名配置按运维文档管理。若使用容器，容器 Web 的 8443 只发布到内网宿主机环回，再由内网 Nginx 接入。

### 公网裸 IP 验收

直接用 IP 测试时，TLS 证书的 SAN 必须包含该 IP，同时受测试设备信任。将公网 Origin 与 Nginx 的 Host 检查设为相同 IP 和端口，并让 IP 虚拟主机成为该监听的 default_server，以接收不带 SNI 的握手。Webview 仍需要独立的可达域名和证书。使用内网 Webview 域名的验收属于具备内网访问的客户端场景。纯外网预览请使用前面的公网主域名和通配 Webview DNS。

## 配置中转

示例文件位于 [apps/web/deploy/nginx](../deploy/nginx/)。

1. 在云主机为隧道创建专用的非交互 SSH 账号，装入专用公钥和 [sshd 限制样例](../deploy/nginx/relay-sshd.conf.example)。先运行 sshd -t，再平滑重载。确认该账号只能建立指定的远端环回端口，普通管理员登录应另用自己的账号。
2. 把 [云端 Stream 配置](../deploy/nginx/edge-stream.conf.example) 放进云端 Nginx 的 stream 上下文，把 [内网 HTTP 配置](../deploy/nginx/lan-http.conf.example) 放进内网 Nginx 的 http 上下文。分别运行 nginx -t，再重载。若 Nginx 的 Stream 模块以动态模块发布，按发行版方式启用它。
3. 在内网服务器保存权限为 0600 的专用私钥，独立核对云主机 SSH 指纹并记录到文件。把 [SSH 隧道用户服务](../deploy/nginx/log4stellar-relay.service.example) 装入 systemd 用户目录并启用。修改 SSH 服务端口时，把 -p 和端口加入 ExecStart 的 SSH 参数。
4. 检查 SSH 用户服务自动重连，在云主机确认 15443 只监听 127.0.0.1。公网和内网 Nginx 的配置检查命令均应退出成功。

内网代理只为工作台与扩展静态资源开启 gzip，并启用 HTTP/2。已登录首页提前加载工作台主模块，在大脚本下载期间显示加载提示。监控路由只从内网验收。遇到上传超时，核对 Nginx 和应用的大小限制、上传分块大小以及隧道超时。

## 公网验收与故障定位

- 用公网浏览器打开主站，确认登录页正常。未登录访问 /static/mount/、/api/session 和 /api/v1/office-previews 应返回 401。
- 使用能访问验收工作区的账号登录，依次验证文件树、Markdown、Word、PowerPoint、PDF 和大附件上传。浏览器的 Network 中，文件内容请求指向 Log4Stellar HTTPS 入口。
- 使用无内网路由的客户端检查独立 Webview 子域。如果安装使用 IP 验收配置，先确认该客户端能解析并连接配置的 Webview 域。
- 如果登录后长时间加载，在 Network 中先看工作台 JS 的状态、传输大小和 Content-Encoding。此前未压缩资产较大，一次下载结束前工作台无法呈现。
- 如果文件返回 5xx，从内网 Web 服务器验证对象存储地址、服务凭据和目标桶权限。若预览子域在 TLS 阶段关闭，先查 DNS、证书 SAN、SNI 与中转端口。若 Word 可预览而 PDF 原件进入二进制文本提示，核对浏览器是否加载了带 PDF 自定义编辑器的新发布包。
- 回退中转时先撤下云端 Stream 配置并重载，随后停止专用 SSH 隧道服务。Web 发布包回退见 [部署与回退](deploy-and-rollback.md)。
