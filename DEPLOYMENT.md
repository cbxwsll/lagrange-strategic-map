# 部署说明（47.94.46.2 / pm2 / Caddy）

本服务按内存敏感环境设计：单进程、SQLite WAL 落盘、pm2 `max_memory_restart=250M`。不要把 SQLite 文件放在仓库外再另建一套未经说明的数据路径；默认使用项目内 `data/`，该目录不会进入 Git。

## 1. 部署前检查

```bash
node -v                         # 需要 >=20
ss -tlnp | grep ':9200 '        # 必须无输出才继续使用暂定端口
pm2 list
free -m
```

若 9200 已占用，不要强行杀现有进程；先由项目负责人确认新端口，再同步修改 `.env`、pm2 配置和 Caddy 反代目标。低内存机器执行原生依赖安装前必须确认已有 swap。

## 2. 拉取与安装

建议部署到 `/projects/lagrange-strategic-map`：

```bash
cd /projects
git clone https://github.com/cbxwsll/lagrange-strategic-map.git
cd lagrange-strategic-map
npm install --omit=dev --no-audit --no-fund
cp .env.example .env
chmod 600 .env
mkdir -p data
```

编辑 `.env`：填写 `CODE_HMAC_SECRET`、SMTP_HOST、SMTP_USER、SMTP_PASS、SMTP_FROM。`CODE_HMAC_SECRET` 可用 `openssl rand -base64 48` 在本机生成，生成后只写入服务器 `.env`。

生产启动会检查密钥长度和 SMTP 必填项，缺失时拒绝启动，不会退化为控制台打印验证码。`.env` 按脚本所在目录读取，不依赖 pm2 启动时的当前目录。

全站内测门槛默认关闭。需要访客输码进站时在服务器 `.env` 设置：

```dotenv
BETA_INVITE_REQUIRED=true
```

设为 `false` 时全站免码。开关只接受小写 `true`/`false`；修改后执行 `pm2 restart lagrange-strategic-map --update-env` 生效。

## 3. pm2 启动

```bash
pm2 start ecosystem.config.cjs
pm2 save
curl --fail http://127.0.0.1:9200/healthz
```

预期健康响应包含 `"ok":true`。后续更新：

```bash
cd /projects/lagrange-strategic-map
cp -a data "data.backup.$(date +%Y%m%d%H%M%S)"
git pull --ff-only
npm install --no-audit --no-fund
npm test
npm prune --omit=dev --no-audit --no-fund
pm2 restart lagrange-strategic-map --update-env
curl --fail http://127.0.0.1:9200/healthz
```

`npm test` 使用独立临时数据库，不接触生产 `data/`。本波 `004_guest_members_and_auto_wizard.sql` 会重建 maps、memberships 和 join_requests 以允许无账号游戏身份成员，并新增 member_sessions；执行前必须按上方命令备份 data，启动后会自动做外键一致性检查。Node 大版本升级后，如 better-sqlite3 报 ABI 错误，在项目目录执行 `npm rebuild` 再重启。

## 4. Caddy 路径分发

在现有 skylin.xin 站点块的顶层加入以下规则，不要嵌套进其他项目的 `handle`/`handle_path`：

```caddy
@lagrange_noslash path /project/lagrange
redir @lagrange_noslash /project/lagrange/ 308

handle_path /project/lagrange/* {
    reverse_proxy 127.0.0.1:9200
}
```

`handle_path` 会剥离前缀，因此应用内部路径保持 `/api/v1/...`、`/ws`、`/healthz`。Caddy `reverse_proxy` 会处理 WebSocket Upgrade，不需要额外 ws 端口，也不要在浏览器使用 `ws://`。

应用并检查：

```bash
caddy validate --config /root/Caddyfile
pm2 restart caddy
curl --fail http://127.0.0.1:2019/config/ | grep -c '9200'
curl --fail https://skylin.xin/project/lagrange/healthz
```

浏览器 WebSocket 地址：

```text
wss://skylin.xin/project/lagrange/ws
```

9200 只绑定 `127.0.0.1`，无需为它在阿里云安全组或 ufw 开公网入站规则。

## 5. 全站内测通行码

首次启动或更新后重启会自动执行门槛表迁移。需要种码时，只在服务器项目目录执行：

```bash
cd /projects/lagrange-strategic-map
npm run invite -- add '在此填入通行码' --name '绑定名'
```

进站接口为 `POST /api/v1/beta/enter`。验证成功后签发 7 天 HttpOnly、SameSite=Lax cookie；生产配置下同时为 Secure。页面无 cookie 时 302 到输码页，API 返回 401 `BETA_REQUIRED`，WebSocket Upgrade 拒绝连接。每次成功进站都会把 `used_count` 加一，仅用于审计，不限制进站次数，也不与注册账号绑定。

需要吊销时，在服务器 SQLite 中把对应码改为 `active=0`。已有 cookie 会立即无法通过新的页面、API、WebSocket 连接或消息校验。真实通行码只写入服务器 SQLite，不要写入 `.env.example`、文档、Issue、提交信息或 Git 跟踪文件。

开启或关闭全站门槛后，无需改代码或重新种码：

```bash
pm2 restart lagrange-strategic-map --update-env
```

## 6. 数据与凭证

- SQLite：`data/lagrange.db` 及其 WAL 文件；备份时同时保留数据库与 WAL，或在低峰执行 SQLite 在线备份。
- `.env`：只存在服务器，权限 600，不提交、不打包进公开仓库。
- 用户密码、找回答案：数据库仅保存 bcrypt 哈希。
- 网站会话 token、成员通行 token、客户端 token、加入申请回执：数据库仅保存 SHA-256 哈希；明文只在签发时返回。成员 cookie 默认 7 天有效，以 `MEMBER_SESSION_TTL_DAYS` 配置，并绑定地图和游戏身份。
- 邮箱验证码：数据库仅保存带用途和邮箱域分离的 HMAC，默认 10 分钟有效、5 次尝试上限、60 秒重发间隔。
- 日志只记录方法、路径、状态码和耗时，不记录请求体、Authorization、Cookie 或 SMTP 内容。
