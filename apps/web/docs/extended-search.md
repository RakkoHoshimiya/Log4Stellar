# 历史版本与附件正文搜索

在 Web 工作台按 F1，执行「Log4Stellar: 历史版本与附件搜索」。查询显示工作区路径、版本时间和正文片段。历史搜索每批最多扫描 32 项，附件和混合范围每批最多扫描 8 项。空结果页仍可继续扫描后续版本。回收站条目恢复后才重新进入搜索。原有工作台搜索继续覆盖当前笔记标题与正文。

搜索支持历史 Markdown 和纯文本，以及 DOCX、XLSX、PPTX 和带文本层的 PDF。单份附件最大 24 MiB，正文保留约 48 KiB，带文本层的 PDF 最多提取前 80 页。搜索有两个执行槽位和一个短等待队列，超出容量或等待时间后返回 429 和 Retry-After。失败的提取可以重试，同工作区同摘要的并发提取会复用结果。查询沿用工作区和版本读取权限，生成的正文片段留在进程内存。升级无需迁移数据库。

## 启用扫描 PDF 和旧版 Office

部署者可在已验证的 Ubuntu 主机配置以下运行环境。

| 变量 | 取值 |
| --- | --- |
| LOG4STELLAR_SEARCH_FORMAT_RUNNER | 指向发布包 server/search-format-sandbox.sh 的绝对路径 |
| LOG4STELLAR_SEARCH_OCI_IMAGE | 已预载的 OCI 基础镜像摘要，格式 sha256: 加 64 个小写十六进制字符 |
| LOG4STELLAR_SEARCH_OCI_SOCKET | 专用 rootless Podman 的 Docker 兼容 Unix socket |

沙箱挂载只读系统工具，要求主机安装 LibreOffice、Poppler、Tesseract 和 eng、chi_sim 语言包。运行容器禁网、只读根文件系统、限制 CPU、内存、进程和文件大小。每个原生格式任务最多运行约 14 秒。发布前用同一运行配置验证一次 DOC、XLS、PPT 和扫描 PDF，确保安装的语言包、容器镜像与 socket 可访问。

OCR 用于整份文档没有可索引文本的 PDF，只处理前三页。混合型 PDF 先使用文本层。旧版 DOC、XLS、PPT 转为 PDF 后提取前 40 页文字。格式错误、超时或损坏的附件计入跳过数。撤掉三个相关环境变量并重启即可停用额外格式，原有搜索仍可使用。
