# Evidence Source Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop quoted/read/document text from becoming issue work evidence while retaining lower-weight toolResult observations of real worktrees and paths.

**Architecture:** Keep `extractWorkEvidence()` as the public entry point and `pickDominant()` as the pure decision layer. Add quote-aware command-segment helpers, select toolCall fields by tool name, distinguish execution signals from toolResult observations, and score each signal kind at most once by taking the higher source weight.

**Tech Stack:** TypeScript, Node.js built-in test assertions via the repository's zero-framework helpers, esbuild, Bash.

**Approved spec:** `docs/superpowers/specs/2026-11-22-evidence-source-isolation-design.md` (A1–A8, U1).

## Global Constraints

- Work only in `/home/elling/git-repo/github/pi-auto-rename/.pi/worktrees/issue-13-evidence-source-isolation`; never edit the main checkout.
- Do not modify `index.ts`, prompts, quality gates, session state, `shouldReDerive`, or title formatting.
- Keep execution weights `mutate=6 / branch=3 / path=3 / view=1`, the unique-mutate short circuit, 2x ambiguity gate, and lower-issue-number tie-break unchanged.
- ToolResult branch/path observations weigh 1 each. Execution wins over observation for the same issue and signal kind; never add 3+1.
- ToolResult must never produce mutate/view. Title capture produces no claim and no score.
- Do not add a shell parser dependency, network request, `gh` invocation, or git-state query to evidence extraction.
- Unknown tools and unsupported shell wrappers fail closed for mutate/view.
- Unit tests use constructed in-memory transcripts; only the external replay task reads real board sessions.
- Repository commits use conventional commit messages and stage files by exact path. The external research script and JSON are not committed.

## File Map

- Modify `lib/auto-rename-core.ts`: shell helpers, tool-field selection, observation flags, scoring, claim guard.
- Modify `test/work-evidence.test.ts`: A1–A6 unit and integrated reproductions.
- Modify `test/docs-timing.test.ts`: README drift checks for A8.
- Modify `README.md`: evidence-source and weight documentation for A8.
- Create outside the repository `/home/elling/.github-issue-driven/zhuxixi/pi-auto-rename/issue-13/research/verify-13.mjs`: real-implementation replay for A7.
- Create outside the repository `/home/elling/.github-issue-driven/zhuxixi/pi-auto-rename/issue-13/research/scan-13-verified.json`: replay evidence for A7.

---

### Task 1: Quote-aware bash command evidence helpers

**Acceptance IDs:** A2.

**Files:**
- Modify: `lib/auto-rename-core.ts` (immediately before `scanIssueSignals`)
- Test: `test/work-evidence.test.ts`

**Interfaces:**
- Consumes: existing `extractWorkEvidence(branch)` tests and the repository's `check`/`eq` helpers.
- Produces:
  - `stripHeredocBodies(command: string): string`
  - `splitCommandSegments(command: string): string[]`
  - `ghIssueAction(segment: string): { kind: "mutate" | "view"; issueNumber: number } | null`
- All three are exported pure functions so tests can import them directly.

- [ ] **Step 1: Add failing direct helper tests**

Add the three functions to the import from `../lib/auto-rename-core`, then add:

```ts
// Real gh commands, including env assignment and the command wrapper.
eq("gh comment is a mutate", ghIssueAction("gh issue comment 13 --body x")?.kind, "mutate");
eq("gh view captures number", ghIssueAction("FOO=bar command gh issue view 460 --json title")?.issueNumber, 460);
eq("gh edit is a mutate", ghIssueAction("gh issue edit 7 --add-assignee @me")?.issueNumber, 7);

// Search text, quoted text, partial issue numbers and unsupported wrappers fail closed.
eq("rg pattern is not gh", ghIssueAction("rg 'gh issue comment 188' session.jsonl"), null);
eq("quoted gh is not a command", ghIssueAction("'gh issue comment 188'"), null);
eq("unsupported wrapper is not guessed", ghIssueAction("sudo gh issue close 13"), null);
eq("issue number must be a complete token", ghIssueAction("gh issue view 13x"), null);

// Separators inside quotes stay inside their segment.
const segments = splitCommandSegments("printf '&& ; |' && gh issue view 13\ngh issue close 14");
eq("quote-aware segment count", segments.length, 3);
eq("first segment retains quoted separators", segments[0], "printf '&& ; |'");
eq("second segment is the real view", ghIssueAction(segments[1])?.issueNumber, 13);
eq("third segment is the real close", ghIssueAction(segments[2])?.kind, "mutate");

const heredoc = "gh issue create --body-file - <<'EOF'\ngh issue comment 188\nissue-188-x10-release\nEOF\ngh issue view 13";
const stripped = stripHeredocBodies(heredoc);
check("heredoc body removed", !stripped.includes("comment 188") && !stripped.includes("x10-release"));
check("command after heredoc retained", stripped.includes("gh issue view 13"));
check("dash heredoc removed", !stripHeredocBodies("cat <<-EOF\ngh issue close 9\nEOF").includes("close 9"));
```

- [ ] **Step 2: Run the tests and confirm RED**

Run: `./test/run-all.sh`
Expected: `work-evidence.test.ts` fails to bundle because the three exports do not exist; no implementation has been added yet.

- [ ] **Step 3: Implement the three pure helpers**

Keep the old broad `RE_ISSUE_MUTATE` and `RE_ISSUE_VIEW` declarations and their existing `scanIssueSignals` usages unchanged in this task so the current tests stay green; Task 2 removes them together with rewiring. Add:

```ts
export function stripHeredocBodies(command: string): string {
  return command.replace(
    /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?\n[ \t]*\2\b/g,
    "<<HEREDOC-STRIPPED>>",
  );
}

export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const push = (end: number) => {
    const segment = command.slice(start, end).trim();
    if (segment) segments.push(segment);
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "\n" || ch === ";" || ch === "|" || ch === "&") {
      push(i);
      if ((ch === "|" || ch === "&") && command[i + 1] === ch) i += 1;
      start = i + 1;
    }
  }
  push(command.length);
  return segments;
}

export function ghIssueAction(
  segment: string,
): { kind: "mutate" | "view"; issueNumber: number } | null {
  const match = segment.trimStart().match(
    /^(?:(?:[A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|\S+)\s+)*(?:command\s+)?gh\s+issue\s+(edit|close|reopen|comment|view)\s+(\d+)(?:\s|$)/,
  );
  if (!match) return null;
  return {
    kind: match[1] === "view" ? "view" : "mutate",
    issueNumber: Number(match[2]),
  };
}
```

Do not call these helpers from `scanIssueSignals` in this task; Task 2 owns that wiring.

- [ ] **Step 4: Run the tests and confirm GREEN**

Run: `./test/run-all.sh`
Expected: all 5 test files pass, including every new A2 assertion.

- [ ] **Step 5: Commit the helper unit**

```bash
git add lib/auto-rename-core.ts test/work-evidence.test.ts
git commit -m "fix: recognize only executed gh issue commands"
```

---

### Task 2: Select execution evidence by tool field

**Acceptance IDs:** A1.

**Files:**
- Modify: `lib/auto-rename-core.ts` (`scanIssueSignals`)
- Test: `test/work-evidence.test.ts`

**Interfaces:**
- Consumes: Task 1's `stripHeredocBodies`, `splitCommandSegments`, and `ghIssueAction`.
- Produces: toolCall execution signals from bash `command`, write/edit `path`, git_worktree `path`+`branch`, and subagent `cwd` only. Unknown tools produce no execution signals.

- [ ] **Step 1: Add failing tool-field tests**

Add a generic helper beside the existing bash `toolCall` helper:

```ts
const namedToolCall = (name: string, args: Record<string, unknown>) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] },
});
```

Add these cases:

```ts
const pollutedWrite = namedToolCall("write", {
  path: "/tmp/evidence-fixture.md",
  content: "gh issue comment 188\nissue-188-x10-release\ngithub-issue-driven/z/p/issue-188/research/",
});
eq("write body alone creates no evidence", extractWorkEvidence([pollutedWrite]), null);

const writeTarget = namedToolCall("write", {
  path: "/home/me/.github-issue-driven/zhuxixi/pi-auto-rename/issue-13/research/note.md",
  content: "gh issue comment 188 and issue-188-x10-release are only examples",
});
eq("write target path claims its own issue", extractWorkEvidence([writeTarget])?.issueNumber, 13);

const editTarget = namedToolCall("edit", {
  path: "/home/me/.github-issue-driven/zhuxixi/pi-auto-rename/issue-14/research/note.md",
  edits: [{ oldText: "issue-188-x10-release", newText: "issue-999-other-work" }],
});
eq("edit target counts but edit bodies do not", extractWorkEvidence([editTarget])?.issueNumber, 14);

const gitWorktree = namedToolCall("git_worktree", {
  action: "add",
  path: "/repo/.pi/worktrees/issue-15-real-work",
  branch: "issue-15-real-work",
});
eq("git_worktree structured fields claim issue", extractWorkEvidence([gitWorktree])?.issueNumber, 15);

const child = namedToolCall("subagent", {
  agent: "implementer",
  cwd: "/repo/.pi/worktrees/issue-16-real-work",
  task: "Discuss gh issue comment 188 and issue-188-x10-release",
});
eq("subagent cwd counts but task does not", extractWorkEvidence([child])?.issueNumber, 16);

const readOnly = namedToolCall("read", {
  path: "/repo/.pi/worktrees/issue-17-not-a-claim/file.ts",
});
eq("read path is not execution evidence", extractWorkEvidence([readOnly]), null);

const searched = toolCall("rg 'gh issue comment 188' /tmp/session.jsonl");
eq("bash rg pattern does not mutate", extractWorkEvidence([searched]), null);
```

- [ ] **Step 2: Run the tests and confirm RED**

Run: `./test/run-all.sh`
Expected: write/read/rg cases fail because the old full-arguments scan sees their embedded issue references.

- [ ] **Step 3: Replace full-argument scanning with explicit field mapping**

Inside `scanIssueSignals`, keep `sig` and `claimSlug`, add a `claimPath` helper, delete the now-unused `RE_ISSUE_MUTATE` and `RE_ISSUE_VIEW` declarations, and replace the assistant toolCall loop with:

```ts
const claimPath = (text: string) => {
  for (const mm of text.matchAll(RE_DRIVEN_PATH)) sig(Number(mm[1])).path = true;
};

// Inside each toolCall block:
const name = String(b.name ?? "");
const args = (b.arguments ?? {}) as Record<string, unknown>;
if (name === "bash") {
  const command = stripHeredocBodies(String(args.command ?? ""));
  for (const segment of splitCommandSegments(command)) {
    const action = ghIssueAction(segment);
    if (!action) continue;
    const s = sig(action.issueNumber);
    if (action.kind === "mutate") s.mutate = true;
    else s.view = true;
  }
  claimSlug(command);
  claimPath(command);
  continue;
}

let target = "";
if (name === "write" || name === "edit") target = String(args.path ?? "");
else if (name === "git_worktree") target = JSON.stringify({ path: args.path, branch: args.branch });
else if (name === "subagent") target = String(args.cwd ?? "");
if (target) {
  claimSlug(target);
  claimPath(target);
}
```

Keep the existing toolResult branch unchanged in this task; Task 3 changes its weights.

- [ ] **Step 4: Run all unit tests**

Run: `./test/run-all.sh`
Expected: all 5 test files pass; the new A1 cases and all existing #7/#11 cases are green.

- [ ] **Step 5: Commit the tool-field unit**

```bash
git add lib/auto-rename-core.ts test/work-evidence.test.ts
git commit -m "fix: isolate execution evidence from document payloads"
```

---

### Task 3: Downweight observations without losing real worktree evidence

**Acceptance IDs:** A3, A4, A5, A6.

**Files:**
- Modify: `lib/auto-rename-core.ts` (`IssueSignals`, `scanIssueSignals`, `pickDominant`, rank formula)
- Test: `test/work-evidence.test.ts`

**Interfaces:**
- Consumes: Task 2's tool-field mapping and title capture.
- Produces: optional `observedBranch?: boolean` and `observedPath?: boolean` on exported `IssueSignals`; observation-aware claim guard and max-source rank formula.

- [ ] **Step 1: Add failing scoring, title-only, #178 and integrated #13 tests**

```ts
// Title capture alone is not a claim.
eq("title-only result is not work evidence", extractWorkEvidence([toolResult(GH_VIEW_460)]), null);

// Execution+observation of branch must be 3, not 4. If summed to 4,
// issue 20 would beat issue 10's two observation points at exactly 2x.
const maxSource = extractWorkEvidence([
  toolCall("git worktree add .pi/worktrees/issue-20-real-work -b issue-20-real-work"),
  toolResult("issue-20-real-work"),
  toolResult("issue-10-other-work github-issue-driven/z/p/issue-10/research/"),
]);
eq("same signal kind takes highest source weight", maxSource, null);

// Real #178 shape: two observations beat three one-point observations.
const observed178 = extractWorkEvidence([
  toolResult("issue-178-accept-registration-race github-issue-driven/z/p/issue-178/research/"),
  toolResult("issue-33-other-work"),
  toolResult("github-issue-driven/z/p/issue-170/research/"),
  toolResult("github-issue-driven/z/p/issue-182/research/"),
]);
eq("two result observations retain issue 178", observed178?.issueNumber, 178);
eq("result branch still supplies slug", observed178?.slug, "accept-registration-race");

// Full #13 pollution shape: only #11 has a real mutate. #188 appears in
// search text, a write body, heredoc body and find output.
const integrated13 = extractWorkEvidence([
  toolCall("gh issue view 11"),
  toolCall("gh issue comment 11 --body start"),
  toolCall("mkdir -p ~/.github-issue-driven/zhuxixi/pi-auto-rename/issue-11/research"),
  toolCall("git worktree add .pi/worktrees/issue-11-evidence-dominance -b issue-11-evidence-dominance"),
  toolCall("rg 'gh issue comment 188' /tmp/session.jsonl"),
  namedToolCall("write", {
    path: "/tmp/examples.md",
    content: "issue-188-x10-release github-issue-driven/z/p/issue-188/research/",
  }),
  toolCall("gh issue create --body-file - <<'EOF'\ngh issue comment 188\nissue-188-x10-release\nEOF"),
  toolResult("github-issue-driven/z/p/issue-188/research/"),
]);
eq("document and result pollution no longer hides issue 11", integrated13?.issueNumber, 11);
```

Leave the existing #11 unique-mutate, multi-mutate, non-top and tie-break tests unchanged.

- [ ] **Step 2: Run the tests and confirm RED**

Run: `./test/run-all.sh`
Expected: observation-only cases either fail or return the pre-fix ambiguous result; integrated #13 is not reliably #11.

- [ ] **Step 3: Add observation flags and max-source scoring**

Extend the signal structure and constants:

```ts
const W_MUTATE = 6, W_BRANCH = 3, W_PATH = 3, W_VIEW = 1, W_OBSERVED = 1;

export interface IssueSignals {
  mutate: boolean;
  view: boolean;
  branch: boolean;
  path: boolean;
  observedBranch?: boolean;
  observedPath?: boolean;
  slug: string;
  title: string;
}
```

Initialize both observation flags to `false` in `sig`. Change the slug/path helpers to accept a source:

```ts
const claimSlug = (text: string, observed = false) => {
  for (const mm of text.matchAll(RE_BRANCH_SLUG)) {
    const s = sig(Number(mm[1]));
    if (observed) s.observedBranch = true;
    else s.branch = true;
    if (!s.slug) s.slug = mm[2].toLowerCase();
  }
};
const claimPath = (text: string, observed = false) => {
  for (const mm of text.matchAll(RE_DRIVEN_PATH)) {
    const s = sig(Number(mm[1]));
    if (observed) s.observedPath = true;
    else s.path = true;
  }
};
```

The toolResult branch must call `claimSlug(text, true)` and `claimPath(text, true)`, then call `captureIssueTitles(text, sig)` exactly as before.

Change the no-claim guard in `pickDominant` to:

```ts
if (!top || !(top.s.mutate || top.s.branch || top.s.path || top.s.observedBranch || top.s.observedPath)) return null;
```

Use this exact rank formula in `extractWorkEvidence`:

```ts
w: (s.mutate ? W_MUTATE : 0) +
  (s.branch ? W_BRANCH : s.observedBranch ? W_OBSERVED : 0) +
  (s.path ? W_PATH : s.observedPath ? W_OBSERVED : 0) +
  (s.view ? W_VIEW : 0),
```

Update comments to say `mutate6 | execution branch/path3 | observed branch/path1 | view1`. Do not alter the unique-mutate branch, 2x comparison, or tie-break.

- [ ] **Step 4: Run all unit tests**

Run: `./test/run-all.sh`
Expected: all 5 test files pass, including A3/A4/A5 and every pre-existing assertion required by A6.

- [ ] **Step 5: Commit the scoring unit**

```bash
git add lib/auto-rename-core.ts test/work-evidence.test.ts
git commit -m "fix: downweight observed issue evidence"
```

---

### Task 4: Document evidence provenance and prevent drift

**Acceptance IDs:** A8.

**Files:**
- Modify: `README.md` (the `Issue evidence` paragraph)
- Modify: `test/docs-timing.test.ts`

**Interfaces:**
- Consumes: Task 3's final scoring behavior.
- Produces: user-facing documentation and static assertions; no runtime interface changes.

- [ ] **Step 1: Add failing README assertions**

Add to `test/docs-timing.test.ts`:

```ts
check("evidence section separates execution from observation", () => {
  if (!/observed|observation|toolResult/i.test(readme)) throw new Error("evidence section must document toolResult observations");
  if (!/write\/edit|write and edit/i.test(readme)) throw new Error("evidence section must document write/edit path-only scanning");
});
check("evidence section documents observation weights and max-source rule", () => {
  if (!/observ[^\n]*\b1\b/i.test(readme)) throw new Error("observed branch/path weight must be 1");
  if (!/higher|maximum|max|取最高/i.test(readme)) throw new Error("same-kind signals must use the higher source weight");
});
```

- [ ] **Step 2: Run the static test and confirm RED**

Run: `./test/run-all.sh`
Expected: `docs-timing.test.ts` fails because README does not yet describe observation weights or path-only write/edit scanning.

- [ ] **Step 3: Rewrite the evidence paragraph**

Replace the existing `Issue evidence` paragraph with:

```markdown
**Issue evidence (issues #7 and #13)**: the extension identifies a GitHub
issue "under work" without network access. Execution evidence comes only from
bash command text (with heredoc bodies removed and `gh` recognized as an actual
command), write/edit target paths (never their document bodies), structured
git_worktree path/branch fields, and subagent working directories. Tool results
still provide issue titles and observed branch/research-path signals, but each
observation weighs 1 instead of the execution weight 3. When execution and
observation describe the same issue and signal kind, only the higher weight is
counted. A unique mutate claim on the top-scoring issue wins outright;
otherwise the top must lead the runner-up by 2x. Winning evidence is injected
into the title prompt as a high-weight block, and a new evidence key overrides
the core lock for exactly one re-derive so existing stage-label titles
(`issue认领处理`-style) self-heal. Sessions with no issue evidence are untouched.
```

- [ ] **Step 4: Run all tests and the standalone build**

Run:

```bash
./test/run-all.sh
out="$(mktemp -d)/auto-rename-core.mjs"
npx esbuild lib/auto-rename-core.ts --bundle --format=esm --platform=node --outfile="$out"
```

Expected: all 5 test files pass and esbuild exits 0.

- [ ] **Step 5: Commit the documentation unit**

```bash
git add README.md test/docs-timing.test.ts
git commit -m "docs: explain issue evidence provenance"
```

---

### Task 5: Replay baseline and fixed real implementations over the same sessions

**Acceptance IDs:** A7.

**Files:**
- Create outside repository: `/home/elling/.github-issue-driven/zhuxixi/pi-auto-rename/issue-13/research/verify-13.mjs`
- Create outside repository: `/home/elling/.github-issue-driven/zhuxixi/pi-auto-rename/issue-13/research/arc-bundle-base-0.4.1.mjs`
- Create outside repository: `/home/elling/.github-issue-driven/zhuxixi/pi-auto-rename/issue-13/research/arc-bundle-fixed.mjs`
- Create outside repository: `/home/elling/.github-issue-driven/zhuxixi/pi-auto-rename/issue-13/research/scan-13-verified.json`

**Interfaces:**
- Consumes: `main@0389c9d` and the completed worktree implementation.
- Produces: per-view baseline/fixed issue decisions and explicit recovered/lost/flipped lists. No repository commit because these are research artifacts.

- [ ] **Step 1: Create the real-implementation replay script**

The script must not import `scan-selfpollution.mjs`, because that legacy entry point overwrites its JSON on import. Create `verify-13.mjs` with:

```js
#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const main = "/home/elling/git-repo/github/pi-auto-rename";
const worktree = path.join(main, ".pi/worktrees/issue-13-evidence-source-isolation");
const research = path.join(os.homedir(), ".github-issue-driven/zhuxixi/pi-auto-rename/issue-13/research");
const baseBundle = path.join(research, "arc-bundle-base-0.4.1.mjs");
const fixedBundle = path.join(research, "arc-bundle-fixed.mjs");

function bundle(source, outfile) {
  execFileSync("npx", [
    "esbuild", source, "--bundle", "--format=esm", "--platform=node", `--outfile=${outfile}`,
  ], { cwd: main, stdio: "inherit" });
}
bundle(path.join(main, "lib/auto-rename-core.ts"), baseBundle);
bundle(path.join(worktree, "lib/auto-rename-core.ts"), fixedBundle);

const base = await import(pathToFileURL(baseBundle).href);
const fixed = await import(pathToFileURL(fixedBundle).href);
const viewsRoot = path.join(os.homedir(), ".pi/agent/agent-board/views");
const rows = [];
const failures = [];
const decisions = new Map();
let skipped = 0;
let scanned = 0;

for (const view of fs.readdirSync(viewsRoot).filter((name) => !name.startsWith("."))) {
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(viewsRoot, view, "meta.json"), "utf8")); }
  catch { skipped += 1; continue; }
  if (!meta.sessionFile || !fs.existsSync(meta.sessionFile)) { skipped += 1; continue; }
  let branch;
  try {
    branch = fs.readFileSync(meta.sessionFile, "utf8").split("\n").filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { skipped += 1; continue; }

  // Both implementations consume this exact same parsed array.
  scanned += 1;
  const before = base.extractWorkEvidence(branch)?.issueNumber ?? null;
  const after = fixed.extractWorkEvidence(branch)?.issueNumber ?? null;
  decisions.set(view, { before, after });
  const kind = before === after ? "same"
    : before !== null && after !== null ? "flipped"
    : before === null ? "recovered" : "lost";
  if (kind !== "same") rows.push({ view, name: meta.name ?? "", before, after, kind });
}

const flipped = rows.filter((row) => row.kind === "flipped");
const recovered = rows.filter((row) => row.kind === "recovered");
const lost = rows.filter((row) => row.kind === "lost");
if (flipped.length) failures.push(`non-null decisions flipped: ${flipped.map((row) => row.view).join(", ")}`);
for (const row of lost) {
  if (row.view !== "view_9ba08f4367" || row.before !== 10640 || row.after !== null) {
    failures.push(`unexpected lost decision: ${JSON.stringify(row)}`);
  }
}

const keyViewIds = ["view_41be5cd13c", "view_eff2b7b9ba", "view_692d8904a2", "view_5b344bae75", "view_9ba08f4367"];
const replay = new Map(keyViewIds.map((view) => [view, decisions.get(view)]));
for (const view of keyViewIds) {
  if (!replay.get(view)) failures.push(`missing key view: ${view}`);
}
const expected = {
  view_41be5cd13c: { before: 178, after: 178 },
  view_eff2b7b9ba: { before: 188, after: 188 },
  view_692d8904a2: { after: 11 },
  view_5b344bae75: { after: 7 },
  view_9ba08f4367: { after: null },
};
for (const [view, expectation] of Object.entries(expected)) {
  const actual = replay.get(view);
  for (const [side, value] of Object.entries(expectation)) {
    if (actual?.[side] !== value) failures.push(`${view} ${side}: expected ${value}, got ${actual?.[side]}`);
  }
}

const report = { views: scanned, skipped, flipped, recovered, lost, keyViews: Object.fromEntries(replay), failures };
fs.writeFileSync(path.join(research, "scan-13-verified.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ views: report.views, skipped, flipped: flipped.length, recovered: recovered.length, lost: lost.length, failures }, null, 2));
if (failures.length) process.exit(1);
```

- [ ] **Step 2: Run the replay**

Run: `node /home/elling/.github-issue-driven/zhuxixi/pi-auto-rename/issue-13/research/verify-13.mjs`
Expected: exit 0; `flipped=0`; only the declared #10640 loss; all five key-view assertions pass.

- [ ] **Step 3: Review every difference**

Read `scan-13-verified.json`. Confirm every `recovered` entry has a subject consistent with its session name, and record the reviewed recovered list in the final implementation report. Extra recovered views are evidence to review, not automatic failures; any non-null flip or unexpected loss is a blocking failure.

---

### Task 6: Final acceptance and deployment-gated dogfood

**Acceptance IDs:** A6, A7, A8, U1.

**Files:**
- Read: `test/run-all.sh`, `README.md`, `research/scan-13-verified.json`
- No runtime file changes.

- [ ] **Step 1: Re-run the complete automated suite**

Run from the worktree:

```bash
./test/run-all.sh
out="$(mktemp -d)/auto-rename-core.mjs"
npx esbuild lib/auto-rename-core.ts --bundle --format=esm --platform=node --outfile="$out"
```

Expected: all test files pass and esbuild exits 0.

- [ ] **Step 2: Recheck the replay artifact**

Run: `node /home/elling/.github-issue-driven/zhuxixi/pi-auto-rename/issue-13/research/verify-13.mjs`
Expected: the A7 assertions still pass. Record the actual command output in the implementation report rather than copying the prototype counts.

- [ ] **Step 3: Mark U1 pending until the real npm copy is updated**

Do not run dogfood from the worktree and call it deployment verification. After merge/release and explicit deployment permission, execute:

```bash
grep -c observedBranch ~/.pi/agent/npm/node_modules/@zhuxixi/pi-auto-rename/lib/auto-rename-core.ts || true
pi update --extensions
```

Reload Pi, then run the same grep again. It must return a non-zero count and the file must contain the observation-weight implementation. Only then run `/autorename` in the real #13 session and inspect `/autorename-status` plus session state.

Pass criteria: evidence is `issue:13`; the title describes evidence-source/text-pollution repair rather than #188/#11; an ordinary no-evidence session keeps its title. If any of these deployment or observation steps has not happened, record U1 as `pending`.

- [ ] **Step 4: Produce the acceptance ledger**

Create the repository-external implementation report under `~/.github-issue-driven/zhuxixi/pi-auto-rename/issue-13/research/sdd/`. For every A1–A8/U1 ID, record the task that owns it, the exact command or manual step, actual result, and any pending item. Do not claim full acceptance while U1 is pending.

## Plan Self-Review Checklist

- D1/D3 map to Task 2/A1; D2 maps to Task 1/A2; D4/D5/D6 map to Task 3/A3–A5; D7 maps to Task 3's title-only assertions; D8 maps to Task 4/A8.
- A6 is checked in Tasks 3 and 6; A7 is checked in Tasks 5 and 6; U1 is explicitly deferred to the real deployment path in Task 6.
- Every repository task has exact files, test input, implementation shape, verification command, and a conventional commit. External research tasks have no artificial commit step.
- No task changes `index.ts` or any prompt/state/quality-gate contract.
