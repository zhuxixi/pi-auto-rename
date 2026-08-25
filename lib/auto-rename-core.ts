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
