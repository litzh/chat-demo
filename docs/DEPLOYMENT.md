# Cloudflare 部署指南

部署形态是 Pages + Pages Functions（Workers 运行时）+ D1 + 私有 R2。生产由 Cloudflare Access 邮箱验证码保护，浏览器继续直连 DeepSeek，服务端不需要 DeepSeek Key。

## 配置文件与鉴权

`wrangler.example.jsonc` 是公开模板。复制为 `wrangler.jsonc` 后修改真实值；后者已被 Git 忽略。已有配置时不要覆盖。Pages 只支持项目根目录的标准配置文件名，不支持用 `--config` 指向其他文件，因此脚本统一读取 `wrangler.jsonc`。不要把真实值写回公开模板。

| 配置                 | 用途                                                                |
| -------------------- | ------------------------------------------------------------------- |
| `name`               | Pages 项目名称                                                      |
| `d1_databases`       | 绑定名必须为 `DB`，填写实际数据库名称、ID 和迁移目录                |
| `r2_buckets`         | 绑定名必须为 `FILES`，填写私有存储桶名称                            |
| `AUTH_MODE`          | 生产固定为 `access`                                                 |
| `APP_ORIGIN`         | 正式 HTTPS origin，不带结尾斜杠，如 `https://chat.example.com`      |
| `ACCESS_TEAM_DOMAIN` | Zero Trust 团队域名，如 `your-team.cloudflareaccess.com`            |
| `ACCESS_AUD`         | 当前 Access 应用的 Audience，不是账户 ID，也不是其他应用的 Audience |
| `ACCESS_EMAIL`       | 唯一允许访问的邮箱，需要与 Access 策略匹配                          |

生产没有密码回退。Worker 验证 JWT 签名、issuer、audience、有效期、应用类型、邮箱及请求域名。公钥从团队的 `/cdn-cgi/access/certs` 获取并缓存，支持轮换。参考 [Cloudflare JWT 校验文档](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)。

本地开发使用 `.dev.vars`：显式设置 `AUTH_MODE=password`，并用 `pnpm password` 生成 `ADMIN_PASSWORD_HASH`。`.dev.vars` 不上传到生产。

## AI 部署流程

以下流程适用于已经得到部署授权的代理。读取资源和检查配置可以自动完成；缺少邮箱、域名或账户选择时再询问。不要反复索取已经给出的授权，也不要把部署授权理解为可以清空历史数据、覆盖其他服务或升级付费套餐。

### 1. 确认工具和认证

```sh
cf --version
cf auth whoami
pnpm exec wrangler --version
pnpm exec wrangler whoami
```

复用现有登录。需要登录时使用工具公开的登录流程；CI 可通过受保护的环境变量提供 Cloudflare API Token 和账户 ID。禁止把 Token 放进仓库、命令行明文、构建输出或日志，也不要依赖 CLI 内部模块、解密私有凭据文件或硬编码本机路径。

`cf` 与 Wrangler 是不同工具，不能假定它们共享登录。当前 `cf` 的 API 命令可以管理资源，但本仓库本地 Functions 上传使用 Wrangler。不要执行 `cf deploy dist` 来替代 Pages Functions 发布。

### 2. 发现命令，再读取现有资源

CLI 会变化，先查当前安装版本，避免猜测参数：

```sh
cf cli search "list Pages projects"
cf cli search "list D1 databases"
cf cli search "list R2 buckets"
cf cli search "list DNS records"
cf cli search "list Access applications and identity providers"
```

对命中的命令执行 `--help`；请求体不明确时，把命令前缀 `cf` 替换成 `cf schema`。搜索词只描述动作与资源，不带个人信息。真实域名、邮箱和 ID 仅用于实际配置命令，不放进搜索服务。

确认以下对应关系：

- Cloudflare 账户与目标域名属于预期账户。
- 已有 Pages 项目的 D1/R2 绑定是否就是本应用的数据。
- 目标子域名是否已指向其他服务；发现冲突先停止覆盖。
- 是否已有仅允许目标邮箱的 Access 策略和 One-time PIN 身份提供者。

已有资源优先复用。不要因为修改了 Git remote 就认为 Cloudflare Pages 已经关联或授权了该 Git 仓库。

### 3. 创建必要资源与本地配置

缺少资源时，通过同样的 `cf cli search` → `--help` / `cf schema` 流程创建 Pages 项目、D1 与 R2。存储桶保持私有，不创建公开下载域名。

```sh
cp wrangler.example.jsonc wrangler.jsonc
```

将实际项目名、数据库 ID、存储桶名填进本地配置。JSON 请求体优先通过结构化工具参数或 Node `execFile` 参数数组传给 CLI，不拼接未经转义的 shell 字符串。不要把 `--body @file` 当作通用能力，只有命令帮助明确支持时才使用。

不要使用 `d1 execute` 清库来“初始化”；数据库结构由 `migrations/` 中的增量迁移维护。资源新建和迁移都不应删除已有聊天。

### 4. 自定义域名和 Access

添加 Pages 自定义域名，再配置代理 CNAME 指向实际分配的 `pages.dev` 地址。Pages 子域名可能与项目名不同，必须读取返回值。

以下命令形式在当前 CLI 中已验证，执行前仍应查看当前帮助：

```sh
cf pages domains list --project-name PROJECT_NAME
cf pages domains create PROJECT_NAME --name chat.example.com
cf dns records list --zone example.com --name chat.example.com
cf zero-trust organization get
cf zero-trust identity-providers list
cf zero-trust access applications list
```

等待域名验证和证书变为 Active，再创建或复用只覆盖该子域名的自托管 Access 应用：

- Allow 策略只包含目标邮箱，不使用 Everyone 或整个邮箱域名。
- 只启用 One-time PIN。已有的单邮箱策略可复用；不要扩大其他应用正在共享的策略。
- 设置合理的会话时长，例如 24 小时，并启用 HttpOnly Cookie。
- 把团队域名、应用 Audience、允许邮箱和正式 origin 写入本地配置。

域名短暂处于 Pending 时先查看状态，不要立即改动安全规则。如验证长期失败，检查 DNS、证书及验证路径，参考 [Pages 域名验证排查](https://developers.cloudflare.com/pages/configuration/debugging-pages/)。若 Access 拦截了真实证书验证请求，只处理必要的验证路径，不能放开聊天 API。

### 5. 检查、迁移和发布

```sh
node scripts/cloud.mjs check
pnpm type
pnpm lint
pnpm test
pnpm db:remote
pnpm deploy
```

脚本拒绝将公开占位符、HTTP 正式地址或密码模式用于生产。`pnpm deploy` 内部先执行构建，然后运行带实际配置的 `wrangler pages deploy`。生产分支默认 `main`；只有明确需要其他分支时才设置 `DSH_DEPLOY_BRANCH`。

本仓库默认走 CLI Direct Upload，GitHub Actions 只负责检查。若另行选择 Pages Git 集成，需要使用已授权关联的 Git 集成项目，并处理 CI 中的真实配置注入；本地被忽略的 `wrangler.jsonc` 不会自动出现在构建环境。不能只推送 Git 就假定当前 Direct Upload 项目会自动更新，也不能直接用公开模板完成生产部署。

### 6. 验收与收尾

```sh
pnpm smoke:cloud https://chat.example.com https://actual-project.pages.dev
```

这个脚本不需要登录凭据，只检查匿名页面/API 被 Access 拦截、旧域名跳转和旧密码入口关闭，不写入测试聊天。

随后由用户完成邮箱验证码登录，代理可以在已登录页面验证：

1. `/api/auth` 返回 `authenticated: true`、`mode: access`，不再要求应用密码。
2. 会话数量和设置可读取；抽查正文、分支和附件，HEAD 大小与原件一致。
3. 同一对话第二端只读，接管后旧端不能写入。
4. DeepSeek 请求由浏览器直接发送；不要打印或导出其 Authorization 头。
5. 原 `pages.dev` 和预览地址无法绕过 Access 读取数据。

不要自动读取用户邮箱验证码，也不要用删除用户聊天来验收。如果需要测试写入，只创建明确的临时记录并仅清理这些 ID。

从旧密码方案迁移时，在 Access 登录验证成功后移除生产 `ADMIN_PASSWORD_HASH`，撤销旧 `auth_sessions`，保留聊天、设置和附件。切换域名后 Key 需要在各设备重新填写；这是浏览器 origin 隔离，不是同步故障。

## 运维与数据边界

- `sessions` 保存元数据、版本、租约和导入指纹；`session_chunks` 保存分片 JSON；`settings` 保存非秘密设置；`session_files` 记录附件引用。
- R2 原件只能通过已认证的 `/api/files/*` 访问，响应为 `private, no-store`。不存在公开 R2 URL 或任意 URL 代理。
- 删除会话不会立即删除 R2 原件。清理未引用对象前先备份，并确认没有本地恢复副本需要它们。
- 会话 JSON 单次保存上限 32 MiB；导入批次另外限制条目和查询数。过大的单个会话需要拆分，不能靠提高并发解决。
- 应用附件大小上限为文档 100 MiB、图片 64 MiB、普通文件 32 MiB，同时受 DeepSeek、Cloudflare 账户与浏览器内存限制。
- 邮箱登录会话由 Access 管理；应用内退出登录转到 `/cdn-cgi/access/logout`。紧急撤销请在 Cloudflare Access 中处理该用户会话。
- 手机录音需要 HTTPS；PWA 只缓存页面资源，不缓存账号 API 和附件。关闭旧页面后重开可启用等待中的 Service Worker 更新。

## 发布前脱敏

公开文件只保留示例域名、邮箱、零 UUID 或明确占位符。检查待提交文件，排除 `wrangler.jsonc`、`.dev.vars`、`deployment.local.*`、聊天 ZIP、D1 导出、R2 原件、日志、Cookie 与任何密钥。

```sh
git status --short
git diff --check
git check-ignore wrangler.jsonc .dev.vars
```

不要提交真实验收记录、账号详情或本机绝对路径。文档示例与测试固定值应明确使用虚构数据。
