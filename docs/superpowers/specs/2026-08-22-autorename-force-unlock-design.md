# Spec: /autorename force 解锁 + 最新上下文重推（issue #1）

日期：2026-08-22
状态：draft，待用户确认

## 背景与目标

core 锁定后 `/autorename` 无法重新生成标题（锁短路 + 输入只有原始意图）。
目标：`/autorename` force 时真正重新推导——解锁并调用模型，输入 = 原始意图 +
最近 ~10 条实质性 user 消息 + Previous title 上下文；周期刷新路径完全不变。

## 决策表

| 决策 | 选择 |
| --- | --- |
| 方案 | C：force 解锁 + 最新上下文 |
| 旧 core 处理 | 作为 Previous title 上下文传给模型（不短路返回） |
| 最新上下文窗口 | 最后 ~10 条实质性 user 消息，每条截 300 字符，总预算 2000 字符 |
| 周期刷新 | 完全不变（locked core 零模型调用复用） |
| 质量门 | force 重推结果仍过 coreIsNonGoal / coreIsMetaActivity；拒绝则保留现标题退避 |
| 状态 | force 成功后 coreLocked=true（新 core 重新锁定），下次 force 可再解锁 |

## 组件契约

### lib/auto-rename-core.ts 新增纯函数

```ts
export const LATEST_USER_MSGS = 10;  // recent-context prompts sent to the model on force
export const LATEST_BUDGET = 2000;   // total char budget for recent context

export function latestSelection(userMsgs: string[]): string
```

- 从 userMsgs 尾部往前扫，取最后 ~10 条实质性消息（isTrivialMessage 过滤、去重）。
- 每条截 PER_MSG_CHAR_CAP（300 字符），总预算 LATEST_BUDGET（2000 字符），
  复用 truncateMsgs 的预算逻辑。
- 返回 `"\n---\n"` 连接；无实质性消息返回 `""`。

### index.ts generateCore 签名扩展

```ts
async function generateCore(rt, early, prevCore, recent = "", prevTitle = ""): Promise<string | null>
```

- `prevCore` 非空 → 原样返回（锁短路，周期路径语义不变）。
- `prevCore` 空 → 调模型：prompt 含 ORIGINAL INTENT；`recent` 非空时追加
  RECENT CONTEXT；`prevTitle` 非空时追加 Previous title。

### index.ts runAutoRename force 路径

```ts
const locked = !opts.force && Boolean(st.coreLocked && prevCore);
const recent = opts.force ? latestSelection(userMsgs) : "";
const coreRaw = await generateCore(rt, safeEarly, locked ? prevCore : "", recent, opts.force ? prevCore : "");
```

- 周期锁定：prevCore 传入 → 短路返回，零模型调用（不变）。
- 周期未锁定：prevCore 传空 → 重推自愈（issue #10 延迟锁定语义不变）。
- force：prevCore 传空（不短路）+ recent + prevTitle=旧 core → 模型必被调用，
  旧 core 仅作为 Previous title 上下文。

- force 时 locked=false → 模型必被调用。
- 质量门照旧（`!locked` 分支在 force 下必然生效）。
- 状态写入：`newState.coreLocked = locked || sel.substantive || opts.force`
  —— force 成功即锁定新 core，防止周期刷新立刻 churn。
- 失败退避：模型失败 / 质量门拒绝 → 保留现标题，reason 退避。

### prompt 调整（force 重推）

```
ORIGINAL INTENT: <early>
RECENT CONTEXT: <recent>
Previous title: <prevCore>
Derive the session's CORE GOAL anchored on the ORIGINAL INTENT. If the RECENT
CONTEXT shows the session's actual focus has evolved, reflect the current focus.
Output ONLY a short noun-phrase title (3-5 English words or 6-12 Chinese chars)...
```

## 数据流

1. 用户 `/autorename` → `runAutoRename(pi, ctx, { force: true })`。
2. 读 state → anchor/prevCore；force 下 locked=false。
3. `early = earlySelection(userMsgs)`；`recent = latestSelection(userMsgs)`。
4. `generateCore(rt, redact(early), "", redact(recent), redact(prevCore))` → 模型调用。
5. 质量门 → capTitle → composeTitle → setSessionName + appendEntry(coreLocked=true)
   + syncBoardName。

## 降级

- 模型失败 → 保留现标题，reason "llm failed; backed off"。
- recent 为空（无实质性消息）→ 仍解锁重推，只用 early + Previous title。
- 质量门拒绝 → 保留现标题退避。
- early 为空 → 现有 "no user messages" 早退不变。

## 非目标

- 周期刷新路径不改（锁语义保留）。
- 不新增命令。
- 不改 capTitle / 质量门正则 / agent-board sync。
- 不动 config schema。

## 测试

- `latestSelection`：尾部取实质性消息 / 去重 / 单条截断 / 总预算 / 空输入 /
  全琐碎返回空。
- 现有纯函数测试全部保持通过（earlySelection 等不动）。
- index.ts 的 force 逻辑无单测框架，靠 debug 日志 + 手工 `/autorename` 验证。

## 文档

- README Troubleshooting：修正 "the core may be locked (that's by design;
  `/autorename` forces a refresh)" → 描述 force 解锁 + 最新上下文重推。
- `/autorename` 命令描述：改为 "force a rename now (bypasses cooldown, pause,
  and core lock; re-derives with latest context)"。
