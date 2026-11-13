---
name: recipe-code-sweep
description: >-
  Use this skill for periodic automated code sweeps: consulting
  .autoloop/declined.md and decisions.md first, scanning for dead code,
  duplicated helpers, and stale comments, exiting silently with NOTHING when
  there is no meaningful payoff, or landing verified cleanups on a dedicated
  branch and emitting a delivery event or notice.
---

# 定期代码大扫除 SOP（Code Sweep）

本 SOP 旨在用 Hydrogen 模型周期性清理仓库技术债（死代码、重复工具逻辑、过期注释），同时严格奉行**「没有高价值收益绝不制造噪声，拒绝重复提议曾被否决的重构」**。

## 1. 原则与红线

1. **宁缺毋滥**：严禁为了刷存在感做纯格式调整、重命名偏好改动或把清晰代码过度抽象。
2. **尊重历史否决**：每次扫描前必须先查 `.autoloop/declined.md`，凡曾被用户拒绝的模块、模式或清理提议，**永久跳过，不得再次修改也不得再次发卡询问**。
3. **测试与契约铁律**：不得修改测试断言来迁就改动，不得删除仍被公开导出或外部脚本依赖的接口，不得删除有价值的文档注释。

## 2. 执行步骤

### Step 1：核对双账本与上次状态

1. 只读查看 `context.json`（关注 `answers` 是否刚获批某项清理，以及 `open` 中是否已有未结大扫除卡片）。
2. 读取 `<cwd>/.autoloop/declined.md` 与 `<cwd>/.autoloop/decisions.md`：
   - 汇总禁用重构区域与已知保留代码白名单。

### Step 2：高价值技术债扫描

重点排查以下 3 类具备确定收益的清理项：

1. **死代码与孤儿实现**：确认全仓库零引用（含动态导入、配置清单、测试与脚本）的私有函数、废弃开关、未使用的局部常量或重复定义的辅助类型。
2. **明显重复逻辑**：同一模块或相邻模块中出现完全同构的复制粘贴逻辑块，可安全收敛为单一纯函数辅助器且不引入额外复杂度。
3. **误导性过期注释**：与当前真实实现明显矛盾的注释、指向已删除文件或已更名符号的陈旧引用。

### Step 3：收益评估与分支决策

#### 情况 A：无实质清理收益（默认静默结案）

若未发现高确定性收益点，或候选点均命中 `declined.md`：

- **首行必须以 `没事可做：` 开头**（如：`没事可做：本次巡检已完成，未发现不在 declined.md 白名单内的死代码或高价值重复逻辑。`）。
- **不要**发送 `notice` 或 `ask` 卡片（直接结束回复，保持工作台绝对安静）。

#### 情况 B：存在安全明确的高价值清理

1. 从主干切出独立清理分支（如 `chore/code-sweep-20261114`），确保不在主工作区直接留下未提交散落改动。
2. 实施最小必要清理（单次大扫除建议聚焦 1～3 个高置信点，保持 Diff 极易人工或异构模型审查）。
3. 运行全量校验命令（如 `npm run typecheck` 与 `npm test` / 对应 `node --test` 套件），**必须全部通过且无跳过用例**。
4. 提交分支并在末尾 ` ```agent-autoloop ` 回执中二选一收尾：
   - 若规则配置了 `emits` 允许 `git.branch.ready`：通过 `events` 发出 `git.branch.ready` 交给下游异构审查交付流水线，附带一条 `fyi: true` 简要战报；
   - 若未接下游交付流水线：发送一条普通 `notice` 卡片列出分支名、清理清单与实测通过的命令结果，请用户查收合并。

#### 情况 C：发现高价值但涉及公共契约或跨模块重构

- 若清理会改动冻结接口、删除导出符号或涉及 `askFirst` 动作：
- 不动手改代码，发送带 `recommend` 票拟的 `ask` 卡片说明收益与风险，待批红后再于原会话续办。

## 3. 回执示例

### 情况 A：无需清理（静默退出）

```text
没事可做：已扫描 kernel/、engine/ 与 protocol/，未发现高置信死代码或重复逻辑（已跳过 declined.md 记录的 legacy-adapter 模块）。
```

### 情况 B：清理完成并送审

````text
已完成本周代码大扫除（分支 chore/code-sweep-20261114），清理 2 处重复校验逻辑并通过全部检查。

```agent-autoloop
{
  "events": [
    {
      "id": "sweep-20261114-chore-code-sweep",
      "type": "git.branch.ready",
      "subject": "chore/code-sweep-20261114",
      "summary": "Deduplicate validation helpers and remove dead constant"
    }
  ],
  "notice": [
    {
      "key": "code-sweep-2026-11-14",
      "title": "周期代码大扫除已完成送审",
      "text": "分支 chore/code-sweep-20261114 已合并 2 处重复校验辅助函数并移除 1 处废弃常量，typecheck 与全部单元测试通过，已提交下游审查。",
      "fyi": true
    }
  ]
}
```
````

## 4. `rules.json` 配置片段示例

```json
{
  "sources": {
    "sweep": { "name": "Code Sweep" }
  },
  "agents": {
    "hydrogen-sweeper": {
      "name": "Hydrogen Code Sweeper",
      "runner": "agy-print",
      "model": "gemini-4-hydrogen-high",
      "effort": "high",
      "access": "edit",
      "maxActive": 1,
      "timeoutMinutes": 45
    }
  },
  "rules": [
    {
      "name": "weekly-code-sweep",
      "when": { "cron": "0 3 * * 1" },
      "to": "hydrogen-sweeper",
      "cwd": "~/Documents/Projects/your-project",
      "skill": "recipe-code-sweep",
      "title": "sweep-{id}",
      "emits": { "source": "sweep", "types": ["git.branch.ready"] }
    }
  ]
}
```
