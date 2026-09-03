# /autorename Force-Split Quality Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the quality gate by path: background renames stay strict (issue #10), while a forced `/autorename` degrades instead of rejecting — meta-activity cores are accepted, non-goal cores are accepted with a visible warning, and every rejection/flag message safely names the rule and the core (issue #5).

**Architecture:** Four new pure functions in `lib/auto-rename-core.ts` (`qualityGate`, `formatQualityGateMessage`, `gateAwareOutcome`, `notificationLevelFor`) carry all policy/message/level logic; `index.ts` only wires them into `runAutoRename` and the command handler. `looksLikeError` is NOT touched (its scope stays anchor-dropping only).

**Tech Stack:** TypeScript, zero-dep unit tests bundled by esbuild (`./test/run-all.sh`), pi extension API.

## Global Constraints

- Worktree: `/home/elling/git-repo/github/pi-auto-rename/.pi/worktrees/issue-5-autorename-quality-gate-force` — all git commands run with `-C` pointing there; never touch main.
- Spec: `docs/superpowers/specs/2026-09-03-autorename-force-quality-gate-design.md` (already committed as first commit).
- Quality gate policy (spec D1): background = `coreIsNonGoal` reject + `coreIsMetaActivity` reject; force = `coreIsNonGoal` accept-with-warning + `coreIsMetaActivity` accept. `looksLikeError` NOT part of the new-core gate and must not be modified.
- Gate messages (spec D4): single-line, whitespace-collapsed, 60 Unicode code points max, JSON-quoted. Reject: `core rejected by quality gate (<rule>): <quoted>`; flag: `quality gate flagged core (<rule>): <quoted>`.
- Outcome merge (spec D3): plain accept → `{ reason: "renamed"|"unchanged", warning: false }`; accept-with-warning → `{ reason: "<outcome>; <flag-message>; force used normalized core fallback", warning: true }` — on BOTH renamed and unchanged paths.
- Notification level (spec D3/A7): `warning || !title` → `"warning"`, else `"info"`.
- Existing unit tests must pass UNMODIFIED (spec A5); new behavior gets new test sections appended before the final `if (failed)` block.
- Test command (run from worktree root): `./test/run-all.sh`.
- Static check (spec A6): `npx esbuild index.ts --bundle --format=esm --platform=node --outfile=/tmp/autorename-bundle-check.mjs --log-level=warning --external:@earendil-works/pi-coding-agent --external:@earendil-works/pi-ai` — `test/run-all.sh` does NOT bundle `index.ts` and cannot substitute.
- Commit style: conventional commits (`feat:`/`docs:`), English messages, author `zhuxixi <zhuzhenxi_555@hotmail.com>` (pass `-c user.name=` / `-c user.email=` on each commit).
- Stage files explicitly (`git add <file>`), never `git add -A`.

---

### Task 1: `qualityGate` pure function (spec A1, A2, A5)

**Files:**
- Modify: `lib/auto-rename-core.ts` (insert after `coreIsMetaActivity`, before the `// ---- configurable title language (issue #3) ----` divider)
- Test: `test/auto-rename-core.test.ts` (add `qualityGate` to imports; append section before the final `if (failed)` block)

**Interfaces:**
- Consumes: `coreIsNonGoal(core: string): boolean`, `coreIsMetaActivity(core: string): boolean` (existing, unchanged).
- Produces: `export type QualityGateRule = "coreIsNonGoal" | "coreIsMetaActivity";` / `export type QualityGateDecision = { action: "accept" } | { action: "reject"; rule: QualityGateRule } | { action: "accept-with-warning"; rule: "coreIsNonGoal" };` / `export function qualityGate(core: string, force: boolean): QualityGateDecision;` — later tasks rely on these exact names.

- [ ] **Step 1: Write the failing tests**

In `test/auto-rename-core.test.ts`, add `qualityGate` to the import list (alphabetically, after `parseIso`), and append before the final `if (failed) {` block:

```ts
// ---- qualityGate: force-split gate policy (issue #5) ----
const q1 = qualityGate("方案确认", false);
check("qualityGate background non-goal rejects", q1.action === "reject" && q1.rule === "coreIsNonGoal");
const q2 = qualityGate("Issue list triage", false);
check("qualityGate background meta rejects", q2.action === "reject" && q2.rule === "coreIsMetaActivity");
const q3 = qualityGate("方案确认", true);
check("qualityGate force non-goal accepts with warning", q3.action === "accept-with-warning" && q3.rule === "coreIsNonGoal");
check("qualityGate force meta accepts", qualityGate("review github issue", true).action === "accept");
check("qualityGate force issue 分析 accepts", qualityGate("issue 分析", true).action === "accept");
check("qualityGate background clean accepts", qualityGate("修复登录越界", false).action === "accept");
check("qualityGate force clean accepts", qualityGate("修复登录越界", true).action === "accept");
check("qualityGate background fix login bug accepts", qualityGate("fix login bug", false).action === "accept");
check("qualityGate force fix login bug accepts", qualityGate("fix login bug", true).action === "accept");
check("qualityGate background empty accepts", qualityGate("", false).action === "accept");
check("qualityGate force empty accepts", qualityGate("", true).action === "accept");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/elling/git-repo/github/pi-auto-rename/.pi/worktrees/issue-5-autorename-quality-gate-force && ./test/run-all.sh`
Expected: FAIL — `qualityGate is not defined` (esbuild bundle error or runtime ReferenceError).

- [ ] **Step 3: Write the implementation**

Insert into `lib/auto-rename-core.ts`, after `coreIsMetaActivity`'s closing brace and before the `// ---- configurable title language (issue #3)` divider:

```ts
export type QualityGateRule = "coreIsNonGoal" | "coreIsMetaActivity";

export type QualityGateDecision =
  | { action: "accept" }
  | { action: "reject"; rule: QualityGateRule }
  | { action: "accept-with-warning"; rule: "coreIsNonGoal" };

/**
 * Route a freshly derived core through the quality gate (issue #5).
 * Background runs stay strict (issue #10): non-goal and meta-activity
 * cores are rejected. A forced /autorename is an explicit user request,
 * so it degrades instead of rejecting: the ambiguous meta filter is
 * skipped entirely and non-goal cores are accepted with a warning, so
 * an explicit rename always yields a title.
 */
export function qualityGate(core: string, force: boolean): QualityGateDecision {
  if (coreIsNonGoal(core)) {
    return force
      ? { action: "accept-with-warning", rule: "coreIsNonGoal" }
      : { action: "reject", rule: "coreIsNonGoal" };
  }
  if (!force && coreIsMetaActivity(core)) {
    return { action: "reject", rule: "coreIsMetaActivity" };
  }
  return { action: "accept" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/elling/git-repo/github/pi-auto-rename/.pi/worktrees/issue-5-autorename-quality-gate-force && ./test/run-all.sh`
Expected: `OK: 1/1 test files passed` with all checks `ok` — including every pre-existing check, unmodified.

- [ ] **Step 5: Commit**

```bash
cd /home/elling/git-repo/github/pi-auto-rename/.pi/worktrees/issue-5-autorename-quality-gate-force
git add lib/auto-rename-core.ts test/auto-rename-core.test.ts
git -c user.name="zhuxixi" -c user.email="zhuzhenxi_555@hotmail.com" commit -m "feat: force-split quality gate policy (issue #5)"
```

---

### Task 2: gate message safety, outcome merge, notification level (spec A3, A4, A7, A5)

**Files:**
- Modify: `lib/auto-rename-core.ts` (insert after `qualityGate` from Task 1)
- Test: `test/auto-rename-core.test.ts` (add `formatQualityGateMessage`, `gateAwareOutcome`, `notificationLevelFor` to imports; append section before the final `if (failed)` block)

**Interfaces:**
- Consumes: `QualityGateDecision` from Task 1.
- Produces: `export function formatQualityGateMessage(decision: Exclude<QualityGateDecision, { action: "accept" }>, core: string): string;` / `export function gateAwareOutcome(outcome: "renamed" | "unchanged", decision: Exclude<QualityGateDecision, { action: "reject" }>, core: string): { reason: string; warning: boolean };` / `export function notificationLevelFor(title: string | undefined, warning?: boolean): "info" | "warning";` — Task 3 relies on these exact names.

- [ ] **Step 1: Write the failing tests**

In `test/auto-rename-core.test.ts`, add the three names to the import list (alphabetically: `formatQualityGateMessage` after `FORCE_SYSTEM_PROMPT_TEMPLATE`, `gateAwareOutcome` after `formatQualityGateMessage`, `notificationLevelFor` after `looksLikeResponse`), and append before the final `if (failed) {` block:

```ts
// ---- gate message safety + outcome merge + notification level (issue #5) ----
const rejMsg = formatQualityGateMessage({ action: "reject", rule: "coreIsMetaActivity" }, "Issue list triage");
eq("formatQualityGateMessage reject shape", rejMsg, `core rejected by quality gate (coreIsMetaActivity): "Issue list triage"`);
const warnMsg = formatQualityGateMessage({ action: "accept-with-warning", rule: "coreIsNonGoal" }, "方案确认");
eq("formatQualityGateMessage accept-with-warning shape", warnMsg, `quality gate flagged core (coreIsNonGoal): "方案确认"`);
eq("formatQualityGateMessage collapses newlines", formatQualityGateMessage({ action: "reject", rule: "coreIsNonGoal" }, "方案\n确认"), `core rejected by quality gate (coreIsNonGoal): "方案 确认"`);
eq("formatQualityGateMessage collapses tabs", formatQualityGateMessage({ action: "reject", rule: "coreIsNonGoal" }, "a\tb"), `core rejected by quality gate (coreIsNonGoal): "a b"`);
eq("formatQualityGateMessage escapes quotes", formatQualityGateMessage({ action: "reject", rule: "coreIsNonGoal" }, 'say "hi"'), 'core rejected by quality gate (coreIsNonGoal): "say \\\"hi\\\""');
check("formatQualityGateMessage no raw newline", !formatQualityGateMessage({ action: "reject", rule: "coreIsNonGoal" }, "a\nb").includes("\n"));
check("formatQualityGateMessage no raw tab", !formatQualityGateMessage({ action: "reject", rule: "coreIsNonGoal" }, "a\tb").includes("\t"));
eq("formatQualityGateMessage caps 60 code points", formatQualityGateMessage({ action: "reject", rule: "coreIsNonGoal" }, "x".repeat(80)), `core rejected by quality gate (coreIsNonGoal): "${"x".repeat(60)}"`);

const oa = gateAwareOutcome("renamed", { action: "accept" }, "fix login");
check("gateAwareOutcome accept renamed", oa.reason === "renamed" && oa.warning === false);
const ob = gateAwareOutcome("unchanged", { action: "accept" }, "fix login");
check("gateAwareOutcome accept unchanged", ob.reason === "unchanged" && ob.warning === false);
const oc = gateAwareOutcome("renamed", { action: "accept-with-warning", rule: "coreIsNonGoal" }, "方案确认");
check("gateAwareOutcome warn renamed", JSON.stringify(oc) === JSON.stringify({ reason: `renamed; quality gate flagged core (coreIsNonGoal): "方案确认"; force used normalized core fallback`, warning: true }));
const od = gateAwareOutcome("unchanged", { action: "accept-with-warning", rule: "coreIsNonGoal" }, "方案确认");
check("gateAwareOutcome warn unchanged keeps info", od.warning === true && od.reason.startsWith("unchanged; quality gate flagged core"));
check("gateAwareOutcome warn unchanged carries core", od.reason.includes('"方案确认"'));

// ---- notificationLevelFor: UI level mapping (issue #5 A7) ----
eq("notificationLevelFor soft fallback warning", notificationLevelFor("方案确认", true), "warning");
eq("notificationLevelFor no title warning", notificationLevelFor(undefined, false), "warning");
eq("notificationLevelFor no title warning flag set", notificationLevelFor(undefined, true), "warning");
eq("notificationLevelFor normal success info", notificationLevelFor("fix login", false), "info");
eq("notificationLevelFor normal success info flag omitted", notificationLevelFor("fix login"), "info");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/elling/git-repo/github/pi-auto-rename/.pi/worktrees/issue-5-autorename-quality-gate-force && ./test/run-all.sh`
Expected: FAIL — `formatQualityGateMessage is not defined`.

- [ ] **Step 3: Write the implementation**

Insert into `lib/auto-rename-core.ts`, immediately after `qualityGate`:

```ts
const GATE_CORE_MAX = 60; // max Unicode code points of a model core echoed into logs/notifications

/**
 * Render an untrusted model core for a single-line log/notification:
 * collapse all whitespace (incl. newlines/tabs) to single spaces, cap
 * at 60 Unicode code points, then JSON-quote so quotes, backslashes and
 * control characters can never forge multi-line output (issue #5 D4).
 */
function quoteGateCore(core: string): string {
  const flat = (core || "").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat); // code points, not UTF-16 units
  return JSON.stringify(chars.slice(0, GATE_CORE_MAX).join(""));
}

/**
 * Single-line, safe quality-gate message naming the rule and quoting
 * the flagged core (issue #5 D2/D4).
 */
export function formatQualityGateMessage(
  decision: Exclude<QualityGateDecision, { action: "accept" }>,
  core: string,
): string {
  const quoted = quoteGateCore(core);
  if (decision.action === "reject") {
    return `core rejected by quality gate (${decision.rule}): ${quoted}`;
  }
  return `quality gate flagged core (${decision.rule}): ${quoted}`;
}

/**
 * Merge a rename outcome with the quality-gate decision (issue #5 D3):
 * plain accepts keep the legacy reason; accept-with-warning keeps the
 * gate details on BOTH the renamed and unchanged paths, with warning
 * set so the command UI notifies at warning level.
 */
export function gateAwareOutcome(
  outcome: "renamed" | "unchanged",
  decision: Exclude<QualityGateDecision, { action: "reject" }>,
  core: string,
): { reason: string; warning: boolean } {
  if (decision.action === "accept") {
    return { reason: outcome, warning: false };
  }
  return {
    reason: `${outcome}; ${formatQualityGateMessage(decision, core)}; force used normalized core fallback`,
    warning: true,
  };
}

/** UI notification level for a rename result (issue #5 D3/A7). */
export function notificationLevelFor(
  title: string | undefined,
  warning = false,
): "info" | "warning" {
  return warning || !title ? "warning" : "info";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/elling/git-repo/github/pi-auto-rename/.pi/worktrees/issue-5-autorename-quality-gate-force && ./test/run-all.sh`
Expected: `OK: 1/1 test files passed`, every pre-existing check unmodified and passing.

- [ ] **Step 5: Commit**

```bash
cd /home/elling/git-repo/github/pi-auto-rename/.pi/worktrees/issue-5-autorename-quality-gate-force
git add lib/auto-rename-core.ts test/auto-rename-core.test.ts
git -c user.name="zhuxixi" -c user.email="zhuzhenxi_555@hotmail.com" commit -m "feat: gate message safety and outcome merge helpers (issue #5)"
```

---

### Task 3: index.ts glue wiring (spec A6, A5)

**Files:**
- Modify: `index.ts` (import block, new `AutoRenameResult` interface, `runAutoRename` gate block and tail, `runAutoRename`/`runSerialized` signatures, `/autorename` handler notify)

**Interfaces:**
- Consumes: `qualityGate`, `formatQualityGateMessage`, `gateAwareOutcome`, `notificationLevelFor` from Tasks 1-2 (exact names).
- Produces: `interface AutoRenameResult { title?: string; reason: string; warning?: boolean; }` used by `runAutoRename` and `runSerialized`; the `/autorename` handler maps it to a notification via `notificationLevelFor`.

- [ ] **Step 1: Extend the import**

In `index.ts`, replace the whole import block with (new names alphabetical):

```ts
import {
  MAX_CORE_WIDTH,
  MAX_TITLE_WORDS,
  capTitle,
  composeTitle,
  coreFromTitle,
  coreIsMetaActivity,
  coreIsNonGoal,
  earlyExcerpt,
  earlySelection,
  formatQualityGateMessage,
  gateAwareOutcome,
  latestSelection,
  looksLikeError,
  looksLikeResponse,
  notificationLevelFor,
  parseIso,
  qualityGate,
  redact,
  scanUserMessages,
  truncateDisplay,
  buildUserPrompt,
  resolveLang,
  systemPromptFor,
  type TitleLang,
} from "./lib/auto-rename-core";
```

- [ ] **Step 2: Add the result contract**

Insert between the `// ---- main flow` divider line and `async function runAutoRename(...)`:

```ts
/** Result of a rename attempt; the /autorename command maps it to a UI
 *  notification. `warning` marks outcomes the user must be told about at
 *  warning level (issue #5: soft quality-gate fallbacks carry a title). */
interface AutoRenameResult {
  title?: string;
  reason: string;
  warning?: boolean;
}
```

- [ ] **Step 3: Change `runAutoRename` signature**

Replace:

```ts
async function runAutoRename(pi: ExtensionAPI, ctx: ExtensionContext, opts: { force?: boolean } = {}): Promise<{ title?: string; reason: string }> {
```

with:

```ts
async function runAutoRename(pi: ExtensionAPI, ctx: ExtensionContext, opts: { force?: boolean } = {}): Promise<AutoRenameResult> {
```

- [ ] **Step 4: Replace the gate block**

Replace:

```ts
  if (!coreRaw) return { reason: "llm failed; backed off" }; // keep current title, retry next period
  if (!locked && (coreIsNonGoal(coreRaw) || coreIsMetaActivity(coreRaw))) {
    debugLog(`core ${coreRaw.slice(0, 60)} rejected by quality gate; backed off`);
    return { reason: "core rejected by quality gate; backed off" };
  }
```

with:

```ts
  if (!coreRaw) return { reason: "llm failed; backed off" }; // keep current title, retry next period
  // Quality gate (issue #5): background runs stay strict (issue #10).
  // A forced /autorename degrades instead of rejecting: the ambiguous
  // meta filter is skipped and non-goal cores are accepted with a
  // warning, so an explicit request always yields a title.
  const gate = locked ? undefined : qualityGate(coreRaw, Boolean(opts.force));
  if (gate && gate.action === "reject") {
    const reason = formatQualityGateMessage(gate, coreRaw);
    debugLog(reason);
    return { reason };
  }
```

- [ ] **Step 5: Replace the tail (state write + return)**

Replace:

```ts
  // Title is stable (core locked). Skip the write when nothing changed so the
  // title isn't churned every refresh.
  const newState: AutoRenameState = { ...st, lastRunEpoch: now, lastSetTitle: title, lastCore: core, coreLocked: locked || sel.substantive || opts.force, paused: false, pausedReason: undefined };
  if (title === st.lastSetTitle) {
    pi.appendEntry(STATE_ENTRY_TYPE, { ...st, lastRunEpoch: now, lastCore: core, coreLocked: locked || sel.substantive || opts.force });
    return { title, reason: "unchanged" };
  }

  lastGeneratedName = title; // record ownership BEFORE writing so the
  pi.setSessionName(title);  // session_info_changed event isn't mistaken for a user rename
  pi.appendEntry(STATE_ENTRY_TYPE, newState);
  syncBoardName(ctx, title);
  return { title, reason: "renamed" };
```

with:

```ts
  // Title is stable (core locked). Skip the write when nothing changed so the
  // title isn't churned every refresh.
  const newState: AutoRenameState = { ...st, lastRunEpoch: now, lastSetTitle: title, lastCore: core, coreLocked: locked || sel.substantive || opts.force, paused: false, pausedReason: undefined };
  const changed = title !== st.lastSetTitle;
  if (!changed) {
    pi.appendEntry(STATE_ENTRY_TYPE, { ...st, lastRunEpoch: now, lastCore: core, coreLocked: locked || sel.substantive || opts.force });
  } else {
    lastGeneratedName = title; // record ownership BEFORE writing so the
    pi.setSessionName(title);  // session_info_changed event isn't mistaken for a user rename
    pi.appendEntry(STATE_ENTRY_TYPE, newState);
    syncBoardName(ctx, title);
  }
  // Gate-aware outcome (issue #5): soft fallbacks keep their warning and
  // gate details on BOTH paths; a locked refresh has no gate decision.
  const outcome = gate
    ? gateAwareOutcome(changed ? "renamed" : "unchanged", gate, coreRaw)
    : { reason: changed ? "renamed" : "unchanged", warning: false };
  return { title, ...outcome };
```

- [ ] **Step 6: Change `runSerialized` signature**

Replace:

```ts
  const runSerialized = async (ctx: ExtensionContext, force: boolean): Promise<{ title?: string; reason: string } | null> => {
```

with:

```ts
  const runSerialized = async (ctx: ExtensionContext, force: boolean): Promise<AutoRenameResult | null> => {
```

- [ ] **Step 7: Map notification level via the pure function**

In the `/autorename` handler, replace:

```ts
      ctx.ui.notify(
        r.title ? `auto-rename: ${r.title} (${r.reason})` : `auto-rename: ${r.reason}`,
        r.title ? "info" : "warning",
      );
```

with:

```ts
      ctx.ui.notify(
        r.title ? `auto-rename: ${r.title} (${r.reason})` : `auto-rename: ${r.reason}`,
        notificationLevelFor(r.title, r.warning),
      );
```

- [ ] **Step 8: Bundle check (static verification, spec A6)**

Run: `cd /home/elling/git-repo/github/pi-auto-rename/.pi/worktrees/issue-5-autorename-quality-gate-force && npx esbuild index.ts --bundle --format=esm --platform=node --outfile=/tmp/autorename-bundle-check.mjs --log-level=warning --external:@earendil-works/pi-coding-agent --external:@earendil-works/pi-ai`
Expected: exit 0, no warnings.

- [ ] **Step 9: Run the full test suite**

Run: `cd /home/elling/git-repo/github/pi-auto-rename/.pi/worktrees/issue-5-autorename-quality-gate-force && ./test/run-all.sh`
Expected: `OK: 1/1 test files passed`.

- [ ] **Step 10: Commit**

```bash
cd /home/elling/git-repo/github/pi-auto-rename/.pi/worktrees/issue-5-autorename-quality-gate-force
git add index.ts
git -c user.name="zhuxixi" -c user.email="zhuzhenxi_555@hotmail.com" commit -m "feat: /autorename force degrades quality-gate rejects instead of bailing (issue #5)"
```

---

### Task 4: Docs (README + CHANGELOG) — supports U1/U2

**Files:**
- Modify: `README.md` (Features bullet, How It Works step 4, Troubleshooting bullet)
- Modify: `CHANGELOG.md` (new Unreleased section)

**Interfaces:**
- Consumes: behavior implemented in Tasks 1-3.
- Produces: user-facing docs describing the force/background gate split; U1/U2 manual verification depends on these being accurate.

- [ ] **Step 1: Update the Features "Quality gates" bullet**

Replace:

```markdown
- **Quality gates**: greeting/ack openers are skipped, procedural
  labels ("Issue list triage") and non-goal cores ("方案确认") are
  rejected and backed off to the next cycle.
```

with:

```markdown
- **Quality gates**: greeting/ack openers are skipped, procedural
  labels ("Issue list triage") and non-goal cores ("方案确认") are
  rejected and backed off to the next cycle. A forced `/autorename`
  degrades instead of rejecting: the meta filter is skipped and
  non-goal cores are accepted with a warning, so an explicit rename
  always yields a title.
```

- [ ] **Step 2: Update How It Works step 4**

Replace:

```markdown
4. The output passes quality gates (not a sentence, not a response,
   not a procedural label), is capped to `maxCoreWidth` display
   columns, and applied via `pi.setSessionName()`.
```

with:

```markdown
4. The output passes quality gates (not a sentence, not a response,
   not a procedural label), is capped to `maxCoreWidth` display
   columns, and applied via `pi.setSessionName()`. On `/autorename`
   the ambiguous meta filter is skipped and non-goal cores fall back
   to a warning instead of an empty rejection.
```

- [ ] **Step 3: Add a Troubleshooting bullet**

Insert after the "Titles stop updating" bullet (before the "No rename happens at all" bullet):

```markdown
- **`/autorename` reports "quality gate flagged core …"**: the model
  produced a non-goal label (e.g. "方案确认"), but force mode still
  set a title from it. Use `/name` to set your own, or run
  `/autorename` again; the next background refresh re-derives the
  core anyway.
```

- [ ] **Step 4: Add a CHANGELOG Unreleased section**

Replace:

```markdown
## [0.2.0] - 2026-08-26
```

with:

```markdown
## [Unreleased]

### Fixed

- `/autorename` no longer bails with an empty rejection when the
  quality gate fires: the meta filter is skipped on force and non-goal
  cores are accepted with a warning that names the rule and the
  rejected core; background renames stay strict (issue #5).

## [0.2.0] - 2026-08-26
```

- [ ] **Step 5: Commit**

```bash
cd /home/elling/git-repo/github/pi-auto-rename/.pi/worktrees/issue-5-autorename-quality-gate-force
git add README.md CHANGELOG.md
git -c user.name="zhuxixi" -c user.email="zhuzhenxi_555@hotmail.com" commit -m "docs: quality gate force behavior in README and CHANGELOG (issue #5)"
```

---

### Task 5: Post-implementation manual verification (spec U1, U2) — after npm release

No code changes. This task executes AFTER the fix is merged and released
(npm publish + `pi update --extensions` are manual release steps, outside
the automated loop); it cannot run in the worktree. Record results in the
issue comment; an untriggered U2 is recorded as `pending`, never as passed.

- [ ] **U1 (issue scenario):** Open a NEW pi session; make the first substantive message an issue-filing intent (e.g. "给这个 extension 的 GitHub 仓库提交一个 issue"); wait for model output; run `/autorename`.
  - Observe: a title IS set and carries issue semantics; the old empty `auto-rename: core rejected by quality gate; backed off` warning no longer appears.
- [ ] **U2 (soft fallback, conditional):** In a session whose content is plan-confirmation-like, run `/autorename`. IF the model produces a non-goal core (e.g. "方案确认"):
  - Observe: the title is still set; the notification level is WARNING; the notification names the rule and quotes the flagged core.
  - IF the model does not trigger the branch: record `pending` with the actual core produced. Do not claim U2 passed.
