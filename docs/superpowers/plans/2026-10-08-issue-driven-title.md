# Issue-Driven Title Implementation Plan (issue #7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** issue-driven 会话的标题反映所做 issue 的主题（从 transcript 工具证据抽取），存量垃圾标题自愈一次。

**Architecture:** 纯函数层（lib/auto-rename-core.ts）新增证据抽取 `extractWorkEvidence` 与 prompt 组装扩展；入口层（index.ts）只做接线（每轮 run 抽一次证据、`shouldReDerive` 判重推、state 记 `evidenceKey`）。spec：`docs/superpowers/specs/2026-10-08-issue-driven-title-design.md`。

**Tech Stack:** TypeScript (ESM, no build), esbuild+node 测试（`test/run-all.sh`，零依赖无框架），pi Extension API。

## Global Constraints

- **Worktree 作业**：`WT=/home/elling/git-repo/github/pi-auto-rename/.pi/worktrees/issue-7-autorename-issue-driven-title`。所有编辑/测试/commit 在 `$WT` 内（`git -C $WT`），**禁碰 main**。
- 零联网、零 `gh` 依赖：issue 标题只从 transcript 的 toolResult 解析。
- 不改 `scanUserMessages` / `earlySelection` / `latestSelection` 的语义与签名。
- 质量门 force 语义不变（issue #5）：force 下 meta 静默放行、non-goal 警告接受。
- 无证据（`extractWorkEvidence` 返回 null）时：`buildUserPrompt` 输出与现状**逐字节一致**（除 Task 6 的 system prompt 恒定行——那是全局有意变更）。
- 测试命令统一：`cd $WT && ./test/run-all.sh`（跑全部测试文件）；新增测试放 `test/work-evidence.test.ts`。
- commit 用 conventional commits；`git add` 按文件，不用 `git add -A`。
- `gh pr view` **不**进入 issue 信号表（PR 号与 issue 号同号空间，PR 标题也不是 issue 标题；PR-driven 会话是 follow-up 范围）。
- 信号计分为**每 issue 每类二元**（0/1），不是出现次数（worktree 路径会重复出现几十次）。

## 精确接口契约（所有 task 共用，不得改名）

```ts
// lib/auto-rename-core.ts 新增导出
export interface WorkEvidence {
  issueNumber: number;
  title: string;   // "" when the issue title was never captured
  slug: string;    // "" when no issue-N-<slug> was seen
  key: string;     // "issue:460" — state comparison key
}
export function extractWorkEvidence(branch: any[]): WorkEvidence | null;
export function evidencePromptBlock(e: WorkEvidence): string;
export function slugToCore(slug: string): string;
export function shouldReDerive(st: { coreLocked?: boolean; evidenceKey?: string }, e: WorkEvidence | null): boolean;
// buildUserPrompt 增可选第 6 参（旧调用点不传 = 行为不变）
export function buildUserPrompt(force: boolean, lang: TitleLang, early: string, recent: string, prevTitle: string, evidence?: WorkEvidence | null): string;
```

测试 fixture（各 task 的测试文件共用，放在 `test/work-evidence.test.ts` 顶部）：

```ts
const toolCall = (command: string) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command } }] },
});
const toolResult = (text: string) => ({
  type: "message",
  message: { role: "toolResult", content: [{ type: "text", text }] },
});
```

---

### Task 1: 证据扫描与 dominant 判定 — `extractWorkEvidence`（A1）

**Files:**
- Modify: `lib/auto-rename-core.ts`（新增 issue #7 区块，放在 `latestSelection` 之后）
- Create: `test/work-evidence.test.ts`

**Interfaces:**
- Consumes: `blockText(content)`（lib 已有导出）。
- Produces: `WorkEvidence`、`extractWorkEvidence(branch)`。

- [ ] **Step 1: 写失败测试**（`test/work-evidence.test.ts`）

```ts
// issue #7 — work-evidence extraction from tool calls / tool results.
import { extractWorkEvidence } from "../lib/auto-rename-core";
import { exitFail, check, eq } from "./helpers";

const toolCall = (command: string) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command } }] },
});
const toolResult = (text: string) => ({
  type: "message",
  message: { role: "toolResult", content: [{ type: "text", text }] },
});
const userMsg = (text: string) => ({
  type: "message",
  message: { role: "user", content: [{ type: "text", text }] },
});

// real-world shape from view_0b5f8f44b5 (gh issue view plain output)
const GH_VIEW_460 =
  "title:\tbug(test): pytest 写穿真实 ~/.zk_config.json——测试 KB 注册进全局配置且切换 default，用户 CLI 静默失联\n" +
  "state:\tOPEN\nauthor:\tzhuxixi\nlabels:\tbug\nnumber:\t460\n--\n## 现象\n正文……";

// claim signals -> dominant issue with captured title
const ev1 = extractWorkEvidence([
  userMsg("hello"),
  toolCall("gh issue view 460 --repo jfox"),
  toolResult(GH_VIEW_460),
  toolCall("gh issue comment 460 --repo zhuxixi/jfox --body '开始处理'"),
  toolCall("git worktree add .pi/worktrees/issue-460-test-config-isolation -b issue-460-test-config-isolation"),
]);
eq("claim+view+title -> #460 with title", ev1?.issueNumber, 460);
check("title captured from plain gh view", (ev1?.title ?? "").includes("pytest 写穿"));
eq("slug from branch", ev1?.slug, "test-config-isolation");
eq("key format", ev1?.key, "issue:460");

// json shape: number BEFORE title, and title BEFORE number (both orders)
const evJson = extractWorkEvidence([
  toolCall("gh issue view 460 --json number,title,state"),
  toolResult('{"number":460,"title":"修复配置写穿","state":"OPEN"}'),
  toolCall("gh issue edit 460 --add-assignee @me"),
]);
eq("json number-then-title", evJson?.title, "修复配置写穿");
const evJson2 = extractWorkEvidence([
  toolCall("gh issue view 461 --json title,number"),
  toolResult('{"title":"标题在前","number":461}'),
  toolCall("gh issue close 461"),
]);
eq("json title-then-number", evJson2?.title, "标题在前");

// github-issue-driven research path is a claim signal
const evPath = extractWorkEvidence([
  toolCall("mkdir -p ~/.claude/github-issue-driven/zhuxixi/jfox/issue-433/ && echo hi > ~/.claude/github-issue-driven/zhuxixi/jfox/issue-433/research/a.md"),
]);
eq("driven path claims issue", evPath?.issueNumber, 433);

// view-only (no claim) -> null, even with a single viewed issue + title
const evViewOnly = extractWorkEvidence([
  toolCall("gh issue view 500"),
  toolResult("title:\t只是看看\nstate:\tOPEN\nnumber:\t500\n--\n正文"),
]);
eq("view-only -> null", evViewOnly, null);

// multi-issue triage: claims on two issues, top < 2x second -> null
const evAmbiguous = extractWorkEvidence([
  toolCall("gh issue comment 10 --body x"),
  toolCall("gh issue comment 11 --body y"),
  toolCall("gh issue view 10"), toolCall("gh issue view 11"),
]);
eq("ambiguous claims -> null", evAmbiguous, null);

// binary counting: the same worktree path 50x must NOT out-claim a real claim
const manyPathCalls = Array.from({ length: 50 }, () =>
  toolCall(`git -C .pi/worktrees/issue-999-heavy-mentioned status`));
const evBinary = extractWorkEvidence([
  ...manyPathCalls,
  toolCall("gh issue comment 888 --body 'fix'"),
]);
eq("binary counting keeps dominance sane", evBinary?.issueNumber, 888);

// empty branch / no tool activity -> null
eq("no messages -> null", extractWorkEvidence([]), null);
eq("user-only branch -> null", extractWorkEvidence([userMsg("hello"), userMsg("看一下 issue 460")]), null);
```

注意：`test/helpers.ts` **不存在**——本仓测试无框架，沿用 `test/auto-rename-core.test.ts` 里的本地 `check/eq/exitFail` 模式。Step 1 一并把该文件顶部的这三个 helper（复制自现有测试文件的实现）放进 `test/work-evidence.test.ts`，不要 import 不存在的模块。现有文件里 helper 长这样（照抄）：

```ts
let failed = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failed += 1;
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}`}`);
  if (!ok) failed += 1;
}
// ... 文件末尾：
if (failed > 0) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log("all checks passed");
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $WT && ./test/run-all.sh`
Expected: FAIL — `extractWorkEvidence` 未导出（bundle 报错或运行时报 undefined is not a function），本文件失败、原文件仍过。

- [ ] **Step 3: 实现**（`lib/auto-rename-core.ts`，插在 `latestSelection` 函数之后）

```ts
// ---- issue-driven work evidence (issue #7) -----------------------------------
// The session's "issue under work" is recovered from tool calls and tool
// results — the subject of an issue-driven session lives there, not in the
// user prompts ("看一下 issue 460" names no subject). Zero network: the issue
// title is parsed from `gh issue view` output already present in the
// transcript. Signals are counted BINARY per issue (a worktree path appears
// in dozens of later commands; occurrence counts would inflate it).

export interface WorkEvidence {
  issueNumber: number;
  title: string;   // "" when the issue title was never captured
  slug: string;    // "" when no issue-N-<slug> was seen
  key: string;     // "issue:460" — state comparison key
}

// explicit issue mutations: the strongest claim ("working on", not "looking at")
const RE_ISSUE_MUTATE = /gh\s+issue\s+(?:edit|close|reopen|comment)\s+(\d+)/g;
// gh issue view N is weak: triage sessions view dozens of issues
const RE_ISSUE_VIEW = /gh\s+issue\s+view\s+(\d+)/g;
// branch / worktree slugs (issue-460-test-config-isolation) claim + carry a subject slug
const RE_BRANCH_SLUG = /(?<![\w-])issue-(\d+)-([a-z0-9][a-z0-9-]{2,})/gi;
// the github-issue-driven research/spec directory layout claims its issue
const RE_DRIVEN_PATH = /github-issue-driven\/[^\s"'/]+\/[^\s"'/]+\/issue-(\d+)\//g;

interface IssueSignals {
  mutate: boolean; view: boolean; branch: boolean; path: boolean;
  slug: string; title: string;
}

function scanIssueSignals(branch: any[]): Map<number, IssueSignals> {
  const map = new Map<number, IssueSignals>();
  const sig = (n: number): IssueSignals => {
    let s = map.get(n);
    if (!s) {
      s = { mutate: false, view: false, branch: false, path: false, slug: "", title: "" };
      map.set(n, s);
    }
    return s;
  };
  const claimSlug = (text: string) => {
    for (const mm of text.matchAll(RE_BRANCH_SLUG)) {
      const s = sig(Number(mm[1]));
      s.branch = true;
      if (!s.slug) s.slug = mm[2].toLowerCase();
    }
  };
  for (const entry of branch) {
    if (entry?.type !== "message" || !entry.message) continue;
    const m = entry.message;
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type !== "toolCall") continue;
        const args = JSON.stringify(b.arguments ?? {});
        for (const mm of args.matchAll(RE_ISSUE_MUTATE)) sig(Number(mm[1])).mutate = true;
        for (const mm of args.matchAll(RE_ISSUE_VIEW)) sig(Number(mm[1])).view = true;
        for (const mm of args.matchAll(RE_DRIVEN_PATH)) sig(Number(mm[1])).path = true;
        claimSlug(args);
      }
    }
    if (m.role === "toolResult") {
      const text = blockText(m.content);
      if (!text) continue;
      for (const mm of text.matchAll(RE_DRIVEN_PATH)) sig(Number(mm[1])).path = true;
      claimSlug(text);
      captureIssueTitles(text, sig);
    }
  }
  return map;
}

/** Pull `title:`/`number:` pairs (gh issue view plain) and {"number":N,
 *  "title":"…"} (gh view --json, either key order) out of one tool result. */
function captureIssueTitles(text: string, sig: (n: number) => IssueSignals): void {
  const titles = [...text.matchAll(/^title:\t?(\S.*)$/gm)].map((m) => m[1].trim());
  const numbers = [...text.matchAll(/^number:\t?(\d+)$/gm)].map((m) => Number(m[1]));
  if (titles.length && titles.length === numbers.length) {
    titles.forEach((t, i) => { const s = sig(numbers[i]); if (!s.title) s.title = t.slice(0, 200); });
    return;
  }
  try { // whole-result JSON (gh issue view --json alone in the result)
    const o = JSON.parse(text);
    if (o && typeof o === "object" && typeof o.title === "string" && typeof o.number === "number") {
      const s = sig(o.number);
      if (!s.title) s.title = String(o.title).slice(0, 200);
      return;
    }
  } catch { /* embedded in a bigger result — regex fallback below */ }
  for (const mm of text.matchAll(/"number"\s*:\s*(\d+)[\s\S]{0,400}?"title"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    const s = sig(Number(mm[1]));
    if (!s.title) { try { s.title = JSON.parse(`"${mm[2]}"`).slice(0, 200); } catch { /* keep "" */ } }
  }
  for (const mm of text.matchAll(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"[\s\S]{0,400}?"number"\s*:\s*(\d+)/g)) {
    const s = sig(Number(mm[2]));
    if (!s.title) { try { s.title = JSON.parse(`"${mm[1]}"`).slice(0, 200); } catch { /* keep "" */ } }
  }
}

const W_MUTATE = 6, W_BRANCH = 3, W_PATH = 3, W_VIEW = 1;

/** The single issue this session is WORKING on, or null. Requires a claim
 *  signal (mutate/branch/path — binary) and a 2x lead over the runner-up;
 *  view-only and ambiguous sessions deliberately yield no evidence. */
export function extractWorkEvidence(branch: any[]): WorkEvidence | null {
  const map = scanIssueSignals(branch);
  const ranked = [...map.entries()]
    .map(([n, s]) => ({
      n, s,
      w: (s.mutate ? W_MUTATE : 0) + (s.branch ? W_BRANCH : 0) + (s.path ? W_PATH : 0) + (s.view ? W_VIEW : 0),
    }))
    .sort((a, b) => b.w - a.w);
  const top = ranked[0];
  if (!top || !(top.s.mutate || top.s.branch || top.s.path)) return null; // no claim at all
  const second = ranked[1];
  if (second && top.w < 2 * second.w) return null;                        // ambiguous
  return { issueNumber: top.n, title: top.s.title, slug: top.s.slug, key: `issue:${top.n}` };
}
```

实现注意：
- `RE_BRANCH_SLUG` 用 lookbehind `(?<![\w-])`，防 `sub-issue-460-x` / `myissue-460-x` 误配；node ≥24 支持。
- `matchAll` 要求 `/g` flag（所有 RE 都带）。
- 上面代码里 `evBinary` 用例断言 888 胜出：999 只有 branch(3)+view? 无 view → w=3；888 mutate=6 → 6 ≥ 2×3 ✓ 成立。若你的实现里 888 没过 2× 线，检查权重。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd $WT && ./test/run-all.sh`
Expected: OK: 2/2 test files passed

- [ ] **Step 5: Commit**

```bash
git -C $WT add lib/auto-rename-core.ts test/work-evidence.test.ts
git -C $WT commit -m "feat: extract issue-under-work evidence from transcript (issue #7)"
```

---

### Task 2: prompt 组装扩展 — `evidencePromptBlock` + `buildUserPrompt` 增参（A2）

**Files:**
- Modify: `lib/auto-rename-core.ts`
- Modify: `test/work-evidence.test.ts`（追加用例）

**Interfaces:**
- Consumes: `WorkEvidence`（Task 1）、现有 `buildUserPrompt(force, lang, early, recent, prevTitle)`。
- Produces: `evidencePromptBlock(e)`、`buildUserPrompt(..., evidence?)`。

- [ ] **Step 1: 追加失败测试**

```ts
import { buildUserPrompt, evidencePromptBlock } from "../lib/auto-rename-core";

const EV: WorkEvidence = { issueNumber: 460, title: "bug(test): pytest 写穿真实配置", slug: "test-config-isolation", key: "issue:460" };

// block content
const blk = evidencePromptBlock(EV);
check("block header names the rule", blk.includes("GITHUB ISSUE UNDER WORK") && blk.includes("MUST be reflected in the core"));
check("block carries number + title", blk.includes("#460") && blk.includes("pytest 写穿真实配置"));

// slug subject when title missing
check("slug subject fallback", evidencePromptBlock({ issueNumber: 7, title: "", slug: "fix-cursor", key: "issue:7" }).includes("fix-cursor"));
// neither: explicit derive-from-intent hint
check("no subject hint", evidencePromptBlock({ issueNumber: 7, title: "", slug: "", key: "issue:7" }).includes("ORIGINAL INTENT"));

// buildUserPrompt: evidence block sits between Previous title and ORIGINAL INTENT
const p = buildUserPrompt(false, "auto", "early intent text", "recent ctx", "Old title", EV);
const iPrev = p.indexOf("Previous title"), iEv = p.indexOf("GITHUB ISSUE UNDER WORK"), iOrig = p.indexOf("ORIGINAL INTENT:");
check("block order prev < evidence < original", iPrev >= 0 && iPrev < iEv && iEv < iOrig);
check("prevTitle line mentions keep-if-subject rule", p.includes("keep it unchanged") || p.includes("output it unchanged"));

// no evidence -> byte-identical legacy output (incl. legacy prevTitle wording)
eq("null evidence legacy byte-compat",
  buildUserPrompt(false, "auto", "early", "", "Old title", null),
  buildUserPrompt(false, "auto", "early", "", "Old title"));
eq("omitted evidence legacy byte-compat",
  buildUserPrompt(false, "auto", "early", "recent", "Old"),
  buildUserPrompt(false, "auto", "early", "recent", "Old", undefined));
```

（`WorkEvidence` 类型在测试里用 `import type { WorkEvidence }` 引入；上面 `eq` 的 byte-compat 两条把第 6 参显式传 null/undefined 与省略互比，锁死"无证据零行为变化"。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $WT && ./test/run-all.sh` — Expected: FAIL（evidencePromptBlock 未导出）

- [ ] **Step 3: 实现**（`lib/auto-rename-core.ts`，紧跟 `buildUserPrompt` 现有实现）

先把 `buildUserPrompt` 改造（保持无证据路径逐字节不变）：

```ts
export function buildUserPrompt(force: boolean, lang: TitleLang, early: string, recent: string, prevTitle: string, evidence?: WorkEvidence | null): string {
  let user = (force
    ? "Derive the session's CORE GOAL anchored on the ORIGINAL INTENT below. "
      + "If the RECENT CONTEXT shows the session's actual focus has evolved, reflect the CURRENT focus. "
    : "Derive the session's CORE GOAL ONLY from the ORIGINAL INTENT below. ")
    + USER_PROMPT_LANG_LINE[lang]
    + "what this one session is accomplishing. No punctuation, no repo name, no "
    + "issue/PR numbers, no greetings/role-play.\n\n";
  if (recent) {
    user += "RECENT CONTEXT (the session's latest user messages — if the actual "
      + "focus has evolved beyond the original intent, reflect the CURRENT focus):\n"
      + recent + "\n\n";
  }
  if (prevTitle) {
    user += (evidence
      ? "Previous title (if it already reflects the GITHUB ISSUE subject, output it unchanged): "
      : "Previous title: ") + prevTitle + "\n\n";
  }
  if (evidence) {
    user += evidencePromptBlock(evidence) + "\n\n";
  }
  user += "ORIGINAL INTENT:\n" + early;
  return user;
}
```

再新增：

```ts
/** The high-weight block naming the issue this session is actually working on
 *  (issue #7): its subject matter MUST shape the core, condensed not verbatim. */
export function evidencePromptBlock(e: WorkEvidence): string {
  const subject = e.title || e.slug;
  const line = subject
    ? `#${e.issueNumber} ${subject}`
    : `#${e.issueNumber} (subject not captured; derive it from the ORIGINAL INTENT)`;
  return "GITHUB ISSUE UNDER WORK (this session's actual work — its subject matter MUST be "
    + "reflected in the core, condensed not verbatim):\n" + Array.from(line).slice(0, 400).join("");
}
```

- [ ] **Step 4: 跑测试确认通过** — `./test/run-all.sh` OK: 2/2
- [ ] **Step 5: Commit** `git -C $WT add lib/auto-rename-core.ts test/work-evidence.test.ts && git -C $WT commit -m "feat: high-weight issue evidence block in title prompt (issue #7)"`

---

### Task 3: slug 机械兜底 — `slugToCore`（A6）

**Files:** Modify `lib/auto-rename-core.ts`、`test/work-evidence.test.ts`

**Interfaces:** Consumes `capTitle`（已有）；Produces `slugToCore(slug: string): string`。

- [ ] **Step 1: 追加失败测试**

```ts
import { slugToCore } from "../lib/auto-rename-core";
eq("slug expands to words", slugToCore("test-config-isolation"), "test config isolation");
eq("empty slug -> empty core", slugToCore(""), "");
eq("junk slug normalized", slugToCore("Fix--Cursor!!"), "fix cursor");
check("long slug capped at width", slugToCore("a-very-long-branch-slug-name-here").length <= 24);
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**

```ts
/** Mechanical fallback core from a branch slug (issue #7 D8): expand kebab to
 *  words and normalize via capTitle (word cap + display width + lowercase). */
export function slugToCore(slug: string): string {
  const cleaned = (slug || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned) return "";
  return capTitle(cleaned.replace(/-/g, " "));
}
```

- [ ] **Step 4: 跑测试确认通过** — OK: 2/2
- [ ] **Step 5: Commit** `git -C $WT commit -m "feat: slug fallback core for issue evidence (issue #7)"`（add 两文件）

---

### Task 4: 重推判据 — `shouldReDerive`（A5）

**Files:** Modify `lib/auto-rename-core.ts`、`test/work-evidence.test.ts`

**Interfaces:** Produces `shouldReDerive(st, e)`（纯布尔）。

- [ ] **Step 1: 追加失败测试**

```ts
import { shouldReDerive } from "../lib/auto-rename-core";
const EV460: WorkEvidence = { issueNumber: 460, title: "t", slug: "s", key: "issue:460" };
check("no evidence -> never re-derive", shouldReDerive({ coreLocked: true, evidenceKey: "issue:460" }, null) === false);
check("evidence appeared (no stored key) -> re-derive", shouldReDerive({ coreLocked: true }, EV460) === true);
check("same key -> no re-derive", shouldReDerive({ coreLocked: true, evidenceKey: "issue:460" }, EV460) === false);
check("key changed -> re-derive", shouldReDerive({ coreLocked: true, evidenceKey: "issue:100" }, EV460) === true);
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**

```ts
/** Re-derive once when the issue evidence changed (issue #7 D6): a core locked
 *  before any evidence existed must not stay frozen once the issue subject is
 *  known. Same key (or no evidence) keeps the lock. */
export function shouldReDerive(st: { coreLocked?: boolean; evidenceKey?: string }, e: WorkEvidence | null): boolean {
  if (!e) return false;
  return (st.evidenceKey ?? "") !== e.key;
}
```

- [ ] **Step 4: 跑测试确认通过** — OK: 2/2
- [ ] **Step 5: Commit** `git -C $WT commit -m "feat: evidence-key re-derive predicate (issue #7)"`

---

### Task 5: 质量门中文流程动词扩词（A4）

**Files:** Modify `lib/auto-rename-core.ts`（`META_ACTION` 常量 + 注释）、`test/auto-rename-core.test.ts`（追加，不新建文件）

**Interfaces:** Consumes `qualityGate`/`coreIsMetaActivity`（语义不变，仅词表扩）；force 行为不动。

- [ ] **Step 1: 追加失败测试**（`test/auto-rename-core.test.ts` 质量门区）

```ts
check("gate rejects issue认领处理 (bg)", qualityGate("issue认领处理", false).action === "reject");
check("gate rejects issue初步调研 (bg)", qualityGate("issue初步调研", false).action === "reject");
check("gate rejects 未认领issue筛选 (bg)", qualityGate("未认领issue筛选", false).action === "reject");
check("gate rejects github issue 闭环 (bg)", qualityGate("github issue 闭环", false).action === "reject");
// force 语义不回归（issue #5）
check("force accepts issue认领处理", qualityGate("issue认领处理", true).action === "accept");
check("force accepts issue 分析", qualityGate("issue 分析", true).action === "accept");
// 扩词不误伤：目标本身含 issue 词但无流程动词
check("clean issue-template core passes", qualityGate("issue模板优化", false).action === "accept");
check("clean github-actions core passes", qualityGate("github actions修复", false).action === "accept");
check("clean zh core passes", qualityGate("修复登录越界", false).action === "accept");
```

- [ ] **Step 2: 跑测试确认失败**（前 4 条 FAIL）
- [ ] **Step 3: 实现** — 只改 `META_ACTION` 一行与注释：

```ts
// PR #11 CR r2 word-bounded list/review/triage; analy[sz] keeps analytics out.
// issue #7: + 中文流程动词（认领/处理/调研/关闭/筛选/评估/跟进/闭环）——`issue认领处理`
// 类 core 曾整体漏过；META_SUBJECT 前置条件保证只影响含 issue/pr/github 的 core。
const META_ACTION = /(?:\b(?:list|review|triage)\b|retriev|compil|analy[sz]|查看|梳理|分析|列表|审查|汇总|认领|处理|调研|关闭|筛选|评估|跟进|闭环)/i;
```

- [ ] **Step 4: 跑测试确认通过** — OK: 2/2（重点看既有 `qualityGate background fix login bug accepts` 等不回归）
- [ ] **Step 5: Commit** `git -C $WT commit -m "fix: quality gate rejects chinese process-verb cores (issue #7)"`

---

### Task 6: system prompt 规则替换 + 金测重写（A3）

**Files:** Modify `lib/auto-rename-core.ts`（`SYSTEM_PROMPT_TEMPLATE` 一行换两行）、`test/auto-rename-core.test.ts`（`GOLDEN_AUTO_SYSTEM_PROMPT` 同步重写 + 新断言）

**Interfaces:** Consumes Task 2 的块名 `GITHUB ISSUE UNDER WORK`。`FORCE_SYSTEM_PROMPT_TEMPLATE` 派生（replace 锚点句）不动——锚点句本行不改，派生自动跟随。

- [ ] **Step 1: 改测试（金测先行）** — 把 `GOLDEN_AUTO_SYSTEM_PROMPT` 中这一行：

```ts
  "- The CORE GOAL is the session's stable focus, NOT the issue/PR title verbatim and NOT " +
  "transient activity like 'code review', 'CR polling', 'babysit', 'monitoring'. Two " +
  "sessions on the same issue must have DIFFERENT cores reflecting their different work.\n" +
```

替换为：

```ts
  "- The CORE GOAL is the session's stable focus, NOT transient activity like 'code " +
  "review', 'CR polling', 'babysit', 'monitoring'.\n" +
  "- When a GITHUB ISSUE UNDER WORK block is present in the user message, the core MUST " +
  "reflect that issue's subject matter — condensed from the issue title, not verbatim; " +
  "add a short stage word (e.g. 调研/实现) only when it genuinely distinguishes this " +
  "session's work. Without such a block, derive the core from the ORIGINAL INTENT only.\n" +
```

并追加断言：

```ts
check("system prompt carries issue-under-work rule", systemPromptFor(false, "auto").includes("GITHUB ISSUE UNDER WORK"));
check("system prompt drops the same-issue-different-cores rule", !systemPromptFor(false, "auto").includes("must have DIFFERENT cores"));
check("force template carries issue-under-work rule too", systemPromptFor(true, "auto").includes("GITHUB ISSUE UNDER WORK"));
```

- [ ] **Step 2: 跑测试确认失败**（金测 byte 不一致 FAIL）
- [ ] **Step 3: 实现** — `SYSTEM_PROMPT_TEMPLATE` 里同步做与金测完全相同的"一行换两行"替换（字符串内容逐字符一致）。`FORCE_SYSTEM_PROMPT_TEMPLATE`、`systemPromptFor`、`injectLang` 一律不动。
- [ ] **Step 4: 跑测试确认通过** — OK: 2/2（含既有 `FORCE template keeps non-anchor lines verbatim` 等断言）
- [ ] **Step 5: Commit** `git -C $WT commit -m "feat: system prompt weights issue-under-work subject over stage (issue #7)"`

---

### Task 7: 入口接线 — index.ts（A1–A6 集成，U1 前置）

**Files:** Modify `index.ts`（仅接线；无新判定逻辑入侧效应层）

**Interfaces:**
- Consumes: Task 1–4、6 的全部导出。
- Produces: `AutoRenameState.evidenceKey?: string`；`generateCore` 增第 8 参 `evidence`。

- [ ] **Step 1: 改动一：state 类型**（`AutoRenameState` 加一行）

```ts
  evidenceKey?: string; // issue #7: evidence the current core was derived under ("issue:460")
```

- [ ] **Step 2: 改动二：`generateCore` 透传证据**

```ts
async function generateCore(rt: LlmRuntime, early: string, prevCore: string, recent = "", prevTitle = "", force = false, lang: TitleLang, evidence: WorkEvidence | null = null): Promise<string | null> {
  if (!early) return null;
  if (prevCore) return prevCore; // locked; no model call needed
  const user = buildUserPrompt(force, lang, early, recent, prevTitle, evidence);
  ...
}
```

（import 行补 `extractWorkEvidence`、`shouldReDerive`、`slugToCore`、`type WorkEvidence`。）

- [ ] **Step 3: 改动三：`runAutoRename` 主流程**

锚点/锁定段改为：

```ts
  // issue #7: the issue under work (from tool evidence) and whether the
  // established core predates it — a pre-evidence core must re-derive once.
  const evidence = extractWorkEvidence(branch);
  const rederive = shouldReDerive(st, evidence);
  const locked = !opts.force && Boolean(st.coreLocked && prevCore) && !rederive;
```

LLM 调用段改为（`promptForce` 让 rederive 复用 force 的软锚点措辞与 recent 上下文；质量门仍按真实 `opts.force` 分档——后台 rederive 保持严格）：

```ts
  const safeEarly = redact(early);
  const promptForce = Boolean(opts.force) || rederive;
  const recent = promptForce ? redact(latestSelection(userMsgs)) : "";
  let coreRaw = await generateCore(rt, safeEarly, locked ? prevCore : "", recent, promptForce ? redact(prevCore) : "", promptForce, config.lang, evidence);
  if (!coreRaw && evidence && evidence.slug) {
    coreRaw = slugToCore(evidence.slug); // mechanical fallback (D8), still gated below
  }
  if (!coreRaw) return { reason: "llm failed; backed off" };
  const gate = locked ? undefined : qualityGate(coreRaw, Boolean(opts.force));
```

（`gate` 及其后所有行不动；仅 `coreRaw` 从 `const` 改 `let` 并插 fallback。）

state 写入两处（changed 与 unchanged 分支）都带上 `evidenceKey: evidence ? evidence.key : st.evidenceKey`，且 `coreLocked` 的三元追加 `|| rederive`：

```ts
  const nextLocked = locked || sel.substantive || Boolean(opts.force) || rederive;
  const nextEvidenceKey = evidence ? evidence.key : st.evidenceKey;
```

（两个分支分别使用这两个变量，替换原内联表达式，其余键不动。）

- [ ] **Step 4: 验证** — `cd $WT && ./test/run-all.sh` OK: 2/2（index.ts 无独立测试，纯函数层已覆盖；此处跑全量防 bundle 破坏）。再 `cd $WT && npx tsc --noEmit -p . 2>/dev/null || npx tsc --noEmit index.ts lib/auto-rename-core.ts --module esnext --target es2022 --moduleResolution bundler --strict --skipLibCheck`（类型冒烟；peer 依赖缺失导致的 import 错误可忽略，只看本仓内类型错误）。
- [ ] **Step 5: Commit** `git -C $WT commit -m "feat: wire issue evidence into rename flow with one-shot self-heal (issue #7)"`

---

### Task 8: 文档 + 全量回归（A 收口，U1 准备）

**Files:** Modify `README.md`、`CHANGELOG.md`

- [ ] **Step 1: CHANGELOG 加 Unreleased 段**

```markdown
## [Unreleased]

### Added
- issue-driven 会话标题证据抽取：从工具调用/返回识别「在做的 issue」（`gh issue view` 的标题/编号成对解析、认领/分支/研究路径信号，每 issue 二元计分 + 2x dominance），作为高权重块进入标题推导（issue #7）
- `evidenceKey` 一次性自愈：证据出现后无视 coreLocked 重推一次，存量流程标签标题（`issue认领处理` 类）自动愈合
- slug 机械兜底：模型失败且只有分支 slug 时展开为词组标题

### Changed
- system prompt：issue 证据在场时 core 必须浓缩反映 issue 主题（不再要求同 issue 会话标题互异）；金测随 spec 显式重写
- 质量门中文扩词：认领/处理/调研/关闭/筛选/评估/跟进/闭环
```

- [ ] **Step 2: README 行为段补一段**（"How it works" 或等效节，3–5 句：证据从哪来、何时注入、自愈语义、无证据零变化）
- [ ] **Step 3: 全量回归** — `cd $WT && ./test/run-all.sh` OK: 2/2；`git -C $WT log --oneline` 检查 8 个实现 commit 干净。
- [ ] **Step 4: Commit** `git -C $WT commit -m "docs: changelog + readme for issue-driven title evidence (issue #7)"`

---

## Self-Review（已执行）

- **Spec 覆盖**：D1→Task 1（输入范围）、D2/D3→Task 1（信号/计分/dominance）、D4→Task 2、D5/D9→Task 6、D6→Task 4+7、D7→Task 5、D8→Task 3+7；验收 A1→Task 1、A2→Task 2、A3→Task 6、A4→Task 5、A5→Task 4、A6→Task 3、U1/U2→合并后实测（不在 plan 内，issue #7 plan Task 收口后执行）。
- **占位符扫描**：无 TBD/TODO；所有代码步骤给全量代码。
- **类型一致性**：`WorkEvidence` 四字段（issueNumber/title/slug/key）在 Task 1/2/4/7 一致；`buildUserPrompt` 第 6 参 `evidence?: WorkEvidence | null` 与 Task 2/7 调用一致；`generateCore` 第 8 参与 Task 7 调用一致。
