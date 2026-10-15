# Evidence Dominance Short-Circuit Implementation Plan (issue #11)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `extractWorkEvidence()` 在「唯一 mutate 持有者且它就是 top」时短路 2x 歧义判据——修复 8 个真实会话的误判、其余判定一律不变；判定逻辑抽为可独立测试的纯函数 `pickDominant`，并把同分排序钉死为「issue 号小者优先」。

**Architecture:** 三层不变式：`scanIssueSignals`（归约，零改动）→ rank（加权 + 显式 tie-break）→ 新增 `pickDominant(ranked)`（纯判定）→ `extractWorkEvidence`（接线 + `WorkEvidence` 组装）。仓库内改动仅 4 个文件（`lib/auto-rename-core.ts`、`test/work-evidence.test.ts`、`test/docs-timing.test.ts`、`README.md`）；全机验证脚本在研究目录（仓库外）。spec：`docs/superpowers/specs/2026-10-15-evidence-dominance-short-circuit-design.md`。

**Tech Stack:** TypeScript（ESM，无构建步骤，pi 直接跑 TS）；esbuild + node 零依赖测试（`./test/run-all.sh`）；无测试框架（内联 `check`/`eq`）。

## Global Constraints

- **Worktree**：`WT=/home/elling/git-repo/github/pi-auto-rename/.pi/worktrees/issue-11-evidence-dominance`。所有编辑/测试/commit 在 `$WT` 内（`git -C $WT`），**禁碰 main**。
- **不改**：权重常量（`W_MUTATE=6/W_BRANCH=3/W_PATH=3/W_VIEW=1`）、信号正则（`RE_MUTATE`/`RE_VIEW`/`RE_BRANCH_SLUG`/`RE_DRIVEN_PATH`）、prompt 构造、质量门、`index.ts`、state 字段、`WorkEvidence` 形状。
- **排序不变式**：`ranked.sort((a, b) => b.w - a.w || a.n - b.n)`——显式 tie-break，不得依赖 JS 引擎的稳定排序。
- **新增导出**：`pickDominant(ranked: RankedIssue[]): number | null`、`IssueSignals`（原为模块内部 interface，本次改为 export）、`RankedIssue`。`extractWorkEvidence` 的签名与返回类型不变。
- **既有断言不得改**：`test/work-evidence.test.ts` 里的 `ambiguous claims -> null`、`binary counting keeps dominance sane`、`view-only -> null` 等既有用例必须原样通过。
- 测试命令：全量 `cd $WT && ./test/run-all.sh`；单文件 `cd $WT && npx esbuild test/work-evidence.test.ts --bundle --format=esm --platform=node --outfile=/tmp/w.test.mjs --log-level=warning && node /tmp/w.test.mjs`（`work-evidence.test.ts` 不 import pi-ai，无需 alias）。
- commit 用 conventional commits；`git add` 按文件，禁止 `git add -A`。
- **U1（用户实测）不在本 plan 内**：需先把修复送到 npm 加载副本（`~/.pi/agent/npm/node_modules/@zhuxixi/pi-auto-rename/`），按 spec「部署与验收前置」执行。

## 精确接口契约（所有 task 共用，不得改名）

```ts
// lib/auto-rename-core.ts
export interface IssueSignals {
  mutate: boolean; view: boolean; branch: boolean; path: boolean;
  slug: string; title: string;
}
export interface RankedIssue { n: number; s: IssueSignals; w: number }
export function pickDominant(ranked: RankedIssue[]): number | null;
export function extractWorkEvidence(branch: any[]): WorkEvidence | null; // 签名不变
```

`pickDominant` 判定次序（唯一权威定义，不得增删顺序）：

1. 空 ranked → `null`
2. top 无 claim（`mutate`/`branch`/`path` 全假）→ `null`
3. mutate 持有者恰 1 个且 `=== top.n` → 返回 `top.n`（**短路**）
4. second 存在且 `top.w < 2 * second.w` → `null`
5. 否则 → `top.n`

## 验收覆盖对照（spec ID ↔ task）

| spec ID | 功能点 | 落点 |
|---|---|---|
| A1 | 唯一 mutate 短路 | Task 1 Step 1 用例 1 |
| A2 | 多 mutate 歧义保护 | Task 1 Step 5（既有用例回归） |
| A3 | 唯一 mutate 非 top 边界 | Task 1 Step 1 用例 2 |
| A4 | 既有行为回归 | Task 1 Step 5（全量 run-all.sh） |
| A5 | 全机零回归（绑真实现） | Task 3 |
| A6 | 类型/构建 | Task 1 Step 2/5（esbuild 即编译检查）+ Task 3 Step 1 |
| A7 | 同分排序不变式 | Task 1 Step 1 用例 3 |
| A8(i)(ii) | README 防漂移 | Task 2 |
| A8(iii) | CHANGELOG/版本发布门 | Task 4（post-merge） |
| U1 | 真实会话标题修正 | plan 外（部署前置后执行） |

---

### Task 1: `pickDominant` 抽取 + 唯一 mutate 短路 + 显式 tie-break

**Files:**
- Modify: `lib/auto-rename-core.ts`（`const W_MUTATE` 起至 `extractWorkEvidence` 结束，约 699–717 行）
- Test: `test/work-evidence.test.ts`

**Interfaces:**
- Consumes: `scanIssueSignals`（同文件内部函数，零改动）、`W_MUTATE`/`W_BRANCH`/`W_PATH`/`W_VIEW`、`WorkEvidence`（同文件既有导出）
- Produces: `pickDominant`、`IssueSignals`、`RankedIssue`（三个新导出；Task 3 通过编译产物间接消费）

- [ ] **Step 1: 写失败测试**

在 `test/work-evidence.test.ts` 的 `eq("ambiguous claims -> null", evAmbiguous, null);` 之后插入（该文件自带 `toolCall` 辅助与 `eq` 断言）：

```ts
// ---- issue #11: unique-mutate short circuit + explicit tie-break ------------

// The view_eff2b7b9ba shape, 13 vs 7: 188 = mutate+view+path+branch,
// 185 = view+path+branch. Without the short circuit 13 < 2*7 -> null.
const evUniqueMutate = extractWorkEvidence([
  toolCall("gh issue comment 188 --body 'start'"),
  toolCall("gh issue view 188"),
  toolCall("ls ~/.claude/github-issue-driven/zhuxixi/pi-agent-board/issue-188/"),
  toolCall("git worktree add .pi/worktrees/issue-188-x10-release -b issue-188-x10-release"),
  toolCall("gh issue view 185"),
  toolCall("ls ~/.claude/github-issue-driven/zhuxixi/pi-agent-board/issue-185/"),
  toolCall("git worktree add .pi/worktrees/issue-185-wheel -b issue-185-wheel"),
]);
eq("unique mutate claim short-circuits the 2x gate (13 vs 7)", evUniqueMutate?.issueNumber, 188);

// Not a general threshold relaxation: when the unique mutate holder is NOT
// the top scorer (100 = view+path+branch = 7, 200 = mutate only = 6), the old
// 2x gate still applies -> ambiguous -> null.
const evMutateNotTop = extractWorkEvidence([
  toolCall("gh issue view 100"),
  toolCall("ls ~/.claude/github-issue-driven/zhuxixi/jfox/issue-100/"),
  toolCall("git worktree add .pi/worktrees/issue-100-fix -b issue-100-fix"),
  toolCall("gh issue comment 200 --body x"),
]);
eq("unique mutate below the top scorer stays ambiguous", evMutateNotTop, null);

// Tie-break with insertion order REVERSED against the issue-number order:
// 300 first (view+path+branch = 7), 200 last (mutate+view = 7). A stable sort
// without the explicit tie-break keeps 300 on top (then 7 < 2*7 -> null);
// with the tie-break the lower number (200, also the unique mutate holder)
// wins and the short circuit returns it.
const evTieBreak = extractWorkEvidence([
  toolCall("gh issue view 300"),
  toolCall("ls ~/.claude/github-issue-driven/zhuxixi/jfox/issue-300/"),
  toolCall("git worktree add .pi/worktrees/issue-300-fix -b issue-300-fix"),
  toolCall("gh issue comment 200 --body x"),
  toolCall("gh issue view 200"),
]);
eq("tie-break keeps the lower issue number on top", evTieBreak?.issueNumber, 200);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $WT && npx esbuild test/work-evidence.test.ts --bundle --format=esm --platform=node --outfile=/tmp/w.test.mjs --log-level=warning && node /tmp/w.test.mjs`
Expected: `FAIL unique mutate claim short-circuits the 2x gate (13 vs 7) — got undefined`、`FAIL tie-break keeps the lower issue number on top — got undefined`；其余（含既有 28 条）全部 `ok`

- [ ] **Step 3: 实现**

把 `lib/auto-rename-core.ts` 中从 `const W_MUTATE = 6, ...` 到 `extractWorkEvidence` 函数结尾的整段替换为：

```ts
const W_MUTATE = 6, W_BRANCH = 3, W_PATH = 3, W_VIEW = 1;

/** Per-issue signal detail (exported so pickDominant has a testable contract). */
export interface IssueSignals {
  mutate: boolean; view: boolean; branch: boolean; path: boolean;
  slug: string; title: string;
}

/** One scored issue: `w` is the weighted total (mutate6 | branch3 | path3 | view1). */
export interface RankedIssue { n: number; s: IssueSignals; w: number }

/** Pick the dominant issue out of a ranked list (highest `w` first).
 *  Decision order:
 *   1. empty list -> null;
 *   2. top has no claim signal (mutate/branch/path) -> null;
 *   3. a unique mutate holder that IS the top wins outright: exactly one issue
 *      received a write operation, so there is no ambiguity for the 2x ratio
 *      (built for "viewing many, working on none") to guard against (issue #11);
 *   4. otherwise the old gate: the top must reach 2x the runner-up. */
export function pickDominant(ranked: RankedIssue[]): number | null {
  const top = ranked[0];
  if (!top || !(top.s.mutate || top.s.branch || top.s.path)) return null;  // no claim at all
  const mutates = ranked.filter((r) => r.s.mutate);
  if (mutates.length === 1 && mutates[0].n === top.n) return top.n;        // unique write claim
  const second = ranked[1];
  if (second && top.w < 2 * second.w) return null;                         // ambiguous
  return top.n;
}

/** The single issue this session is WORKING on, or null (decision order in
 *  pickDominant). Ties break on the lower issue number, so the outcome never
 *  depends on JS engine sort stability. */
export function extractWorkEvidence(branch: any[]): WorkEvidence | null {
  const map = scanIssueSignals(branch);
  const ranked: RankedIssue[] = [...map.entries()]
    .map(([n, s]) => ({
      n, s,
      w: (s.mutate ? W_MUTATE : 0) + (s.branch ? W_BRANCH : 0) + (s.path ? W_PATH : 0) + (s.view ? W_VIEW : 0),
    }))
    .sort((a, b) => b.w - a.w || a.n - b.n);
  const n = pickDominant(ranked);
  if (n === null) return null;
  const s = map.get(n) as IssueSignals;
  return { issueNumber: n, title: s.title, slug: s.slug, key: `issue:${n}` };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2
Expected: 三条新用例全部 `ok`，既有用例无 FAIL

- [ ] **Step 5: 全量回归（A2/A4）**

Run: `cd $WT && ./test/run-all.sh`
Expected: `OK: 5/5 test files passed`（含 `ambiguous claims -> null` 原样通过）

- [ ] **Step 6: Commit**

```bash
cd $WT && git add lib/auto-rename-core.ts test/work-evidence.test.ts \
  && git commit -m "fix: short-circuit the ambiguity gate for a unique mutate claim (issue #11)"
```

---

### Task 2: README 措辞 + `docs-timing` 防漂移断言（A8 i/ii）

**Files:**
- Modify: `README.md`（evidence 段，约 140–148 行）
- Modify: `test/docs-timing.test.ts`

**Interfaces:**
- Consumes: Task 1 的行为（README 描述必须与实现一致）
- Produces: 无新增导出；README 的 evidence 段落成为 A8 的静态检查对象

- [ ] **Step 1: 写失败断言**

在 `test/docs-timing.test.ts` 的 `check("how-it-works mentions the first settle", ...)` 块之后追加（该文件用 `support/assert.ts` 的 `check(name, fn)`）：

```ts
check("evidence section documents the unique-mutate short-circuit", () => {
  if (!/unique mutate|唯一 mutate/i.test(readme)) throw new Error("evidence section must document the short-circuit");
});
check("no stale plain-2x wording in the evidence section", () => {
  if (readme.includes("2x dominance margin")) throw new Error("stale '2x dominance margin' wording present");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $WT && ./test/run-all.sh`
Expected: `FAIL evidence section documents the unique-mutate short-circuit`（第二条断言此时为绿，因为旧措辞仍在——它锁的是"改完之后不许回漂"）；其余文件通过

- [ ] **Step 3: 改 README**

把 `README.md` 中这一段（原句跨三行）：

```
parsed for title/number pairs, plus claim/branch/research-path signals
scored per issue with a 2x dominance margin. When evidence wins, it is
```

替换为：

```
parsed for title/number pairs, plus claim/branch/research-path signals
scored per issue. A unique mutate claim on the top-scoring issue wins
outright (one write operation rules out ambiguity); otherwise the top must
lead the runner-up by 2x. When evidence wins, it is
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd $WT && ./test/run-all.sh`
Expected: `OK: 5/5 test files passed`

- [ ] **Step 5: Commit**

```bash
cd $WT && git add README.md test/docs-timing.test.ts \
  && git commit -m "docs: document the unique-mutate short circuit in the README evidence section"
```

---

### Task 3: 全机零回归验证（A5，绑修复后的真实实现）

**Files:**
- Create: `~/.claude/github-issue-driven/zhuxixi/pi-auto-rename/issue-11/research/verify-11.mjs`（**仓库外**，与 `scan-11.mjs` 同目录）
- Create（产物）：同目录的 `arc-bundle-fixed.mjs`、`scan-11-verified.json`
- 不修改：`arc-bundle.mjs`、`scan-11-rules.json`（研究基线真值，禁止覆写）

**Interfaces:**
- Consumes: `lib/auto-rename-core.ts` 的编译产物（Task 1 后的实现）、基线 `arc-bundle.mjs`、基线 `scan-11-rules.json`
- Produces: `scan-11-verified.json`（论域快照 + 断言结果）+ 一条 issue 评论

- [ ] **Step 1: 构建修复后的 bundle（A6 的编译检查一并落在这里）**

```bash
WT=/home/elling/git-repo/github/pi-auto-rename/.pi/worktrees/issue-11-evidence-dominance
R=/home/elling/.claude/github-issue-driven/zhuxixi/pi-auto-rename/issue-11/research
cd "$WT" && npx esbuild lib/auto-rename-core.ts --bundle --format=esm --platform=node \
  --outfile="$R/arc-bundle-fixed.mjs" --log-level=warning && ls -la "$R/arc-bundle-fixed.mjs"
```
Expected: 零报错，bundle 生成成功

- [ ] **Step 2: 写 `verify-11.mjs`**

```js
#!/usr/bin/env node
// Issue #11 — A5 verification. Runs BOTH the frozen baseline implementation
// (arc-bundle.mjs == main@cf23ad7) and the fixed one (arc-bundle-fixed.mjs ==
// the issue-11 worktree) over the same board sessions, then asserts:
//   (i)  every view in the research baseline's recovered list is recovered;
//   (ii) the fixed implementation matches the rule-A replica on every view;
//   (iii) zero regressions (no view that had evidence loses it);
//   (iv) extra recuperations (views created after the research scan) are
//        reported, not failed.
// Read-only over ~/.pi/agent/agent-board; never overwrites baseline artifacts.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as baseline from "./arc-bundle.mjs";
import * as fixed from "./arc-bundle-fixed.mjs";

const VROOT = path.join(os.homedir(), ".pi/agent/agent-board/views");
const HERE = import.meta.dirname;

const RE_MUTATE = /gh\s+issue\s+(?:edit|close|reopen|comment)\s+(\d+)/g;
const RE_VIEW = /gh\s+issue\s+view\s+(\d+)/g;
const RE_SLUG = /(?<![\w-])issue-(\d+)-([a-z0-9][a-z0-9-]{2,})/gi;
const RE_PATH = /github-issue-driven\/[^\s"'/]+\/[^\s"'/]+\/issue-(\d+)\//g;
const W_MUTATE = 6, W_BRANCH = 3, W_PATH = 3, W_VIEW = 1;

const blockText = (c) => typeof c === "string" ? c
  : (Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join(" ").trim() : "");

function scan(branch) {
  const map = new Map();
  const sig = (n) => {
    let s = map.get(n);
    if (!s) { s = { mutate: false, view: false, branch: false, path: false, slug: "", title: "" }; map.set(n, s); }
    return s;
  };
  for (const e of branch) {
    if (e?.type !== "message" || !e.message) continue;
    const m = e.message;
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type !== "toolCall") continue;
        const args = JSON.stringify(b.arguments ?? {});
        for (const x of args.matchAll(RE_MUTATE)) sig(Number(x[1])).mutate = true;
        for (const x of args.matchAll(RE_VIEW)) sig(Number(x[1])).view = true;
        for (const x of args.matchAll(RE_PATH)) sig(Number(x[1])).path = true;
        for (const x of args.matchAll(RE_SLUG)) { const s = sig(Number(x[1])); s.branch = true; if (!s.slug) s.slug = x[2].toLowerCase(); }
      }
    }
    if (m.role === "toolResult") {
      const t = blockText(m.content);
      if (!t) continue;
      for (const x of t.matchAll(RE_PATH)) sig(Number(x[1])).path = true;
      for (const x of t.matchAll(RE_SLUG)) { const s = sig(Number(x[1])); s.branch = true; if (!s.slug) s.slug = x[2].toLowerCase(); }
    }
  }
  return map;
}

const rank = (map) => [...map.entries()]
  .map(([n, s]) => ({ n, s, w: (s.mutate ? W_MUTATE : 0) + (s.branch ? W_BRANCH : 0) + (s.path ? W_PATH : 0) + (s.view ? W_VIEW : 0) }))
  .sort((a, b) => b.w - a.w || a.n - b.n);

// rule-A replica over the ranked list (mirrors the implemented decision order)
function ruleA(ranked) {
  const top = ranked[0];
  if (!top || !(top.s.mutate || top.s.branch || top.s.path)) return null;
  const muts = ranked.filter((r) => r.s.mutate);
  if (muts.length === 1 && muts[0].n === top.n) return top.n;
  const second = ranked[1];
  if (second && top.w < 2 * second.w) return null;
  return top.n;
}

const expected = JSON.parse(fs.readFileSync(path.join(HERE, "scan-11-rules.json"), "utf8"));
const expectedRecovered = new Set(expected.perRule.A.recoveredViews);

const rows = [];
let skipped = 0, ruleMismatch = 0;
for (const v of fs.readdirSync(VROOT).filter((x) => !x.startsWith("."))) {
  let meta; try { meta = JSON.parse(fs.readFileSync(path.join(VROOT, v, "meta.json"), "utf8")); } catch { skipped += 1; continue; }
  if (!meta.sessionFile || !fs.existsSync(meta.sessionFile)) { skipped += 1; continue; }
  let branch; try {
    branch = fs.readFileSync(meta.sessionFile, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { skipped += 1; continue; }
  const rb = baseline.extractWorkEvidence(branch);
  const rf = fixed.extractWorkEvidence(branch);
  const decA = ruleA(rank(branch ? scan(branch) : []));
  const nBase = rb ? rb.issueNumber : null;
  const nFixed = rf ? rf.issueNumber : null;
  if (nFixed !== decA) ruleMismatch += 1;
  rows.push({ view: v, name: meta.name ?? "", nBase, nFixed, ruleA: decA, expected: expectedRecovered.has(v) });
}

const recovered = rows.filter((r) => r.nBase === null && r.nFixed !== null);
const lost = rows.filter((r) => r.nBase !== null && r.nFixed === null);
const missing = [...expectedRecovered].filter((v) => !recovered.some((r) => r.view === v));
const extra = recovered.filter((r) => !expectedRecovered.has(r.view)).map((r) => r.view);

const assertions = [
  { id: "A5(i)", desc: `all ${expectedRecovered.size} research-baseline views recovered`, ok: missing.length === 0, detail: missing },
  { id: "A5(ii)", desc: "fixed implementation === rule-A replica on every view", ok: ruleMismatch === 0, detail: `${ruleMismatch} mismatches` },
  { id: "A5(iii)", desc: "zero regressions (lost = 0)", ok: lost.length === 0, detail: lost.map((r) => r.view) },
];

const artifact = {
  generatedAt: new Date().toISOString(),
  baselineBundle: "arc-bundle.mjs (main@cf23ad7)",
  fixedBundle: "arc-bundle-fixed.mjs (issue-11 worktree)",
  scannedViews: rows.length, skippedViews: skipped,
  baselineNonNull: rows.filter((r) => r.nBase !== null).length,
  fixedNonNull: rows.filter((r) => r.nFixed !== null).length,
  recoveredViews: recovered.map((r) => r.view),
  extraRecoveredViews: extra,
  lostViews: lost.map((r) => r.view),
  assertions,
  viewUniverse: rows.map((r) => r.view),
};
fs.writeFileSync(path.join(HERE, "scan-11-verified.json"), JSON.stringify(artifact, null, 2));

for (const a of assertions) console.log(`${a.ok ? "PASS" : "FAIL"} ${a.id} ${a.desc}${a.ok ? "" : ` — ${JSON.stringify(a.detail)}`}`);
console.log(`views=${rows.length} skipped=${skipped} baselineNonNull=${artifact.baselineNonNull} fixedNonNull=${artifact.fixedNonNull} recovered=${recovered.length} extra=${extra.length} lost=${lost.length}`);
process.exit(assertions.every((a) => a.ok) ? 0 : 1);
```

- [ ] **Step 3: 跑验证**

Run: `cd /home/elling/.claude/github-issue-driven/zhuxixi/pi-auto-rename/issue-11/research && node verify-11.mjs`
Expected: 三条断言全 `PASS`；`recovered` ≥ 8（额外项记入 `extraRecoveredViews`）；`lost=0`

- [ ] **Step 4: 记录（研究目录 + issue 评论）**

把 `verify-11.mjs` 的输出摘要（三条断言 + 计数）作为评论发到 issue #11，并确认 `scan-11-verified.json` 已落盘。

- [ ] **Step 5: Commit（仓库内无改动，此步为记录确认）**

确认 `git -C $WT status --short` 只有预期文件；Task 3 不产生仓库内 commit（验证脚本按既定纪律留在 `~/.claude/github-issue-driven/`）。

---

### Task 4: CHANGELOG 与版本锚点（A8(iii)，post-merge 发布门）

**Files:**
- Modify: `CHANGELOG.md`（新增 `## [0.4.1]` 段）
- Modify: `package.json`（`"version": "0.4.0"` → `"0.4.1"`）

**执行时机**：PR 合并进 main 之后（仓内惯例：`e5191be chore: changelog for 0.4.0 release` 在 PR #10 merge 之后）。**不在 fix PR 内**。

- [ ] **Step 1: 写 CHANGELOG 段**

在 `## [0.4.0] - 2026-10-13` 之前插入：

```markdown
## [0.4.1] - 2026-10-15

### Fixed
- issue 证据抽取把「唯一 mutate 且为 top」误判为歧义（典型形态 13 vs 7，差 1 分）：会话里对唯一一个 issue 执行过写操作时不再参与 2x 比例比较，标题不再退回流程标签（issue #11）
```

- [ ] **Step 2: bump 版本**

`package.json` 的 `"version": "0.4.0"` 改为 `"0.4.1"`（`package.json` 是唯一版本来源；`CHANGELOG.md` 与 npm 发布跟它对齐）。

- [ ] **Step 3: 发布门断言（A8 iii）**

Run（在 main checkout，即 `/home/elling/git-repo/github/pi-auto-rename`）：
```bash
grep -q '^## \[0.4.1\]' CHANGELOG.md && grep -A6 '^## \[0.4.1\]' CHANGELOG.md | grep -q '^### Fixed' && echo "A8(iii) PASS"
```
Expected: `A8(iii) PASS`

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md && git commit -m "chore: changelog for 0.4.1 release"
git add package.json && git commit -m "0.4.1"
```

- [ ] **Step 5: 发布（人工确认后）**

`npm publish` 与 `pi update --extensions` 属发布动作，执行前需用户明确许可（与 push/PR 同级的授权门）。

---

## Self-Review

**1. Spec coverage**：A1/A3/A7 → Task 1 Step 1 的三条新用例；A2/A4 → Task 1 Step 5 全量回归；A5 → Task 3 三条断言；A6 → Task 1 Step 2/5（esbuild 即编译）+ Task 3 Step 1；A8(i)(ii) → Task 2；A8(iii) → Task 4 Step 3；U1 → plan 外（依赖部署，spec 已给 A/B 对照步骤）。spec 的「非目标」全部由 Global Constraints 承接（不改权重/正则/prompt/质量门/index.ts/state）。

**2. Placeholder scan**：无 TBD/TODO；每个代码步骤都给了可粘贴的完整代码（含 Task 3 的整份 `verify-11.mjs`）。

**3. Type consistency**：`IssueSignals`/`RankedIssue`/`pickDominant` 的签名在「精确接口契约」、Task 1 Step 3、Task 3 Step 2 三处一致；`extractWorkEvidence` 返回类型 `WorkEvidence | null` 未变；Task 3 的副本 `ruleA` 与 Task 1 的 `pickDominant` 判定次序逐条对应（空 → 无 claim → 唯一 mutate 短路 → 2x → top）。
