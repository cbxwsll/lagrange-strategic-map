# 拉格朗日战略地图服务端

无尽的拉格朗日玩家游戏外实时战略地图。服务器负责网站账号、游戏身份、地图与权限、数据存储和 WebSocket 推送；本地客户端负责游戏数据采集与轨迹运算。

本仓库已实现设计文档 v1.0 的第一波服务器端范围（§3–§6、§10–§11）和第二波网页 UI（§4.1、§6.1、§6.2、§9），采用 Node.js 20+、Express、SQLite（better-sqlite3）、`ws` 与无构建步骤的原生 HTML/JS/CSS，许可证为 GPL-3.0-only。

## 已实现

- 邮箱验证码注册、密码/验证码登录、自定义问题找回；密码和找回答案使用 bcrypt 哈希。
- 可运行时切换的全站内测门槛：页面、API 与 WebSocket 统一校验 7 天签名 cookie；停用码立即失效，注册不再单独要求邀请码。
- 网站账号会话、成员通行会话、验证码状态、限流计数、地图、权限、申请和快照全部落 SQLite，不把地图数据驻留内存。
- 游戏内 ID 作为唯一身份基准，游戏名仅用于显示与重名候选查询；加入地图不绑定网站账号。
- 创建向导按准备→部署客户端→地图信息→完成执行；创建者大号角色名由用户手填，星系和联合体只接受客户端上报值。唯一同名自动绑定角色 ID，重名必须消歧，无匹配会警告但允许只保存角色名继续。
- 客户端 `dataAccount` 持久标记为 observer，只作数据来源，不进入名册、成员、创建者或权限候选，也不能加入地图或持有成员会话。
- 创建者、T 权限、盟主、小队队长、管理员子集权限；T/管理员权限转移与盟主任免队长。
- 无账号访客凭游戏名和加入密码申请，重名时必须选择候选游戏内 ID；当前 T 权限持有者与盟主双签，任一方同意即加入。
- 审批通过后，申请人凭独立回执领取绑定地图+游戏身份的 7 天 HttpOnly 成员通行 cookie，可访问对应地图 API 和 WebSocket。
- 本地客户端 HTTP 批量上报、token 哈希认证、批次幂等、星体/舰队/共享度快照、roster、维护与换星系处理。
- 地图恢复、roster 移出与跨图自动加入、数据号离盟下线和创建者手动恢复。
- 地图合并申请与目标创建者审批、历史版本档案馆。
- WebSocket Cookie 认证、地图订阅/退订和心跳骨架；业务推送事件尚未启用。
- 原生静态页面：地图列表与加入、邮箱注册/登录/找回、四步创建向导、账号设置。
- 地图页：建筑名搜索、特征筛选、共享度提示、舰队三态、创建者管理入口、档案馆和 WS 状态。
- 最新快照只读接口 `GET /maps/:id/display`，从 SQLite 读取真实建筑、舰队和共享度数据，并按当前成员身份返回关系与颜色：自己白色、同小队青色、同联合体蓝色；色值集中在 `src/lib/viewer-colors.js`。
- §11 权限状态机 8 项单测，以及密码边界、端到端集成、静态页面和运行时地址测试。

## 明确不在本波范围

- 本地客户端抓包、扫码登录、协议模拟和轨迹运算（设计文档 §12 真机验证项）。
- WebSocket 具体业务推送消息；地图页已接 WS 骨架和只读快照，等待后续业务事件。

## 目录

```text
src/
  index.js                 服务入口与优雅退出
  app.js                   Express 装配
  config.js                环境变量与生产配置检查
  db/
    index.js               SQLite 连接和迁移执行器
    migrations/001_initial.sql
    migrations/002_invites.sql
    migrations/003_beta_gate.sql
    migrations/004_guest_members_and_auto_wizard.sql
    migrations/005_observer_and_viewer_colors.sql
  invite.js                 内测通行码命令行管理入口
  lib/                     认证、权限、地图、roster、安全等领域逻辑
  routes/                  auth / maps / display / join / permissions / client
  ws.js                    WebSocket 骨架
public/                   原生 HTML/JS/CSS 页面，无构建步骤
test/                     权限单测、集成测试、WebSocket 与 UI 测试
```

## 本地运行

要求 Node.js 20 或更高版本。

```bash
npm install
cp .env.example .env
# 填写 CODE_HMAC_SECRET 与 SMTP 配置；本地生产模式同样会检查
npm test
npm start
```

开发测试不需要真实 SMTP：测试使用注入的内存邮件捕获器，不会把验证码写入数据库或日志。正常运行必须配置 SMTP，服务不会在响应或日志中返回验证码。

默认监听 `127.0.0.1:9200`，健康检查：

```bash
curl http://127.0.0.1:9200/healthz
```

数据库默认位于 `data/lagrange.db`，首次启动自动执行迁移。WAL 模式产生的 `-shm`/`-wal` 文件均被 `.gitignore` 排除。

## 全站内测门槛

`.env` 中 `BETA_INVITE_REQUIRED=true` 时，没有有效通行 cookie 的访客访问任何页面、API 或 WebSocket 都会被拦截；仅健康检查、进站接口、输码页及其必要静态资源放行。`false` 或缺省时全站免码。修改环境变量后执行 `pm2 restart lagrange-strategic-map --update-env` 即可切换。

管理员在服务器手动种码：

```bash
npm run invite -- add '在此填入通行码' --name '绑定名'
```

`invites` 保存 `code`、`bound_name`、`active`、`used_count` 和 `created_at`。正确通行码会换来由 `CODE_HMAC_SECRET` 签名、有效期 7 天的 HttpOnly cookie，并进入原目标页面；欢迎提示使用邀请码的 `bound_name`，不是注册用户名。每次成功进站仅增加审计计数，不存在次数上限，注册流程也不消耗次数。将对应记录改为 `active=0` 即可吊销，已有 cookie 会立即无法通过新的页面、API、WebSocket 连接或消息校验。真实通行码只写入服务器 SQLite，不进入 Git。

## API 前缀

所有 REST API 位于 `/api/v1`。经 Caddy 对外暴露时前缀为 `/project/lagrange/api/v1`。

网站认证支持 `Authorization: Bearer <session-token>` 和 HttpOnly Cookie。无账号成员使用独立的 `lagrange_member` Cookie，绑定单个地图与游戏身份，不等同于网站账号或内测通行 Cookie。客户端上报使用独立的 `Authorization: Bearer <client-token>`，三种 token 不混用。WebSocket 只接受网站会话或成员会话 Cookie，不把 token 放进 URL 查询参数；内测门槛开启时还必须同时携带有效通行 cookie。

### 账号

| 方法与路径 | 用途 |
|---|---|
| `GET /beta/enter` | 读取全站内测门槛开关状态 |
| `POST /beta/enter` | 校验通行码并签发 7 天通行 cookie |
| `POST /auth/email-codes` | 发送 register/login/recovery 验证码 |
| `POST /auth/register` | 注册；`intent=create` 进入创建向导，`join` 进入地图列表 |
| `POST /auth/login` | 邮箱+密码登录 |
| `POST /auth/login/email` | 邮箱+验证码登录 |
| `POST /auth/logout`、`GET /auth/me` | 退出、当前账号 |
| `GET /auth/session` | 页面初始化读取会话；游客返回 `user=null` |
| `PUT /auth/recovery/question` | 设置自定义找回问题 |
| `GET /auth/recovery/question/mine` | 当前账号读取自己的找回问题，未设置返回 `question=null` |
| `GET /auth/recovery/question?email=` | 找回流程按邮箱读取找回问题 |
| `POST /auth/recovery/reset` | 验证答案、重置密码并注销全部会话 |

密码规则：至少 8 个字符、bcrypt 输入不超过 72 字节、无空白，字母/数字/特殊符号任意两类。Unicode 字母（含中文）按字母类处理。

### 地图与加入

| 方法与路径 | 用途 |
|---|---|
| `GET /maps/wizard-prep` | step1 准备文案 |
| `POST /maps` | step2 创建空草稿；返回 mapId |
| `GET /maps` | 地图列表，自己的地图置顶 |
| `GET /maps/:id/wizard` | 客户端在线、首批数据、非 observer 玩家候选与默认地图名 |
| `POST /maps/:id/client-tokens` | step2 签发客户端令牌，仅显示一次 |
| `DELETE /maps/:id/client-tokens/:tokenId` | 撤销客户端令牌 |
| `GET /maps/:id/creator-candidates?gameName=` | 按手填大号名检索当前 roster 候选，返回角色 ID、联合体、小队等区分信息 |
| `POST /maps/:id/wizard` | step3 保存大号角色名及可确定的角色 ID，并设置地图名、审核开关和加入密码 |
| `POST /maps/:id/activate` | step4 首批数据与地图信息齐全后激活 |
| `GET /maps/:id/display` | 最新快照；支持 search、featureKey、featureValue 查询 |
| `POST /maps/:id/join-requests` | 无需网站账号；游戏名+加入密码申请，重名时附候选游戏内 ID |
| `POST /maps/:id/join-requests/:requestId/session` | 申请人凭回执查询状态；通过后签发成员通行 cookie |
| `GET /maps/:id/game-identities?gameName=` | 重名游戏 ID 候选 |
| `GET /maps/:id/join-requests/inbox` | 当前 T 权限持有者/盟主审批箱 |
| `POST /maps/:id/join-requests/:requestId/review` | 审批，角色为 `t` 或 `leader` |
| `POST /maps/:id/join-requests/:requestId/cancel` | 申请人取消 |
| `GET /maps/join-requests/mine` | 我的申请 |

加入申请返回一次性展示的高熵回执，服务端只存其 SHA-256 哈希。页面将回执保存在当前标签页的 `sessionStorage` 中并轮询状态；审批接口不会给审批人签发申请人 cookie。成员 membership 以 `map_id + game_identity_id` 为准，`user_id` 可为空。成员 cookie 默认 7 天过期，可用 `MEMBER_SESSION_TTL_DAYS` 调整，不能用于其他地图。

### 权限与生命周期

| 方法与路径 | 用途 |
|---|---|
| `GET /maps/:id/permissions` | 我的角色及可用管理员权限常量 |
| `POST /maps/:id/permissions/grant` | 管理员子集授予 |
| `POST /maps/:id/permissions/transfer-t` | 当前持有者转移 T 权限；创建者不变 |
| `POST /maps/:id/permissions/transfer-admin` | 转移管理员权限集合 |
| `POST /maps/:id/captains` | 盟主任命队长并指定 teamId |
| `DELETE /maps/:id/captains/:userId` | 盟主删除队长权限 |
| `POST /maps/:id/roster/check` | 按当前 roster 移出成员并跨图自动加入 |
| `POST /maps/:id/restore` | 新星系恢复，模式 same/different_organization |
| `POST /maps/:id/resume-access` | 数据号回盟后由创建者手动恢复访问 |
| `GET /maps/:id/archives`、`DELETE .../:archiveId` | 档案馆查看/删除 |
| `GET /maps/:id/merge-requests` | 查看发出/收到的合并申请 |
| `POST /maps/:id/merge-requests` | 源地图创建者向目标地图申请合并 |
| `POST /maps/:id/merge-requests/:requestId/review` | 目标地图创建者审批 |

合并批准后，目标地图保留自身创建者与角色体系；源地图成员及管理员子集复制到目标地图，源地图创建者/T/盟主/队长身份不覆盖目标角色。源地图当前版本进入档案馆、客户端令牌撤销，源地图标记 `merged` 并指向目标地图。

### 客户端上报

`POST /api/v1/client/report`，JSON 上限 2 MB。`protocolVersion` 当前固定为 `weiyang-3.0`，对应设计文档的“未央开拓 3.0”。

```json
{
  "batchId": "client-generated-unique-id",
  "protocolVersion": "weiyang-3.0",
  "dataAccount": { "gameId": "data-id", "gameName": "数据小号" },
  "galaxy": { "id": "galaxy-id", "name": "星系名" },
  "organization": { "id": "org-id", "name": "联合体名" },
  "serverStatus": "online",
  "roster": [
    { "gameId": "data-id", "gameName": "数据小号", "isLeader": false, "teamId": "team-1" }
  ],
  "snapshots": [
    {
      "observedAt": "2026-11-07T10:00:00.000Z",
      "gameTime": "optional-game-clock",
      "bodies": [
        { "key": "body-1", "name": "建筑名", "type": "base", "x": 1, "y": 2, "z": 0, "features": {} }
      ],
      "fleets": [
        { "key": "fleet-1", "ownerGameId": "player-id", "state": "real", "x": 3, "y": 4, "z": 0, "vx": 0, "vy": 1, "vz": 0, "payload": {} }
      ],
      "sharing": { "current": 10, "target": 100, "effect": "效果", "visitsEquivalent": 9 }
    }
  ]
}
```

- `roster` 可省略；一旦提供，按该版本完整名单替换。`dataAccount` 及其他 observer 不写入 `map_roster`，但原始 roster 中是否包含当前数据号会单独保存，用于离盟下线与回盟恢复判断。
- 建筑关系着色从 `features.ownerGameId`、`features.ownerId` 或 `features.playerGameId` 读取所有人；舰队使用 `ownerGameId`。服务端按当前网站账号 membership 绑定的游戏身份或成员 cookie 计算 `relation` 和 `color`。
- `serverStatus`：`online`、`maintenance`、`expedition_ended`。
- 舰队 `state`：`real`、`estimated`、`invalid`，对应真实/推算/判错。
- 新批次返回 202；相同 mapId+batchId 且内容完全一致返回 200 且 `duplicate=true`；同 ID 不同内容返回 409。
- 新星系先写待恢复版本并保留旧版本；只有创建者调用恢复接口后才切换公开当前版本。

### WebSocket

- 直连：`ws://127.0.0.1:9200/ws`
- 域名：`wss://skylin.xin/project/lagrange/ws`
- 连接后收到 `ready`；发送 `{ "type": "subscribe", "mapId": "..." }` 订阅，`unsubscribe` 退订。
- 非订阅消息当前返回 `BUSINESS_EVENTS_NOT_ENABLED`，不伪装成已实现业务推送。

## 验证

```bash
npm test
```

当前共 47 项测试，覆盖：§11 权限 8/8、密码边界 8/8、注册登录找回、内测门槛、004/005 旧库迁移、手填大号唯一匹配、重名强制消歧、无匹配警告但允许继续、observer 名册/成员/权限/会话隔离、同一快照双查看者关系着色、无账号双签审批、成员 cookie 的地图/display/WebSocket 访问与跨图拒绝、换星系恢复、静态页面和真实快照筛选。测试数据库位于系统临时目录，每项测试后删除。另以 iPhone 仿真执行创建到免注册加入的完整浏览器流程。

部署见 [DEPLOYMENT.md](DEPLOYMENT.md)。
