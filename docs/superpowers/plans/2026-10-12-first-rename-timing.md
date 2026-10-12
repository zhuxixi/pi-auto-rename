# First-Rename Timing Implementation Plan (issue #9)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让会话在**第一个有内容的 settle** 就拿到标题（不再等 `firstAfterMin` 墙钟），`firstAfterMin` 降级为「核心锁定门槛」；纯问候会话用零成本机械标题；退出与重开各有一条兜底路径。

**Architecture:** 纯函数层（`lib/auto-rename-core.ts`）新增 5 个判定/格式化函数；入口层（`index.ts`）只做接线：due 改调 `renameDue`、机械路径走第三处 state 写点、锁定时序改调 `coreLocksNow`、`session_start` 自愈、`session_shutdown` 兜底、`session_info_changed` 判据加初始名。spec：`docs/superpowers/specs/2026-10-12-first-rename-timing-design.md`。

**Tech Stack:** TypeScript (ESM, no build), esbuild+node 零依赖测试（`test/run-all.sh`），pi Extension API。

## Global Constraints

- **Worktree 作业**：`WT=/home/elling/git-repo/github/pi-auto-rename/.pi/worktrees/issue-9-not-due-timer-board-fallbackname`。所有编辑/测试/commit 在 `$WT` 内（`git -C $WT`），**禁碰 main**。
- **不引入定时器**：本设计没有任何 `setTimeout`/`setInterval`（spec 非目标 2）；唯一的 `setTimeout` 仍是 `llmOnce` 的 12s 看门狗。
- 不动 agent-board 侧；不改质量门分叉语义（issue #5），仅新增「机械 core 不过门」豁免；不改锚点/证据通道语义（issue #7 逐字节保持）。
- **不新增 state 字段**（无迁移）；机械路径的 state 写法是唯一的字段形状差异（不含 `lastRunEpoch`）。
- 接口名不得改：`renameDue` / `coreLocksNow` / `trivialCore` / `shouldRenameOnStart` / `formatStatusLine`（五个纯函数全部导出）。
- 测试命令统一：全量 `cd $WT && ./test/run-all.sh`；单文件 `npx esbuild test/<f>.test.ts --bundle --format=esm --platform=node --outfile=/tmp/<f>.mjs --alias:@earendil-works/pi-ai/compat=test/support/pi-ai-stub.ts --log-level=warning && node /tmp/<f>.mjs`。
- **测试隔离**：任何 import `../index` 的测试必须在 import 前设 `process.env.HOME=<tmp>` **且** `process.env.AGENT_BOARD_ROOT=<tmp>/board`（`CONFIG_PATH` 与 `BOARD_ROOT` 都在模块加载期求值，见 `index.ts:79,281`）。
- commit 用 conventional commits；`git add` 按文件，不用 `git add -A`。
- 用户实测（U1–U4）**不在本 plan 内**：需按 spec「部署前置」7 步装 worktree 产物后另行执行。

## 精确接口契约（所有 task 共用，不得改名）

```ts
// lib/auto-rename-core.ts 新增导出
export function renameDue(input: {
  st: { lastRunEpoch?: number };
  nowSec: number;
  repeatEveryMin: number;
  force?: boolean;
  final?: boolean;
}): boolean;

export function coreLocksNow(input: {
  alreadyLocked?: boolean;
  substantive: boolean;
  ageSec: number;
  firstAfterMin: number;
  force?: boolean;
  rederive?: boolean;
}): boolean;

export function trivialCore(lang: TitleLang): string;

export function shouldRenameOnStart(input: {
  reason: string;
  lastRunEpoch?: number;
  hasUserMessages: boolean;
}): boolean;

export function formatStatusLine(
  st: { lastSetTitle?: string; lastCore?: string; coreLocked?: boolean; paused?: boolean; pausedReason?: string; lastRunEpoch?: number },
  config: { firstAfterMin: number },
): string;

// index.ts 内部（非导出）签名变化
async function generateCore(rt, early, prevCore, recent?, prevTitle?, force?, lang, evidence?, signal?: AbortSignal): Promise<string | null>;
async function runAutoRename(pi, ctx, opts: { force?: boolean; final?: boolean; signal?: AbortSignal } = {}): Promise<AutoRenameResult>;
```

测试支撑（`test/support/`，仅测试用）：

```ts
// test/support/pi-ai-stub.ts —— 由 esbuild --alias 注入，替代 @earendil-works/pi-ai/compat
export const stubState: { mode: "ok" | "fail" | "hang"; calls: number; title: string };
export function complete(model: unknown, ctx: unknown, opts: unknown): Promise<{ content: { type: string; text: string }[] }>;
```

---

### Task 1: `renameDue` —— 首轮去墙钟化（A1）

**Files:**
- Modify: `lib/auto-rename-core.ts`（新增区块放在 `shouldReDerive` 之后）
- Create: `test/support/assert.ts`
- Create: `test/first-rename-timing.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `renameDue`（见契约）；`test/support/assert.ts` 导出 `check(name, fn)`、`eq(name, got, expect)`、`summary()`

- [ ] **Step 1: 写失败测试**

`test/support/assert.ts`:

```ts
let failed = 0;
export function eq(name: string, got: unknown, expect: unknown): void {
  if (Object.is(got, expect)) { console.log(`ok   ${name}`); return; }
  failed += 1;
  console.error(`FAIL ${name} — got ${JSON.stringify(got)} want ${JSON.stringify(expect)}`);
}
export function check(name: string, fn: () => void): void {
  try { fn(); } catch (e) { failed += 1; console.error(`FAIL ${name} — ${e instanceof Error ? e.message : String(e)}`); }
}
export function summary(): void {
  if (failed > 0) { console.error(`\n${failed} checks FAILED`); process.exit(1); }
  console.log("\nall checks passed");
}
```

`test/first-rename-timing.test.ts`（Task 2–5 会往同一文件追加用例）:

```ts
import { renameDue } from "../lib/auto-rename-core";
import { eq, summary } from "./support/assert";

// A1: 首个 run 不再看墙钟（issue #9 D1）
eq("first run due at age 0", renameDue({ st: {}, nowSec: 1000, repeatEveryMin: 3 }), true);
eq("first run due right after settle", renameDue({ st: {}, nowSec: 1000.5, repeatEveryMin: 3 }), true);
// 冷却分支保持现状
eq("repeat not due inside cooldown", renameDue({ st: { lastRunEpoch: 1000 }, nowSec: 1000 + 179, repeatEveryMin: 3 }), false);
eq("repeat due at cooldown edge", renameDue({ st: { lastRunEpoch: 1000 }, nowSec: 1000 + 180, repeatEveryMin: 3 }), true);
// force / final 恒 true
eq("force always due", renameDue({ st: { lastRunEpoch: 1000 }, nowSec: 1000, repeatEveryMin: 3, force: true }), true);
eq("final always due", renameDue({ st: { lastRunEpoch: 1000 }, nowSec: 1000, repeatEveryMin: 3, final: true }), true);
// firstAfterMin 不再参与 due 判定（签名里已无该参数）
summary();
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $WT && npx esbuild test/first-rename-timing.test.ts --bundle --format=esm --platform=node --outfile=/tmp/frt.mjs --log-level=warning && node /tmp/frt.mjs`
Expected: esbuild 报错 `No matching export ... renameDue`（或运行期 `renameDue is not a function`）。

- [ ] **Step 3: 最小实现**

`lib/auto-rename-core.ts` 追加:

```ts
/**
 * Whether a rename run is due (issue #9 D1). force/final bypass every gate.
 * The first run of a session is due as soon as content exists — the
 * firstAfterMin wall-clock gate moved to the core lock (`coreLocksNow`), so a
 * session that dies in two minutes still gets a title while it is alive.
 */
export function renameDue(input: {
  st: { lastRunEpoch?: number };
  nowSec: number;
  repeatEveryMin: number;
  force?: boolean;
  final?: boolean;
}): boolean {
  if (input.force || input.final) return true;
  if (!input.st.lastRunEpoch) return true;
  return input.nowSec - input.st.lastRunEpoch >= input.repeatEveryMin * 60;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2
Expected: 全部 `ok`，末行 `all checks passed`

- [ ] **Step 5: Commit**

```bash
cd $WT
git add test/support/assert.ts test/first-rename-timing.test.ts lib/auto-rename-core.ts
git commit -m "feat(core): renameDue — first rename no longer waits for firstAfterMin (A1)"
```

---

### Task 2: `coreLocksNow` —— 锁定门槛（A2）

**Files:**
- Modify: `lib/auto-rename-core.ts`
- Modify: `test/first-rename-timing.test.ts`

**Interfaces:**
- Consumes: `test/support/assert.ts`
- Produces: `coreLocksNow`

- [ ] **Step 1: 写失败测试**（追加到 `test/first-rename-timing.test.ts`，`summary()` 之前）

```ts
import { coreLocksNow } from "../lib/auto-rename-core";

// A2: 5 分钟是「修正窗口」，不是「没标题窗口」
eq("substantive locks after window", coreLocksNow({ substantive: true, ageSec: 300, firstAfterMin: 5 }), true);
eq("substantive stays unlocked before window", coreLocksNow({ substantive: true, ageSec: 299, firstAfterMin: 5 }), false);
eq("trivial never locks", coreLocksNow({ substantive: false, ageSec: 9999, firstAfterMin: 5 }), false);
eq("already locked stays locked", coreLocksNow({ alreadyLocked: true, substantive: false, ageSec: 1, firstAfterMin: 5 }), true);
eq("force locks regardless of age", coreLocksNow({ substantive: true, ageSec: 1, firstAfterMin: 5, force: true }), true);
eq("evidence re-derive locks", coreLocksNow({ substantive: true, ageSec: 1, firstAfterMin: 5, rederive: true }), true);
```

- [ ] **Step 2: 跑测试确认失败**

Run: 同 Task 1 Step 2
Expected: `coreLocksNow is not a function`（或 esbuild 无该导出）

- [ ] **Step 3: 最小实现**

```ts
/**
 * Whether the core locks on this run (issue #9 D2). The 5-minute window keeps
 * its original purpose — "wait until the intent settles" — but now as a
 * correction window: a title exists from the first settle, and only a
 * substantive anchor that is at least firstAfterMin old gets frozen.
 * Already-locked cores, force, and evidence re-derives always lock.
 */
export function coreLocksNow(input: {
  alreadyLocked?: boolean;
  substantive: boolean;
  ageSec: number;
  firstAfterMin: number;
  force?: boolean;
  rederive?: boolean;
}): boolean {
  if (input.alreadyLocked) return true;
  if (input.force || input.rederive) return true;
  return input.substantive && input.ageSec >= input.firstAfterMin * 60;
}
```

- [ ] **Step 4: 跑测试确认通过**；Expected: `all checks passed`
- [ ] **Step 5: Commit**

```bash
git add lib/auto-rename-core.ts test/first-rename-timing.test.ts
git commit -m "feat(core): coreLocksNow — firstAfterMin becomes the core-lock gate (A2)"
```

---

### Task 3: `trivialCore` —— 纯问候机械标题（A3）

**Files:**
- Modify: `lib/auto-rename-core.ts`
- Modify: `test/first-rename-timing.test.ts`

**Interfaces:**
- Consumes: `TitleLang`（已存在于 core）
- Produces: `trivialCore`

- [ ] **Step 1: 写失败测试**

```ts
import { trivialCore, capTitle } from "../lib/auto-rename-core";

eq("trivial core zh", trivialCore("zh"), "问候交流");
eq("trivial core auto", trivialCore("auto"), "Greeting exchange");
eq("trivial core en", trivialCore("en"), "Greeting exchange");
eq("trivial core is capTitle-stable", capTitle(trivialCore("zh"), 5, 24), "问候交流");
```

- [ ] **Step 2: 跑测试确认失败**；Expected: `trivialCore is not a function`
- [ ] **Step 3: 最小实现**

```ts
/** Mechanical core for a session whose whole early window is greetings
 *  (issue #9 D3): zero model cost, no quality gate, and the caller must NOT
 *  lock the core nor consume the rename cooldown. */
export function trivialCore(lang: TitleLang): string {
  return lang === "zh" ? "问候交流" : "Greeting exchange";
}
```

- [ ] **Step 4: 跑测试确认通过**；Expected: `all checks passed`
- [ ] **Step 5: Commit**

```bash
git add lib/auto-rename-core.ts test/first-rename-timing.test.ts
git commit -m "feat(core): trivialCore — local greeting title, no model call (A3)"
```

---

### Task 4: `shouldRenameOnStart` —— 重开自愈判据（A7 判据层）

**Files:**
- Modify: `lib/auto-rename-core.ts`
- Modify: `test/first-rename-timing.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `shouldRenameOnStart`

- [ ] **Step 1: 写失败测试**

```ts
import { shouldRenameOnStart } from "../lib/auto-rename-core";

// A7: 非 reload、从未命名、有内容 → 自愈
eq("resume never named with content", shouldRenameOnStart({ reason: "resume", hasUserMessages: true }), true);
eq("startup never named with content", shouldRenameOnStart({ reason: "startup", hasUserMessages: true }), true);
eq("reload is skipped", shouldRenameOnStart({ reason: "reload", hasUserMessages: true }), false);
eq("already named is skipped", shouldRenameOnStart({ reason: "resume", hasUserMessages: true, lastRunEpoch: 1 }), false);
eq("empty session is skipped", shouldRenameOnStart({ reason: "new", hasUserMessages: false }), false);
eq("unknown reason is allowed (defensive)", shouldRenameOnStart({ reason: "", hasUserMessages: true }), true);
```

- [ ] **Step 2: 跑测试确认失败**；Expected: `shouldRenameOnStart is not a function`
- [ ] **Step 3: 最小实现**

```ts
/**
 * Whether session_start should self-heal a never-named session that already
 * has content (issue #9 D5) — reopening an old view names it immediately.
 * Defensive by design: only an explicit "reload" is skipped, so an SDK reason
 * rename can never silently disable the self-heal.
 * SDK: SessionStartEvent.reason ∈ startup|reload|new|resume|fork
 * (@earendil-works/pi-coding-agent dist/core/extensions/types.d.ts:562-568).
 */
export function shouldRenameOnStart(input: {
  reason: string;
  lastRunEpoch?: number;
  hasUserMessages: boolean;
}): boolean {
  if (input.reason === "reload") return false;
  if (input.lastRunEpoch) return false;
  return input.hasUserMessages;
}
```

- [ ] **Step 4: 跑测试确认通过**；Expected: `all checks passed`
- [ ] **Step 5: Commit**

```bash
git add lib/auto-rename-core.ts test/first-rename-timing.test.ts
git commit -m "feat(core): shouldRenameOnStart — reopen self-heal predicate (A7)"
```

---

### Task 5: `formatStatusLine` —— 部署自证标记（A12）

**Files:**
- Modify: `lib/auto-rename-core.ts`
- Modify: `test/first-rename-timing.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `formatStatusLine`（`/autorename-status` 的唯一渲染入口）

- [ ] **Step 1: 写失败测试**

```ts
import { formatStatusLine } from "../lib/auto-rename-core";

const line = formatStatusLine({ lastSetTitle: "Fix login bug", lastCore: "fix login bug", coreLocked: true, paused: false, lastRunEpoch: 1000 }, { firstAfterMin: 5 });
check("status keeps legacy fields", () => {
  for (const frag of ["title=Fix login bug", "core=fix login bug", "locked=yes", "paused=no", "lastRun="]) {
    if (!line.includes(frag)) throw new Error(`missing ${frag} in ${line}`);
  }
});
eq("status carries timing marker", line.endsWith("timing=first@settle,lock@5m"), true);
eq("empty state renders (none)", formatStatusLine({}, { firstAfterMin: 7 }).includes("title=(none) core=(none)"), true);
eq("marker follows config", formatStatusLine({}, { firstAfterMin: 7 }).endsWith("timing=first@settle,lock@7m"), true);
```

- [ ] **Step 2: 跑测试确认失败**；Expected: `formatStatusLine is not a function`
- [ ] **Step 3: 最小实现**（把现有 `/autorename-status` 的内联模板搬进来 + 追加 timing 字段）

```ts
/**
 * One-line `/autorename-status` text (issue #9 D9). The trailing
 * `timing=first@settle,lock@<n>m` marker is also the deployment self-proof:
 * a copy without the new timing semantics cannot print it, so user tests can
 * verify the loaded code before trusting their results.
 */
export function formatStatusLine(
  st: { lastSetTitle?: string; lastCore?: string; coreLocked?: boolean; paused?: boolean; pausedReason?: string; lastRunEpoch?: number },
  config: { firstAfterMin: number },
): string {
  return `auto-rename: title=${st.lastSetTitle ?? "(none)"} core=${st.lastCore ?? "(none)"} ` +
    `locked=${st.coreLocked ? "yes" : "no"} ` +
    `paused=${st.paused ? st.pausedReason ?? "yes" : "no"} ` +
    `lastRun=${st.lastRunEpoch ? new Date(st.lastRunEpoch * 1000).toLocaleTimeString() : "never"} ` +
    `timing=first@settle,lock@${config.firstAfterMin}m`;
}
```

- [ ] **Step 4: 跑测试确认通过**；Expected: `all checks passed`
- [ ] **Step 5: Commit**

```bash
git add lib/auto-rename-core.ts test/first-rename-timing.test.ts
git commit -m "feat(core): formatStatusLine with timing self-proof marker (A12)"
```

---

### Task 6: integration harness + 首个 settle 即命名（A5）

**Files:**
- Create: `test/support/pi-ai-stub.ts`
- Create: `test/support/fake-pi.ts`
- Create: `test/first-rename-wiring.test.ts`
- Modify: `test/run-all.sh`（esbuild 增 `--alias:`）

**Interfaces:**
- Consumes: `renameDue`、`trivialCore`、`shouldRenameOnStart`、`formatStatusLine`
- Produces: `test/support/fake-pi.ts` 导出
  `makeHarness(opts: { sessionFile: string; branch: any[]; sessionName?: string }): { pi, ctx, names: string[], entries: {customType: string; data: any}[], fire(event: string, payload?: any): Promise<void> }`；
  `writeSessionFile(dir: string, startedAtSec: number, msgs: string[]): string`

- [ ] **Step 1: 写 stub 与 harness**

`test/support/pi-ai-stub.ts`:

```ts
/** Test double for @earendil-works/pi-ai/compat (injected via esbuild --alias). */
export const stubState = {
  mode: "ok" as "ok" | "fail" | "hang",
  calls: 0,
  title: "fix login bug",
};

export async function complete(): Promise<{ content: { type: string; text: string }[] }> {
  stubState.calls += 1;
  if (stubState.mode === "fail") throw new Error("stub llm failure");
  if (stubState.mode === "hang") return new Promise(() => {});
  return { content: [{ type: "text", text: stubState.title }] };
}

export function resetStub(): void {
  stubState.mode = "ok";
  stubState.calls = 0;
  stubState.title = "fix login bug";
}
```

`test/support/fake-pi.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Minimal pi session file: timestamped entries so firstTimestamp() can age the session. */
export function writeSessionFile(dir: string, startedAtSec: number, msgs: string[]): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.jsonl");
  const lines = [
    JSON.stringify({ type: "session", id: "test", timestamp: new Date(startedAtSec * 1000).toISOString(), cwd: dir }),
    ...msgs.map((text, i) =>
      JSON.stringify({
        type: "message",
        id: `m${i}`,
        timestamp: new Date((startedAtSec + i) * 1000).toISOString(),
        message: { role: "user", content: [{ type: "text", text }], timestamp: (startedAtSec + i) * 1000 },
      }),
    ),
  ];
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

export function makeHarness(opts: { sessionFile: string; branch: any[]; sessionName?: string }) {
  const handlers = new Map<string, ((...args: any[]) => any)[]>();
  const names: string[] = [];
  const entries: { customType: string; data: any }[] = [];
  let currentName = opts.sessionName;
  const model = { provider: "stub", id: "stub" };
  const pi: any = {
    on(event: string, handler: (...args: any[]) => any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerCommand() {}, registerShortcut() {}, registerFlag() {}, registerTool() {},
    // appendEntry must also land in the branch: readState() scans the branch,
    // so state written by a run has to be visible to the next run (real pi
    // behaves the same way).
    appendEntry(customType: string, data: any) {
      entries.push({ customType, data });
      opts.branch.push({ type: "custom", customType, data });
    },
    setSessionName(name: string) { currentName = name; names.push(name); },
    getSessionName() { return currentName; },
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  const ctx: any = {
    cwd: process.cwd(),
    hasUI: false,
    ui: { notify() {} },
    model,
    modelRegistry: { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "stub" }) },
    sessionManager: {
      getBranch: () => opts.branch,
      getEntries: () => opts.branch,
      getSessionFile: () => opts.sessionFile,
      getSessionName: () => currentName,
    },
  };
  const fire = async (event: string, payload: any = {}) => {
    for (const h of handlers.get(event) ?? []) await h({ type: event, ...payload }, ctx);
  };
  return { pi, ctx, names, entries, fire, handlers };
}
```

- [ ] **Step 2: 让测试能 import index.ts**

`test/run-all.sh` 的 esbuild 行追加 alias（对所有测试无副作用）:

```bash
  if ! npx esbuild "$t" --bundle --format=esm --platform=node --outfile="$out" --log-level=warning \
      --alias:@earendil-works/pi-ai/compat=test/support/pi-ai-stub.ts; then
```

（`--alias:` 必须用**精确子路径**：只别名包名会报 `Could not resolve .../compat`。）

- [ ] **Step 3: 写失败测试**

`test/first-rename-wiring.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, summary, check } from "./support/assert";

// Module-level paths (CONFIG_PATH / BOARD_ROOT) are evaluated at import time,
// so the env has to be redirected BEFORE importing the extension.
const home = mkdtempSync(join(tmpdir(), "ar-home-"));
const board = mkdtempSync(join(tmpdir(), "ar-board-"));
process.env.HOME = home;
process.env.AGENT_BOARD_ROOT = board;

const { makeHarness, writeSessionFile } = await import("./support/fake-pi");
const { resetStub, stubState } = await import("./support/pi-ai-stub");
const autoRename = (await import("../index")).default;

async function runGreetingSettle(startedAtSec: number) {
  resetStub();
  const branch = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } }];
  const sessionFile = writeSessionFile(join(home, "s"), startedAtSec, ["hello"]);
  const h = makeHarness({ sessionFile, branch, sessionName: "hello" });
  autoRename(h.pi);
  await h.fire("session_start", { reason: "resume" });
  await new Promise((r) => setTimeout(r, 50)); // trigger() runs detached
  await h.fire("agent_settled");
  await new Promise((r) => setTimeout(r, 50));
  return h;
}

// A5: 首个 settle 即命名（不等 5 分钟），琐碎锚点零模型调用
const h = await runGreetingSettle(Date.now() / 1000 - 10);
eq("greeting session named at first settle", h.names.at(-1), "Greeting exchange");
eq("greeting path never calls the model", stubState.calls, 0);
check("state written without lastRunEpoch (A4)", () => {
  const last = h.entries.at(-1)?.data ?? {};
  if (last.lastRunEpoch !== undefined) throw new Error(`lastRunEpoch must stay unset, got ${last.lastRunEpoch}`);
});
summary();
```

- [ ] **Step 4: 跑测试确认失败**

Run: `cd $WT && ./test/run-all.sh`
Expected: `first-rename-wiring` 失败（`h.names` 为空 —— 接线还没做）

- [ ] **Step 5: Commit**（harness 先行，测试仍红）

```bash
git add test/support/pi-ai-stub.ts test/support/fake-pi.ts test/first-rename-wiring.test.ts test/run-all.sh
git commit -m "test: integration harness (pi-ai stub + fake pi/ctx) and first-settle naming case (A5)"
```

> Task 7 让本测试转绿。**不要**在本 task 里改 `index.ts`。

---

### Task 7: 入口接线（A4/A5/A6/A8）+ due 与机械路径

**Files:**
- Modify: `index.ts:358-372`（due 判定）、`index.ts:404-421`（模型调用 → 机械分支）、`index.ts:426-441`（写点/锁定）、`index.ts:202` 附近（`generateCore` 加 signal）

**Interfaces:**
- Consumes: `renameDue`、`coreLocksNow`、`trivialCore`
- Produces: `runAutoRename(pi, ctx, { force?, final?, signal? })`；`generateCore(..., signal?)`

- [ ] **Step 1: due 判定改调 `renameDue`**

先把五个新函数加进 `index.ts:51-80` 的既有 import 块：`renameDue, coreLocksNow, trivialCore, shouldRenameOnStart, formatStatusLine`（同一句 named import，不新建 import 语句）。

替换 `index.ts:361-372` 的整段 due 检查为:

```ts
  // due check (issue #9 D1): the first run is due as soon as the session has
  // content — firstAfterMin now gates the core lock, not the first title.
  if (!renameDue({ st, nowSec: now, repeatEveryMin: config.repeatEveryMin, force: opts.force, final: opts.final })) {
    return { reason: "not due yet" };
  }
  const sessionStartSec = (sessionFile ? firstTimestamp(sessionFile) : null) ?? now;
  const ageSec = now - sessionStartSec;
```

- [ ] **Step 2: 机械路径 + 第三写点**

把 `index.ts:404-421`（`buildLlmRuntime` → quality gate）整段替换为:

```ts
  // Mechanical path (issue #9 D3): a greetings-only session gets a local core —
  // no model call, no quality gate, and no lastRunEpoch (so the cooldown can
  // never block the upgrade once real content arrives).
  const mechanical = !sel.substantive;
  let coreRaw = "";
  let gate: ReturnType<typeof qualityGate> | undefined;
  if (mechanical) {
    coreRaw = trivialCore(config.lang);
  } else {
    const rt = await buildLlmRuntime(ctx);
    if (!rt) return { reason: "no usable model (registry auth failed)" };
    const safeEarly = redact(early);
    const promptForce = Boolean(opts.force) || rederive;
    const recent = promptForce ? redact(latestSelection(userMsgs)) : "";
    coreRaw = await generateCore(rt, safeEarly, locked ? prevCore : "", recent, promptForce ? redact(prevCore) : "", promptForce, config.lang, evidence, opts.signal);
    if (!coreRaw && evidence && evidence.slug) {
      coreRaw = slugToCore(evidence.slug); // mechanical fallback (D8), still gated below
    }
    if (!coreRaw) return { reason: "llm failed; backed off" }; // keep current title, retry next period
    gate = locked ? undefined : qualityGate(coreRaw, Boolean(opts.force));
    if (gate && gate.action === "reject") {
      const reason = formatQualityGateMessage(gate, coreRaw);
      debugLog(reason);
      return { reason };
    }
  }
```

- [ ] **Step 3: 锁定与写点**

把 `index.ts:429-441` 替换为:

```ts
  const nextLocked = mechanical
    ? false
    : coreLocksNow({
        alreadyLocked: locked,
        substantive: sel.substantive,
        ageSec,
        firstAfterMin: config.firstAfterMin,
        force: Boolean(opts.force),
        rederive,
      });
  const nextEvidenceKey = evidence ? evidence.key : st.evidenceKey;
  const changed = title !== st.lastSetTitle;
  if (mechanical) {
    // Third state write point (spec R1-D1): no lastRunEpoch on purpose.
    if (!changed) return { reason: "unchanged (trivial)" };
    lastGeneratedName = title;
    pi.setSessionName(title);
    pi.appendEntry(STATE_ENTRY_TYPE, { ...st, lastSetTitle: title, lastCore: core, coreLocked: false });
    syncBoardName(ctx, title);
    return { title, reason: "renamed (trivial)", warning: false };
  }
  const newState: AutoRenameState = { ...st, lastRunEpoch: now, lastSetTitle: title, lastCore: core, coreLocked: nextLocked, evidenceKey: nextEvidenceKey, paused: false, pausedReason: undefined };
```

（其后保留原有的 `if (!changed) { ... } else { ... }` 写点与 outcome 计算，`newState` 引用不变。）

- [ ] **Step 4: `generateCore` / `runAutoRename` 透传 signal**

`generateCore` 签名加末参 `signal?: AbortSignal`，并把 `llmOnce(rt, user, "<修正提示原样>", signal, systemPromptFor(force, lang))` 的第 4 参由 `undefined` 改为 `signal`。
`runAutoRename` 的 `opts` 类型改为 `{ force?: boolean; final?: boolean; signal?: AbortSignal }`。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd $WT && ./test/run-all.sh`
Expected: `first-rename-wiring` 转绿（名字为 `Greeting exchange`、stub 调用 0 次、state 无 `lastRunEpoch`）；既有测试仍全绿。

> 断言首句的 `"Greeting exchange"` 对应默认 config `lang: "auto"`（`DEFAULT_CONFIG.lang`）。

- [ ] **Step 6: Commit**

```bash
git add index.ts test/first-rename-wiring.test.ts
git commit -m "feat(extension): settle-driven first rename + mechanical greeting path (A4/A5/A6)"
```

---

### Task 8: 退出兜底（A8/A11）+ 重开自愈接线（A7）

**Files:**
- Modify: `index.ts`（`session_start` 处理器、新增 `session_shutdown` 处理器、`runSerialized` 签名与 `running` 日志）
- Modify: `test/first-rename-wiring.test.ts`

**Interfaces:**
- Consumes: `shouldRenameOnStart`
- Produces: `FINAL_BUDGET_MS = 5_000`；`runSerialized(ctx, force, extra?: { final?: boolean; signal?: AbortSignal })`

- [ ] **Step 1: 写失败测试**（追加到 `test/first-rename-wiring.test.ts`，`summary()` 之前）

```ts
// A7: 重开自愈（有内容、从未命名、非 reload）
{
  resetStub();
  const branch = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello fix the bug" }] } }];
  const sessionFile = writeSessionFile(join(home, "s2"), Date.now() / 1000 - 600, ["hello fix the bug"]);
  const h = makeHarness({ sessionFile, branch, sessionName: "hello" });
  autoRename(h.pi);
  await h.fire("session_start", { reason: "resume" });
  await new Promise((r) => setTimeout(r, 50));
  eq("resume self-heal names the session", h.names.at(-1), "fix login bug");
}
// A7 反例：reload 不自愈
{
  resetStub();
  const branch = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello fix the bug" }] } }];
  const sessionFile = writeSessionFile(join(home, "s3"), Date.now() / 1000 - 600, ["hello fix the bug"]);
  const h = makeHarness({ sessionFile, branch, sessionName: "hello" });
  autoRename(h.pi);
  await h.fire("session_start", { reason: "reload" });
  await new Promise((r) => setTimeout(r, 50));
  eq("reload does not rename", h.names.length, 0);
}
// A8: 退出兜底（从未命名 → 命名；已命名 → 不动；reload → 不动）
{
  resetStub();
  const branch = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello fix the bug" }] } }];
  const sessionFile = writeSessionFile(join(home, "s4"), Date.now() / 1000 - 30, ["hello fix the bug"]);
  const h = makeHarness({ sessionFile, branch, sessionName: "hello" });
  autoRename(h.pi);
  await h.fire("session_shutdown", { reason: "quit" });
  eq("quit final-run names the session", h.names.at(-1), "fix login bug");
}
{
  resetStub();
  const branch = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello fix the bug" }] } }];
  const sessionFile = writeSessionFile(join(home, "s5"), Date.now() / 1000 - 30, ["hello fix the bug"]);
  const h = makeHarness({ sessionFile, branch, sessionName: "hello" });
  autoRename(h.pi);
  await h.fire("session_shutdown", { reason: "reload" });
  eq("reload final-run is skipped", h.names.length, 0);
}
// A11a: final 失败分支不阻塞退出、不写半状态
{
  resetStub();
  stubState.mode = "fail";
  const branch = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello fix the bug" }] } }];
  const sessionFile = writeSessionFile(join(home, "s6"), Date.now() / 1000 - 30, ["hello fix the bug"]);
  const h = makeHarness({ sessionFile, branch, sessionName: "hello" });
  autoRename(h.pi);
  let threw = false;
  try { await h.fire("session_shutdown", { reason: "quit" }); } catch { threw = true; }
  eq("failing final run does not throw", threw, false);
  eq("failing final run writes no title", h.names.length, 0);
  check("failing final run writes no state", () => {
    if (h.entries.some((e) => e.customType === "auto-rename-state")) throw new Error("state written on failure");
  });
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $WT && ./test/run-all.sh`
Expected: A7/A8/A11a 用例失败（`session_shutdown` 无处理器 → 名字为空）

- [ ] **Step 3: 接线**

`session_start` 处理器（`index.ts:479-485`）改为:

```ts
  pi.on("session_start", async (event, ctx) => {
    sessionCtx = ctx;
    const branch = ctx.sessionManager.getBranch();
    const st = readState(branch);
    lastGeneratedName = st.lastSetTitle; // reload-safe: recognize our own past writes
    initialNameSeen = pi.getSessionName(); // D6: seed/initial name, not a user rename
    if (debugEnabled) debugLog(`restored state: ${JSON.stringify(st)}`);
    if (shouldRenameOnStart({ reason: event.reason, lastRunEpoch: st.lastRunEpoch, hasUserMessages: scanUserMessages(branch).length > 0 })) {
      debugLog(`session_start(${event.reason}): never named with content — self-healing`);
      trigger(false);
    }
  });
```

新增（放在 `agent_settled` 之后）:

```ts
  // Exit catch-all (issue #9 D4): a session that dies before its first settle
  // still gets a title. pi awaits shutdown handlers, so a short budget is safe.
  pi.on("session_shutdown", async (event, ctx) => {
    try {
      const st = readState(ctx.sessionManager.getBranch());
      if (event.reason === "reload" || st.lastRunEpoch) return;
      await runSerialized(ctx, false, { final: true, signal: AbortSignal.timeout(FINAL_BUDGET_MS) });
    } catch (e) {
      debugLog(`final run failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
```

`runSerialized`（`index.ts:459-467`）改为:

```ts
  const runSerialized = async (ctx: ExtensionContext, force: boolean, extra: { final?: boolean; signal?: AbortSignal } = {}): Promise<AutoRenameResult | null> => {
    if (running) {
      // Visible on purpose (spec R2-D3): the final run returns null silently —
      // this log is the only trace that the exit catch-all was swallowed.
      debugLog("run skipped: another run is in flight");
      return null;
    }
    running = true;
    try {
      return await runAutoRename(pi, ctx, { force, ...extra });
    } finally {
      running = false;
    }
  };
```

模块级常量与变量:

```ts
const FINAL_BUDGET_MS = 5_000; // exit catch-all budget (spec D3)
let initialNameSeen: string | undefined; // session name at session_start (spec D6)
```

- [ ] **Step 4: 跑测试确认通过**；Expected: 全部 integration 用例绿 + 既有测试绿
- [ ] **Step 5: Commit**

```bash
git add index.ts test/first-rename-wiring.test.ts
git commit -m "feat(extension): session_shutdown catch-all + session_start self-heal (A7/A8/A11)"
```

---

### Task 9: 手工改名保护（A9）

**Files:**
- Modify: `index.ts`（`session_info_changed` 处理器，`index.ts:487-497`）
- Modify: `test/first-rename-wiring.test.ts`

**Interfaces:**
- Consumes: `initialNameSeen`（Task 8）
- Produces: 暂停判据「≠ 我设的标题，且（无自动标题时）≠ 初始名」

- [ ] **Step 1: 写失败测试**

```ts
// A9: 首跑期手工改名 → 暂停；随后 settle/final 不再改写；种子名重放不暂停
{
  resetStub();
  const branch = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello fix the bug" }] } }];
  const sessionFile = writeSessionFile(join(home, "s7"), Date.now() / 1000 - 600, ["hello fix the bug"]);
  const h = makeHarness({ sessionFile, branch, sessionName: "hello" });
  autoRename(h.pi);
  await h.fire("session_start", { reason: "resume" });
  await new Promise((r) => setTimeout(r, 50));
  const namedOnce = h.names.length;
  await h.fire("session_info_changed", { name: "my own title" });   // 用户在首轮锁定前改名
  await h.fire("agent_settled");
  await h.fire("session_shutdown", { reason: "quit" });
  await new Promise((r) => setTimeout(r, 50));
  eq("manual rename freezes the session", h.names.length, namedOnce);
  check("paused with manual_rename reason", () => {
    const st = h.entries.filter((e) => e.customType === "auto-rename-state").at(-1)?.data ?? {};
    if (st.paused !== true || st.pausedReason !== "manual_rename") throw new Error(`bad state ${JSON.stringify(st)}`);
  });
}
{
  resetStub();
  const branch = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } }];
  const sessionFile = writeSessionFile(join(home, "s8"), Date.now() / 1000 - 600, ["hello"]);
  const h = makeHarness({ sessionFile, branch, sessionName: "hello" });
  autoRename(h.pi);
  await h.fire("session_start", { reason: "resume" });
  await h.fire("session_info_changed", { name: "hello" });          // board 重放种子名
  const paused = h.entries.some((e) => e.customType === "auto-rename-state" && e.data?.paused === true);
  eq("seed name replay does not pause", paused, false);
}
```

- [ ] **Step 2: 跑测试确认失败**；Expected: 第一个用例失败（手工改名后仍被改写 / 无 paused 状态）
- [ ] **Step 3: 接线**

```ts
  pi.on("session_info_changed", (event, ctx) => {
    const name = event.name?.trim();
    if (!name || name === lastGeneratedName) return;
    lastGeneratedName = name;
    const st = readState(ctx.sessionManager.getBranch());
    if (st.paused) return; // already paused — don't pile up duplicate entries (issue #10)
    // issue #9 D6: a session that was never auto-named still protects the
    // user's own rename — anything other than our last title AND other than the
    // name seen at session_start (board seed / replayed seed) is a user rename.
    const ours = st.lastSetTitle ? name === st.lastSetTitle : name === initialNameSeen;
    if (!ours) {
      pi.appendEntry(STATE_ENTRY_TYPE, { ...st, paused: true, pausedReason: "manual_rename" });
      debugLog(`manual rename detected (${name}); session paused`);
    }
  });
```

- [ ] **Step 4: 跑测试确认通过**；Expected: 全部绿
- [ ] **Step 5: Commit**

```bash
git add index.ts test/first-rename-wiring.test.ts
git commit -m "fix(extension): manual-rename guard covers the pre-first-title window (A9)"
```

---

### Task 10: README 新语义 + 文档一致性检查（A13）

**Files:**
- Modify: `README.md:100`、`README.md:119-120`（配置表与 How It Works）
- Create: `test/docs-timing.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `test/docs-timing.test.ts`（静态断言）

- [ ] **Step 1: 写失败测试**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, summary } from "./support/assert";

const readme = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf8");

check("config table documents the lock gate", () => {
  if (!/firstAfterMin[^\n]*lock/i.test(readme)) throw new Error("firstAfterMin row must describe the core-lock semantics");
});
check("no stale 'first rename after' wording", () => {
  for (const stale of ["First rename after this many minutes of session life", "first rename after `firstAfterMin`"]) {
    if (readme.includes(stale)) throw new Error(`stale wording present: ${stale}`);
  }
});
check("how-it-works mentions the first settle", () => {
  if (!/first settle|first `agent_settled`|first agent_settled/i.test(readme)) throw new Error("How It Works must describe settle-driven first rename");
});
summary();
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $WT && npx esbuild test/docs-timing.test.ts --bundle --format=esm --platform=node --outfile=/tmp/docs.mjs --log-level=warning && node /tmp/docs.mjs`
Expected: `FAIL`（README 仍是旧文案）

- [ ] **Step 3: 改 README**

- 配置表行（README:100）改为:

```
| `firstAfterMin` | `5`                         | Core-lock delay: the title appears at the first settle and stays re-derivable until the session is this old |
```

- 「How It Works」第 1 条（README:119-120）改为:

```
1. On the first `agent_settled` that has user content, the extension names the
   session immediately (no wall-clock wait); after that it re-checks every
   `repeatEveryMin`. The core locks once the session is `firstAfterMin` old, so
   early titles stay correctable. A session that ends first gets one final
   attempt on `session_shutdown`, and a never-named session is named when it is
   reopened.
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd $WT && ./test/run-all.sh`
Expected: `OK: N/N test files passed`

- [ ] **Step 5: Commit**

```bash
git add README.md test/docs-timing.test.ts
git commit -m "docs: README timing semantics + static consistency test (A13)"
```

---

## Self-Review

**Spec 覆盖**：D1→Task 1+7（`renameDue` + due 接线）、D2→Task 2+7（`coreLocksNow`）、D3→Task 3+7（机械路径 + 第三写点）、D4→Task 8（shutdown 兜底）、D5→Task 4+8（`shouldRenameOnStart` + session_start 接线）、D6→Task 9、D7→全 plan（无定时器）、D8→Task 10、D9→Task 5（`formatStatusLine`）+ Task 7（status 命令改调）。
**验收映射**：A1→Task 1、A2→Task 2、A3→Task 3、A4→Task 6+7、A5→Task 6+7、A6→Task 2+7、A7→Task 4+8、A8→Task 8、A9→Task 9、A10→每个 task 的 Step 4 全量回归、A11→Task 8、A12→Task 5、A13→Task 10。**U1–U4 不在 plan 内**（需按 spec 部署前置 7 步装 worktree 产物后由用户实测）。
**占位符扫描**：无 TBD/TODO；每个代码步骤都有可粘贴的代码与命令。
**类型一致性**：`renameDue`/`coreLocksNow`/`trivialCore`/`shouldRenameOnStart`/`formatStatusLine` 五个名字在契约、Task 1–5 实现、Task 6–10 调用处一致；`runSerialized(ctx, force, extra)` 与 `runAutoRename(pi, ctx, opts)` 的 `final`/`signal` 字段在 Task 7/8 一致。
**已知实现细节（实现者需按真实代码适配，断言不变）**：`/autorename-status` 的 handler 在 Task 7 改调 `formatStatusLine`（spec D9）；`agent_settled` 处理器保持不变；`test/first-rename-wiring.test.ts` 的顶层 `await import` 需要 esbuild `--format=esm` 的 top-level await 支持（node 24 已满足）。
