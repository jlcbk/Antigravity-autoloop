# Antigravity-Autoloop

> **全内生于 Google Antigravity 内部的确定性事件驱动 Agent 自动化工作台与「票拟—批红」协同系统。**
>
> 灵感源自 [KKKKhazix/agent-autoloop](https://github.com/KKKKhazix/agent-autoloop) 与数字生命卡兹克关于「注意力最贵：内阁票拟 + 皇帝批红」的架构实践，将**事件中台、规则调度内核、多模型子代理执行、会话零消耗挂起续接、硬安全门禁、本地异构模型审查交付流水线，以及可视化批奏折面板** 100% 收敛至 Antigravity 程序内部，无需外部云服务器、公网端口、第三方 IM 机器人或外部命令行 Agent。

---

## 核心结论速览

1. **完全可行（原生契合度 >95%）**：Antigravity 自带 Node.js 24 运行时（原生含 `node:sqlite`）、`sidecar_sdk` 常驻后台服务与右侧辅助面板（Auxiliary Web UI Pane）、`agy -p --conversation` 无头会话续接、`agentapi` 会话唤醒、`hooks.json` 生命周期硬拦截、`mcp_config.json` 对话工具桥接，以及原生 `swarm` 多子代理并行调度能力，足以在不引入任何外部运行依赖的前提下完整承载并增强 `agent-autoloop`。
2. **三大原生升级（相比原外部版）**：
   - **零外部通道闭环**：右侧辅助面板（`sidecar://autoloop/hub/`）直接化身「内阁批奏折工作台 + 自动化流水线视图」，配合聊天框内 MCP 指令与 macOS 原生系统通知，无需配置飞书企业自建应用或暴露公网地址。
   - **软约束升级为硬门禁**：原版 `askFirst` 仅靠 Prompt 叮嘱 Agent 自觉遵守；内生版通过 Antigravity `PreToolUse` 与 `Stop` 钩子，在工具执行前硬性拦截越权高危操作与控制面篡改、在回合结束前原地校验并修复回执 JSON。
   - **内置异构模型路由**：直接在规则中按任务性质调度 Antigravity 内部模型池（如 `gemini-4-carbon-high` / `claude-opus-5-5-high` 负责复杂架构开发，`gemini-4-hydrogen-xhigh` 负责只读独立代码审查，`gemini-4-hydrogen-high` 负责日常运维与子任务执行，`gemini-3.8-flash-high` 负责轻量分诊与日报）。

---

## 日常推荐工作方式：默认极简 + 按需升档（三挡模式）

并非所有日常任务都需要重型流水线。安装本插件后，推荐遵循**「默认直出零打扰，按需口令升档」**的三挡节奏：

| 挡位 | 触发方式 | 适用场景 | 执行机制与注意力开销 |
| :--- | :--- | :--- | :--- |
| 🟢 **一挡：默认极简** | 直接正常对话（无需任何口令） | 日常问答、随手修小 Bug、改配置、轻量脚本与探索讨论 | `PreToolUse` / `Stop` 钩子识别无 `AUTOLOOP_GUARD_FILE` 自动毫秒级放行；主代理直接完成交付，**零弹窗、零卡片、零额外 Token 开销**。 |
| 🟡 **二挡：单次盲审** | 口令附带 **“做完过一遍盲审”** | 核心业务逻辑修改、重构定稿、准备提交前质量把关 | 主代理完成实现后，拉起**单个零历史上下文的只读子代理**独立挑刺（只看产物与 Diff，不喂前文结论），拦截真实触发路径缺陷后再交付。 |
| 🔴 **三挡：内阁流水线** | 主动点名 `autoloop` / `recipe-*`，或向 `.autoloop/inbox/` 投递事项 | 定时巡检自愈、批量议题分诊、九阶段 AI 视频制片厂、敏感分支合并交付 | 启动完整确定性事件路由：**「票拟」挂起零进程驻留等待「批红」** + **两级异构模型交叉审查（第 2 轮增量 Diff 定向复核）** + **隔离 Worktree 门禁合并**。 |

---

## V1.1.0 核心升级亮点

完整变更明细请参阅 **[CHANGELOG.md](./CHANGELOG.md)**：

| 升级维度 | V1.1.0 核心能力摘要 |
| :--- | :--- |
| **1. 执行器与会话自愈** | 新增 `discardReceipt` 安全降级（业务已完成但回执连修 2 次仍损坏时丢弃坏回执保留成果，杜绝 10 次带副作用重跑）；坏历史会话 `!started` 自动新开降级与延迟 `session` 补报；`agy-print` 收到最终 `result` 后 `30s` 退出宽限回收。 |
| **2. 跨进程事实账本** | `kernel/store.ts` 新增 `commitLatest`，在 SQLite `BEGIN IMMEDIATE` 锁内增量追平跨进程写入的 `facts` 后再执行 `decide`，实现 CLI 与常驻 Sidecar 并发零冲突、异常零脏写回滚。 |
| **3. 三层控制面护栏** | `hooks/pre-tool-guard.mjs` 实现密级文件零访问、`hub.db` 写禁、`context.json`/`rules.json` 安全只读放行与内联写脚本拦截；补齐 `"删除数据库"` 词表；`context-file.ts` 消除中文正向复合词批复误判；三 Runner 统一环境变量脱敏与探针输出双窗限流。 |
| **4. 增量异构交付审查** | `delivery/` 引入两级审查（必填真实触发路径 `how`、普通测试轻读、安全纯洁门禁严审）、第 2 轮 `prevSha..headSha` 增量 Diff 定向复核（纯 `*.md` 修改自动回退全量补丁防蒙混过关）、默认 **2 轮**转人工、单轮 30 分钟超时及跨分支名 SHA 缓存复用。 |
| **5. 协议与状态机闭环** | `askFirst` 支持省略并自动填充 7 类默认红线；同 `group` 有效 `parallel` 一致性校验与跨规则 `(grp, lane)` 互斥；`link` 严格限 `http/https`；`context.decided` 覆盖 `"done"` 历史卡；默认 `60s` 指数退避 + 第 3 次失败末行预警卡；`tell: "always"` 自动简报与 `[<rule>]` 通知前缀；终态自动清理已触发 `timers`。 |
| **6. 第 7 场景：AI 视频制片厂** | 内置 `recipe-ai-video-studio` 技能、九阶段工业级 SOP（`docs/07`）与 `video-qa-tools.py` 确定性质检工具（黄金线框、灰度明度、首尾帧 3 倍像素差分叠图、切点抽帧），并兼容 macOS GUI 启动 `PATH`。 |

---

## 工程文档全景导航

本仓库采用**契约先行（Contract-First）+ 多子代理并行研发（Multi-Subagent Parallel Execution）**的大型项目工程规范。所有设计、协议、计划、任务拆解与验收标准均沉淀于以下文档：

| 编号 | 文档路径 | 核心内容与用途 | 目标读者 |
| :--- | :--- | :--- | :--- |
| **宪章** | [AGENTS.md](./AGENTS.md) | 架构红线（内核纯洁性、零外部依赖、指令数据分离）、代码规范、TDD 铁律、子代理文件所有权边界 | 协调者、全体 Hydrogen 子代理、审查子代理 |
| **日志** | [CHANGELOG.md](./CHANGELOG.md) | 版本发布演进记录（`v1.1.0` 六大工程加固与 AI 视频制片厂、`v1.0.0` 全内生首发底座） | 全体用户、维护者与审查子代理 |
| **01** | [docs/01-research-and-feasibility.md](./docs/01-research-and-feasibility.md) | 原项目 `agent-autoloop` 机制深度拆解、卡兹克推文核心思想提炼、Antigravity 全内生架构 1:1 映射与边界约束论证 | 项目负责人、架构师 |
| **02** | [docs/02-prd-and-target-outcomes.md](./docs/02-prd-and-target-outcomes.md) | 产品愿景、核心用户旅程、8 大功能模块需求规格（FR）、非功能指标（SLO）、七大内置场景模板与最终交付效果定义 | 项目负责人、产品与验收子代理 |
| **03** | [docs/03-system-architecture-and-protocol.md](./docs/03-system-architecture-and-protocol.md) | 插件目录蓝图、冻结的数据结构与接口契约（`protocol` / `kernel` / `engine` / `hooks` / `mcp` / `sidecar`）、状态机与安全模型 | 全体开发子代理（开工必读） |
| **04** | [docs/04-development-workflow-and-roadmap.md](./docs/04-development-workflow-and-roadmap.md) | 标准研发流程（SDLC）、6 阶段里程碑（M0–M5）、分支与工作树（`workspace: "share"`）集成规范、阶段准出标准（DoD）与风险矩阵 | 协调者（Coordinator）、合并守门人 |
| **05** | [docs/05-subagent-wbs-and-hydrogen-guide.md](./docs/05-subagent-wbs-and-hydrogen-guide.md) | **6 波次 × 22 个原子工作包（WP-01 ~ WP-22）超细颗粒度拆解**、零文件冲突所有权矩阵、`Gemini 4 Hydrogen` 调度实操指南与即拷即用 Brief 模板 | 协调者、全体 Hydrogen 子代理 |
| **06** | [docs/06-testing-verification-and-acceptance.md](./docs/06-testing-verification-and-acceptance.md) | 五层测试金字塔：纯洁性门禁、状态机单元测试、20 万步确定性随机模拟与强杀恢复测试、Antigravity 桩集成测试、真机 `try` 端到端验收手册 | 测试子代理、验证子代理（Verifier） |
| **07** | [docs/07-ai-video-production-sop.md](./docs/07-ai-video-production-sop.md) | 从一句话想法到 1080p 成片：AI 视频低抽卡率九阶段 SOP（错误前置漏斗、零上下文盲审、首尾帧差分、七段式提示词、代码救片与精密后期） | 视频创作用户、总导演与盲审子代理 |

---

## 仓库结构全景（V1.1.0 完整实现）

本项目本身即是一个**零第三方运行时依赖**的标准 **Antigravity 原生插件包（Plugin Bundle）**，可直接挂载或软链至 `~/.gemini/config/plugins/autoloop/`：

```text
Antigravity-autoloop/
├── README.md                          # 项目总览、三挡工作方式、快速上手与文档索引
├── CHANGELOG.md                       # 版本演进与工程加固变更记录（Keep a Changelog）
├── AGENTS.md                          # 全局研发宪章与子代理行为铁律
├── plugin.json                        # Antigravity 插件清单（打包 Sidecar、MCP、Hooks、Skills、Rules）
├── mcp_config.json                    # 暴露给聊天会话的 autoloop_hub 工具服务配置（兼容 macOS GUI PATH）
├── hooks.json                         # PreToolUse 高危拦截与 Stop 回执语法校验生命周期钩子
├── package.json                       # 零 dependencies，仅含 TypeScript 类型检查与 Node 24 测试脚本
├── tsconfig.json                      # Node 24 原生 TypeScript (erasableSyntaxOnly) 配置
├── bin/autoloop.mjs                   # 命令行可执行入口
├── docs/                              # 完整工程研发与专项生产 SOP 文档体系（01 ~ 07）
├── examples/rules.starter.json        # 开箱即用的多模型角色与七大场景规则样板
├── rules/AGENTS.md                    # 插件启用时注入的精简 Autoloop 协同规则 (<2KB)
├── skills/
│   ├── autoloop-admin/SKILL.md        # 规则编写、启停补跑、排障与日常管理手册
│   ├── recipe-morning-brief/SKILL.md  # 内置场景 1：每日工作区提交与笔记早报
│   ├── recipe-issue-triage/SKILL.md   # 内置场景 2：Issue / 本地待办自动分诊与修复
│   ├── recipe-code-sweep/SKILL.md     # 内置场景 3：周期性代码大扫除与死代码清理
│   ├── recipe-pr-delivery/SKILL.md    # 内置场景 4：本地/GitHub 分支异构审查与自动交付
│   ├── recipe-health-watch/           # 内置场景 5：零 Token 静默探针巡检与异常自愈
│   ├── recipe-idea-to-sop/SKILL.md    # 内置场景 6：新观点/外部教程拆解试跑与固化流
│   └── recipe-ai-video-studio/        # 内置场景 7：从想法到 1080p 成片低抽卡率 AI 制片厂（含 QA 脚本）
├── protocol/                          # 冻结协议层：Schema、输入校验、回执解析、无外部依赖类型
├── kernel/                            # 纯函数确定性内核：decide / evolve / store(commitLatest) / cron / due
├── engine/                            # Antigravity 原生执行器：agy -p 会话适配器、agentapi 唤醒器、command 探针
├── delivery/                          # 本地隔离 worktree 检查与异构模型只读审查（两级审查、第 2 轮增量 Diff 定向复核、默认 2 轮转人工、跨分支名 SHA 缓存）
├── mcp/                               # Stdio MCP 服务端（11 个 autoloop_* 工具，子代理自动防自批隔离）
├── hooks/                             # 三层控制面自保护 PreToolUse 安全门禁钩子与 Stop 原地修复钩子
├── sidecars/hub/                      # 常驻 SidecarApp 宿主 + 右侧辅助面板「批奏折工作台」前端（HTML/CSS/JS）
├── cli/                               # 本地诊断、离线检查（status / why / check / explain / try）命令行入口
├── scripts/                           # 性能基准测试（benchmark.ts）与本地插件挂载脚本（install-local-plugin.sh）
├── tests/                             # 60 个测试套件、201 个自动化用例（纯洁性门禁、状态机、安全隔离、增量审查与全链路 E2E）
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
