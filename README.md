# Antigravity-Autoloop

> **全内生于 Google Antigravity 内部的确定性事件驱动 Agent 自动化工作台与「票拟—批红」协同系统。**
>
> 灵感源自 [KKKKhazix/agent-autoloop](https://github.com/KKKKhazix/agent-autoloop) 与数字生命卡兹克关于「注意力最贵：内阁票拟 + 皇帝批红」的架构实践，将**事件中台、规则调度内核、多模型子代理执行、会话零消耗挂起续接、硬安全门禁、本地异构模型审查交付流水线，以及可视化批奏折面板** 100% 收敛至 Antigravity 程序内部，无需外部云服务器、公网端口、第三方 IM 机器人或外部命令行 Agent。

---

## 核心结论速览

1. **完全可行（原生契合度 >95%）**：Antigravity 自带 Node.js 24 运行时（原生含 `node:sqlite`）、`sidecar_sdk` 常驻后台服务与右侧辅助面板（Auxiliary Web UI Pane）、`agy -p --conversation` 无头会话续接、`agentapi` 会话唤醒、`hooks.json` 生命周期硬拦截、`mcp_config.json` 对话工具桥接，以及原生 `swarm` 多子代理并行调度能力，足以在不引入任何外部运行依赖的前提下完整承载并增强 `agent-autoloop`。
2. **三大原生升级（相比原外部版）**：
   - **零外部通道闭环**：右侧辅助面板（`sidecar://autoloop/hub/`）直接化身「内阁批奏折工作台 + 自动化流水线视图」，配合聊天框内 MCP 指令与 macOS 原生系统通知，无需配置飞书企业自建应用或暴露公网地址。
   - **软约束升级为硬门禁**：原版 `askFirst` 仅靠 Prompt 叮嘱 Agent 自觉遵守；内生版通过 Antigravity `PreToolUse` 与 `Stop` 钩子，在工具执行前硬性拦截越权高危操作、在回合结束前原地校验回执 JSON。
   - **内置异构模型路由**：直接在规则中按任务性质调度 Antigravity 内部模型池（如 `gemini-4-carbon-high` / `claude-opus-5-5-high` 负责复杂架构开发，`gemini-4-hydrogen-xhigh` 负责只读独立代码审查，`gemini-4-hydrogen-high` 负责日常运维与子任务执行，`gemini-3.8-flash-high` 负责轻量分诊与日报）。

---

## 工程文档全景导航

本仓库采用**契约先行（Contract-First）+ 多子代理并行研发（Multi-Subagent Parallel Execution）**的大型项目工程规范。所有设计、协议、计划、任务拆解与验收标准均沉淀于以下文档：

| 编号 | 文档路径 | 核心内容与用途 | 目标读者 |
| :--- | :--- | :--- | :--- |
| **宪章** | [AGENTS.md](./AGENTS.md) | 架构红线（内核纯洁性、零外部依赖、指令数据分离）、代码规范、TDD 铁律、子代理文件所有权边界 | 协调者、全体 Hydrogen 子代理、审查子代理 |
| **01** | [docs/01-research-and-feasibility.md](./docs/01-research-and-feasibility.md) | 原项目 `agent-autoloop` 机制深度拆解、卡兹克推文核心思想提炼、Antigravity 全内生架构 1:1 映射与边界约束论证 | 项目负责人、架构师 |
| **02** | [docs/02-prd-and-target-outcomes.md](./docs/02-prd-and-target-outcomes.md) | 产品愿景、核心用户旅程、8 大功能模块需求规格（FR）、非功能指标（SLO）、内置五大场景模板与最终交付效果定义 | 项目负责人、产品与验收子代理 |
| **03** | [docs/03-system-architecture-and-protocol.md](./docs/03-system-architecture-and-protocol.md) | 插件目录蓝图、冻结的数据结构与接口契约（`protocol` / `kernel` / `engine` / `hooks` / `mcp` / `sidecar`）、状态机与安全模型 | 全体开发子代理（开工必读） |
| **04** | [docs/04-development-workflow-and-roadmap.md](./docs/04-development-workflow-and-roadmap.md) | 标准研发流程（SDLC）、6 阶段里程碑（M0–M5）、分支与工作树（`workspace: "share"`）集成规范、阶段准出标准（DoD）与风险矩阵 | 协调者（Coordinator）、合并守门人 |
| **05** | [docs/05-subagent-wbs-and-hydrogen-guide.md](./docs/05-subagent-wbs-and-hydrogen-guide.md) | **6 波次 × 22 个原子工作包（WP-01 ~ WP-22）超细颗粒度拆解**、零文件冲突所有权矩阵、`Gemini 4 Hydrogen` 调度实操指南与即拷即用 Brief 模板 | 协调者、全体 Hydrogen 子代理 |
| **06** | [docs/06-testing-verification-and-acceptance.md](./docs/06-testing-verification-and-acceptance.md) | 五层测试金字塔：纯洁性门禁、状态机单元测试、20 万步确定性随机模拟与强杀恢复测试、Antigravity 桩集成测试、真机 `try` 端到端验收手册 | 测试子代理、验证子代理（Verifier） |

---

## 目标仓库结构蓝图（实施态）

完成研发后，本项目本身即是一个标准的 **Antigravity 原生插件包（Plugin Bundle）**，可直接挂载或软链至 `~/.gemini/config/plugins/autoloop/`：

```text
Antigravity-autoloop/
├── README.md                          # 项目总览与文档索引
├── AGENTS.md                          # 全局研发宪章与子代理行为铁律
├── plugin.json                        # Antigravity 插件清单（打包 Sidecar、MCP、Hooks、Skills、Rules）
├── mcp_config.json                    # 暴露给聊天会话的 autoloop-mcp 工具服务配置
├── hooks.json                         # PreToolUse 高危拦截与 Stop 回执语法校验生命周期钩子
├── package.json                       # 零 dependencies，仅含 TypeScript 类型检查与 Node 24 测试脚本
├── tsconfig.json                      # Node 24 原生 TypeScript (erasableSyntaxOnly) 配置
├── docs/                              # 完整工程研发文档体系（01 ~ 06）
├── rules/
│   └── AGENTS.md                      # 插件启用时注入的精简 Autoloop 协同规则
├── skills/
│   ├── autoloop-admin/SKILL.md        # 规则编写、启停补跑、排障与日常管理手册
│   ├── recipe-morning-brief/SKILL.md  # 内置场景 1：每日工作区提交与笔记早报
│   ├── recipe-issue-triage/SKILL.md   # 内置场景 2：Issue / 本地待办自动分诊与修复
│   ├── recipe-code-sweep/SKILL.md     # 内置场景 3：周期性代码大扫除与死代码清理
│   ├── recipe-pr-delivery/SKILL.md    # 内置场景 4：本地/GitHub 分支异构审查与自动交付
│   └── recipe-idea-to-sop/SKILL.md    # 内置场景 6：新观点/外部教程拆解试跑与固化流
├── protocol/                          # 冻结协议层：Schema、输入校验、回执解析、无外部依赖类型
├── kernel/                            # 纯函数确定性内核：decide / evolve / store(node:sqlite) / cron / due
├── engine/                            # Antigravity 原生执行器：agy -p 会话适配器、agentapi 唤醒器、command 探针
├── delivery/                          # 本地 CI 与异构模型只读快照审查流水线（最多 3 轮、绑定 SHA）
├── mcp/                               # Stdio MCP 服务端（status / why / answer / resolve / emit / pause / replay / run）
├── hooks/                             # PreToolUse 安全门禁脚本与 Stop 回执校验脚本
├── sidecars/
│   └── hub/                           # 常驻 SidecarApp 宿主 + 右侧辅助面板「批奏折工作台」前端（HTML/CSS/JS）
├── cli/                               # 本地诊断、离线检查（check / explain / why / try）命令行入口
├── tests/                             # 纯洁性测试、状态机测试、Fake AGY 集成测试
└── sim/                               # 确定性随机模拟（20 万步种子复现）、不变量检查与 SIGKILL 崩溃恢复测试
```

---

## 如何启动多子代理（Hydrogen）研发

1. **初始化版本控制**：在仓库根目录执行 `git init && git add . && git commit -m "chore: initialize architecture & engineering docs"`（`swarm` 的 `workspace: "share"` 依赖 Git 仓库做独立工作树隔离）。
2. **阅读调度手册**：打开 [docs/05-subagent-wbs-and-hydrogen-guide.md](./docs/05-subagent-wbs-and-hydrogen-guide.md)，查看波次依赖图与 **Native Swarm + `gemini-4-hydrogen-high` / `gemini-4-hydrogen-xhigh`** 派单指令。
3. **按波次推进（Wave 0 → Wave 5）**：每波次并行启动互不碰撞文件的 Author 子代理 + 按 `3:1` 比例配备 Verifier 审查子代理，每波次通过 [docs/06-testing-verification-and-acceptance.md](./docs/06-testing-verification-and-acceptance.md) 中的准出检查后合入主分支。
