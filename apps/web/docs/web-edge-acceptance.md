# Web 边界场景验收

## 运行条件

使用 Node.js 24、项目依赖、Chrome 和 LibreOffice。普通测试可以直接运行，带数据库的测试使用独立 PostgreSQL 和对象存储。给测试进程设置 `LOG4STELLAR_STORAGE_CONFIG`，值为测试存储配置文件。按 `.github/workflows/web.yml` 的集成任务准备存储配置和数据库，测试数据使用独立库和桶。

在两套新数据库中分别验证托管工作区初始化和账户安全。两个用例都会初始化平台管理员，复用一个数据库会触发 `PlatformAlreadyInitialized`。

## 版本与回收站

```sh
LOG4STELLAR_IT=1 node --test --test-concurrency=1 \
  apps/web/attachment-versions.test.mjs apps/web/workspace-files.test.mjs
```

- 两个写请求携带同一个 ETag。恰好一个创建新版本，另一请求返回 `412 FileChanged`，版本父链连续。独立复核用真实 PostgreSQL 和 RustFS 对同一个当前版本同时发起两次回滚。
- 删除笔记和含嵌套附件的目录。重新创建同名目录和附件后，批量恢复返回 409，已处理的笔记恢复被回退，两条回收站记录仍可用，现存附件内容保持原样。
- 使用保留两份恢复同名目录，再把恢复后的目录与笔记一并删除和恢复。按原路径读取笔记，按恢复路径读取嵌套附件，并检查附件字节和回收站记录。
- 直接读取历史二进制版本与区间响应，确认恢复后的内容与原始字节一致。

## 账户安全

用全新的环回 PostgreSQL 测试库 `managed_acceptance` 运行：

```sh
LOG4STELLAR_MANAGED_IT=1 LOG4STELLAR_BROWSER_IT=1 LOG4STELLAR_CHROME_CHANNEL=chrome \
  node --test apps/web/account-security.browser.test.mjs
```

通过 Chrome 走完密码修改、二维码与 TOTP 绑定、会话撤销、恢复码登录、重复恢复码拒绝、恢复码轮换和停用双因素。受限会话在第二因素通过前无法访问租户 API。验证两个会话同时提交相同 TOTP 时仅一个成功。

## Office 与界面

```sh
node --test apps/web/office-preview-{contract,files,service,ui,worker}.test.mjs
LOG4STELLAR_IT=1 node --test apps/web/office-preview.integration.test.mjs
```

文件需覆盖 DOCX 多页正文、XLSX 多工作表和 PPTX 多页幻灯片。预览按页可读，首尾标记可从 PDF 提取，转换前后的原件版本数相同。集成套件验证真实 LibreOffice、版本范围、超限拒绝、队列状态和失败处理。部署转换器还需用相同的容器包装器独立转换样本，核对禁用网络、只读根文件系统、进程数、CPU、内存、单文件上限和超时。

首屏回归使用独立工作区和正式同款的 TLS 与 Webview 主机配置。逐个单击含多页的 DOCX、XLSX、PPTX，确认 worker 资源请求成功、首屏画布实际出现且进度条消失。使用鼠标滚轮滚到最后一页并确认该页已绘制。打开损坏的 DOCX，确认显示错误、进度条结束且没有画布。单元用例另外模拟 worker 启动一直未完成，验证超时会终止加载并显示错误。

界面检查涵盖预览进度、取消、损坏文件提示，以及工作区切换和 Office 菜单四种语言。第三方扩展和低频菜单按实际使用范围继续抽样。

## 运维

真实 RustFS 删除和恢复要求显式设置 `LOG4STELLAR_GC_RUSTFS_IT=1`。数据库必须为环回地址上的 `managed_acceptance`，对象存储必须为环回地址上的专用 `l4s-gc-test-acceptance` 桶。

```sh
LOG4STELLAR_IT=1 LOG4STELLAR_GC_RUSTFS_IT=1 \
  node --test --test-concurrency=1 apps/web/blob-gc-integration.test.mjs
node --test apps/web/{backup-schedule,restore-backup,deploy-release,monitoring}.test.mjs
```

- 仅真实孤立对象进入删除。计划阶段对象仍能读取，执行后对象确实消失，恢复副本可按原字节写回，受保护对象保持可读且哈希一致。核对审计条数、删除字节数和执行状态。
- 托管模式用 `tenants/<tenantId>/workspaces/<workspaceId>/sha256/`。清理 CLI 从 PostgreSQL 读归属，`LOG4STELLAR_MANAGED_TENANTS=1` 时只列托管工作区。未登记的工作区和不属于目录映射的对象保持原样。租户前缀、旧路径和同摘要对象分别验证。
- 旧路径的观察记录不能授权托管对象删除。对象身份变化会重新计算宽限期。运行写入和清理的版本必须都支持 PostgreSQL 工作区锁，再考虑实际删除。现有部署保持自动清理关闭。
- 运维演练先执行 `node apps/web/blob-gc.mjs plan workspace:<id>` 和 `review workspace:<id>`。按已验证的恢复流程使用独立对象桶。只有显式设置删除开关和恢复目录后 `apply` 才能物理删除。
- 隔离环境验证回退和恢复。正式主机重启、正式回退需要维护窗口。异机备份与告警需要实际的外部存储和通知接收端。GitHub Actions 需要工作流启用与真实运行记录，保留验收产物还需配置上传步骤。
