# Changelog

All notable changes to **Antigravity-Autoloop** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/lang/zh-CN/).

---

## [1.1.0] - 2026-11-19

本版本聚焦**生产级容错自愈、跨进程 SQLite 并发一致性、三层控制面纵深防御、第 2 轮增量 Diff 异构审查降噪**，并正式内置第 7 套工业级自动化场景 **`recipe-ai-video-studio`（九阶段低抽卡率 AI 视频制片厂）**。全仓自动化测试扩展至 **60 个测试套件、201 个用例**。

### Added

- **第 7 套内置场景 `recipe-ai-video-studio`（九阶段 AI 视频制片厂）**：
  - 新增 [docs/07-ai-video-production-sop.md](./docs/07-ai-video-production-sop.md) 完整生产规范、[skills/recipe-ai-video-studio/SKILL.md](./skills/recipe-ai-video-studio/SKILL.md) 总导演技能与 `skills/recipe-ai-video-studio/scripts/video-qa-tools.py` 确定性质检工具（支持 38.2%/61.8% 黄金构图线框、黑白明度检验、尺寸强制对齐、手机小屏预览、首尾帧 3 倍像素差分叠图、切点前后各 3 帧导出），并在 `examples/rules.starter.json` 中预置 `video` 事件源与 `ai-video-studio` 规则。
- **跨进程单事务增量追平提交 `store.commitLatest`（`kernel/store.ts`）**：
  - 在 SQLite `BEGIN IMMEDIATE` 写事务内自动拉取 `seq > view.seq` 的外部新追加 `facts`（如 CLI 本地回退模式与常驻 Sidecar 并发写库），先同步更新 `projections` 与工作 `View` 再执行 `decideFn`；若 `decideFn` 抛错且无外部增量则完整 `ROLLBACK` 保持零脏写，若有外部增量则仅提交已追平的外部事实。
- **执行器 `discardReceipt` 安全降级与退出宽限回收（`engine/supervisor.ts`、`engine/agy-runner.ts`）**：
  - 当首轮业务执行已完成（`exitCode === 0` 且结论为 `done` 或 `nothing`），但末尾 `agent-autoloop` 回执经最多 2 次原地 `repairPrompt` 仍无法修复时，启用 `discardReceipt` 降级保留原业务结果（`done` 时自动附带「回执格式损坏已忽略」人工核查 `notice` 卡），防止把已完成的有副作用任务打成 `failed` 重做 10 遍；
  - `runAgyPrint` 新增 `postResultGraceMs`（默认 `30s`），流式收到最终 `result` 事件后若子进程滞留未退，宽限到期后优雅终止进程组并保留已完成输出，不再误判为轮次超时。
- **第 2+ 轮 `prevSha..headSha` 增量 Diff 定向复核与两级审查机制（`delivery/reviewer.ts`、`delivery/snapshot.ts`）**：
  - 第 2 轮及后续复审自动提取 `previousReviewedSha..headSha` 增量补丁（`incremental-diff.patch`）并注入上一轮未决 `blocking` 清单，要求审查模型逐条核销修复情况与新引入缺陷，严禁在未改动的历史代码中翻旧账拉锯；
  - 新增纯文档改动复核特判（`docs_only`）：当上一轮存在代码级阻塞问题而本轮仅修改 `*.md` 文件时，自动回退提供完整分支 `diff.patch` 供核实，防止仅靠修改文档规避代码修复；
  - 新增文件两级分类审查：安全与纯洁性门禁测试（`tests/*purity*|*security*|*safety*|*isolation*.test.ts` 及命中 `sensitivePaths` 的测试）执行严审，普通测试文件（`tests/*.test.ts`）执行分节轻读（仅查行为覆盖、不因写法风格报 `blocking`）；每条 `blocking` 缺陷强制要求写明当前调用链下的真实触发路径（支持 `how` 字段），同类同因问题合并单条。
- **连续失败早期预警与 `tell: "always"` 自动简报闭环（`kernel/decide.ts`、`sidecars/hub/notifier.ts`）**：
  - 轮次连续第 **3** 次失败退避时，自动发出单张 `sys:retry-streak-warn` 预警卡（提取错误输出最后一行非空摘要，限 120 字符），并在同 `(rule, lane)` 后续恢复成功时自动结案；
  - 配置 `tell: "always"` 的规则在轮次 `done` 且未显式产出 `ask`/`notice` 时，自动生成一张 `fyi: true` 执行简报卡并推送桌面通知；桌面通知标题统一增加 `[<rule>]` 前缀。

### Changed

- **审查轮次上限、超时与跨分支名 SHA 缓存解耦（`delivery/`）**：
  - `DEFAULT_MAX_REVIEW_ROUNDS` 默认值由 `3` 收敛为 **`2` 轮**（仍可通过 `.autoloop/delivery.json` 的 `maxReviewRounds` 按项目覆盖），单轮只读审查默认超时调整为 **30 分钟**（`DEFAULT_REVIEW_TIMEOUT_MS`）；
  - `review-ledger.json` 幂等缓存按 `(headSha, mergeBaseSha, reviewerModel)` 匹配，分支改名或跨分支引用同一提交 SHA 时直接复用既有审查结果，零重复 Token 消耗。
- **协议 Schema 与并发互斥收敛（`protocol/`、`kernel/`）**：
  - `rules.json` 顶层 `askFirst` 升级为**可选**字段：省略时自动注入 `DEFAULT_ASK_FIRST` 7 类高危红线，显式配置 `[]` 时保持为空；
  - `parseRulesConfig` 新增同并发组 `group` 有效 `parallel`（省略视为 `1`）一致性校验，不一致直接在配置加载期报错拦截；`canClaimRun` 强化同 `(grp, lane)` 跨规则严格单活跃互斥；
  - 入站与回执衍生事件 `link` 校验收紧为仅允许 `http://` 或 `https://` 协议；
  - `job.context.decided` 同时纳入 `"decided"` 与 `"done"` 状态的历史已批卡片，确保多轮续跑中已获批的 `approvedKeys` 不丢失；
  - 默认失败重试退避基数 `DEFAULT_RETRY_BASE_MS` 设为 **`60s`**（按 `60s * 2^(attempt-1)` 指数退避，上限 30 分钟）；轮次进入终态或规则被移除时自动清理关联的已触发 `timers` 记录。
- **macOS 桌面端启动与 CLI 兼容性增强（`mcp_config.json`、`engine/`）**：
  - `mcp_config.json` 启动命令注入 `$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin` 兼容 macOS GUI 精简 `PATH`；
  - `buildAgyArgs` 调整为末尾 `--print <prompt>` 参数顺序；`runAgentApiUi` 自动识别 `language_server` 可执行文件名并补齐 `agentapi` 子命令前缀。

### Fixed & Security

- **`PreToolUse` 三层控制面分级自保护（`hooks/pre-tool-guard.mjs`）**：
  - 区分**密级零访问层**（`guard.json`、`owner.token`、`ingest.token`、`master.key`、`ipc.json` 全面禁读写）、**数据库防篡改层**（`hub.db` / `-wal` / `-shm` 仅放行 `ls`/`stat`/`file` 元信息查看，禁读写篡改）与**只读上下文/配置层**（`context.json`、`rules.json` 放行 `cat`/`head`/`tail`/`sed -n`/`nl`/`awk` 非原地/`jq`/`python3 -m json.tool`/只读 `git`/`autoloop check|explain|status|why` 查看，硬拦截重定向覆盖、`sed -i` 及 `node -e` / `python -c` 等内联脚本写操作，同时守护全局 `~/.gemini/config/config.json`）；
  - 内置高危类别 `drop-db` 补齐 `"删除数据库"`、`"数据库删除"`、`"删除生产数据"` 中文别名与模式匹配，消除默认 `askFirst` 词表盲区。
- **坏历史会话自动降级与延迟 `session` 补报（`engine/supervisor.ts`、`engine/agy-runner.ts`）**：
  - 修复续接失效历史 `conversationId` 时反复卡死失败的问题：若带 `job.session` 启动未进入有效流式帧即非零退出（`!started && exitCode !== 0`），自动降级为 `session: null` 全新会话执行并向内核清空旧会话引用；若流式首帧无会话 ID 而后续帧返回真实 `session`，自动补发 `markStarted` 持久化。
- **中文审批语义防误判与 Runner 环境/流控加固（`engine/context-file.ts`、`engine/command-runner.ts`、`protocol/receipt.ts`）**：
  - `isApprovedChoice` 新增正向/中性中文双字词（如“不错”“不用等”“毫不犹豫”“级别”“识别”“是否”）预剥离，修复正向批复因含“不/别/否”单字被误判为拒绝的问题；
  - `agy-print`、`agentapi-ui`、`command` 三类执行器统一调用 `sanitizeRunnerEnv` 剥离控制面令牌；`command-runner` 引入首尾双窗口有界流收集器（`stdout` 64KB+512KB、`stderr` 64KB+256KB），既防巨量日志 OOM 又保证末尾 `agent-autoloop` 回执完整可解析；
  - `readMessage` 升级为自底向上精确围栏长度匹配，防止正文中未闭合代码块吞噬末尾合法回执，并兼容首行带 Markdown 标题/列表/加粗标记的结论识别。

---

## [1.0.0] - 2026-11-14

**Antigravity-Autoloop 首个全内生正式版发布**——在零第三方运行时依赖（纯 Node.js `>= 24` + `node:sqlite` + Antigravity `sidecar_sdk`）约束下，完整实现确定性事件驱动调度内核、「票拟—批红」零消耗挂起续接、生命周期硬门禁、异构模型审查交付与右侧辅助面板工作台。

### Added

- **冻结协议契约层（`protocol/`）**：完整定义 `rules.json` Schema、入站事件白名单校验、回执解析器（`readMessage` / `promptFor` / `repairPrompt`）及指令数据分离提示词构造器。
- **纯函数事件溯源内核（`kernel/`）**：实现零外部 IO 的确定性状态机 `decide`、增量投影 `evolve`、单事务 `IMMEDIATE` + `WAL` SQLite 存储引擎 `store`（指纹变更自动从 `facts` 全量重放重建）、5 段时区感知 `cron`（休眠唤醒 `latestBefore` 单次安全补跑）、统一到期索引 `due` 以及 `hops > 8` 跳数熔断器。
- **Antigravity 原生执行器与监督循环（`engine/`）**：实现 `agy-print` 无头流式会话续接执行器、`agentapi-ui` 可视化会话唤醒执行器、`command` 零 Token 静默探针执行器、运行级 `0700`/`0600` 物理隔离 `context.json`/`guard.json` 生成器与最多 2 次原会话回执修复的 `Supervisor`。
- **生命周期硬安全门禁（`hooks/`）**：内置 `PreToolUse` 高危动作与只读模式拦截钩子（`pre-tool-guard.mjs`）及 `Stop` 回执格式原地校验钩子（`stop-receipt-check.mjs`），非 Autoloop 会话毫秒级零干扰放行。
- **本地异构审查与五步安全交付流水线（`delivery/`）**：仅从受信任基线分支 Git 对象库读取 `.autoloop/delivery.json` 与 `AGENTS.md`，串联裸快照提取、Hydrogen ↔ Carbon 异构只读沙箱互审、一次性隔离 `git worktree` 门禁检查、`sensitivePaths` 奏折放行、CAS 原子合并与合并后冒烟验证。
- **常驻 Sidecar 宿主、批奏折工作台与 MCP / CLI 双通道（`sidecars/hub/`、`mcp/`、`cli/`）**：
  - 常驻 `SidecarApp` 承载右侧辅助面板 `sidecar://autoloop/hub/`（严格 `textContent` / DOM API 防 XSS 渲染）、本地 `fs.watch` 文件防抖触发器与参数隔离的 macOS `osascript` 原生通知；
  - Stdio MCP 服务 `autoloop_hub` 暴露 11 个 `autoloop_*` 工具，并在子代理环境下自动剥离管理审批工具防自批；
  - 双模 `autoloop` CLI（优先走 Sidecar IPC，离线无缝回退本地 SQLite）及 1 分钟闭环体验向导 `autoloop try`。
- **内置技能库与五层验证体系（`skills/`、`tests/`、`sim/`）**：随包提供 `autoloop-admin` 及首批 6 大内置场景技能（`morning-brief`、`issue-triage`、`code-sweep`、`pr-delivery`、`health-watch`、`idea-to-sop`），配套 `purity.test.ts` 架构纯洁性静态扫描、200,000 步确定性混沌模拟（`sim/random.ts`）与真实子进程随机 `SIGKILL` 崩溃恢复压测（`sim/crash-harness.ts`）。
