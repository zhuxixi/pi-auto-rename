// issue #7 — work-evidence extraction from tool calls / tool results,
// plus its high-weight injection into the title prompt (evidencePromptBlock).
import { extractWorkEvidence, buildUserPrompt, evidencePromptBlock, slugToCore, shouldReDerive } from "../lib/auto-rename-core";
import type { WorkEvidence } from "../lib/auto-rename-core";

// zero-dep helpers, inlined (no test framework — same pattern as test/auto-rename-core.test.ts)
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

// ---- evidencePromptBlock + buildUserPrompt evidence param (issue #7 task 2) ---
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

// ---- slugToCore mechanical fallback (issue #7 task 3 / A6) ---
eq("slug expands to words", slugToCore("test-config-isolation"), "test config isolation");
eq("empty slug -> empty core", slugToCore(""), "");
eq("junk slug normalized", slugToCore("Fix--Cursor!!"), "fix cursor");
check("long slug capped at width", slugToCore("a-very-long-branch-slug-name-here").length <= 24);

// ---- shouldReDerive evidence-key predicate (issue #7 task 4 / A5) ---
const EV460: WorkEvidence = { issueNumber: 460, title: "t", slug: "s", key: "issue:460" };
check("no evidence -> never re-derive", shouldReDerive({ coreLocked: true, evidenceKey: "issue:460" }, null) === false);
check("evidence appeared (no stored key) -> re-derive", shouldReDerive({ coreLocked: true }, EV460) === true);
check("same key -> no re-derive", shouldReDerive({ coreLocked: true, evidenceKey: "issue:460" }, EV460) === false);
check("key changed -> re-derive", shouldReDerive({ coreLocked: true, evidenceKey: "issue:100" }, EV460) === true);

if (failed > 0) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log("all checks passed");
