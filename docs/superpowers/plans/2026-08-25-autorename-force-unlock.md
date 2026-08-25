# /autorename Force Unlock + Latest-Context Re-derive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/autorename` truly regenerate the session title: bypass the core lock and re-derive with the latest user context (issue #1).

**Architecture:** Add a pure `latestSelection` function to `lib/auto-rename-core.ts` (tail scan of the last ~10 substantive user messages), extend `generateCore` in `index.ts` with `recent`/`prevTitle` prompt inputs, and unlock the force path in `runAutoRename`. Periodic refresh behavior is untouched.

**Tech Stack:** TypeScript, zero-dep unit tests bundled by esbuild (`./test/run-all.sh`), pi extension API.

## Global Constraints

- Worktree: `/home/elling/git-repo/github/pi-auto-rename/.pi/worktrees/issue-1-autorename-force-unlock` — all git commands run with `-C` pointing there; never touch main.
- Spec: `docs/superpowers/specs/2026-08-22-autorename-force-unlock-design.md` (already committed as first commit).
- Latest-context window: last ~10 substantive user messages, per-msg cap 300 chars, total budget 2000 chars.
- Force semantics: `/autorename` bypasses cooldown, pause, AND core lock; old core is passed as "Previous title" prompt context, never short-circuited.
- Periodic path: locked core still returns verbatim with zero model calls; unlocked periodic re-derive (issue #10 self-heal) unchanged.
- Quality gates (`coreIsNonGoal` / `coreIsMetaActivity`) and failure back-off apply to force results too.
- Commit style: conventional commits (`feat:`/`docs:`/`test:`), English messages, author `zhuxixi <zhuzhenxi_555@hotmail.com>`.
- Stage files explicitly (`git add <file>`), never `git add -A`.

---

### Task 1: `latestSelection` pure function

**Files:**
- Modify: `lib/auto-rename-core.ts` (append after `earlySelection`, before `earlyExcerpt`)
- Test: `test/auto-rename-core.test.ts` (append a new section before the final `if (failed)` block)

**Interfaces:**
- Consumes: `isTrivialMessage(text: string): boolean`, `truncateMsgs(msgs: string[], budget: number): string[]` (module-private, same file), `PER_MSG_CHAR_CAP`.
- Produces: `export const LATEST_USER_MSGS = 10; export const LATEST_BUDGET = 2000; export function latestSelection(userMsgs: string[]): string` — returns `"\n---\n"`-joined recent substantive messages in transcript order, `""` when none.

- [ ] **Step 1: Write the failing tests**

Append to `test/auto-rename-core.test.ts` (before the final `if (failed)` block), and add `latestSelection` to the import list at the top:

```ts
// ---- latestSelection: recent-context tail scan (issue #1) ----
eq("latestSelection empty", latestSelection([]), "");
eq(
	"latestSelection takes last 10 substantive",
	latestSelection(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"]),
	"c\n---\nd\n---\ne\n---\nf\n---\ng\n---\nh\n---\ni\n---\nj\n---\nk\n---\nl",
);
eq("latestSelection skips trivial in tail", latestSelection(["real1", "hello", "ok", "real2"]), "real1\n---\nreal2");
eq("latestSelection dedups", latestSelection(["x", "x", "y"]), "x\n---\ny");
eq("latestSelection all trivial -> empty", latestSelection(["hello", "ok", "收到"]), "");
eq("latestSelection per-msg cap 300", latestSelection(["x".repeat(400)]).length, 300);
const tenLong = Array.from({ length: 10 }, (_, i) => `msg${i}-` + "x".repeat(290));
const latest = latestSelection(tenLong);
check(
	"latestSelection budget keeps most recent",
	latest.startsWith("msg3-") && latest.endsWith("msg9-" + "x".repeat(290)),
	latest.slice(0, 40) + " ... " + latest.slice(-40),
);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/elling/git-repo/github/pi-auto-rename/.pi/worktrees/issue-1-autorename-force-unlock && ./test/run-all.sh`
Expected: FAIL — `latestSelection is not defined` (esbuild bundle error or runtime ReferenceError).

- [ ] **Step 3: Write the implementation**

Append to `lib/auto-rename-core.ts` after `earlySelection`:

```ts
export const LATEST_USER_MSGS = 10;  // recent-context prompts sent to the model on force
export const LATEST_BUDGET = 2000;   // total char budget for recent context

/**
 * The last LATEST_USER_MSGS substantive prompts -> the session's RECENT
 * CONTEXT, used only on forced re-derive (/autorename) so the model can see
 * whether the session's actual focus has drifted from the original intent.
 * Scanned from the tail backwards; throwaway openers are skipped and
 * duplicates dropped. Empty when there is no substantive recent content.
 */
export function latestSelection(userMsgs: string[]): string {
  if (!userMsgs.length) return "";
  const seen = new Set<string>();
  const picked: string[] = [];
  for (let i = userMsgs.length - 1; i >= 0 && picked.length < LATEST_USER_MSGS; i -= 1) {
    const m = userMsgs[i];
    if (seen.has(m)) continue;
    seen.add(m);
    if (isTrivialMessage(m)) continue;
    picked.push(m);
  }
  if (!picked.length) return "";
  picked.reverse(); // most recent first, so truncateMsgs cuts the OLDEST on budget
  const kept = truncateMsgs(picked, LATEST_BUDGET);
  kept.reverse();   // back to transcript order for the model
  return kept.join("\n---\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/elling/git-repo/github/pi-auto-rename/.pi/worktrees/issue-1-autorename-force-unlock && ./test/run-all.sh`
Expected: `OK: 1/1 test files passed` with all checks `ok`.

- [ ] **Step 5: Commit**

```bash
cd /home/elling/git-repo/github/pi-auto-rename/.pi/worktrees/issue-1-autorename-force-unlock
git add lib/auto-rename-core.ts test/auto-rename-core.test.ts
git -c user.name="zhuxixi" -c user.email="zhuzhenxi_555@hotmail.com" commit -m "feat: latestSelection tail scan for recent context (issue #1)"
```

---

### Task 2: Force path unlock in `index.ts`

**Files:**
- Modify: `index.ts` (import line, `generateCore`, `runAutoRename`, `/autorename` command description)

**Interfaces:**
- Consumes: `latestSelection(userMsgs: string[]): string` from Task 1.
- Produces: `generateCore(rt: LlmRuntime, early: string, prevCore: string, recent = "", prevTitle = ""): Promise<string | null>` — `prevCore` non-empty still short-circuits (periodic lock); `recent`/`prevTitle` only feed the prompt when the model is actually called.

- [ ] **Step 1: Extend the import**

In `index.ts`, change the import block to include `latestSelection` (alphabetical order):

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
  latestSelection,
  looksLikeError,
  looksLikeResponse,
  parseIso,
  redact,
  scanUserMessages,
  truncateDisplay,
} from "./lib/auto-rename-core";
```

- [ ] **Step 2: Extend `generateCore`**

Replace the whole `generateCore` function with:

```ts
/**
 * Return the core-goal title, or null on hard failure. When prevCore is set
 * (the session already has an established, locked core) it is returned verbatim
 * with no model call — anchored refreshes are free, and the title only changes
 * if the anchor is dropped and re-derived. On a forced re-derive (/autorename)
 * prevCore is passed empty and recent/prevTitle feed the prompt instead, so the
 * model re-derives with the latest context (issue #1).
 */
async function generateCore(rt: LlmRuntime, early: string, prevCore: string, recent = "", prevTitle = ""): Promise<string | null> {
  if (!early) return null;
  if (prevCore) return prevCore; // locked; no model call needed
  let user = "Derive the session's CORE GOAL ONLY from the ORIGINAL INTENT below. " +
    "Output a concise noun-phrase title (3-5 English words or 6-12 Chinese chars): " +
    "what this one session is accomplishing. No punctuation, no repo name, no " +
    "issue/PR numbers, no greetings/role-play.\n\n";
  if (recent) {
    user += "RECENT CONTEXT (the session's latest user messages — if the actual " +
      "focus has evolved beyond the original intent, reflect the CURRENT focus):\n" +
      recent + "\n\n";
  }
  if (prevTitle) {
    user += "Previous title: " + prevTitle + "\n\n";
  }
  user += "ORIGINAL INTENT:\n" + early;
  const core = await llmOnce(rt, user,
    "Wrong: that was a sentence/response, not a title. Output ONLY a short noun-phrase title, nothing else.");
  return core || null;
}
```

- [ ] **Step 3: Unlock the force path in `runAutoRename`**

Replace the lock computation:

```ts
  const prevCore = anchor ?? "";
  // The core locks only once derived from substantive intent; before that
  // every refresh re-derives (cheap) so a junk core self-corrects.
  const locked = Boolean(st.coreLocked && prevCore);
```

with:

```ts
  const prevCore = anchor ?? "";
  // The core locks only once derived from substantive intent; before that
  // every refresh re-derives (cheap) so a junk core self-corrects. A forced
  // /autorename always unlocks: the model is called again with the latest
  // context so a drifted title can be regenerated (issue #1).
  const locked = !opts.force && Boolean(st.coreLocked && prevCore);
```

Replace the model-call block:

```ts
  // redact secrets before anything goes to the model
  const safeEarly = redact(early);
  const coreRaw = await generateCore(rt, safeEarly, locked ? prevCore : "");
```

with:

```ts
  // redact secrets before anything goes to the model
  const safeEarly = redact(early);
  const recent = opts.force ? redact(latestSelection(userMsgs)) : "";
  const coreRaw = await generateCore(rt, safeEarly, locked ? prevCore : "", recent, opts.force ? redact(prevCore) : "");
```

Replace the state write (both occurrences of `coreLocked: locked || sel.substantive`):

```ts
  const newState: AutoRenameState = { ...st, lastRunEpoch: now, lastSetTitle: title, lastCore: core, coreLocked: locked || sel.substantive, paused: false, pausedReason: undefined };
  if (title === st.lastSetTitle) {
    pi.appendEntry(STATE_ENTRY_TYPE, { ...st, lastRunEpoch: now, lastCore: core, coreLocked: locked || sel.substantive });
```

with:

```ts
  const newState: AutoRenameState = { ...st, lastRunEpoch: now, lastSetTitle: title, lastCore: core, coreLocked: locked || sel.substantive || opts.force, paused: false, pausedReason: undefined };
  if (title === st.lastSetTitle) {
    pi.appendEntry(STATE_ENTRY_TYPE, { ...st, lastRunEpoch: now, lastCore: core, coreLocked: locked || sel.substantive || opts.force });
```

(`opts.force` locks the freshly derived core so periodic refreshes don't churn it; the next `/autorename` unlocks again.)

- [ ] **Step 4: Update the command description**

Replace:

```ts
    description: "Force an auto-rename now (bypasses cooldown and pause)",
```

with:

```ts
    description: "Force a rename now (bypasses cooldown, pause, and core lock; re-derives with latest context)",
```

- [ ] **Step 5: Bundle check (no unit tests for the extension entry)**

Run: `cd /home/elling/git-repo/github/pi-auto-rename/.pi/worktrees/issue-1-autorename-force-unlock && npx esbuild index.ts --bundle --format=esm --platform=node --outfile=/tmp/autorename-bundle-check.mjs --log-level=warning --external:@earendil-works/pi-coding-agent --external:@earendil-works/pi-ai`
Expected: exit 0, no warnings.

- [ ] **Step 6: Run the full test suite**

Run: `cd /home/elling/git-repo/github/pi-auto-rename/.pi/worktrees/issue-1-autorename-force-unlock && ./test/run-all.sh`
Expected: `OK: 1/1 test files passed`.

- [ ] **Step 7: Commit**

```bash
cd /home/elling/git-repo/github/pi-auto-rename/.pi/worktrees/issue-1-autorename-force-unlock
git add index.ts
git -c user.name="zhuxixi" -c user.email="zhuzhenxi_555@hotmail.com" commit -m "feat: /autorename force unlocks core and re-derives with latest context (issue #1)"
```

---

### Task 3: Docs (README + CHANGELOG)

**Files:**
- Modify: `README.md` (Commands table + Troubleshooting)
- Modify: `CHANGELOG.md` (Unreleased section)

- [ ] **Step 1: Update the Commands table**

Replace:

```markdown
| `/autorename`         | Force a rename now (bypasses cooldown and pause)    |
```

with:

```markdown
| `/autorename`         | Force a rename now (bypasses cooldown, pause, and core lock; re-derives with latest context) |
```

- [ ] **Step 2: Update Troubleshooting**

Replace:

```markdown
- **Titles stop updating**: check `/autorename-status` — the session
  may be paused (manual rename detected) or the core may be locked
  (that's by design; `/autorename` forces a refresh).
```

with:

```markdown
- **Titles stop updating**: check `/autorename-status` — the session
  may be paused (manual rename detected) or the core may be locked
  (that's by design: periodic refreshes reuse the locked core without
  a model call). `/autorename` forces a re-derive — it bypasses the
  lock and includes the latest user messages, so a drifted title can
  be regenerated.
```

- [ ] **Step 3: Add a CHANGELOG entry**

Replace:

```markdown
## [Unreleased]
```

with:

```markdown
## [Unreleased]

### Fixed

- `/autorename` now truly regenerates the title: it bypasses the core
  lock and re-derives with the latest user messages (recent context)
  plus the previous title as prompt context, so a drifted or
  inaccurate title can be corrected on demand (issue #1).
```

- [ ] **Step 4: Commit**

```bash
cd /home/elling/git-repo/github/pi-auto-rename/.pi/worktrees/issue-1-autorename-force-unlock
git add README.md CHANGELOG.md
git -c user.name="zhuxixi" -c user.email="zhuzhenxi_555@hotmail.com" commit -m "docs: document /autorename force re-derive semantics (issue #1)"
```

---

## Manual Verification (after all tasks)

1. In a live pi session with the extension loaded from the worktree (or after
   `pi install` of the built package), run `/autorename-status` to confirm
   `locked=yes`.
2. Run `/autorename` — expect a model call (debug log shows the run) and a
   title that reflects the latest context; `/autorename-status` shows the new
   core and `locked=yes`.
3. Run `/autorename` again — expect another model call (force always unlocks).
4. Wait one `repeatEveryMin` cycle — expect no model call (locked core reused).
