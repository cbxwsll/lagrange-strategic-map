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

内测邀请开关默认关闭。需要邀请注册时在服务器 `.env` 设置：

```dotenv
BETA_INVITE_REQUIRED=true
```

设为 `false` 时两种注册流程均不要求邀请码。开关只接受小写 `true`/`false`；修改后执行 `pm2 restart lagrange-strategic-map --update-env` 生效。

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

`npm test` 使用独立临时数据库，不接触生产 `data/`。Node 大版本升级后，如 better-sqlite3 报 ABI 错误，在项目目录执行 `npm rebuild` 再重启。

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

## 5. 内测邀请码

首次启动或更新后重启会自动执行邀请表迁移。需要种码时，只在服务器项目目录执行：

```bash
cd /projects/lagrange-strategic-map
npm run invite -- add '在此填入邀请码' --name '绑定名' --uses 1
```

`--uses` 必须是非负整数：`1` 表示仅可成功注册一个账号，`0` 表示不限次数。每次成功注册都会增加 `used_count`，并在 `invite_uses` 记录使用账号。真实邀请码只写入服务器 SQLite，不要写入 `.env.example`、文档、Issue、提交信息或 Git 跟踪文件。

开启或关闭邀请注册后，无需改代码或重新种码：

```bash
pm2 restart lagrange-strategic-map --update-env
```

## 6. 数据与凭证

- SQLite：`data/lagrange.db` 及其 WAL 文件；备份时同时保留数据库与 WAL，或在低峰执行 SQLite 在线备份。
- `.env`：只存在服务器，权限 600，不提交、不打包进公开仓库。
- 用户密码、找回答案：数据库仅保存 bcrypt 哈希。
- 会话 token、客户端 token：数据库仅保存 SHA-256 哈希；客户端明文令牌仅签发时显示一次。
- 邮箱验证码：数据库仅保存带用途和邮箱域分离的 HMAC，默认 10 分钟有效、5 次尝试上限、60 秒重发间隔。
- 日志只记录方法、路径、状态码和耗时，不记录请求体、Authorization、Cookie 或 SMTP 内容。
