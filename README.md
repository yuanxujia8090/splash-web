# Splash Web

本机 **Splash** 运维管理端（配置 · 状态 · 重启）。默认只绑 `127.0.0.1`，**不做公网管理**，**无通用 shell**（只暴露 Splash 白名单 CLI flag）。

许可证：Apache-2.0（与 [incoai/splash](https://github.com/incoai/splash) 兼容）。

## 3 步打开管理页

```bash
cd /path/to/splash-web
npm install
npm start
```

浏览器打开：**http://127.0.0.1:8000/admin**

> 只记一个对外端口 `8000`：管理页在 `/admin`，Splash 的 API / 聊天等经同一端口反代。  
> Splash 实际由本端拉到上游端口（默认 `18000`，配置字段 `upstreamPort`）。  
> 可用环境变量覆盖：`SPLASH_WEB_PORT=18080`、`SPLASH_WEB_UPSTREAM_PORT=18001`。

若启动时报端口被占用（常见：你以前在终端手开的 Splash 占了 8000），请先停掉该进程，再由 splash-web 统一占 8000 并代管 Splash；**不会**回退到 8787。

## 模型文件：复用，不重复下载

「选模型路径」优先扫描并列出：

1. `~/.lmstudio/models`（LM Studio 常用下载目录）
2. `~/.omlx/models`（oMLX 模型目录）

也可在输入框手填其它**本地**路径或 `OWNER/REPO[:VARIANT]`。管理端**不会**下载模型、不另建缓存目录。

- **本地目录**（下拉或 `/` / `~` 开头）：走 Splash `prepare_local_model`，再 `python -m server.server <prepared> --model <owner/repo>`，复用 `~/.lmstudio/models` / `~/.omlx/models`。  
- **HF `owner/repo`**：仍走 `splash serve --model …`。  
- **DFlash2**：配置里可开开关并选择 draft；开启后本地 prepare 传 `draft=`，`splash serve` 传 `--draft-model`。关闭则不强制 draft。

## 能做什么

| 能力 | 说明 |
|------|------|
| 配置 | 模型路径、对外端口、`--max-memory` / `--max-context` 等日常项；保存后提示「需重启才生效」 |
| 状态 | Ready、生成速度（tok/s）、并发/队列；一眼区分「卡了」还是「在算」 |
| 重启 | 一键安全重启**本端拉起**的 Splash；失败给可读原因 |
| 端口 | 对外一端口；冲突时说人话 |

## 不会做什么

- 不重做 Chat、不做 HF 下载器、不做菜单栏 App  
- 不杀「外部手动启动」的 Splash（只读状态 + 提示你先手动停）  
- 不执行任意命令 / 任意脚本  

## 安全重启与 DRY_RUN

- 进程用 `child_process.spawn(..., { shell: false })`，参数来自白名单校验。  
- 配置文件：`~/.config/splash-web/config.json`  
- 无人值守或避免加载大模型时：

```bash
SPLASH_WEB_DRY_RUN=1 npm start
```

此时仍监听对外端口并提供 `/admin`；「启动/重启」只生成白名单命令，**不真正 spawn** `splash serve`；非 `/admin` 反代返回说明 / 503。

## 前提

本机已安装 Splash（例如 Homebrew：`/opt/homebrew/bin/splash`），并能在终端跑 `splash serve --help`。

## 开发

```bash
npm test
npm run dev
```
