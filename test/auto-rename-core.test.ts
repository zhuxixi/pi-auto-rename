/**
 * Parameterized cases for lib/auto-rename-core.ts — issue #6.
 * Covers the trickiest logic in the repo: CJK display-width truncation,
 * capTitle's regex chain, secret redaction, and the guard-rail classifiers.
 *
 * Run with (no test framework — zero-dep, bundled by esbuild):
 *   npx esbuild test/auto-rename-core.test.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/auto-rename-core-test.mjs && node /tmp/auto-rename-core-test.mjs
 */
import {
	blockText,
	buildUserPrompt,
	capTitle,
	composeTitle,
	coreFromTitle,
	coreIsMetaActivity,
	coreIsNonGoal,
	earlyExcerpt,
	earlySelection,
	FORCE_SYSTEM_PROMPT_TEMPLATE,
	formatQualityGateMessage,
	gateAwareOutcome,
	isCommandInvocation,
	injectLang,
	isTrivialMessage,
	LANG_PLACEHOLDER,
	LANG_RULES,
	latestSelection,
	looksLikeError,
	looksLikeResponse,
	notificationLevelFor,
	parseIso,
	qualityGate,
	redact,
	resolveLang,
	scanUserMessages,
	systemPromptFor,
	SYSTEM_PROMPT_TEMPLATE,
	truncateDisplay,
} from "../lib/auto-rename-core";

let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
	if (cond) {
		console.log(`ok   ${name}`);
	} else {
		failed++;
		console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
}
function eq(name: string, got: unknown, expect: unknown): void {
	check(name, got === expect, `got ${JSON.stringify(got)}, expected ${JSON.stringify(expect)}`);
}

// ---- truncateDisplay: display columns, not string length ----
eq("truncateDisplay ascii", truncateDisplay("hello", 3), "hel");
eq("truncateDisplay cjk 2-col", truncateDisplay("你好世界", 5), "你好");
eq("truncateDisplay mixed", truncateDisplay("ab你cd", 5), "ab你c");
eq("truncateDisplay no half wide char", truncateDisplay("ab你好", 3), "ab");
eq("truncateDisplay empty", truncateDisplay("", 5), "");
eq("truncateDisplay zero width", truncateDisplay("abc", 0), "");
eq("truncateDisplay fits exactly", truncateDisplay("你好", 4), "你好");

// ---- capTitle: quotes / ref prefixes / counters / sentence cut / double cap ----
eq("capTitle strips ascii quotes", capTitle('"Fix login bug"'), "fix login bug");
eq("capTitle strips cjk quotes", capTitle("「修复登录越界」"), "修复登录越界");
eq("capTitle drops Issue #N prefix", capTitle("Issue #6: 建立完整测试覆盖"), "建立完整测试覆盖");
eq("capTitle drops bare #N prefix", capTitle("#123 修复崩溃"), "修复崩溃");
eq("capTitle drops round counter", capTitle("round 3 retry logic fix"), "retry logic fix");
eq("capTitle drops 第N轮 counter", capTitle("第2轮 修复方案"), "修复方案");
eq("capTitle cuts at sentence end", capTitle("Fix the bug. Then deploy"), "fix the bug");
eq("capTitle keeps dots in filenames", capTitle("fix config.json loading"), "fix config.json loading");
eq("capTitle cuts at cjk sentence end", capTitle("修复登录越界。然后优化"), "修复登录越界");
eq("capTitle word cap", capTitle("one two three four five six seven"), "one two three four five");
eq("capTitle display-width cap backs off to word boundary", capTitle("hello world foo", 10, 8), "hello");
eq("capTitle combined quotes+ref+sentence", capTitle('"Issue #42: Fix login. Deploy hotfix"'), "fix login");
eq("capTitle empty", capTitle(""), "");

// ---- capTitle word-boundary truncation + english lowercase (issue #10) ----
eq("capTitle word boundary", capTitle("Locate nvim config location"), "locate nvim config");
eq("capTitle lowercase ascii", capTitle("Fix Login Bug"), "fix login bug");
eq("capTitle lowercase keeps cjk", capTitle("修复登录越界"), "修复登录越界");
eq("capTitle lowercase mixed", capTitle("GLM版本升级到5.3"), "glm版本升级到5.3");
eq("capTitle cjk cut no backoff", capTitle("这是一个非常非常长的中文标题需要截断"), "这是一个非常非常长的中文");
eq("capTitle hyphen boundary", capTitle("release-all-pipeline-orchestration-x"), "release-all-pipeline");

// ---- coreFromTitle: legacy format migration ----
eq("coreFromTitle legacy repo+refs", coreFromTitle("owner/repo: fix login | issue#6"), "fix login");
eq("coreFromTitle keeps colon without slash", coreFromTitle("Fix: login"), "Fix: login");
eq("coreFromTitle cuts subtask", coreFromTitle("core -- subtask"), "core");
eq("coreFromTitle empty", coreFromTitle(""), "");
eq("coreFromTitle trims", coreFromTitle("  spaced core  "), "spaced core");

// ---- composeTitle ----
eq("composeTitle verbatim", composeTitle("fix login"), "fix login");
eq("composeTitle empty -> session", composeTitle(""), "session");

// ---- coreIsNonGoal ----
check("coreIsNonGoal 方案确认", coreIsNonGoal("方案确认"));
check("coreIsNonGoal Review case-insensitive", coreIsNonGoal("Review"));
check("coreIsNonGoal ok", coreIsNonGoal("ok"));
check("coreIsNonGoal whitespace-insensitive", coreIsNonGoal("继 续"));
check("coreIsNonGoal real goal", !coreIsNonGoal("修复登录越界"));
check("coreIsNonGoal empty", !coreIsNonGoal(""));

// ---- earlyExcerpt: first-N anchoring + dedup + budget ----
eq("earlyExcerpt empty", earlyExcerpt([]), "");
eq("earlyExcerpt takes first 2 only", earlyExcerpt(["a", "b", "c"]), "a\n---\nb");
eq("earlyExcerpt dedups", earlyExcerpt(["a", "a"]), "a");
eq("earlyExcerpt per-msg cap 300", earlyExcerpt(["x".repeat(400)]).length, 300);

// ---- redact: secret patterns ----
eq("redact aws key", redact("use AKIAIOSFODNN7EXAMPLE please"), "use [REDACTED_AWS_KEY] please");
eq("redact sk- key", redact("key sk-abcdefghijklmnopqrst1234 end"), "key [REDACTED_API_KEY] end");
eq("redact bearer keeps scheme", redact("Bearer abcdefghijklmnopqrstuvwxyz"), "Bearer [REDACTED]");
eq("redact KEY= form", redact("API_KEY=supersecretvalue"), "API_KEY=[REDACTED]");
eq("redact token: form", redact("token: abc123xyz"), "token=[REDACTED]");
eq(
	"redact private key block",
	redact("-----BEGIN RSA PRIVATE KEY-----\nabc123\n-----END RSA PRIVATE KEY-----"),
	"[REDACTED_PRIVATE_KEY]",
);
eq("redact leaves normal text", redact("fix login bug"), "fix login bug");

// ---- looksLikeResponse / looksLikeError ----
check("looksLikeResponse empty", looksLikeResponse(""));
check("looksLikeResponse cjk opener", looksLikeResponse("好的，我来处理"));
check("looksLikeResponse sentence", looksLikeResponse("Fix the bug."));
check("looksLikeResponse title fragment", !looksLikeResponse("修复登录越界"));
check("looksLikeError traceback", looksLikeError("Traceback (most recent call last)"));
check("looksLikeError runtime error", looksLikeError("java RuntimeError boom"));
check("looksLikeError panic", looksLikeError("kernel panic"));
check("looksLikeError normal title", !looksLikeError("fix login page"));
check("looksLikeError bug keyword (regex is case-insensitive)", looksLikeError("fix login bug"));
check("looksLikeError empty", !looksLikeError(""));

// ---- parseIso ----
eq("parseIso valid", parseIso("2026-08-15T16:02:20Z"), Date.parse("2026-08-15T16:02:20Z") / 1000);
eq("parseIso invalid", parseIso("not a date"), null);
eq("parseIso non-string", parseIso(123), null);
eq("parseIso undefined", parseIso(undefined), null);

// ---- blockText / scanUserMessages ----
eq("blockText string passthrough", blockText("hello"), "hello");
eq(
	"blockText filters text blocks",
	blockText([{ type: "text", text: "a" }, { type: "tool_use", id: "1" }, { type: "text", text: "b" }]),
	"a b",
);
eq("blockText non-array", blockText(42), "");
eq("blockText empty array", blockText([]), "");
const branch = [
	{ type: "message", message: { role: "user", content: "first" } },
	{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } },
	{ type: "custom", customType: "x" },
	{ type: "message", message: { role: "user", content: [{ type: "text", text: "second" }] } },
	{ type: "message", message: { role: "user", content: [] } },
];
check(
	"scanUserMessages keeps genuine user prompts",
	JSON.stringify(scanUserMessages(branch)) === JSON.stringify(["first", "second"]),
	JSON.stringify(scanUserMessages(branch)),
);

// ---- isTrivialMessage: throwaway openers carry no intent (issue #10) ----
check("isTrivialMessage hello", isTrivialMessage("hello"));
check("isTrivialMessage Hello!", isTrivialMessage("Hello!"));
check("isTrivialMessage ok", isTrivialMessage("ok"));
check("isTrivialMessage 收到", isTrivialMessage("收到"));
check("isTrivialMessage 在吗？", isTrivialMessage("在吗？"));
check("isTrivialMessage empty", isTrivialMessage(""));
check("isTrivialMessage blank", isTrivialMessage("   "));
check("isTrivialMessage issue list NOT trivial", !isTrivialMessage("issue list"));
check("isTrivialMessage 修 bug NOT trivial", !isTrivialMessage("修 bug"));
check("isTrivialMessage real intent NOT trivial", !isTrivialMessage("走GitHub issue driven的流程处理第六个问题"));

// ---- earlySelection: skip trivial openers within the early window (issue #10) ----
const sel1 = earlySelection(["hello", "issue list", "走GitHub issue driven流程处理第六个问题，给我一个clear report"]);
check("earlySelection skips greeting, keeps real intent", sel1.text.includes("issue list") && sel1.text.includes("走GitHub"));
check("earlySelection substantive when real content", sel1.substantive);
const sel2 = earlySelection(["hello", "hi"]);
eq("earlySelection all-trivial fallback text", sel2.text, "hello\n---\nhi");
check("earlySelection all-trivial not substantive", !sel2.substantive);
const sel3 = earlySelection(["fix the login bug", "add tests"]);
eq("earlySelection substantive pair", sel3.text, "fix the login bug\n---\nadd tests");
check("earlySelection substantive flag", sel3.substantive);
const sel4 = earlySelection(["hello", "hello", "real intent here"]);
eq("earlySelection dedup", sel4.text, "real intent here");
const sel5 = earlySelection(["hello", "hi", "ok", "收到", "在吗", "好的", "real intent at position seven"]);
eq("earlySelection window bound falls back", sel5.text, "hello\n---\nhi");
check("earlySelection window bound not substantive", !sel5.substantive);
eq("earlySelection empty", earlySelection([]).text, "");
check("earlySelection empty not substantive", !earlySelection([]).substantive);
eq("earlyExcerpt delegates to earlySelection", earlyExcerpt(["hello", "issue list", "real intent"]), "issue list\n---\nreal intent");

// ---- coreIsMetaActivity: process labels are not goals (issue #10) ----
check("coreIsMetaActivity Issue list triage", coreIsMetaActivity("Issue list triage"));
check("coreIsMetaActivity GitHub Issue 查看", coreIsMetaActivity("GitHub Issue 查看"));
check("coreIsMetaActivity GitHub issue analysis", coreIsMetaActivity("GitHub issue analysis"));
check("coreIsMetaActivity Issue list review", coreIsMetaActivity("Issue list review"));
check("coreIsMetaActivity Issue list retrieval", coreIsMetaActivity("Issue list retrieval"));
check("coreIsMetaActivity Issue list compilation", coreIsMetaActivity("Issue list compilation"));
check("coreIsMetaActivity Issue内容梳理", coreIsMetaActivity("Issue内容梳理"));
check("coreIsMetaActivity Issue驱动技能包迁移 NOT meta", !coreIsMetaActivity("Issue驱动技能包迁移"));
check("coreIsMetaActivity 修复登录越界 NOT meta", !coreIsMetaActivity("修复登录越界"));
check("coreIsMetaActivity llm cache fix NOT meta", !coreIsMetaActivity("llm cache fix"));
check("coreIsMetaActivity status-bar优化 NOT meta", !coreIsMetaActivity("status-bar优化"));
check("coreIsMetaActivity Issue List Triage title-cased", coreIsMetaActivity("Issue List Triage")); // PR #11 CR: /i regression
check("coreIsMetaActivity GitHub Issue Review title-cased", coreIsMetaActivity("GitHub Issue Review"));
check("coreIsMetaActivity analytics NOT meta (narrowed)", !coreIsMetaActivity("GitHub analytics dashboard"));
check("coreIsMetaActivity issue analysis still meta", coreIsMetaActivity("GitHub issue analysis"));
check("coreIsMetaActivity issue analyses meta (verb/plural variants)", coreIsMetaActivity("issue analyses")); // PR #11 CR r2 issue-3
check("coreIsMetaActivity analyze issues meta", coreIsMetaActivity("analyze issues"));
check("coreIsMetaActivity GitHub Checklist NOT meta (word boundary)", !coreIsMetaActivity("GitHub Checklist")); // PR #11 CR r2 issue-4
check("coreIsMetaActivity github preview tool NOT meta", !coreIsMetaActivity("github preview tool"));
check("coreIsMetaActivity empty NOT meta", !coreIsMetaActivity(""));

// ---- latestSelection: recent-context tail scan (issue #1) ----
eq("latestSelection empty", latestSelection([]), "");
eq(
	"latestSelection takes last 10 substantive",
	latestSelection(["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10", "m11", "m12"]),
	"m3\n---\nm4\n---\nm5\n---\nm6\n---\nm7\n---\nm8\n---\nm9\n---\nm10\n---\nm11\n---\nm12",
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

// ---- isCommandInvocation / latestSelection command filtering (issue #1 CR) ----
check("isCommandInvocation /autorename", isCommandInvocation("/autorename"));
check("isCommandInvocation /clear", isCommandInvocation("/clear"));
check("isCommandInvocation path NOT command", !isCommandInvocation("/home/elling/git-repo"));
check("isCommandInvocation command with args NOT single-token", !isCommandInvocation("/name foo"));
check("isCommandInvocation empty", !isCommandInvocation(""));
eq("latestSelection skips slash commands", latestSelection(["real1", "/autorename", "real2"]), "real1\n---\nreal2");

// ---- configurable title language (issue #3) ----
eq("resolveLang auto", resolveLang("auto"), "auto");
eq("resolveLang zh", resolveLang("zh"), "zh");
eq("resolveLang en", resolveLang("en"), "en");
eq("resolveLang uppercase falls back", resolveLang("EN"), "auto");
eq("resolveLang junk falls back", resolveLang("Chinese"), "auto");
eq("resolveLang number falls back", resolveLang(3), "auto");
eq("resolveLang undefined falls back", resolveLang(undefined), "auto");
eq("injectLang fills zh rule", injectLang("head " + LANG_PLACEHOLDER + " tail", "zh"), "head " + LANG_RULES.zh + " tail");
eq("injectLang fills en rule", injectLang("head " + LANG_PLACEHOLDER + " tail", "en"), "head " + LANG_RULES.en + " tail");
eq("injectLang fills auto rule", injectLang("head " + LANG_PLACEHOLDER + " tail", "auto"), "head " + LANG_RULES.auto + " tail");
eq("injectLang no placeholder returns verbatim", injectLang("no placeholder", "zh"), "no placeholder");

// ---- prompt templates with lang placeholder (issue #3) ----
const placeholderCount = (s: string): number => s.split(LANG_PLACEHOLDER).length - 1;
eq("SYSTEM template placeholder exactly once", placeholderCount(SYSTEM_PROMPT_TEMPLATE), 1);
eq("FORCE template placeholder exactly once", placeholderCount(FORCE_SYSTEM_PROMPT_TEMPLATE), 1);
check("SYSTEM template keeps strict anchor", SYSTEM_PROMPT_TEMPLATE.includes("Derive the CORE GOAL ONLY from the ORIGINAL INTENT"));
check("FORCE template drops strict anchor", !FORCE_SYSTEM_PROMPT_TEMPLATE.includes("Derive the CORE GOAL ONLY from the ORIGINAL INTENT"));
check("FORCE template carries soft anchor", FORCE_SYSTEM_PROMPT_TEMPLATE.includes("Derive the CORE GOAL anchored on the ORIGINAL INTENT"));
check("FORCE template differs from SYSTEM", FORCE_SYSTEM_PROMPT_TEMPLATE !== SYSTEM_PROMPT_TEMPLATE);
check("FORCE template keeps non-anchor lines verbatim", FORCE_SYSTEM_PROMPT_TEMPLATE.includes("You LABEL the session, you do NOT participate"));
check("SYSTEM template keeps non-anchor lines verbatim", SYSTEM_PROMPT_TEMPLATE.includes("Never start with: 好的/收到/没问题"));
for (const lang of ["auto", "zh", "en"] as const) {
  const filled = injectLang(SYSTEM_PROMPT_TEMPLATE, lang);
  check(`injectLang(${lang}) fills the real template`, !filled.includes(LANG_PLACEHOLDER) && filled.includes(LANG_RULES[lang]));
}

// ---- glue-layer prompt construction (issue #3 final review) ----
// Golden string: the exact pre-issue-#3 SYSTEM_PROMPT. lang="auto" must
// produce this byte-for-byte — pins backward compatibility.
const GOLDEN_AUTO_SYSTEM_PROMPT =
  "You are an automatic TITLE generator. Your ENTIRE output is ONE short title " +
  "naming what this session is about (its CORE GOAL).\n" +
  "HARD RULES:\n" +
  "- Derive the CORE GOAL ONLY from the ORIGINAL INTENT (the earliest user prompts). " +
  "That is this session's stable focus — what this one session is accomplishing. Ignore " +
  "everything else: later messages may contain pasted reference material, spec/design " +
  "dumps, or content quoted from another session; those NEVER redefine the core. Never " +
  "let a filename, spec heading, or pasted block become the core.\n" +
  "- You LABEL the session, you do NOT participate. Never answer, greet, advise, " +
  "or role-play the conversation.\n" +
  "- Output a concise NOUN PHRASE (like a document title / folder name), NOT a sentence.\n" +
  "- The CORE GOAL is the session's stable focus, NOT the issue/PR title verbatim and NOT " +
  "transient activity like 'code review', 'CR polling', 'babysit', 'monitoring'. Two " +
  "sessions on the same issue must have DIFFERENT cores reflecting their different work.\n" +
  "- Never start with: 好的/收到/没问题/当然/作为/我来/我会/我们可以/让我们/我将/感谢/" +
  "理解/明白/您好. No greetings, no first-person verbs, no advice.\n" +
  "- No sentence-ending punctuation (。.！？!). Do NOT include the repo name or any " +
  "issue/PR numbers (#123, PR#45) — those are not part of the title.\n" +
  "- No transient counters (round/attempt/pass/try/retry N, 第N轮).\n" +
  "- 3-5 words (English) or 6-12 characters (Chinese). Output ONLY the <core goal>.\n" +
  "If the session is non-technical (business/strategy/writing), still output ONLY a " +
  "short topic label, never advice or a response.\n" +
  "Good: \"登录重定向修复\" / \"配置同步方案\" / \"Fix login redirect\"\n" +
  "Bad (NEVER): \"好的，没问题。作为你的技术专家我来帮你梳理…\" / \"I'll help you with…\"\n" +
  "Derive the title ONLY from the session's actual content; never reuse these example words.";
eq("systemPromptFor auto golden (byte-identical to pre-issue#3)", systemPromptFor(false, "auto"), GOLDEN_AUTO_SYSTEM_PROMPT);
check("systemPromptFor force differs from strict", systemPromptFor(true, "auto") !== GOLDEN_AUTO_SYSTEM_PROMPT);
check("systemPromptFor force carries soft anchor", systemPromptFor(true, "auto").includes("Derive the CORE GOAL anchored on the ORIGINAL INTENT"));
check("systemPromptFor zh fills zh rule", systemPromptFor(false, "zh").includes(LANG_RULES.zh));
eq("buildUserPrompt auto strict golden",
  buildUserPrompt(false, "auto", "hello world", "", ""),
  "Derive the session's CORE GOAL ONLY from the ORIGINAL INTENT below. " +
  "Output a concise noun-phrase title (3-5 English words or 6-12 Chinese chars): " +
  "what this one session is accomplishing. No punctuation, no repo name, no " +
  "issue/PR numbers, no greetings/role-play.\n\n" +
  "ORIGINAL INTENT:\nhello world");
check("buildUserPrompt force wording", buildUserPrompt(true, "auto", "hello", "", "").includes("anchored on the ORIGINAL INTENT"));
check("buildUserPrompt zh line", buildUserPrompt(false, "zh", "hello", "", "").includes("Chinese noun-phrase title (6-12 汉字"));
check("buildUserPrompt en line", buildUserPrompt(false, "en", "hello", "", "").includes("English noun-phrase title (3-5 words, no Chinese)"));
check("buildUserPrompt recent block", buildUserPrompt(false, "auto", "hello", "recent msg", "").includes("RECENT CONTEXT (the session's latest user messages") && buildUserPrompt(false, "auto", "hello", "recent msg", "").includes("recent msg"));
check("buildUserPrompt prevTitle block", buildUserPrompt(false, "auto", "hello", "", "Old title").includes("Previous title: Old title"));

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

if (failed) {
	console.error(`\n${failed} checks FAILED`);
	process.exit(1);
}
console.log("\nall checks passed");
