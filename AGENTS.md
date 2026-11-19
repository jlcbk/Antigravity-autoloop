# Antigravity-Autoloop 全局研发宪章（给所有参与研发与审查的 Agent）

在修改或新增本仓库任何文件之前，**必须**先阅读所负责模块对应的规格章节：
- 架构与冻结契约：[docs/03-system-architecture-and-protocol.md](docs/03-system-architecture-and-protocol.md)
- 子代理工作包边界：[docs/05-subagent-wbs-and-hydrogen-guide.md](docs/05-subagent-wbs-and-hydrogen-guide.md)
- 测试与验收门禁：[docs/06-testing-verification-and-acceptance.md](docs/06-testing-verification-and-acceptance.md)
- AI 视频制片厂 SOP：[docs/07-ai-video-production-sop.md](docs/07-ai-video-production-sop.md)
- 版本演进与变更日志：[CHANGELOG.md](CHANGELOG.md)

---

## 一、六条不可逾越的架构红线

1. **内核绝对纯洁（Kernel Purity）**：
   - `kernel/` 只负责四件事：**收事件、按规则分活、派活、记事实账本**。
   - `kernel/` **严禁**导入 `node:http`、`node:child_process`、`node:fs`（除 `kernel/store.ts` 仅导入 `node:sqlite` 外）、`sidecar_sdk` 或任何外部模块；**严禁**调用 `Date.now()`、`new Date()`（无参）、`Math.random()`、`crypto.randomUUID()`、`process.env`；**严禁**出现 `agy`、`agentapi`、`hydrogen`、`carbon`、`claude`、`feishu` 等具体运行时或模型名称。
   - 时间戳 `now`、环境密钥与配置一律由宿主层（`sidecars/hub/`）作为参数显式传入 `decide(view, input, now, env)`。`tests/purity.test.ts` 对此执行静态扫描门禁，违规直接阻断合并。
2. **零第三方运行时依赖（Zero Runtime Dependencies）**：
   - 运行环境固定为 Antigravity 内置兼容的 **Node.js >= 24**（原生支持 TypeScript 类型擦除直跑、`node:sqlite`、`node:test`、`fetch`、`fs.watch`）以及 Antigravity 内置的 `sidecar_sdk`。
   - `package.json` **严禁**添加 `"dependencies"` 字段；`devDependencies` 仅允许 `typescript`、`@types/node`、`prettier`。
3. **指令与数据严格分离（Instruction-Data Separation）**：
   - 外部或探针传入的事件文本（`summary`、`detail`）属于**不可信资料**，**严禁**拼接进发送给 Agent 的提示词字符串（Prompt）中。
   - 提示词只允许包含经过严格白名单正则校验的 `source`、`type`、`subject`、`link` 以及本地可信 `rules.json` 定义的 `cwd`、`skill`、`prompt`、`askFirst`。事件详情一律写入独立的只读 `context.json` 文件并明确声明其仅为参考资料。
4. **挂起零消耗（One Round Never Waits for Humans）**：
   - 任何执行器或工具均不得在进程内轮询等待人类审批或长周期外部状态。
   - 需要人类拍板（`ask`）或预约未来复查（`later`）时，Agent **必须**输出末尾 `agent-autoloop` JSON 回执代码块并立即结束当前轮次退出进程；等待期间零进程驻留、零 Token 消耗，待用户在辅助面板点击卡片或定时器到期后再按原 `conversationId` 续接唤醒。
5. **事实溯源与单事务提交（Single-Transaction Event Sourcing）**：
   - `facts` 只追加日志是唯一权威状态源。每次状态变更必须在同一个 SQLite `IMMEDIATE` 事务（`WAL` + `synchronous = FULL`）内完成：`decide` 产出 `Fact` → `store` 追加日志 → `evolve` 更新 `projections` 与 `due` 索引，落盘成功后才向调用方返回确认。
   - 升级表结构或查询视图不写迁移脚本，指纹变化时从 `facts` 全量确定性重放重建。
6. **跳数熔断（Hop Circuit Breaker）**：
   - Agent 回执触发的衍生事件必须继承当前轮次最大 `hops + 1`（即使跨越人工 `ask` 问答或 `later` 定时复查也不清零）。当 `hops > 8` 时，仅记录事件并生成一张系统熔断告警卡片，**严禁**继续派发新轮次。

---

## 二、多子代理（Hydrogen）并行协作铁律

1. **严守文件所有权边界（Strict File Ownership）**：
   - 每个子代理只能创建或修改其工作包（`WP-xx`）在 `Owned Paths` 中显式列出的文件。
   - 发现上游冻结契约（`protocol/`）确需调整时，**严禁自行修改**，必须立刻在协作看板 `@coordinator` 报告原因与影响范围，由协调者统一裁决。
2. **契约先行，禁止臆造字段**：
   - 所有跨模块调用（`kernel` ↔ `sidecar`、`sidecar` ↔ `engine`、`sidecar` ↔ `mcp`、`sidecar` ↔ `ui`、`hooks` ↔ `engine`）必须严格遵循 `docs/03-system-architecture-and-protocol.md` 中定义的字段名、状态枚举与错误码。
3. **测试先行（TDD First）**：
   - 每个行为测试文件顶部用注释写明**它防止哪一种真实故障或安全越界**。
   - 先写失败测试，再写最小必要实现；不写复述实现细节的脆弱测试，不为凑覆盖率堆砌无意义 Mock。
4. **独立工作树提交与审查分离**：
   - 并行编码子代理使用 `workspace: "share"` 在各自工作树完成开发，提交前必须通过 `npm run typecheck` 与本模块对应的 `node --test` 命令。
   - 验证子代理（Verifier）**只读不改**：发现缺陷时在看板指明 `文件路径:行号`、触发条件与复现命令并 `@原作者` 修复，严禁 Verifier 直接下场改代码引发双写冲突。

---

## 三、审查必查清单（踩中任意一条即打回）

审查子代理（Verifier）与本地交付审查器只拦截**真实功能缺陷与架构越界**，不纠结个人代码风格偏好。以下情况一律判定为阻塞级缺陷（Must Fix）：

- `kernel/` 出现外部模块导入、系统时钟/随机数读取、环境变量读取，或出现具体模型/产品硬编码字符串。
- 事件的 `summary` 或 `detail` 原文被拼入提示词，或事件 payload 能够篡改执行目录 `cwd`、模型 `model`、权限档位 `access`。
- 同一 `source + id` 事件被重复入账或重复派单；同一 `group` 并发超过 `parallel` 上限，或单规则/单模型超过 `maxActive` 上限。
- 轮次失败重试时，未将该事项（`rule + lane`）排队期间新到达的事件合并进重试轮次；或者已连接上原会话（`started = true`）后中断却开启全新会话导致有副作用的操作重做一遍。
- 回执 JSON 格式写错时，把已完成的业务重做了一遍（正确做法：在原会话仅发送 `repairPrompt` 重写最后一条回复，最多 2 次；若首轮业务已完成 `done`/`nothing` 但 2 次修复后回执仍损坏或无可用会话，必须走 `discardReceipt` 安全降级保留首轮结论（`done` 时推告警通知卡），严禁标为 `failed` 触发整轮副作用重跑）。
- 同一张 `open` 提问卡片被回答两次，或回答与 `resolve` 同时生效；用户点击停止（`cancel`）后，已杀死的进程返回非零退出码又被当成 `failed` 自动重派。
- `PreToolUse` 安全门禁漏放命中了未授权 `askFirst` 规则的危险命令（含子 Shell / 内联脚本绕过或将中英文否定批复误判为已授权），或未保护控制面密钥/数据库/规则文件与 `guard.json` 本身（密级文件零访问、`hub.db*` 与 `rules.json` 严禁覆写、`guard.json` 损坏须 fail-closed 拒绝），或辅助面板 UI 将不可信事件文本以 `innerHTML` 未转义直接渲染导致 XSS。
- Antigravity 插件配置违规：修改用户全局 `~/.gemini/config/config.json`、使用通配符权限（如 `command(*)`），或 MCP 服务名未加 `autoloop` 命名空间前缀。
