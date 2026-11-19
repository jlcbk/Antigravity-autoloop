# Antigravity-Autoloop

> **全内生于 Google Antigravity 内部的确定性事件驱动多引擎 Agent 自动化工作台与「票拟—批红」协同系统。**
>
> 灵感源自 [KKKKhazix/agent-autoloop](https://github.com/KKKKhazix/agent-autoloop) 与数字生命卡兹克关于「注意力最贵：内阁票拟 + 皇帝批红」的架构实践，将**事件中台、规则调度内核、八模全通道子代理执行、会话零消耗挂起续接、硬安全门禁、跨厂商真异构代码审查交付流水线，以及可视化批奏折面板** 100% 收敛至 Antigravity 控制面统一编排，无需外部云服务器、公网端口或第三方 IM 机器人。

---

## 核心结论速览

1. **完全可行（原生契合度 >95%）**：Antigravity 自带 Node.js 24 运行时（原生含 `node:sqlite`）、`sidecar_sdk` 常驻后台服务与右侧辅助面板（Auxiliary Web UI Pane）、`agy -p --conversation` 无头会话续接、`agentapi` 会话唤醒、`hooks.json` 生命周期硬拦截、`mcp_config.json` 对话工具桥接，以及原生 `swarm` 多子代理并行调度能力，足以在不引入任何第三方 NPM 运行时依赖的前提下完整承载并增强 `agent-autoloop`。
2. **四大核心架构优势（相比原外部版）**：
   - **零外部通道闭环**：右侧辅助面板（`sidecar://autoloop/hub/`）直接化身「内阁批奏折工作台 + 自动化流水线视图」，配合聊天框内 MCP 指令与 macOS 原生系统通知，无需配置飞书企业自建应用或暴露公网地址。
   - **软约束升级为硬门禁**：原版 `askFirst` 仅靠 Prompt 叮嘱 Agent 自觉遵守；本系统通过 Antigravity `PreToolUse` / `Stop` 钩子、外部 CLI 原生沙箱以及 `ACP` 协议层 `session/request_permission` 硬性拦截越权高危操作与控制面篡改，并在回合结束前原地校验修复回执 JSON。
   - **八模全通道执行矩阵（后台正规军 + 前台特种兵互补）**：
     - **Antigravity 原生双通道**：`agy-print`（主力无头流式续接）+ `agentapi-ui`（客户端可视化会话与 `browser` 联动）；
     - **外部原生流式双通道**：`codex`（OpenAI Codex CLI `exec --json` 原生沙箱与 `--effort`）+ `claude`（Claude Code / `zcode` / `dsh` `stream-json` 流式续接）；
     - **通用 `acp` 万能协议通道**：基于 Agent Client Protocol（NDJSON JSON-RPC 2.0），一套适配器通吃 OpenCode（`opencode acp`）、Gemini CLI、Qwen Code、Goose、Kimi CLI 等所有兼容 Agent，并在协议层集中执行 `access` 与 `askFirst` 权限审批；
     - **`herdr` 交互式常驻窗格/远程机器特种通道**：联动 tmux 窗格编排器 `herdr`（支持 `w3:p1`、`kind:codex`、`spawn:opencode` 选择器与 `--machine` 跨机 SSH 派单），采用「后台正规军（`exec/acp` 挂起零进程驻留 + 强制沙箱隔离）+ 前台特种兵（`herdr` 原生驱动官方纯 TUI 终端客户端、复用交互态会话、跨机 SSH 调度）」的黄金互补分工，全程严守各平台与 Coding Plan 套餐的官方客户端调用规范。
   - **跨厂商真异构盲审交付**：除 Antigravity 内部 Hydrogen ↔ Carbon 互审外，本地交付流水线（`.autoloop/delivery.json`）支持通过 `reviewerRunner` 将 Gemini / Claude 编写的代码交由外部 OpenAI `codex` 或 `opencode acp` 执行只读盲审，彻底打破同源模型思维盲区。

---

## 日常推荐工作方式：默认极简 + 按需升档（三挡模式）

并非所有日常任务都需要重型流水线。安装本插件后，推荐遵循**「默认直出零打扰，按需口令升档」**的三挡节奏：

| 挡位                    | 触发方式                                                           | 适用场景                                                           | 执行机制与注意力开销                                                                                                                                  |
| :---------------------- | :----------------------------------------------------------------- | :----------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🟢 **一挡：默认极简**   | 直接正常对话（无需任何口令）                                       | 日常问答、随手修小 Bug、改配置、轻量脚本与探索讨论                 | `PreToolUse` / `Stop` 钩子识别无 `AUTOLOOP_GUARD_FILE` 自动毫秒级放行；主代理直接完成交付，**零弹窗、零卡片、零额外 Token 开销**。                    |
| 🟡 **二挡：单次盲审**   | 口令附带 **“做完过一遍盲审”**                                      | 核心业务逻辑修改、重构定稿、准备提交前质量把关                     | 主代理完成实现后，拉起**单个零历史上下文的只读子代理**独立挑刺（只看产物与 Diff，不喂前文结论），拦截真实触发路径缺陷后再交付。                       |
| 🔴 **三挡：内阁流水线** | 主动点名 `autoloop` / `recipe-*`，或向 `.autoloop/inbox/` 投递事项 | 定时巡检自愈、批量议题分诊、九阶段 AI 视频制片厂、敏感分支合并交付 | 启动完整确定性事件路由：**「票拟」挂起零进程驻留等待「批红」** + **两级异构模型交叉审查（第 2 轮增量 Diff 定向复核）** + **隔离 Worktree 门禁合并**。 |

---

## V1.2.0 核心升级亮点（八模全通道执行矩阵 & 跨厂商真异构盲审）

完整变更明细请参阅 **[CHANGELOG.md](./CHANGELOG.md)**：

| 升级维度                       | V1.2.0 核心能力摘要                                                                                                                                                                                                                                                                  |
| :----------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. 八模全通道执行矩阵**      | `RunnerKind` 扩展为 **8 类全通道**：Antigravity 原生（`agy-print` / `agentapi-ui`）+ 外部原生流式（`codex` / `claude`·`zcode`·`dsh`）+ 通用 `acp` 万能协议（通吃 OpenCode / Gemini / Qwen / Goose / Kimi）+ `herdr` 交互式常驻窗格/远程机器特种通道 + 本地 `delivery` / `command`。  |
| **2. 正规军 + 特种兵互补分工** | **后台正规军（`agy-print` / `codex` / `claude` / `acp`）**：单轮完结即退出（等待批红期间**零进程驻留**），强制内核沙箱/协议级权限门禁；**前台特种兵（`herdr`）**：接管常驻 tmux 交互窗格或 `--machine` 远程节点，原生驱动官方纯 TUI 客户端并保留交互态上下文，严守各模型厂商与 Coding Plan 客户端白名单规范。 |
| **3. 协议层 ACP 权限门禁**     | `acp` 执行器在 JSON-RPC 2.0 握手中声明 `fs.readTextFile: true`、`fs.writeTextFile: access !== "read"`、`terminal: false`（命令经由 ACP 智能体内置 Shell 工具发起并统一受 `session/request_permission` + `guard.json` 裁决），结合 `<AUTOLOOP_HOME>` 外部目录/子路径封锁、`access: "read"` 严格只读工具白名单与 `approvedKeys` 硬性拦截越权操作。 |
| **4. Herdr 复用派发与双模采集** | `herdr` 执行器遵循 Reuse-First 解析窗格（`w3:p1`、具名 Agent、`kind:<kind>`、`spawn:<kind>` 本工作区无抢焦点 `workspace create --no-focus` + `agent start` 及 OpenCode 弹窗 `esc` 清理），以 `herdr agent prompt <paneId> <wrappedPrompt> --wait`（`shell: false` 参数隔离，提示词 0 字节拼接 `summary`/`detail`）派发；本机采用 `0600` `herdr-handoff-attempt-<N>.md` 无损交接 + `agent read --source recent-unwrapped` 回退，`--machine` / `--remote` 远程模式投递 `0600` 只读远端上下文并直接从 `recent-unwrapped` 终端增量捕获回执，忙碌窗格跨重试保留会话、取消时仅发 `send-keys esc` 安全中断。 |
| **5. 跨厂商真异构代码盲审**    | `.autoloop/delivery.json` 新增 `reviewerRunner`（`"agy-print" \| "codex" \| "claude" \| "acp"`）与 `reviewerCommand`，支持 Gemini/Claude 分支由 OpenAI `codex` 或 `opencode acp` 执行只读盲审。                                                                                      |
| **6. 延续 V1.1.0 工业底座**    | 完整继承 `commitLatest` 跨进程单事务账本、`discardReceipt` 防副作用重跑、三层 `PreToolUse` 控制面护栏、第 2 轮 `prevSha..headSha` 增量 Diff 定向复核与 `recipe-ai-video-studio` 九阶段制片厂 SOP。                                                                                   |

---

## 工程文档全景导航

本仓库采用**契约先行（Contract-First）+ 多子代理并行研发（Multi-Subagent Parallel Execution）**的大型项目工程规范。所有设计、协议、计划、任务拆解与验收标准均沉淀于以下文档：

| 编号     | 文档路径                                                                                           | 核心内容与用途                                                                                                                           | 目标读者                                 |
| :------- | :------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------- |
| **宪章** | [AGENTS.md](./AGENTS.md)                                                                           | 架构红线（内核纯洁性、零外部依赖、指令数据分离）、代码规范、TDD 铁律、子代理文件所有权边界                                               | 协调者、全体 Hydrogen 子代理、审查子代理 |
| **日志** | [CHANGELOG.md](./CHANGELOG.md)                                                                     | 版本发布演进记录（`v1.2.0` 八模全通道与跨厂商盲审、`v1.1.0` 工程加固与 AI 制片厂、`v1.0.0` 全内生底座）                                  | 全体用户、维护者与审查子代理             |
| **01**   | [docs/01-research-and-feasibility.md](./docs/01-research-and-feasibility.md)                       | 原项目 `agent-autoloop` 机制深度拆解、卡兹克推文核心思想提炼、Antigravity 全内生架构 1:1 映射与边界约束论证                              | 项目负责人、架构师                       |
| **02**   | [docs/02-prd-and-target-outcomes.md](./docs/02-prd-and-target-outcomes.md)                         | 产品愿景、核心用户旅程、8 大功能模块需求规格（FR）、非功能指标（SLO）、七大内置场景模板与最终交付效果定义                                | 项目负责人、产品与验收子代理             |
| **03**   | [docs/03-system-architecture-and-protocol.md](./docs/03-system-architecture-and-protocol.md)       | 插件目录蓝图、冻结的数据结构与接口契约（`protocol` / `kernel` / `engine` / `hooks` / `mcp` / `sidecar`）、状态机与安全模型               | 全体开发子代理（开工必读）               |
| **04**   | [docs/04-development-workflow-and-roadmap.md](./docs/04-development-workflow-and-roadmap.md)       | 标准研发流程（SDLC）、6 阶段里程碑（M0–M5）、分支与工作树（`workspace: "share"`）集成规范、阶段准出标准（DoD）与风险矩阵                 | 协调者（Coordinator）、合并守门人        |
| **05**   | [docs/05-subagent-wbs-and-hydrogen-guide.md](./docs/05-subagent-wbs-and-hydrogen-guide.md)         | **6 波次 × 22 个原子工作包（WP-01 ~ WP-22）超细颗粒度拆解**、零文件冲突所有权矩阵、`Gemini 4 Hydrogen` 调度实操指南与即拷即用 Brief 模板 | 协调者、全体 Hydrogen 子代理             |
| **06**   | [docs/06-testing-verification-and-acceptance.md](./docs/06-testing-verification-and-acceptance.md) | 五层测试金字塔：纯洁性门禁、状态机单元测试、20 万步确定性随机模拟与强杀恢复测试、Antigravity 桩集成测试、真机 `try` 端到端验收手册       | 测试子代理、验证子代理（Verifier）       |
| **07**   | [docs/07-ai-video-production-sop.md](./docs/07-ai-video-production-sop.md)                         | 从一句话想法到 1080p 成片：AI 视频低抽卡率九阶段 SOP（错误前置漏斗、零上下文盲审、首尾帧差分、七段式提示词、代码救片与精密后期）         | 视频创作用户、总导演与盲审子代理         |

---

## 仓库结构全景（V1.2.0 完整实现）

本项目本身即是一个**零第三方运行时依赖**的标准 **Antigravity 原生插件包（Plugin Bundle）**，可直接挂载或软链至 `~/.gemini/config/plugins/autoloop/`：

```text
Antigravity-autoloop/
├── README.md                          # 项目总览、八模执行矩阵、三挡工作方式、快速上手与文档索引
├── CHANGELOG.md                       # 版本演进与工程加固变更记录（Keep a Changelog）
├── AGENTS.md                          # 全局研发宪章与子代理行为铁律
├── plugin.json                        # Antigravity 插件清单（打包 Sidecar、MCP、Hooks、Skills、Rules）
├── mcp_config.json                    # 暴露给聊天会话的 autoloop_hub 工具服务配置（兼容 macOS GUI PATH）
├── hooks.json                         # PreToolUse 高危拦截与 Stop 回执语法校验生命周期钩子
├── package.json                       # 零 dependencies，仅含 TypeScript 类型检查与 Node 24 测试脚本
├── tsconfig.json                      # Node 24 原生 TypeScript (erasableSyntaxOnly) 配置
├── bin/autoloop.mjs                   # 命令行可执行入口
├── docs/                              # 完整工程研发与专项生产 SOP 文档体系（01 ~ 07）
├── examples/rules.starter.json        # 开箱即用的八模角色池（含 codex/claude/acp/herdr）与七大场景规则样板
├── rules/AGENTS.md                    # 插件启用时注入的精简 Autoloop 协同规则 (<2KB)
├── skills/
│   ├── autoloop-admin/SKILL.md        # 八种 runner 选型指南、规则编写、启停补跑与日常排障手册
│   ├── recipe-morning-brief/SKILL.md  # 内置场景 1：每日工作区提交与笔记早报
│   ├── recipe-issue-triage/SKILL.md   # 内置场景 2：Issue / 本地待办自动分诊与修复
│   ├── recipe-code-sweep/SKILL.md     # 内置场景 3：周期性代码大扫除与死代码清理
│   ├── recipe-pr-delivery/SKILL.md    # 内置场景 4：跨厂商异构盲审（reviewerRunner）与五步安全交付
│   ├── recipe-health-watch/           # 内置场景 5：零 Token 静默探针巡检与异常自愈
│   ├── recipe-idea-to-sop/SKILL.md    # 内置场景 6：新观点/外部教程拆解试跑与固化流
│   └── recipe-ai-video-studio/        # 内置场景 7：从想法到 1080p 成片低抽卡率 AI 制片厂（含 QA 脚本）
├── protocol/                          # 冻结协议层：八枚举 RunnerKind、Schema、输入校验、回执解析
├── kernel/                            # 纯函数确定性内核：decide / evolve / store(commitLatest) / cron / due
├── engine/                            # 八模执行引擎：agy -p、agentapi、codex、claude(zcode/dsh)、acp、herdr、command
├── delivery/                          # 隔离 worktree 检查与跨厂商异构只读审查（reviewerRunner、第 2 轮增量 Diff、SHA 缓存）
├── mcp/                               # Stdio MCP 服务端（11 个 autoloop_* 工具，子代理自动防自批隔离）
├── hooks/                             # 三层控制面自保护 PreToolUse 安全门禁钩子与 Stop 原地修复钩子
├── sidecars/hub/                      # 常驻 SidecarApp 宿主 + 右侧辅助面板「批奏折工作台」前端（HTML/CSS/JS）
├── cli/                               # 本地诊断、离线检查（status / why / check / explain / try）命令行入口
├── scripts/                           # 性能基准测试（benchmark.ts）与本地插件挂载脚本（install-local-plugin.sh）
├── tests/                             # 纯洁性门禁、状态机、多引擎适配器、安全隔离、增量审查与全链路 E2E 测试套件
└── sim/                               # 确定性随机模拟（20 万步种子复现）、12 条不变量检查与 SIGKILL 崩溃恢复压测
```

---

## 快速上手（Quick Start）

> **环境要求**：Node.js `>= 24.0.0`（Antigravity 内置兼容运行时）。

```bash
# 1. 安装开发期类型检查工具（零运行时依赖）并跑通全套校验与测试
npm install
npm run typecheck
npm test

# 2. 一键闭环演练（验证「票拟挂起零进程驻留 -> 批红唤醒原会话续办」）
./bin/autoloop.mjs try --auto

# 3. 挂载为本地 Antigravity 原生插件（创建 ~/.gemini/config/plugins/autoloop 软链接）
./scripts/install-local-plugin.sh

# 4. 可选：运行 200,000 步确定性混沌模拟与性能基准测试
node --disable-warning=ExperimentalWarning sim/random.ts 24301 200000
npm run benchmark
```

安装完成后，在 Antigravity 插件中心确认启用 `autoloop`，即可在右侧辅助面板打开 **批奏折工作台**（`sidecar://autoloop/hub/`），或在对话中直接调用 `autoloop_*` MCP 工具。
