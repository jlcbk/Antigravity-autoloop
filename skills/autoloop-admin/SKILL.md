---
name: autoloop-admin
description: >-
  Use this skill whenever the user wants to inspect, configure, troubleshoot, or
  control Antigravity-Autoloop: checking status or causal history (why),
  authoring or validating rules.json, managing .autoloop/decisions.md and
  .autoloop/declined.md ledgers, answering or resolving cards, pausing/resuming/
  replaying/running/stopping rules, or opening the Autoloop workbench panel.
---

# Autoloop 中台总管与规则编排指南

本手册指导 Antigravity 主代理协同管理 **Antigravity-Autoloop** 事件中台、批奏折工作台、声明式规则 `rules.json` 与长期决策双账本。

## 1. 核心交互面与 MCP 工具清单

### 1.1 右侧辅助面板（批奏折工作台）

当需要引导用户查看待批「票拟」卡片、实时流水线状态或历史因果链时，在回复中给出可点击入口：

`[Autoloop 工作台](sidecar://autoloop/hub/)`

### 1.2 `autoloop_hub` MCP 工具集

在主对话中优先使用以下 MCP 工具操控中台（工具名均带 `autoloop_` 前缀）：

| 工具名                   | 权限类别 | 用途与使用时机                                                                                                             |
| :----------------------- | :------- | :------------------------------------------------------------------------------------------------------------------------- |
| `autoloop_status`        | 只读     | 查看待批 `open` 卡片、各规则流水线状态（运行中/空闲/已暂停）、今日与近 7 日轮次及 Token 消耗。                             |
| `autoloop_why`           | 只读     | 按 `run` ID 查询完整因果账本（触发事件、规则版本、执行模型、工作区、Token 用量、回执明细与可跳转会话 ID）。                |
| `autoloop_explain_rules` | 只读     | 对当前或草稿 `rules.json` 做 Schema 校验，解释事件路由去向、并发组与下次 Cron 触发时间。**修改规则前必须先用此工具校验。** |
| `autoloop_answer`        | 本人管理 | 在聊天框代用户批复指定 `open` 提问卡（传入 `card` 与 `choice` 下标或自由文本 `text`），原子唤醒原会话续办。                |
| `autoloop_resolve`       | 本人管理 | 将已过时或核实无需再处理的卡片标记结案（传入 `card` 与 `reason`）。                                                        |
| `autoloop_emit`          | 事件投递 | 向中台注入标准本地事件（如触发 `idea.ingest`、`git.branch.ready` 或手动测试事件），按 `source + id` 幂等去重。             |
| `autoloop_pause`         | 本人管理 | 暂停指定规则（支持 `until` 定时自动恢复），暂停期间跳过事件仅记录不积压。                                                  |
| `autoloop_resume`        | 本人管理 | 恢复已暂停的规则，并返回暂停期间跳过的事件列表供决定是否补跑。                                                             |
| `autoloop_replay`        | 本人管理 | 按 `since` 对暂停期间跳过的事件执行补跑（每条仅补一次，避免雪崩）。                                                        |
| `autoloop_run`           | 本人管理 | 立即手动触发指定规则执行一轮。                                                                                             |
| `autoloop_stop`          | 本人管理 | 强制停止运行中或排队中的轮次（先 `SIGTERM` 后 `SIGKILL` 清理进程组；内核强制归入 `cancelled`，绝不触发失败重试）。         |

> **权限隔离机制**：当子代理处于 Autoloop 调度上下文中（环境变量含 `AUTOLOOP_RUN_ID`）时，`mcp/server.mjs` 会自动剥离 `autoloop_answer`、`autoloop_resolve`、`autoloop_pause`、`autoloop_stop` 等本人管理权限，彻底防止子代理「自己批自己的奏折」。

### 1.3 本地诊断 CLI 对应命令

在终端排障或离线预演时，可使用 `autoloop` CLI：

- `autoloop status [--json]` / `autoloop why <run>`
- `autoloop check [draft.json]` / `autoloop explain [draft.json]`
- `autoloop emit <type> [--dry-run]`
- `autoloop pause` / `autoloop resume` / `autoloop replay` / `autoloop run` / `autoloop stop` / `autoloop answer`
- `autoloop try`（1 分钟端到端试跑与零消耗挂起体验）

---

## 2. `rules.json` 标准结构与模型分工策略

配置文件位于 `<AUTOLOOP_HOME>/rules.json`（默认 `~/.gemini/antigravity/autoloop_data/rules.json`，支持热加载；若新配置校验失败，系统会保留上一版有效规则继续运行并推送告警卡片）。

### 2.1 顶层冻结字段（严格白名单，禁止多余未知字段）

- `timezone`（可选）：合法 IANA 时区字符串，如 `"Asia/Shanghai"`。
- `askFirst`（必填字符串数组）：全局必须先上呈 `ask`「票拟」卡片获批的高危动作类别与命令模式，例如 `["rm -rf", "git push --force", "git reset --hard", "删除数据库", "对外发送消息", "修改密钥或权限", "产生实质费用"]`。
- `sources`（对象）：声明事件源键名到显示名称的映射 `{ "<sourceKey>": { "name": "显示名称" } }`。**不同源的 `name` 不能重复**。
- `agents`（对象）：定义可调度的执行角色池。
- `rules`（数组）：定义事件或定时触发路由规则（`name` 不能重复）。

### 2.2 四种 `runner` 与模型分工策略

每个 `agents.<id>` 允许字段为 `name`（全池唯一）、`runner`、`model`、`effort`、`access`、`command`、`maxActive`、`timeoutMinutes`：

| `runner` 值     | 适用场景                                                                 | 关键配置与分工建议                                                                                                                                                                                                                                                                                                                                                                    |
| :-------------- | :----------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `"agy-print"`   | **主力无头执行器**（单轮完成即退出进程，支持 `--conversation` 无损续接） | 支持 `model`、`effort`（`low`/`medium`/`high`/`xhigh`/`max`）、`access`（`read`/`edit`/`full`，默认 `edit`）。<br/>• `gemini-4-hydrogen-medium` / `high`：每日晨报、代码大扫除、日常运维、新观点拆解统筹；<br/>• `gemini-4-hydrogen-xhigh`：高复杂度架构排障、异构只读安全审查（配 `access: "read"`）；<br/>• `gemini-4-carbon-high`：主力功能开发（与 Hydrogen 形成异构开发/互审）。 |
| `"agentapi-ui"` | **可视化交互会话 / 浏览器子代理场景**                                    | 需打开客户端可见会话或联动内置 `browser` 子代理时使用，支持 `new-conversation` 与 `send-message` 续接。                                                                                                                                                                                                                                                                               |
| `"command"`     | **零 Token 本地探针**                                                    | **必须**提供非空参数数组 `command`（如 `["node", "./probes/check.mjs"]`）；非 `command` 类型严禁配置该字段。无变化退出码 0 不消费任何模型 Token。                                                                                                                                                                                                                                     |
| `"delivery"`    | **本地异构审查与隔离 Worktree 交付器**                                   | 用于接管 `git.branch.ready` 等分支交付事件，执行只读 Diff 审查与临时 Worktree 检查合并。                                                                                                                                                                                                                                                                                              |

### 2.3 `rules[]` 核心字段与三大触发器

每条规则支持以下字段（所有字段名均受严格校验）：

- `name`：规则唯一名称。
- `when`（三选一）：
  1. **定时触发**：`{ "cron": "0 9 * * *" }`（严格 5 段 Cron；休眠唤醒后通过 `latestBefore` 仅安全补跑最近一次）。
  2. **事件源路由**：`{ "source": "<sourceKey>", "types": ["issue.*", "inbox.new"] }`（`source` 必须在 `sources` 中已定义，`types` 支持 `*` 通配符，字符集 `[a-zA-Z0-9._*-]`）。
  3. **本地文件监听**：`{ "watch": { "paths": ["~/project/.autoloop/inbox"], "debounceMs": 1500, "types": ["inbox.file"] } }`（`debounceMs` 为非负整数）。
- `to`：对应 `agents` 中的角色键名。
- `cwd`：工作区目录，**必须是绝对路径（`/` 开头）或 `~` / `~/` 路径**。
- `skill`（可选）：加载的 Skill 名称（如 `"recipe-morning-brief"`）。
- `prompt`（可选）：可信本地补充指令。
- `title`（可选）：会话标题模板，**必须以字母或数字开头且绝对不能包含空白字符**（匹配 `/^[a-zA-Z0-9]\S*$/`），仅支持 `{subject}` 与 `{id}` 占位符，例如 `"triage-{subject}"`。
- `group` / `parallel` / `maxActive`（并发控制）：
  - `group` 默认等于规则 `name`；
  - 设置 `parallel`（正整数）时，系统按事件 `subject` 自动切分独立事项（Lane），同 `group` 下同时运行的轮次不超过 `parallel`；同一事项新来事件自动排队合并；
  - `maxActive`（正整数）限制单条规则最大同时运行轮数。
- `resume`（布尔值，默认 `false`）：同事项后续事件是否默认续接上一轮成功会话（注：`ask` 批红与 `later` 到期唤醒会自动续接原 `session`）。
- `tell`（`"always" | "needed" | "never"`，默认 `"needed"`）：通知策略。
- `emits`（可选）：`{ "source": "<sourceKey>", "types": ["git.branch.ready"] }`。仅白名单内衍生事件才被允许从回执发出，且每跳自动继承 `hops + 1`（`hops > 8` 强制熔断）。

### 2.4 完整 `rules.json` 参考样例

```json
{
  "timezone": "Asia/Shanghai",
  "askFirst": [
    "rm -rf",
    "git push --force",
    "git reset --hard",
    "删除数据库",
    "对外发送消息",
    "修改密钥或权限",
    "产生实质费用"
  ],
  "sources": {
    "inbox": { "name": "Local Inbox" },
    "triage": { "name": "Issue Triage" },
    "manual": { "name": "Manual Emit" }
  },
  "agents": {
    "hydrogen-brief": {
      "name": "Hydrogen Brief Reader",
      "runner": "agy-print",
      "model": "gemini-4-hydrogen-medium",
      "effort": "medium",
      "access": "read",
      "maxActive": 1,
      "timeoutMinutes": 15
    },
    "hydrogen-worker": {
      "name": "Hydrogen Worker",
      "runner": "agy-print",
      "model": "gemini-4-hydrogen-high",
      "effort": "high",
      "access": "edit",
      "maxActive": 2,
      "timeoutMinutes": 45
    },
    "carbon-architect": {
      "name": "Carbon Architect",
      "runner": "agy-print",
      "model": "gemini-4-carbon-high",
      "effort": "high",
      "access": "edit",
      "maxActive": 1,
      "timeoutMinutes": 60
    },
    "hydrogen-reviewer": {
      "name": "Hydrogen XHigh Reviewer",
      "runner": "agy-print",
      "model": "gemini-4-hydrogen-xhigh",
      "effort": "xhigh",
      "access": "read",
      "maxActive": 2,
      "timeoutMinutes": 30
    }
  },
  "rules": [
    {
      "name": "morning-brief",
      "when": { "cron": "0 9 * * *" },
      "to": "hydrogen-brief",
      "cwd": "~/Documents/Projects/my-repo",
      "skill": "recipe-morning-brief",
      "title": "brief-{id}",
      "tell": "needed"
    },
    {
      "name": "issue-triage",
      "when": { "source": "inbox", "types": ["issue.*"] },
      "to": "hydrogen-worker",
      "cwd": "~/Documents/Projects/my-repo",
      "skill": "recipe-issue-triage",
      "title": "triage-{subject}",
      "group": "repo-work",
      "parallel": 2,
      "resume": true,
      "emits": { "source": "triage", "types": ["git.branch.ready"] }
    }
  ]
}
```

---

## 3. 长期记忆双账本规范（定过的事绝不二问）

所有受 Autoloop 托管的业务工作区，应在 `<cwd>/.autoloop/` 下维护两份确定性 Markdown 账本。任何自动化 SOP 在分析问题、提出重构或发起 `ask` 奏折卡前，**必须先读取这两份文件**：

1. **`.autoloop/decisions.md`（已采纳圣旨与偏好账本）**
   - 记录经用户「批红」确认的技术选型、代码风格偏好、工作流路径、输出格式、批准边界。
   - **格式规范**：
     ```markdown
     ## [YYYY-MM-DD] <决策主题>

     - **来源**：Card #<id> / Run #<run>（或对话确认）
     - **生效范围**：<目录 / 规则 / 全局>
     - **裁决结论**：<明确可执行的偏好或规则>
     ```
2. **`.autoloop/declined.md`（已否决方向账本）**
   - 记录用户明确拒绝、叫停或证明无效的提议（如不愿重构的遗留模块、拒绝引入的工具链、不需要自动化的方向）。
   - **格式规范**：
     ```markdown
     ## [YYYY-MM-DD] <被否决提议>

     - **来源**：Card #<id> / Run #<run>
     - **涉及范围**：<文件 / 模块 / 工具>
     - **否决原因**：<用户批注或复盘原因>
     - **禁忌约束**：后续巡检与拆解不得再次提议或发起同类 ask 卡片。
     ```

---

## 4. 安全边界与日常排障操作流程

### 4.1 修改或新增规则的标准流程

1. 与用户确认触发时机、工作区 `cwd`、执行模型档位与 `askFirst` 边界。
2. 构造草稿 JSON，先调用 `autoloop_explain_rules`（或运行 `autoloop check draft.json`）确认零报错且 Cron 下次触发时刻符合预期。
3. 写入 `<AUTOLOOP_HOME>/rules.json` 后，再调用一次 `autoloop_status` 核实新流水线已热加载就绪。

### 4.2 轮次异常或卡住时的排障步骤

1. 调用 `autoloop_status` 定位异常的 `run` 编号或规则名。
2. 调用 `autoloop_why` 查看该轮次的规则版本、输入事件 `context.json` 摘要、模型用量、错误原因及 `session`。
3. 常见处置：
   - **配置错误导致不断失败**：先 `autoloop_pause` 暂停该规则，修复问题后再 `autoloop_resume` 并按需 `autoloop_replay`。
   - **需要立即终止失控轮次**：调用 `autoloop_stop`，告知用户可在 `[Autoloop 工作台](sidecar://autoloop/hub/)` 查看最终 `cancelled` 状态。
   - **回执格式报错**：确认 Agent 遵守「首行结论 + 末尾独占一行开始的 ` ```agent-autoloop ` 代码块 + 独占一行的结束 ` ``` `」，切勿标为 ` ```json `。
