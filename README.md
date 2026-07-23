# Kimi Code 仪表盘

Kimi Code 的 VS Code 辅助插件（非官方）：补上官方插件面板缺失的能力——查看/切换思考级别、Token 用量统计、官方额度占比（5 小时/每周/月度/赠送）、上下文大小配置。

与官方 Kimi Code 插件并存，不修改其任何文件；只读写 Kimi Code CLI 的数据目录（`~/.kimi-code`）。

- GitHub 仓库：https://github.com/1998moye/kimi-code-dashboard
- VS Code 应用市场：搜索「Kimi Code 仪表盘」

## 安装教程

**第 1 步：安装并登录 Kimi Code CLI**（额度接口和配置文件都依赖它）

```powershell
# Windows（PowerShell）
irm https://code.kimi.com/kimi-code/install.ps1 | iex
```

```bash
# macOS / Linux
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
```

安装后在终端运行 `kimi`，输入 `/login` 完成登录（CLI 下载页：https://code.kimi.com/kimi-code ）。

**第 2 步：安装本插件**（二选一）

- VS Code 扩展面板搜索「Kimi Code 仪表盘」直接安装
- 或从 [GitHub Releases](https://github.com/1998moye/kimi-code-dashboard/releases) 下载 `.vsix` → 扩展面板右上角 `...` → `Install from VSIX...`

**第 3 步（可选）：配置网页 token 以显示月度/赠送额度**

打开插件面板 → 额度占比卡片 → 按界面里的两种方式之一获取 token 粘贴即可（约 30 天有效）。不配置也不影响其他功能。

## 权限与数据说明（请在使用前阅读）

- 本插件读取 `~/.kimi-code/` 下的本地数据：`config.toml`（模型与思考配置）、`sessions/**/wire.jsonl`（会话 token 用量记录）、`credentials/kimi-code.json`（OAuth 凭证，仅用于调用官方额度接口和自动刷新 token）
- 调用的网络接口只有两个，均为 Kimi 官方域名：`api.kimi.com/coding/v1/usages`（额度）和 `www.kimi.com` 会员统计接口（月度/赠送额度，需自行粘贴网页 token），以及 `auth.kimi.com`（token 刷新）
- 所有数据只在本机处理，不向任何第三方发送
- **本插件使用了 Kimi 未公开的私有接口，官方随时可能变更导致功能失效；本项目与月之暗面（Moonshot AI）无任何关联，亦非官方产品**
- 网页 token 以明文存储在 VS Code 设置中，请知悉；可在设置中随时清空

## 功能

- **状态栏常驻**：显示当前默认模型 + 生效的思考档位（如 `K3 · high`），点击弹出 QuickPick 切档
- **侧边栏面板**（活动栏月亮图标）：
  - **思考级别**：当前生效档位高亮，按模型的 `support_efforts` 动态生成切换按钮
  - **额度占比**：官方接口实时数据（5 小时/每周/并发上限），网页接口补充月度总量与赠送额度，进度条 + 重置倒计时 + 手动刷新；OAuth token 过期自动刷新，无需手动跑 CLI
  - **Token 用量**：今日 / 近7天 / 全部汇总，按模型分组（含缓存命中率），最近 20 个会话明细；增量扫描 + 本地缓存
  - **上下文配置**：各模型 `max_context_size` 查看与修改，修改写入 `[models."<alias>".overrides]`（抗官方模型目录刷新）
  - **数据目录**：显示实际使用的路径，便于排错
- 监听 `config.toml` 变化自动刷新

## 原理

- 思考档位：读写 `~/.kimi-code/config.toml` 的 `[thinking] effort`（CLI 的 `/effort` 持久化的也是这里）
- Token 用量：扫描 `~/.kimi-code/sessions/*/*/agents/*/wire.jsonl` 中 `type: "usage.record"` 的权威记录（`inputOther`/`output`/`inputCacheRead`/`inputCacheCreation`），官方插件与 CLI 的会话都在这里
- 额度：`GET {base_url}/usages`（Bearer 认证）；token 过期时走标准 OAuth refresh 流程自动换新并写回
- 数据目录定位：`kimiCompanion.kimiHome` 设置 > `KIMI_CODE_HOME` 环境变量 > `~/.kimi-code`
- 写 `config.toml` 前自动备份为 `config.toml.bak`；刷新凭证前备份 `kimi-code.json.bak`

## 已知边界（如实说明）

- 面板显示的「当前思考级别」是 `config.toml` 里的持久化值；运行中的会话如有未持久化的临时改动则无法探测
- Token 统计是**本地会话数据聚合，不是账号 quota**；账号额度看「额度占比」卡片
- 改思考档位 / 上下文大小对**新会话**生效，官方插件的当前会话需重开
- K3 / K2.7 是 `always_thinking` 模型，思考不可关闭，只能调强度
- 1M 上下文需要 Allegretto 及以上会员，改配置不能绕过会员限制
- 超过 20MB 的 wire.jsonl 会被跳过并计数提示

## 安装

纯 JavaScript、零依赖。从 Releases 下载 `.vsix`，在 VS Code 扩展面板选择 "Install from VSIX" 安装。

## 文件结构

- `package.json` — 插件清单（视图容器、命令、设置项）
- `extension.js` — VS Code 侧：状态栏、Webview 面板、命令、文件监听
- `lib/kimiConfig.js` — config.toml 解析与定点写入（纯 Node，可独立测试）
- `lib/usageScanner.js` — sessions 扫描与用量聚合（纯 Node，可独立测试）
- `lib/quotaClient.js` — 官方额度接口与 OAuth 刷新（纯 Node，可独立测试）

