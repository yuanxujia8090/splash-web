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

## 采样参数（temperature / top_p / top_k）

Splash 的 `serve` **没有**采样相关 CLI flag —— 这几个值只存在于**每个请求的 JSON 体**里。所以 splash-web 在反代层补缺省：

| 管理页字段 | 请求字段 | 不传时的 Splash 原生默认 | 允许范围 |
|---|---|---|---|
| 温度 | `temperature` | `1.0` | `[0, 2]`，0 = 贪心 |
| Top-P | `top_p` | `0.95` | `(0, 1]` |
| Top-K | `top_k` | `20` | `-1` / `0` = 关闭，或正整数 |

规则：

- 只补客户端**没写**的字段；显式写了的（含 `null`）不动。
- 只作用于 `/v1/chat/completions`、`/v1/completions`、`/v1/responses`、`/v1/messages`，且 `Content-Type` 为 JSON。
- 请求体超过 8 MB 不缓冲，直接流式透传（视觉输入可能很大）。
- 改动**不用重启 Splash**，下一个请求就生效。
- 响应头 `x-splash-web-sampling` 会写明这次补了哪些值，便于排查。
- 关掉「启用注入」即完全不干预，行为回到 Splash 原生默认。

出厂默认值故意与 Splash 原生默认相同，所以默认开启也不会改变任何行为。

来源：Splash 1.4.0 `libexec/server/frontend.py`（`SAMPLING_NUMBERS` / `TOP_K_DEFAULT`）。

## 能做什么

| 能力 | 说明 |
|------|------|
| 配置 | 模型路径、对外端口、`--max-memory` / `--max-context` 等日常项；保存后提示「需重启才生效」 |
| 采样 | 温度 / top_p / top_k，反代补缺省，不用重启 |
| 状态 | Ready、生成速度（tok/s）、并发/队列；一眼区分「卡了」还是「在算」 |
| 重启 | 一键安全重启**本端拉起**的 Splash；失败给可读原因 |
| 端口 | 对外一端口；冲突时说人话 |

## 速度口径（Decode / Prefill tok/s）

算法对齐 [pi-token-speed](https://github.com/gsanhueza/pi-token-speed) 的**时间滑动窗口**：

- 采样：管理页打开期间，每秒读一次上游 `/status`，取累计计数 `metrics.decode_output_tokens` / `metrics.prefill_input_tokens`。
- 窗口：默认 1000ms，速度 = 窗口内 token 增量 × 1000 / 实际时间跨度。
- 下限：时间跨度最短按 100ms 算（对应 `MIN_SLIDING_WINDOW`），避免「憋一会再一次性吐出来」把速度算爆。
- 显示：主值是最近约 1 秒的窗口实时值（秒级刷新）；这两行后面跟一个浅色的「平均 xxx」，是从上次重置起累计的平均。其他指标不展示平均值。
- 刷新节奏：管理页每 1 秒轮询一次 `/status`，同时每秒记录一个采样点；上一轮没返回时跳过本次，避免上游卡住时请求堆积。
- 平均累计：上游 `*_tokens` / `*_wall_ms` 增量加总，落在 `~/.config/splash-web/speed-stats.json`，重启 splash-web 或 Splash 都不清零。
- 手动重置：点管理页的「刷新」按钮会把平均值清零、从那一刻重新累计（自动轮询不重置）。
- 精度：保留 1 位小数（`123.46 → 123.5`）。
- 空闲：管理页关掉 60 秒后停止采样，不再轮询上游。

所以数字是**最近约 1 秒的实测吞吐**，会跟着负载跳动；不懂为什么跳的时候，先看「活跃请求 / 队列」两行。

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
