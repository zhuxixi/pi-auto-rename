/**
 * Pure core-goal / title logic for auto-rename. Zero pi dependency —
 * unit-tested via esbuild+node (test/auto-rename-core.test.ts). The extension
 * entry (auto-rename.ts) wires these into pi's event loop and LLM calls.
 */

export const MAX_CORE_WIDTH = 24;   // core capped at 24 DISPLAY columns (CJK=2): fits agent-board's ~26-col name field

const FIRST_USER_MSGS = 2;      // original-intent prompts sent to the model
const PER_MSG_CHAR_CAP = 300;   // truncate each prompt to this many chars
export const MAX_TITLE_WORDS = 5;

export function parseIso(ts: unknown): number | null {
  if (typeof ts !== "string") return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t / 1000;
}

// ---- secret redaction (borrowed from pi-autoname) ----------------------------
const SENSITIVE_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: "[REDACTED_PRIVATE_KEY]" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED_AWS_KEY]" },
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replacement: "[REDACTED_API_KEY]" },
  { re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi, replacement: "$1[REDACTED]" },
  { re: /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*=\s*["']?[^"'\s]+/g, replacement: "$1=[REDACTED]" },
  { re: /\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*["']?[^"'\s,;]+/gi, replacement: "$1=[REDACTED]" },
];

export function redact(text: string): string {
  let out = text;
  for (const { re, replacement } of SENSITIVE_PATTERNS) {
    out = out.replace(re, (...args) => replacement.replace(/\$(\d+)/g, (_, i) => String(args[Number(i)] ?? "")));
  }
  return out;
}

// ---- transcript parsing -----------------------------------------------------
export function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text")
    .map((b: any) => String(b.text ?? ""))
    .join(" ")
    .trim();
}

/** Genuine user prompts in transcript order (assistant/tool output excluded). */
export function scanUserMessages(branch: any[]): string[] {
  const msgs: string[] = [];
  for (const entry of branch) {
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    const text = blockText(entry.message.content);
    if (text) msgs.push(text);
  }
  return msgs;
}

function truncateMsgs(msgs: string[], budget: number): string[] {
  const chunks: string[] = [];
  let total = 0;
  for (const m of msgs) {
    let cap = m.slice(0, PER_MSG_CHAR_CAP);
    if (total + cap.length > budget) cap = cap.slice(0, Math.max(0, budget - total));
    if (cap) { chunks.push(cap); total += cap.length; }
    if (total >= budget) break;
  }
  return chunks;
}

const EARLY_WINDOW = 6; // look for substantive openers within the first N user messages

/** Greeting/ack/ping openers carry no intent. Deliberately narrow (issue #10
 *  spec D1: false negatives are fine — the quality gate is the safety net). */
const TRIVIAL_MESSAGE = /^\s*(?:hello|hi|hey|yo|ok|okay|k|thanks|thank\s*you|thx|test|testing|ping|在吗|在么|在不在|你好|您好|喂|嗨|哈喽|嘿|收到|好的?|嗯+|哦|啊|是的?|对的?|可以|没问题|行|测试|试试|早|早上好|中午好|下午好|晚上好)\s*[!！~…。.,，?？]*\s*$/i;

/** True if a user message is a throwaway opener (greeting/ack/ping) or empty. */
export function isTrivialMessage(text: string): boolean {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return true;
  return TRIVIAL_MESSAGE.test(t);
}

/** Single-token slash commands (/autorename, /clear) are recorded as user
 *  messages in pi sessions; they carry no intent and must not pollute the
 *  recent context sent to the model (issue #1 CR). */
const COMMAND_INVOCATION = /^\s*\/[a-z][a-z0-9-]*\s*$/i;

export function isCommandInvocation(text: string): boolean {
  return COMMAND_INVOCATION.test((text || "").trim());
}

export interface EarlySelection {
  text: string;
  /** True when at least one selected message is substantive (non-trivial). */
  substantive: boolean;
}

/**
 * The first FIRST_USER_MSGS substantive prompts within EARLY_WINDOW -> the
 * session's ORIGINAL INTENT, used to derive the stable CORE GOAL. Throwaway
 * openers ("hello", "在吗") are skipped so they can't crowd the real intent
 * out; when every opener in the window is trivial, fall back to the raw first
 * prompts (a weak title beats no title). Only the earliest prompts are used
 * (never the recent tail), so a loud paste later in the session can never
 * redefine the core-derivation — structurally, not by prompt-fu.
 */
export function earlySelection(userMsgs: string[]): EarlySelection {
  if (!userMsgs.length) return { text: "", substantive: false };
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const m of userMsgs.slice(0, EARLY_WINDOW)) {
    if (seen.has(m)) continue;
    seen.add(m);
    if (isTrivialMessage(m)) continue;
    picked.push(m);
    if (picked.length >= FIRST_USER_MSGS) break;
  }
  if (picked.length) return { text: truncateMsgs(picked, 1200).join("\n---\n"), substantive: true };
  const raw: string[] = [];
  const seenRaw = new Set<string>();
  for (const m of userMsgs.slice(0, FIRST_USER_MSGS)) {
    if (seenRaw.has(m)) continue;
    seenRaw.add(m);
    raw.push(m);
  }
  return { text: truncateMsgs(raw, 1200).join("\n---\n"), substantive: false };
}

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
    if (isTrivialMessage(m) || isCommandInvocation(m)) continue;
    picked.push(m);
  }
  if (!picked.length) return "";
  // picked is already most-recent-first (tail scan); truncateMsgs keeps the
  // FRONT prefix on budget (the most recent), cutting the OLDEST tail.
  const kept = truncateMsgs(picked, LATEST_BUDGET);
  kept.reverse();   // back to transcript order for the model
  return kept.join("\n---\n");
}

/** Thin wrapper kept for the original signature (existing tests/imports). */
export function earlyExcerpt(userMsgs: string[]): string {
  return earlySelection(userMsgs).text;
}

// ---- model output -> core ---------------------------------------------------
// A sentence ender: Chinese 。！？ always; ASCII .!? only when followed by
// space/end (so dots inside "Claude.md", "v1.2", "config.json" don't count).
const SENTENCE_END = /[。！？]|[.!?](?:\s|$)/;

// Wide chars (CJK, kana, hangul, fullwidth) occupy 2 terminal columns.
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u3000-\u303F\u3040-\u30FF]/u;

function charWidth(ch: string): number {
  return WIDE_CHAR.test(ch) ? 2 : 1;
}

/** Truncate to a display-column budget (not JS string length), so a CJK core
 * fits agent-board's name column the same way an ASCII core does. */
export function truncateDisplay(s: string, maxWidth: number): string {
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = charWidth(ch);
    if (w + cw > maxWidth) break;
    out += ch;
    w += cw;
  }
  return out;
}

/** Display-width truncation that backs off to the last space/hyphen when the
 *  cut would split an ASCII word (issue #10 spec D6). CJK cuts stay as-is:
 *  no word boundaries to back off to. */
function truncateAtWordBoundary(s: string, maxWidth: number): string {
  const out = truncateDisplay(s, maxWidth);
  if (out === s) return out.trimEnd();
  const chars = Array.from(s);
  const outLen = Array.from(out).length;
  const prev = chars[outLen - 1] ?? "";
  const next = chars[outLen] ?? "";
  const isWordChar = (c: string) => /[A-Za-z0-9]/.test(c);
  if (isWordChar(prev) && isWordChar(next)) {
    const m = /^(.*)[\s-]/.exec(out);
    if (m && m[1].trim()) return m[1].trimEnd();
  }
  return out.trimEnd();
}

/** Trim to a title-shaped fragment: strip quotes, cut at the first
 * sentence-ending punctuation (titles are not sentences), then cap words and
 * display width. English is normalized to lowercase (issue #10 spec D7). */
export function capTitle(text: string, maxWords = MAX_TITLE_WORDS, maxWidth = MAX_CORE_WIDTH): string {
  let t = (text || "").replace(/\s+/g, " ").trim();
  t = t.replace(/^["'“”‘′「」]+|["'“”‘′「」]+$/g, "");
  // drop a leading "Issue #N" / "PR #N" / "#N" label — a core is a goal, not a ref
  t = t.replace(/^(?:issue|pr|pull request)\s*#?\d+\s*[:：、\-–—\s]*/i, "");
  t = t.replace(/^#\d+\s*[:：、\-–—\s]*/, "").trim();
  // drop transient counters (round N, 第N轮, attempt N) — not stable title material
  t = t.replace(/\b(?:round|attempt|pass|try|iteration|iter|retry)\s*#?\d+\b/i, "");
  t = t.replace(/第?\d+\s*轮/, "");
  t = t.replace(/\s+/g, " ").trim();
  const cut = SENTENCE_END.exec(t);
  if (cut) t = t.slice(0, cut.index).trim();
  const words = t.split(" ");
  t = words.length > maxWords ? words.slice(0, maxWords).join(" ") : t;
  t = truncateAtWordBoundary(t, maxWidth);
  t = t.replace(/[A-Z]/g, (ch) => ch.toLowerCase()); // english titles are lowercase (D7); CJK unaffected
  return t.trim();
}

/** Extract the core-goal part from a previously set title (for anchoring).
 *  New titles ARE the core (no repo prefix / refs suffix), so this mostly
 *  returns the title verbatim; the legacy strips below migrate older sessions
 *  that still carry the `owner/repo: core | refs` format. The `: ` strip only
 *  fires when the preceding segment looks like an owner/repo (contains "/"),
 *  so a core that itself contains ": " (e.g. "Fix: login") is not truncated. */
export function coreFromTitle(title: string): string {
  if (!title) return "";
  let t = title;
  const cidx = t.indexOf(": ");
  if (cidx > 0 && t.slice(0, cidx).includes("/")) t = t.split(": ").slice(1).join(": "); // drop legacy "<repo>: " prefix
  if (t.includes(" | ")) t = t.split(" | ")[0];                   // drop legacy " | refs" suffix
  if (t.includes(" -- ")) t = t.split(" -- ")[0];                 // core is before the sub-task
  return t.trim();
}

/** Compose the session title. The title is just the core goal — no
 *  `owner/repo:` prefix and no `| issue#N PR#N` suffix; repo / issue / PR
 *  context is shown natively by the status bar and agent-board. */
export function composeTitle(core: string): string {
  return core || "session";
}

// ---- guard rails -------------------------------------------------------------
export function looksLikeResponse(t: string): boolean {
  if (!t) return true;
  if (SENTENCE_END.test(t)) return true;
  return /^(好的?|收到|没问题|当然|可以|作为|我是|我来|我会|我们可以|让我们|我将|感谢|谢|理解|明白|您好?|嘿|哈喽|当然可以)/.test(t);
}

/** True if a string looks like an error/stacktrace, not a title. */
export function looksLikeError(t: string): boolean {
  return /(\bBUG\b|\[[A-Z]+:|\bException\b|\bTraceback\b|\bRuntimeError\b|\bOutOfMemory\b|\bOutofMemor|\bCUDA\b|\bSegfault\b|\bFatal\b|\bpanic\b|\bAbort\b)/i.test(t || "");
}

const NON_GOAL_CORE = /^(方案确认|确认方案|方案讨论|讨论方案|确认|进worktree|进入worktree|worktree|讨论|继续|review|codereview|代码审查|审查|沟通|跟进|下一步|准备|开始|启动|推进|ok|okay|好的?|可以|没问题|方案|计划|规划)$/i;

/** True if a core is a procedural/confirmation label rather than a goal. */
export function coreIsNonGoal(core: string): boolean {
  const c = (core || "").replace(/\s+/g, "").toLowerCase();
  return Boolean(c) && NON_GOAL_CORE.test(c);
}

const META_SUBJECT = /(issue|pr|pull\s*request|github)/i;
const META_ACTION = /(?:\b(?:list|review|triage)\b|retriev|compil|analy[sz]|查看|梳理|分析|列表|审查|汇总)/i; // PR #11 CR r2: word-bounded list/review/triage (checklist/preview escape), analy[sz] keeps verb/plural variants out, analytics stays out

/** True if a core labels the *process* (triaging/reviewing issues) instead of
 *  the *goal* — the classic junk title from orchestrated sessions whose first
 *  prompts are dispatch boilerplate like "issue list" (issue #10 spec D3). */
export function coreIsMetaActivity(core: string): boolean {
  const c = (core || "").trim();
  if (!c) return false;
  return META_SUBJECT.test(c) && META_ACTION.test(c);
}

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
 * a quality-gate hit never blocks an explicit rename.
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

const GATE_CORE_MAX = 60; // max Unicode code points of a model core echoed into logs/notifications

/**
 * Render an untrusted model core for a single-line log/notification:
 * collapse whitespace AND C1 controls to single spaces (JS `\s` misses
 * U+0085 NEL — a Unicode line separator — and JSON.stringify only escapes
 * C0, so C1 would otherwise survive and break single-line output), cap
 * at 60 Unicode code points, then JSON-quote so quotes, backslashes and
 * control characters can never forge multi-line output (issue #5 D4;
 * C1 fold per PR #6 CR round-1 advisory).
 */
function quoteGateCore(core: string): string {
  const flat = (core || "").replace(/[\s\u0080-\u009f]+/g, " ").trim();
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

// ---- configurable title language (issue #3) ---------------------------------
export type TitleLang = "auto" | "zh" | "en";

/** Validate a config value: unknown/invalid languages fall back to "auto"
 *  (the dual-language behavior), same fallback philosophy as the other
 *  config keys in index.ts loadConfig. */
export function resolveLang(value: unknown): TitleLang {
  return value === "zh" || value === "en" || value === "auto" ? value : "auto";
}

export const LANG_PLACEHOLDER = "__LANG_RULE__";

/** System-prompt HARD-RULES language line per lang (issue #3 spec). */
export const LANG_RULES: Record<TitleLang, string> = {
  auto: "- 3-5 words (English) or 6-12 characters (Chinese). Output ONLY the <core goal>.",
  zh: "- Output the title in Chinese (6-12 汉字). English is allowed only for unavoidable technical terms or proper nouns.",
  en: "- Output the title in English (3-5 words). No Chinese characters.",
};

/** generateCore user-prompt language line per lang (issue #3 spec). */
export const USER_PROMPT_LANG_LINE: Record<TitleLang, string> = {
  auto: "Output a concise noun-phrase title (3-5 English words or 6-12 Chinese chars): ",
  zh: "Output a concise Chinese noun-phrase title (6-12 汉字; English only for technical terms): ",
  en: "Output a concise English noun-phrase title (3-5 words, no Chinese): ",
};

/** Fill the language rule into a prompt template. When the placeholder is
 *  absent the template is returned verbatim (safe degradation, same
 *  philosophy as the force-prompt replace). */
export function injectLang(template: string, lang: TitleLang): string {
  return template.replace(LANG_PLACEHOLDER, LANG_RULES[lang]);
}

/** SYSTEM_PROMPT with the language rule line replaced by LANG_PLACEHOLDER.
 *  Moved here from index.ts (issue #3) so the lang wiring is pure and
 *  testable; every line except the placeholder is verbatim-identical to the
 *  original prompt, including the strict anchor sentence. */
export const SYSTEM_PROMPT_TEMPLATE =
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
  LANG_PLACEHOLDER + "\n" +
  "If the session is non-technical (business/strategy/writing), still output ONLY a " +
  "short topic label, never advice or a response.\n" +
  "Good: \"登录重定向修复\" / \"配置同步方案\" / \"Fix login redirect\"\n" +
  "Bad (NEVER): \"好的，没问题。作为你的技术专家我来帮你梳理…\" / \"I'll help you with…\"\n" +
  "Derive the title ONLY from the session's actual content; never reuse these example words.";

/** Derived from SYSTEM_PROMPT_TEMPLATE by replacing the strict anchor sentence
 *  with the soft (force) anchor — the same derivation index.ts used, kept
 *  intact so the two prompts can never drift apart. If the replace ever fails
 *  to match, force silently falls back to the strict template (safe
 *  degradation, unchanged from before). */
export const FORCE_SYSTEM_PROMPT_TEMPLATE = SYSTEM_PROMPT_TEMPLATE.replace(
  "- Derive the CORE GOAL ONLY from the ORIGINAL INTENT (the earliest user prompts). " +
  "That is this session's stable focus — what this one session is accomplishing. Ignore " +
  "everything else: later messages may contain pasted reference material, spec/design " +
  "dumps, or content quoted from another session; those NEVER redefine the core. Never " +
  "let a filename, spec heading, or pasted block become the core.\n",
  "- Derive the CORE GOAL anchored on the ORIGINAL INTENT (the earliest user prompts). " +
  "If the RECENT CONTEXT shows the session's actual focus has evolved beyond the " +
  "original intent, reflect the CURRENT focus instead. Pasted reference material, " +
  "spec/design dumps, or content quoted from another session must never become the core.\n",
);

/** System prompt for a run: template selected by force, language rule filled. */
export function systemPromptFor(force: boolean, lang: TitleLang): string {
  return injectLang(force ? FORCE_SYSTEM_PROMPT_TEMPLATE : SYSTEM_PROMPT_TEMPLATE, lang);
}

/**
 * The generateCore user prompt: original-intent derivation instruction,
 * language line, optional RECENT CONTEXT / Previous title blocks, then the
 * ORIGINAL INTENT excerpt. Moved here from index.ts (issue #3 final review)
 * so the glue wiring is unit-testable.
 */
export function buildUserPrompt(force: boolean, lang: TitleLang, early: string, recent: string, prevTitle: string): string {
  let user = (force
    ? "Derive the session's CORE GOAL anchored on the ORIGINAL INTENT below. " +
      "If the RECENT CONTEXT shows the session's actual focus has evolved, reflect the CURRENT focus. "
    : "Derive the session's CORE GOAL ONLY from the ORIGINAL INTENT below. ") +
    USER_PROMPT_LANG_LINE[lang] +
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
  return user;
}
