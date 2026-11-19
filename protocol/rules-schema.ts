import type {
  AccessTier,
  AgentProfile,
  EffortLevel,
  RuleSpec,
  RuleTrigger,
  RulesConfig,
  RunnerKind,
  TellPolicy,
} from "./types.ts";
import {
  ProtocolInputError,
  assertAllowedKeys,
  assertNonEmptyString,
  assertPlainObject,
} from "./validate.ts";

export const DEFAULT_ASK_FIRST: readonly string[] = [
  "rm -rf",
  "git push --force",
  "git reset --hard",
  "删除数据库",
  "对外发送消息",
  "修改密钥或权限",
  "产生实质费用",
];

const RULES_CONFIG_KEYS = new Set([
  "timezone",
  "askFirst",
  "sources",
  "agents",
  "rules",
]);

const SOURCE_KEYS = new Set(["name"]);
const AGENT_KEYS = new Set([
  "name",
  "runner",
  "model",
  "effort",
  "access",
  "command",
  "maxActive",
  "timeoutMinutes",
]);

const RULE_KEYS = new Set([
  "name",
  "when",
  "to",
  "cwd",
  "skill",
  "prompt",
  "title",
  "group",
  "parallel",
  "maxActive",
  "resume",
  "tell",
  "emits",
]);

const WATCH_KEYS = new Set(["paths", "debounceMs", "types"]);
const EMITS_KEYS = new Set(["source", "types"]);

const VALID_RUNNERS = new Set<RunnerKind>([
  "agy-print",
  "agentapi-ui",
  "command",
  "delivery",
]);
const VALID_EFFORTS = new Set<EffortLevel>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const VALID_ACCESS = new Set<AccessTier>(["read", "edit", "full"]);
const VALID_TELL = new Set<TellPolicy>(["always", "needed", "never"]);

const TYPE_PATTERN_RE = /^[a-zA-Z0-9._*-]+$/;
const TITLE_TEMPLATE_RE = /^[a-zA-Z0-9]\S*$/;
const CRON_FIVE_FIELDS_RE = /^\S+(?:\s+\S+){4}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

function assertPositiveInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ProtocolInputError(`${label} 必须是正整数`);
  }
  return value;
}

function assertIdentifierKey(key: string, label: string): void {
  if (key.length === 0 || /\s/.test(key) || CONTROL_CHAR_RE.test(key)) {
    throw new ProtocolInputError(
      `${label} 键名 "${key}" 不能为空且不能包含空白或控制字符`,
    );
  }
}

function parseTypePatterns(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProtocolInputError(`${label} 必须是非空字符串数组`);
  }
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const t = assertNonEmptyString(value[i], `${label}[${i}]`, 64);
    if (!TYPE_PATTERN_RE.test(t)) {
      throw new ProtocolInputError(`${label}[${i}] 仅允许 [a-zA-Z0-9._*-]`);
    }
    out.push(t);
  }
  return out;
}

function parseAgent(agentId: string, raw: unknown): AgentProfile {
  const label = `agents.${agentId}`;
  assertIdentifierKey(agentId, "agents");
  const obj = assertPlainObject(raw, label);
  assertAllowedKeys(obj, AGENT_KEYS, label);

  const name = assertNonEmptyString(obj.name, `${label}.name`);
  if (
    typeof obj.runner !== "string" ||
    !VALID_RUNNERS.has(obj.runner as RunnerKind)
  ) {
    throw new ProtocolInputError(
      `${label}.runner 必须是 "agy-print"、"agentapi-ui"、"command" 或 "delivery"`,
    );
  }
  const runner = obj.runner as RunnerKind;

  const profile: AgentProfile = {
    name,
    runner,
    access: "edit",
    timeoutMinutes: 60,
  };

  if (obj.model !== undefined) {
    profile.model = assertNonEmptyString(obj.model, `${label}.model`);
  }

  if (obj.effort !== undefined) {
    if (
      typeof obj.effort !== "string" ||
      !VALID_EFFORTS.has(obj.effort as EffortLevel)
    ) {
      throw new ProtocolInputError(
        `${label}.effort 必须是 "low"、"medium"、"high"、"xhigh" 或 "max"`,
      );
    }
    profile.effort = obj.effort as EffortLevel;
  }

  if (obj.access !== undefined) {
    if (
      typeof obj.access !== "string" ||
      !VALID_ACCESS.has(obj.access as AccessTier)
    ) {
      throw new ProtocolInputError(
        `${label}.access 必须是 "read"、"edit" 或 "full"`,
      );
    }
    profile.access = obj.access as AccessTier;
  }

  if (obj.command !== undefined) {
    if (runner !== "command") {
      throw new ProtocolInputError(
        `${label}.command 仅允许用于 runner === "command"`,
      );
    }
    if (!Array.isArray(obj.command) || obj.command.length === 0) {
      throw new ProtocolInputError(`${label}.command 必须是非空参数数组`);
    }
    profile.command = obj.command.map((arg, idx) =>
      assertNonEmptyString(arg, `${label}.command[${idx}]`),
    );
  } else if (runner === "command") {
    throw new ProtocolInputError(
      `${label}.command 在 runner === "command" 时必填`,
    );
  }

  if (obj.maxActive !== undefined) {
    profile.maxActive = assertPositiveInt(obj.maxActive, `${label}.maxActive`);
  }

  if (obj.timeoutMinutes !== undefined) {
    profile.timeoutMinutes = assertPositiveInt(
      obj.timeoutMinutes,
      `${label}.timeoutMinutes`,
    );
  }

  return profile;
}

function parseRuleTrigger(
  raw: unknown,
  sources: Record<string, { name: string }>,
  label: string,
): RuleTrigger {
  const obj = assertPlainObject(raw, label);
  const keys = Object.keys(obj);

  if (keys.includes("cron")) {
    assertAllowedKeys(obj, new Set(["cron"]), label);
    const cron = assertNonEmptyString(obj.cron, `${label}.cron`).trim();
    if (!CRON_FIVE_FIELDS_RE.test(cron)) {
      throw new ProtocolInputError(`${label}.cron 必须是 5 段标准 Cron 表达式`);
    }
    return { cron };
  }

  if (keys.includes("watch")) {
    assertAllowedKeys(obj, new Set(["watch"]), label);
    const watchObj = assertPlainObject(obj.watch, `${label}.watch`);
    assertAllowedKeys(watchObj, WATCH_KEYS, `${label}.watch`);

    if (!Array.isArray(watchObj.paths) || watchObj.paths.length === 0) {
      throw new ProtocolInputError(`${label}.watch.paths 必须是非空路径数组`);
    }
    const paths = watchObj.paths.map((p, idx) =>
      assertNonEmptyString(p, `${label}.watch.paths[${idx}]`),
    );

    const watch: { paths: string[]; debounceMs?: number; types?: string[] } = {
      paths,
    };
    if (watchObj.debounceMs !== undefined) {
      if (
        typeof watchObj.debounceMs !== "number" ||
        !Number.isSafeInteger(watchObj.debounceMs) ||
        watchObj.debounceMs < 0
      ) {
        throw new ProtocolInputError(
          `${label}.watch.debounceMs 必须是非负整数`,
        );
      }
      watch.debounceMs = watchObj.debounceMs;
    }
    if (watchObj.types !== undefined) {
      watch.types = parseTypePatterns(watchObj.types, `${label}.watch.types`);
    }
    return { watch };
  }

  if (keys.includes("source") || keys.includes("types")) {
    assertAllowedKeys(obj, new Set(["source", "types"]), label);
    const source = assertNonEmptyString(obj.source, `${label}.source`);
    if (!Object.prototype.hasOwnProperty.call(sources, source)) {
      throw new ProtocolInputError(
        `${label}.source 引用了未定义的事件源: ${source}`,
      );
    }
    const types = parseTypePatterns(obj.types, `${label}.types`);
    return { source, types };
  }

  throw new ProtocolInputError(
    `${label} 必须为 { cron }、{ source, types } 或 { watch } 之一`,
  );
}

function parseRule(
  raw: unknown,
  index: number,
  sources: Record<string, { name: string }>,
  agents: Record<string, AgentProfile>,
): RuleSpec {
  const label = `rules[${index}]`;
  const obj = assertPlainObject(raw, label);
  assertAllowedKeys(obj, RULE_KEYS, label);

  const name = assertNonEmptyString(obj.name, `${label}.name`);
  if (CONTROL_CHAR_RE.test(name)) {
    throw new ProtocolInputError(`${label}.name 不能包含控制字符`);
  }

  const when = parseRuleTrigger(obj.when, sources, `${label}.when`);

  const to = assertNonEmptyString(obj.to, `${label}.to`);
  if (!Object.prototype.hasOwnProperty.call(agents, to)) {
    throw new ProtocolInputError(`${label}.to 引用了未定义的执行角色: ${to}`);
  }

  const cwd = assertNonEmptyString(obj.cwd, `${label}.cwd`);
  if (CONTROL_CHAR_RE.test(cwd)) {
    throw new ProtocolInputError(`${label}.cwd 不能包含控制字符`);
  }
  if (!cwd.startsWith("/") && cwd !== "~" && !cwd.startsWith("~/")) {
    throw new ProtocolInputError(`${label}.cwd 必须是绝对路径或 ~/ 开头路径`);
  }

  const rule: RuleSpec = {
    name,
    when,
    to,
    cwd,
    group: name,
    resume: false,
    tell: "needed",
  };

  if (obj.skill !== undefined) {
    const skill = assertNonEmptyString(obj.skill, `${label}.skill`);
    if (CONTROL_CHAR_RE.test(skill)) {
      throw new ProtocolInputError(`${label}.skill 不能包含控制字符`);
    }
    rule.skill = skill;
  }

  if (obj.prompt !== undefined) {
    rule.prompt = assertNonEmptyString(obj.prompt, `${label}.prompt`);
  }

  if (obj.title !== undefined) {
    if (typeof obj.title !== "string" || obj.title.length === 0) {
      throw new ProtocolInputError(`${label}.title 必须是非空字符串`);
    }
    if (CONTROL_CHAR_RE.test(obj.title) || !TITLE_TEMPLATE_RE.test(obj.title)) {
      throw new ProtocolInputError(
        `${label}.title 必须以字母或数字开头且不能包含空白字符`,
      );
    }
    rule.title = obj.title;
  }

  if (obj.group !== undefined) {
    rule.group = assertNonEmptyString(obj.group, `${label}.group`);
  }

  if (obj.parallel !== undefined) {
    rule.parallel = assertPositiveInt(obj.parallel, `${label}.parallel`);
  }

  if (obj.maxActive !== undefined) {
    rule.maxActive = assertPositiveInt(obj.maxActive, `${label}.maxActive`);
  }

  if (obj.resume !== undefined) {
    if (typeof obj.resume !== "boolean") {
      throw new ProtocolInputError(`${label}.resume 必须是布尔值`);
    }
    rule.resume = obj.resume;
  }

  if (obj.tell !== undefined) {
    if (
      typeof obj.tell !== "string" ||
      !VALID_TELL.has(obj.tell as TellPolicy)
    ) {
      throw new ProtocolInputError(
        `${label}.tell 必须是 "always"、"needed" 或 "never"`,
      );
    }
    rule.tell = obj.tell as TellPolicy;
  }

  if (obj.emits !== undefined) {
    const emitsObj = assertPlainObject(obj.emits, `${label}.emits`);
    assertAllowedKeys(emitsObj, EMITS_KEYS, `${label}.emits`);
    const source = assertNonEmptyString(
      emitsObj.source,
      `${label}.emits.source`,
    );
    if (!Object.prototype.hasOwnProperty.call(sources, source)) {
      throw new ProtocolInputError(
        `${label}.emits.source 引用了未定义的事件源: ${source}`,
      );
    }
    const types = parseTypePatterns(emitsObj.types, `${label}.emits.types`);
    rule.emits = { source, types };
  }

  return rule;
}

/**
 * Parse, validate, and apply defaults to a RulesConfig payload.
 */
export function parseRulesConfig(input: unknown): RulesConfig {
  const obj = assertPlainObject(input, "RulesConfig");
  assertAllowedKeys(obj, RULES_CONFIG_KEYS, "RulesConfig");

  let timezone: string | undefined;
  if (obj.timezone !== undefined) {
    timezone = assertNonEmptyString(obj.timezone, "RulesConfig.timezone");
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      throw new ProtocolInputError(
        `RulesConfig.timezone 不是合法的 IANA 时区: ${timezone}`,
      );
    }
  }

  let askFirst: string[];
  if (obj.askFirst !== undefined) {
    if (!Array.isArray(obj.askFirst)) {
      throw new ProtocolInputError("RulesConfig.askFirst 必须是字符串数组");
    }
    askFirst = obj.askFirst.map((item, idx) =>
      assertNonEmptyString(item, `RulesConfig.askFirst[${idx}]`),
    );
  } else {
    askFirst = [...DEFAULT_ASK_FIRST];
  }

  const rawSources = assertPlainObject(obj.sources, "RulesConfig.sources");
  const sources: Record<string, { name: string }> = {};
  const seenSourceDisplayNames = new Set<string>();
  for (const [sourceKey, rawSource] of Object.entries(rawSources)) {
    assertIdentifierKey(sourceKey, "RulesConfig.sources");
    const srcObj = assertPlainObject(rawSource, `sources.${sourceKey}`);
    assertAllowedKeys(srcObj, SOURCE_KEYS, `sources.${sourceKey}`);
    const name = assertNonEmptyString(srcObj.name, `sources.${sourceKey}.name`);
    if (seenSourceDisplayNames.has(name)) {
      throw new ProtocolInputError(
        `RulesConfig.sources 存在重复显示名称: ${name}`,
      );
    }
    seenSourceDisplayNames.add(name);
    sources[sourceKey] = { name };
  }

  const rawAgents = assertPlainObject(obj.agents, "RulesConfig.agents");
  const agents: Record<string, AgentProfile> = {};
  const seenAgentNames = new Set<string>();
  for (const [agentId, rawAgent] of Object.entries(rawAgents)) {
    const profile = parseAgent(agentId, rawAgent);
    if (seenAgentNames.has(profile.name)) {
      throw new ProtocolInputError(
        `RulesConfig.agents 存在重复角色名称: ${profile.name}`,
      );
    }
    seenAgentNames.add(profile.name);
    agents[agentId] = profile;
  }

  if (!Array.isArray(obj.rules)) {
    throw new ProtocolInputError("RulesConfig.rules 必须是数组");
  }
  const rules: RuleSpec[] = [];
  const seenRuleNames = new Set<string>();
  const groupParallelByGrp = new Map<
    string,
    { parallel: number; ruleName: string }
  >();
  for (let i = 0; i < obj.rules.length; i++) {
    const rule = parseRule(obj.rules[i], i, sources, agents);
    if (seenRuleNames.has(rule.name)) {
      throw new ProtocolInputError(
        `RulesConfig.rules 存在重复规则名称: ${rule.name}`,
      );
    }
    seenRuleNames.add(rule.name);
    if (rule.parallel !== undefined) {
      const grp = rule.group ?? rule.name;
      const existingGroup = groupParallelByGrp.get(grp);
      if (existingGroup && existingGroup.parallel !== rule.parallel) {
        throw new ProtocolInputError(
          `同一并发组 "${grp}" 的规则 "${existingGroup.ruleName}" (parallel=${existingGroup.parallel}) 与 "${rule.name}" (parallel=${rule.parallel}) 设置了不一致的 parallel 值`,
        );
      }
      if (!existingGroup) {
        groupParallelByGrp.set(grp, {
          parallel: rule.parallel,
          ruleName: rule.name,
        });
      }
    }
    rules.push(rule);
  }

  const config: RulesConfig = {
    askFirst,
    sources,
    agents,
    rules,
  };
  if (timezone !== undefined) {
    config.timezone = timezone;
  }
  return config;
}
