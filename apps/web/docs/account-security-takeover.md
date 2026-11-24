# 账户安全运行时交付

## 分支与提交范围

分支为 `takeover/task4-account-security`，从外包接线提交
`4de1edb36cf` 继续。使用 `git log --oneline 4de1edb36cf..takeover/task4-account-security` 查看接手提交。

- 实际 Better Auth 和 SQLite 账户库已覆盖密码、TOTP、一次性恢复码、修改密码、设备列表、标签和撤销。
- 绑定由当前密码发起，首个 TOTP 码确认后生效。验证码时间步、恢复码与登录挑战只消费一次。
- 浏览器双因素表单支持两种码，失败时保留表单，成功后进入工作台。
- 恢复码更换和解绑要求当前密码与有效第二因素。解绑在同一数据库事务内撤销其他会话，并重新签发当前会话。

## 可复现测试

在服务器的独立工作树运行，要求仓库锁定的 Node.js 和 pnpm：

```sh
pnpm --dir apps/web --ignore-workspace install --frozen-lockfile --ignore-scripts --prefer-offline
node --test apps/web/account-security.integration.test.mjs
node --test apps/web/*.test.mjs
```

集成测试创建临时 SQLite 账户库、独立签名密钥和虚拟工作区；
无需连接正式笔记、PostgreSQL 或 RustFS。时钟按 TOTP 时间步确定推进。
重点验证半认证态请求、验证码重放、并行恢复码、浏览器表单、设备标签和会话撤销。

## 迁移与回滚

服务启动时创建 Better Auth 第二因素字段及附加表，现有账户默认保留原登录方式。
发布前在隔离副本验证迁移，并一起备份 `auth.sqlite` 和签名密钥。
生产账户启用双因素后，应用回滚必须选择仍能执行双因素门禁的发行包。
更早版本只能用于隔离演练。恢复到迁移前的账户快照会丢失备份之后的安全设置变更，
应在明确接受影响后执行。保留数据库新增表供重新升级使用。

## 验收入口

本分支提供浏览器的 `/login` 双因素页和
`/api/account-security` 下的账户管理接口。详细 JSON 契约见 [账户安全契约](./account-security.md)。
从工作台左下角原生账户菜单选择「账户安全…」，或在登录后访问
`/account/security`。设置页在新标签页打开，支持四种现有界面语言。
绑定时二维码由服务端在本地生成。二维码与恢复码使用无缓存响应，
不调用外部二维码服务。设置页提供手动密钥供无法扫码时使用。

全流程浏览器验收需要从根仓库安装 Playwright 和 Chromium，然后运行：

```sh
LOG4STELLAR_BROWSER_IT=1 node --test apps/web/account-security.browser.test.mjs
```

浏览器测试使用临时 HTTPS、独立 SQLite、测试账号和隔离页面。
覆盖修改密码、两设备会话管理、显示二维码、确认绑定、恢复登录、
更换备份码和关闭双因素。正式 Web 未切换。
二维码使用 MIT 许可的 `qrcode-generator@2.0.4`，版本由 Web lockfile 固定。
