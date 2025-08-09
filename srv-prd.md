# SoundPP 后端服务 PRD

## 1. 概述

### 1.1 目标
为 SoundPP 桌面应用提供两类在线能力：
- 云同步：用户登录后，跨设备同步音效库（元数据与素材），以服务器为准（Last-Write-Wins）。
- 音频超市：仅管理员上架的官方音效包浏览/搜索/预览/下载与一键导入。

### 1.2 范围（MVP）
- 鉴权：邮箱+密码、JWT（Access/Refresh）。
- 同步：获取/提交 manifest、增量传输素材、服务端版本控制、简单冲突处理（以云为准）。
- 资产：本机磁盘存储、哈希去重、Range 下载、Nginx 静态分发。
- 超市：列表、详情、下载计数；管理员上传/更新。
- 监控与备份：最小可用（健康检查、结构化日志、每日备份）。

### 1.3 非目标（本期不做）
- 用户投稿/互动（评分/评论/举报）。
- E2EE、复杂冲突合并 UI、第三方对象存储与 CDN（仅预留扩展）。
- 多租户/多区域部署。

### 1.4 约束
- 服务器：2C/2G/40G，新加坡；中国大陆用户为主，网络波动存在。
- 技术栈：Node.js LTS + Fastify + SQLite + Nginx；本地磁盘优先，尽量零额外云费。

---

## 2. 架构

### 2.1 拓扑
客户端(Electron) ⇄ Nginx(反代+静态) ⇄ Fastify(API) ⇄ SQLite(DB) + 本地FS(assets)

### 2.2 模块
- AuthService：注册/登录/令牌、角色与权限。
- SyncService：manifest 读写、版本控制、LWW 冲突处理。
- AssetService：哈希命名、去重、权限校验、Range 下载。
- MarketService：包/条目/标签查询、下载计数。
- AdminService：包与资产的上架/更新。
- Infra：日志、限流、配置、任务（可后续接入队列）。

### 2.3 目录
- /srv/soundpp/app（Node）
- /srv/soundpp/db/soundpp.sqlite（SQLite）
- /srv/soundpp/assets/{aa}/{hash}.{ext}（资产）
- /srv/soundpp/backup（备份）
- /srv/soundpp/logs（日志）
- /srv/soundpp/nginx（配置）

---

## 3. 数据模型（SQLite）

### 3.1 用户与会话
```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user', -- 'user'|'admin'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### 3.2 同步与资产
```sql
CREATE TABLE user_manifests (
  user_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1,
  data TEXT NOT NULL,            -- JSON: groups/audios/hotkeys/notes...
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE assets (
  content_hash TEXT PRIMARY KEY, -- sha256:xxx
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE user_assets (
  user_id TEXT NOT NULL,
  asset_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, asset_hash),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_hash) REFERENCES assets(content_hash) ON DELETE CASCADE
);
```

### 3.3 音频超市
```sql
CREATE TABLE market_packs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  author_name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0',
  tags TEXT,                     -- JSON array
  language TEXT DEFAULT 'zh-CN',
  license TEXT DEFAULT 'CC BY 4.0',
  cover_url TEXT,
  preview_url TEXT,
  download_count INTEGER NOT NULL DEFAULT 0,
  file_size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'published', -- 'draft'|'published'|'archived'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE market_pack_items (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  asset_hash TEXT NOT NULL,
  duration_ms INTEGER,
  order_index INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (pack_id) REFERENCES market_packs(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_hash) REFERENCES assets(content_hash)
);
```

---

## 4. API 设计（REST + JSON）

### 4.1 通用规范
- 认证：Authorization: Bearer <access_token>
- 分页：page, pageSize（默认 1, 20，上限 100）
- 错误：{ code, message, details? }；HTTP 状态与业务码对应
- 速率限制：匿名 10 req/s，认证用户 20 req/s；登录接口单 IP 5/min

### 4.2 鉴权
- POST /api/auth/register
  - body: { email, password }
  - 201 | 409
- POST /api/auth/login
  - body: { email, password }
  - 200: { accessToken, refreshToken, user: { id, email, role } }
- POST /api/auth/refresh
  - body: { refreshToken }
  - 200: { accessToken, refreshToken }
- POST /api/auth/logout
  - body: { refreshToken }
- GET /api/auth/me
  - 200: { id, email, role, createdAt }

约束：密码 ≥8 位，含字母数字；邮箱验证可后置。

### 4.3 同步
- GET /api/sync/manifest
  - 200: { revision, generatedAt, groups:[], audios:[], hotkeys:[] }
- PUT /api/sync/manifest
  - body: { baseRevision, data }
  - 200: { revision }（服务端版本+1，LWW 覆盖）
  - 409: 远端已更新（客户端应先 GET 更新后再 PUT）
- GET /api/sync/assets/:hash
  - 302/200：经服务端鉴权后返回 X-Accel-Redirect 到 /assets 路径（Nginx 内部取文件）
- 说明：素材上传仅管理员；普通用户仅下载。

### 4.4 音频超市（只读）
- GET /api/market/packs?query=&tag=&page=&pageSize=
  - 200: { items: [{id,title,authorName,tags,coverUrl,version,downloadCount}], total }
- GET /api/market/packs/:id
  - 200: { id,title,description,tags,items:[{displayName,assetHash,durationMs}], previewUrl, license }
- GET /api/market/packs/:id/download
  - 200: { files: [{ assetHash, url }], manifest: {...} }
- POST /api/market/packs/:id/download-count
  - 204

### 4.5 管理员
- POST /api/admin/assets/upload (multipart)
  - fields: file, filename, contentType
  - 201: { assetHash, url }
- POST /api/admin/packs
  - body: { title, description?, authorName, version?, tags?, language?, license?, coverUrl?, previewUrl?, items:[{displayName, assetHash, durationMs?}] }
  - 201: { id }
- PUT /api/admin/packs/:id
- DELETE /api/admin/packs/:id
- GET /api/admin/users?page=&pageSize=

---

## 5. 业务规则

### 5.1 Manifest
- 服务端维护每用户一份 manifest（JSON），字段包含 groups/audios/hotkeys/notes 等。
- LWW：PUT 时若 baseRevision < serverRevision，返回 409；客户端需先拉取覆盖后再提交。
- 服务器负责递增 revision，并写入 updated_at。

### 5.2 资产
- 命名：sha256 内容哈希；路径 /assets/{hash[:2]}/{hash}.{ext}
- 去重：同 hash 不重复写盘；记录 filename/contentType/size。
- 限制：单文件 ≤ 50MB（MVP），允许类型：audio/mpeg, audio/wav, audio/ogg, audio/aac。
- 下载：Nginx 静态，支持 Range/缓存；Node 层鉴权后通过 X-Accel-Redirect 暴露。

### 5.3 超市
- 状态：draft/published/archived；客户端仅见 published。
- 版本：语义化 version；覆盖式更新（MVP 不做差分）。
- 计数：下载成功后异步+1（失败不计）。

---

## 6. 非功能性

### 6.1 性能
- API P95 < 200ms；支持 100 并发连接。
- 静态资源走 Nginx 零拷贝；开启 sendfile、tcp_nopush、gzip（按需）。

### 6.2 可靠性
- 备份：每日 SQLite .backup，保留 14 天；资产 rsync 可选夜间执行。
- 监控：/health 返回 { ok, db, diskUsage }；PM2 守护自恢复。

### 6.3 安全
- HTTPS（Let’s Encrypt）。
- 密码 argon2/bcrypt + 唯一盐；JWT（Access 15m，Refresh 7d，旋转刷新）。
- 限流：登录 5/min/IP；通用 10~20 req/s。
- 日志脱敏：不记录密码/令牌；错误日志带 requestId。

---

## 7. 运维

### 7.1 Nginx 片段
```nginx
server {
  listen 443 ssl http2;
  server_name example.com;

  ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

  # API
  location /api/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }

  # 静态资产（内部重定向）
  location /assets/ {
    internal;
    alias /srv/soundpp/assets/;
    add_header Cache-Control "public, max-age=31536000, immutable";
    add_header Accept-Ranges bytes;
  }

  sendfile on;
  tcp_nopush on;
  gzip on;
  gzip_types audio/mpeg application/json text/plain application/javascript text/css;
}
```

### 7.2 备份脚本（示例）
```bash
#!/usr/bin/env bash
set -euo pipefail
TS=$(date +%Y%m%d-%H%M%S)
BK=/srv/soundpp/backup
DB=/srv/soundpp/db/soundpp.sqlite
mkdir -p "$BK"
sqlite3 "$DB" ".backup '$BK/soundpp-$TS.sqlite'"
find "$BK" -name 'soundpp-*.sqlite' -mtime +14 -delete
```

### 7.3 资源与清理
- 日志按天轮转，保留 7~14 天。
- 资产目录定期清理“孤儿文件”（不在 assets 表）与未引用的草稿包资源。

---

## 8. 里程碑

### 8.1 MVP（4–6 周）
- 鉴权/用户模型
- Manifest GET/PUT + LWW
- 资产写入（管理员）与下载路径
- 超市列表/详情/下载计数（只读）
- Nginx+HTTPS，备份与健康检查

### 8.2 Beta（2–4 周）
- 超市预览与导入优化
- 监控/日志完善，压测与限流调优
- 资产体积/并发下载优化（Range/阈值）

### 8.3 发布（2 周）
- 联调稳定性
- 备份恢复演练
- 文档与运维手册完善

---

## 9. 验收

- 功能：登录/刷新令牌；Manifest LWW 成功覆盖；资产可断点下载；超市可浏览/详情/下载；管理员可上架包。
- 性能：P95 < 200ms；100 并发通过；资产下载稳定。
- 安全：HTTPS 可用；限流生效；日志脱敏；依赖无高危漏洞。
- 可靠：7x24 稳定运行；备份可恢复；健康检查 OK。

---

## 10. 未来扩展（预留）
- StorageAdapter：本地FS → S3/COS/OSS（接口不变）。
- Repo：SQLite → PostgreSQL（通过仓储层切换）。
- 队列与任务：Redis + BullMQ（转码、导入、统计异步化）。
- CDN：备案后切国内 CDN 加速音频分发。
