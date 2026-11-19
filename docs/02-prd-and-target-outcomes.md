# 02. 产品需求规格书与目标效果定义（PRD & Target Outcomes）

## 1. 产品定位与愿景

**Antigravity-Autoloop** 是运行在 Google Antigravity 内部的**全内生自主工作流中台与「票拟—批红」决策驾驶舱**。

它将用户在 Antigravity 中的工作方式从「事事亲力亲为开窗口盯聊天」升级为**「定规矩、看全局、批关键奏折」**：
- 日常巡检、代码清理、告警初查、文档汇总、分支审查与测试合并由后台不同档位的内置模型按规则自主闭环推进；
- 只有触碰安全红线（`askFirst`）或需要人类主观权衡的事项，才会化作一张清晰简练的**决策卡片（票拟）**呈现在 Antigravity 右侧辅助面板中；
- 等待人类批复期间**零活跃会话、零后台轮询、零 Token 消耗**；人类一键点选（批红）后，原 Agent 会话立刻无缝接续把剩余工作干完。

---

## 2. 核心用户角色与使用体验（目标效果全景）

### 效果一：在 Antigravity 右侧面板「像批奏折一样管全局」
用户在聊天窗点击一键胶囊 `[Autoloop 工作台](sidecar://autoloop/hub/)` 打开右侧辅助面板，看到四个高信噪比视图：
1. **待批奏折区（Pending Decisions）**：每张卡片用三行以内大白话说清「发生了什么、为什么需要你定、影响是什么」，高亮推荐选项（`票拟推荐`），提供一键选项按钮与补充批注输入框；点击后卡片原地变为「已批复 · 正在续办」，做完后自动更新为最终处理结果。
2. **自主流水线总览（Live Pipelines）**：实时展示各条规则（早报、仓库巡检、Issue 分诊、分支交付等）当前的排队数、运行中轮次、挂起等待复查的定时器、暂停状态与今日完成数。
3. **因果溯源抽屉（`why` Causal Inspector）**：点开任意历史轮次，秒级展开其完整账本：「哪版规则触发 → 收到哪些原始事件 → 哪个模型（如 `gemini-4-hydrogen-high`）在哪个工作区执行 → 消耗多少输入/输出/缓存 Token → 产出了什么回执 → 关联哪条可点击打开的 Antigravity 会话」。
4. **规则与风控开关（Control Bar）**：支持一键暂停某条规则（`Pause`）、查看暂停期间跳过的事件并按需一键补跑（`Replay`）、手动立即触发一轮（`Run Now`）或强制终止异常轮次（`Stop`）。

### 效果二：在任意聊天窗口用自然语言管控中台
通过内置的 `autoloop-mcp` 服务，用户在当前任何 Antigravity 对话中直接说：
- *「帮我看看今天 Autoloop 跑了哪些活，有没有等我拍板的卡片？」*
- *「把刚才那张数据库清理的卡片选第二个方案（先备份再归档）。」*
- *「加一条每天早上 9 点用 Hydrogen 模型汇总工作区 Git 提交的早报规则，先 dry-run 预演给我看。」*
Agent 即可直接调用 MCP 工具完成查询、批卡、校验草稿与派单，无需记命令行参数。

### 效果三：全自动代码交付与异构模型互审闭环
当开发子代理在功能分支完成代码提交并发出 `branch.ready` 事件（或打上交付标记）后，Autoloop 自动接管后续四步：
1. **异构只读与两级增量审查**：唤醒与作者不同的模型（例如 Carbon 写的代码自动派给 `gemini-4-hydrogen-xhigh`，Hydrogen 写的代码自动派给 `gemini-4-carbon-high`，在 `--mode plan --sandbox` 下无状态只读审查裸 Git 快照，单轮默认 30 分钟超时）：第 1 轮审全量差异并要求每条阻塞项写明具体触发路径（普通测试文件分节轻读）；第 2 轮起提取 `prevSha..headSha` 增量 Diff 结合上轮未决阻塞清单定向复核（纯 `*.md` 改动自动回退全量严防蒙混过关）；默认最多 2 轮，超限未决自动升级为人工批奏折卡片拍板，且跨分支名按 Commit SHA 幂等缓存绝不重审同一提交；
2. **隔离工作树检查**：在临时 `git worktree` 中执行 `typecheck`、单元测试与安全门禁，绝不污染用户正在编辑的主工作区；
3. **合并落盘**：检查与审查双通过后自动合并至目标分支（如涉及 `sensitivePaths` 敏感目录或冲突则自动转交一张批奏折卡片请用户拍板）；
4. **构建/健康核实**：运行合并后冒烟验证，记录交付账本并发送 `fyi` 结案简报。

---

## 3. 功能需求规格矩阵（Functional Requirements）

| 模块编号 | 模块名称 | 优先级 | 核心功能明细 |
| :--- | :--- | :---: | :--- |
| **FR-01** | **多源本地事件接入层** | P0 | 1. 内置 Cron 定时引擎（支持 IANA 时区、夏令时防重、休眠唤醒仅补最近一次）；<br/>2. 本地文件与目录变更监听源（防抖合并、生成稳定事件 `id`）；<br/>3. 零 Token 命令探针源（`use: "command"`，脚本退出码 0 且仅在发现增量时回传 `events`）；<br/>4. 本地回环 HTTP/MCP 事件投递入口，按 `source + id` 严格幂等去重。 |
| **FR-02** | **声明式规则与并发调度引擎** | P0 | 1. 解析并热加载 `rules.json`（含 JSON Schema 强校验，改坏时保留旧规则继续运行并推告警卡）；<br/>2. 支持按 `source + types`（含通配符 `alert.*`）或 `cron` 路由；<br/>3. 三级并发控制：全局 Worker 容量 `capacity`、规则组上限 `group + parallel`、单规则/单模型上限 `maxActive`；<br/>4. 同事项（`rule + subject`）运行期间新来事件自动排队合并为一轮；<br/>5. 规则动态 `pause`、`resume`（展示跳过事件列表）、`replay --since`（每条只补一次）与 `run` 立即执行。 |
| **FR-03** | **Antigravity 原生多模型执行器** | P0 | 1. **`agy-print` 主执行器**：封装 `agy -p --output-format stream-json`，支持配置任意 Antigravity 模型（如 `gemini-4-hydrogen-high`、`gemini-4-carbon-high`、`claude-opus-5-5-high` 等）、推理强度 `effort` 与权限映射（`read`→`plan+sandbox`，`edit`→`accept-edits+sandbox`，`full`→`auto`）；<br/>2. **`agentapi-ui` 交互执行器**：支持为需要可视化会话或内置 `browser` 子代理的任务创建/唤醒客户端会话；<br/>3. **跨轮原会话续接**：回答卡片、到期复查或 `resume: true` 时通过 `--conversation <id>` 精准续接；若该会话正在被另一轮占用或上一轮被手动取消，则安全降级开新会话并携带资料；<br/>4. **增量 Token 用量核算**：自动提取并累加每轮 `input`、`output`、`cached` Token 用量。 |
| **FR-04** | **原子回执协议与无损纠错** | P0 | 1. 解析末尾 ```` ```agent-autoloop ```` 代码块（支持自底向上逆向围栏扫描）的五类动作：`ask`、`notice`（含 `fyi`）、`resolve`、`later`（含改期与 `cancel`）、`events`；<br/>2. 首行状态识别（自动剥离前导 Markdown 装饰符）：`没跑成：` / `FAILED:` 触发 `60s * 2^(attempt-1)` 指数退避重试（上限 30m / 10 次，第 3 次连续失败发末行摘要预警卡并在恢复后自动关闭），`没事可做：` / `NOTHING:` 静默归档，其余记为 `done`（`tell: "always"` 无卡完成自动补 `fyi` 简报卡）；<br/>3. 回执语法错误时，在原会话注入 `repairPrompt` 仅重写最后一条消息（最多 2 次）；若首轮业务已完成但 2 次修复仍失败，执行 `discardReceipt` 安全降级保留结论并推告警卡，严禁重跑业务副作用；<br/>4. 衍生事件强制校验规则 `emits` 白名单并递增 `hops`，`hops > 8` 自动熔断。 |
| **FR-05** | **双重安全护栏（隔离 + 硬钩子）** | P0 | 1. **指令数据物理分离**：不可信事件正文写入每轮隔离目录的 `context.json`（外部 `link` 仅允许 `http://`/`https://`），Prompt 仅含受检标识符；<br/>2. **`PreToolUse` 硬拦截钩子与控制面自保护**：对密级文件（`guard.json`/`owner.token`/`master.key` 等）执行零访问封锁，对 `hub.db*` 与 `rules.json` 执行写保护，穿透子 Shell 与 `node -e`/`python -c` 拦截违反 `access: "read"` 或未获批 `askFirst` 的调用，并精准识别中英文否定批复防误授权限；<br/>3. **`Stop` 回执预检钩子**：在模型回合结束瞬间校验疑似回执代码块格式，格式非法立即返回 `"decision": "continue"` 原地修复。 |
| **FR-06** | **右侧辅助面板「批奏折工作台」与通知** | P0 | 1. 基于 `SidecarApp` 构建响应式 Web UI（自动适配 Antigravity 深浅色主题 CSS 变量）；<br/>2. 支持待批卡片一键批红、自由文本批复、通知卡片一键结案备注；<br/>3. 支持实时状态流（ETag/增量序列号轮询）、规则暂停/恢复/补跑/立跑、运行中轮次强制停止（连同子进程组清理）；<br/>4. 支持 `why` 时间线溯源及一键复制/跳转原会话；<br/>5. 新 `open` 卡片（及 `tell: "always"` 的 `fyi` 简报卡）到达时触发带 `[<rule>]` 前缀的 macOS 原生系统通知（参数隔离防命令注入）。 |
| **FR-07** | **Stdio MCP 聊天控制桥** | P1 | 在插件 `mcp_config.json` 中注册 `autoloop_hub` MCP 服务，暴露只读查询（`autoloop_status`、`autoloop_why`、`autoloop_explain_rules`）与本人管理操作（`autoloop_answer`、`autoloop_resolve`、`autoloop_emit`、`autoloop_pause`、`autoloop_resume`、`autoloop_replay`、`autoloop_run`、`autoloop_stop`）；同时在子代理启动环境中自动剥离本人管理凭据，防止子代理「自己批自己的奏折」。 |
| **FR-08** | **本地异构审查交付与七大开箱模板** | P1 | 1. 实现本地分支交付器 `delivery/`（只读裸 Git 差异快照生成 → 异构模型两级增量定向复核（第 2 轮 `prevSha..headSha` 增量 Diff，默认 2 轮上限超限转人工奏折卡）→ 隔离 Worktree 测试检查 → 自动合并 → 冒烟核实）；<br/>2. 内置 **7 套**即拿即用规则与场景 SOP Skill 模板：<br/>　① `recipe-morning-brief`（每日研发早报）<br/>　② `recipe-issue-triage`（本地待办/Issue 独立复现与自动分诊）<br/>　③ `recipe-code-sweep`（周期性代码清理大扫除，联动双账本避坑）<br/>　④ `recipe-pr-delivery`（分支异构两级增量审查与安全合并交付）<br/>　⑤ `recipe-health-watch`（零 Token 本地/HTTP 服务健康巡检与故障自愈）<br/>　⑥ `recipe-idea-to-sop`（新观点/外部教程拆解试跑、双账本偏好校准与永久 SOP 规则固化五步工作流）<br/>　⑦ `recipe-ai-video-studio`（九阶段低抽卡率 AI 视频制片厂：错误前置成本漏斗、四节点零上下文盲审、首尾帧像素差分、Seedance/H3 七段式提示词、代码优先救片与 `ffmpeg` 程序化成片合成）；<br/>3. 内置交互式试跑命令 `autoloop try`（1 分钟走完「发事件 → Hydrogen 接单提问 → 零消耗挂起 → 面板点选颜色 → 续接原会话完结」全流程）。 |

---

## 4. 非功能指标与量化验收红线（SLOs）

| 指标类别 | 目标值 / 验收红线 | 验证方法 |
| :--- | :--- | :--- |
| **挂起资源消耗** | 等待人工拍板或等待 `later` 复查期间，**活跃 Agent 进程数 = 0，Token 消耗 = 0** | 集成测试与真机 `try` 挂起阶段进程树与账单检查 |
| **Sidecar 冷启动延迟** | `< 150 ms`（含 SQLite WAL 打开与投影游标校验） | `scripts/benchmark.ts` 实测 |
| **Sidecar 空闲内存占用** | `< 80 MB RSS` | 空载驻留 5 分钟 `process.memoryUsage().rss` |
| **单次事件入账与派单延迟** | `p99 < 5 ms`（本地 SSD 单事务 WAL 落盘） | 基准测试连续写入 2,000 条事件统计 |
| **崩溃恢复数据零丢失** | 随机 `SIGKILL` 强杀宿主进程 500 次，**所有已返回 200 确认的事实、卡片决定与去重键 100% 不丢失、不重派** | `sim/crash.ts` 真 SQLite 强杀恢复测试 |
| **状态机不变量正确性** | 固定种子 200,000 步随机故障/乱序/重放模拟，**零不变量违背** | `sim/random.ts` + `sim/invariants.ts` |
| **防循环止损上限** | 任意自激事件链最多执行 `8` 跳后 100% 强制熔断并告警 | `tests/hops-breaker.test.ts` |
| **提示词注入隔离度** | 外部事件 `summary`/`detail` 含任意恶意指令或伪造代码块围栏，**0 字节进入主提示词字符串**，且无法突破 `PreToolUse` 的 `access`/`askFirst` 门禁 | `tests/security-isolation.test.ts` |

---

## 5. 明确的不做清单（Non-Goals / Scope Boundaries）

为防止架构膨胀变成难以维护的巨石系统，V1.0 明确划定以下**不做边界**：
1. **不做拖拽式连线工作流画布（如 Coze / Dify / n8n 节点连线器）**：复杂流程一律靠「声明式 `rules.json` + Markdown `SKILL.md` SOP + 结构化回执衍生事件」表达，保持极致的文本可版本化与 Agent 自维护能力。
2. **不内置公网穿透服务或第三方云端数据库**：坚持 100% 本地单机内生运行，所有数据以 0600/0700 权限保存在用户本机目录。
3. **不在内核层耦合任何特定业务系统 SDK**：无论是 Git、GitHub、Google Calendar 还是浏览器巡检，一律通过外围探针脚本、Skill 或 Antigravity 已安装的插件能力接入，内核永远只认标准事件与标准回执。
