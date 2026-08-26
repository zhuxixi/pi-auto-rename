/**
 * auto-rename — AI session naming for Pi: derives a short CORE GOAL title.
 *
 * After a session has been alive FIRST_AFTER_MIN minutes, and then every
 * REPEAT_EVERY_MIN minutes, it derives a concise title naming what this one
 * session is accomplishing (its CORE GOAL), applies it via pi.setSessionName(),
 * and mirrors it into the agent-board view meta.json (absorbing
 * agent-board-name-sync's job).
 *
 * The title is JUST the core goal — no `owner/repo:` prefix and no
 * `| issue#N PR#N` suffix. Repo, branch, issue, and PR context belong in the
 * status bar / agent-board's own fields (pi-agent-board shows them natively),
 * not crammed into the session name. This differs from the Claude Code hook
 * this was ported from, where the title was the only display surface.
 *
 * No `gh` / git dependency: the title is derived purely from the session's
 * original intent, so behavior is identical on GitHub, GitLab, and self-hosted
 * git. (The CC-hook issue/PR detection via `gh pr view` was removed with the
 * suffix.)
 *
 * Length budget: agent-board's list view shows ~24-26 display columns for the
 * name, so the core is capped at 24 display columns (12 CJK chars / 24 ASCII).
 *
 * Design (do not break):
 *   * Title anchors on the session's CORE GOAL derived from the ORIGINAL INTENT
 *     (earliest user prompts), not the latest transient action; later pastes
 *     (spec dumps quoted from other sessions) can never crowd the core out.
 *   * The core is locked once established: periodic refreshes reuse prev_core
 *     verbatim (no model call) — the title only changes if re-derived.
 *   * Manual rename protection: an out-of-band name change (≠ last set title)
 *     pauses this session so we never fight the user.
 *   * LLM via pi's model registry (deepseek/deepseek-v4-flash by default) —
 *     keys stay in pi's keychain, never read from dotfiles here.
 *   * Best-effort everywhere: never throws into pi's event loop.
 *
 * State lives in the session file as `auto-rename-state` custom entries
 * ({lastRunEpoch, lastSetTitle, lastCore, paused, pausedReason}).
 *
 * Controls:
 *   * ~/.pi/agent/auto-rename.json  {enabled, model, firstAfterMin, repeatEveryMin, maxCoreWidth, debug, lang}
 *   * /autorename          force a rename now (bypasses cooldown, pause, and core lock; re-derives with latest context)
 *   * /autorename-pause    pause this session
 *   * /autorename-resume   resume this session
 *   * /autorename-status   show current state
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai/compat";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  FORCE_SYSTEM_PROMPT_TEMPLATE,
  SYSTEM_PROMPT_TEMPLATE,
  USER_PROMPT_LANG_LINE,
  injectLang,
  resolveLang,
  type TitleLang,
} from "./lib/auto-rename-core";

// Re-export the pure core so existing imports from this entry keep working.
export { capTitle, composeTitle, coreFromTitle, coreIsNonGoal, earlyExcerpt, truncateDisplay };

// ---- config -----------------------------------------------------------------
const CONFIG_PATH = join(homedir(), ".pi", "agent", "auto-rename.json");

interface AutoRenameConfig {
  enabled: boolean;
  model: string;            // "provider/modelId" in pi's model registry
  firstAfterMin: number;    // first rename after this many minutes of session life
  repeatEveryMin: number;   // re-rename cadence after the first rename
  maxCoreWidth: number;     // core-goal cap in display columns (CJK counts 2)
  debug: boolean;
  lang: TitleLang;          // forced title language (issue #3)
}

const DEFAULT_CONFIG: AutoRenameConfig = {
  enabled: true,
  model: "deepseek/deepseek-v4-flash",
  firstAfterMin: 5,
  repeatEveryMin: 3,
  maxCoreWidth: MAX_CORE_WIDTH,
  debug: false,
  lang: "auto",
};

const MAX_NAME_TOKENS = 1024;   // generous: thinking-mode models burn tokens on reasoning
const AI_TOTAL_BUDGET_MS = 30_000;
const AI_ATTEMPT_TIMEOUT_MS = 12_000;
const STATE_ENTRY_TYPE = "auto-rename-state";

let debugEnabled = false;
let configCache: AutoRenameConfig | undefined;
let configMtime = 0;

function debugLog(msg: string): void {
  if (debugEnabled) console.error(`[auto-rename] ${msg}`);
}

function loadConfig(): AutoRenameConfig {
  try {
    if (!existsSync(CONFIG_PATH)) {
      mkdirSync(dirname(CONFIG_PATH), { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf8");
      configCache = { ...DEFAULT_CONFIG };
      configMtime = 0;
    } else {
      const mtime = statSync(CONFIG_PATH).mtimeMs;
      if (!configCache || mtime !== configMtime) {
        const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
        configCache = {
          enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
          model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : DEFAULT_CONFIG.model,
          firstAfterMin: typeof raw.firstAfterMin === "number" && raw.firstAfterMin >= 1 ? raw.firstAfterMin : DEFAULT_CONFIG.firstAfterMin,
          repeatEveryMin: typeof raw.repeatEveryMin === "number" && raw.repeatEveryMin >= 1 ? raw.repeatEveryMin : DEFAULT_CONFIG.repeatEveryMin,
          maxCoreWidth: typeof raw.maxCoreWidth === "number" && raw.maxCoreWidth >= 8 ? raw.maxCoreWidth : DEFAULT_CONFIG.maxCoreWidth,
          debug: typeof raw.debug === "boolean" ? raw.debug : DEFAULT_CONFIG.debug,
          lang: resolveLang(raw.lang),
        };
        configMtime = mtime;
      }
    }
  } catch (error) {
    console.error(`[auto-rename] failed to load config; using defaults: ${error instanceof Error ? error.message : String(error)}`);
    configCache = { ...DEFAULT_CONFIG };
    configMtime = 0;
  }
  const config = configCache ?? { ...DEFAULT_CONFIG };
  debugEnabled = config.debug;
  return config;
}

// ---- transcript parsing -----------------------------------------------------
/** Earliest timestamp in the leading lines of the session file. */
function firstTimestamp(file: string, maxLines = 64): number | null {
  let earliest: number | null = null;
  try {
    const lines = readFileSync(file, "utf8").split(/\r?\n/).slice(0, maxLines);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ts = parseIso(JSON.parse(line)?.timestamp);
        if (ts !== null && (earliest === null || ts < earliest)) earliest = ts;
      } catch { /* skip malformed */ }
    }
  } catch { /* file unreadable */ }
  return earliest;
}

// ---- LLM call -----------------------------------------------------------------
interface LlmRuntime {
  ctx: ExtensionContext;
  model: any;
  apiKey: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

function extractText(response: any): string {
  const text = (response?.content ?? [])
    .filter((b: any) => b?.type === "text")
    .map((b: any) => String(b.text ?? ""))
    .join("")
    .trim();
  if (text) return text;
  // thinking-mode models may return reasoning only; last line is the best guess
  const thinking = (response?.content ?? [])
    .filter((b: any) => b?.type === "thinking")
    .map((b: any) => String(b.thinking ?? ""))
    .join("")
    .trim();
  if (!thinking) return "";
  const lines = thinking.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

async function llmOnce(rt: LlmRuntime, userContent: string, correctionHint?: string, signal?: AbortSignal, systemPrompt: string = injectLang(SYSTEM_PROMPT_TEMPLATE, "auto")): Promise<string> {
  const messages: any[] = [{ role: "user", content: [{ type: "text", text: userContent }], timestamp: Date.now() }];
  const call = async (msgs: any[]): Promise<string> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("llm attempt timed out")), AI_ATTEMPT_TIMEOUT_MS);
    const onOuter = () => controller.abort(signal?.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener("abort", onOuter, { once: true });
    try {
      const resp = await complete(
        rt.model,
        { systemPrompt, messages: msgs },
        {
          apiKey: rt.apiKey, headers: rt.headers, env: rt.env,
          maxTokens: MAX_NAME_TOKENS,
          reasoningEffort: "minimal", // deepseek-v4-flash defaults to thinking; keep it cheap
          signal: controller.signal,
        } as any,
      );
      return extractText(resp);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onOuter);
    }
  };

  let out = "";
  try { out = await call(messages); } catch (e) { debugLog(`llm failed: ${e instanceof Error ? e.message : String(e)}`); }
  if (!out) { // transient error -> one retry
    try { out = await call(messages); } catch { /* give up below */ }
  }
  if (out && !looksLikeResponse(out)) return out;
  if (out && correctionHint) {
    debugLog(`output looks like a response (${out.slice(0, 60)}); corrective retry`);
    messages.push({ role: "user", content: [{ type: "text", text: correctionHint }], timestamp: Date.now() });
    try {
      const out2 = await call(messages);
      if (out2 && !looksLikeResponse(out2)) return out2;
    } catch { /* fall through */ }
  }
  return "";
}

/**
 * Return the core-goal title, or null on hard failure. When prevCore is set
 * (the session already has an established, locked core) it is returned verbatim
 * with no model call — anchored refreshes are free, and the title only changes
 * if the anchor is dropped and re-derived. On a forced re-derive (/autorename)
 * prevCore is passed empty and recent/prevTitle feed the prompt instead, so the
 * model re-derives with the latest context (issue #1).
 */
async function generateCore(rt: LlmRuntime, early: string, prevCore: string, recent = "", prevTitle = "", force = false, lang: TitleLang): Promise<string | null> {
  if (!early) return null;
  if (prevCore) return prevCore; // locked; no model call needed
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
  const core = await llmOnce(rt, user,
    "Wrong: that was a sentence/response, not a title. Output ONLY a short noun-phrase title, nothing else.",
    undefined, injectLang(force ? FORCE_SYSTEM_PROMPT_TEMPLATE : SYSTEM_PROMPT_TEMPLATE, lang));
  return core || null;
}

// ---- state ---------------------------------------------------------------------
interface AutoRenameState {
  lastRunEpoch?: number;
  lastSetTitle?: string;
  lastCore?: string;
  coreLocked?: boolean; // issue #10 D4: re-derive on every refresh until locked
  paused?: boolean;
  pausedReason?: string;
}

function readState(branch: any[]): AutoRenameState {
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (entry?.type === "custom" && entry.customType === STATE_ENTRY_TYPE && entry.data && typeof entry.data === "object") {
      return entry.data as AutoRenameState;
    }
  }
  return {};
}

// ---- agent-board sync (absorbed from agent-board-name-sync) ---------------------
const BOARD_ROOT = (() => {
  if (process.env.AGENT_BOARD_ROOT) return resolve(process.env.AGENT_BOARD_ROOT);
  if (process.env.AGENT_VIEW_ROOT) return resolve(process.env.AGENT_VIEW_ROOT);
  return join(homedir(), ".pi", "agent", "agent-board");
})();

function atomicWriteJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

/** Push a name into the board view whose sessionFile matches the current session. */
function syncBoardName(ctx: ExtensionContext, name: string): void {
  try {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;
    const dir = join(BOARD_ROOT, "views");
    if (!existsSync(dir)) return;
    const normalized = resolve(sessionFile);
    for (const viewId of readdirSync(dir)) {
      if (viewId.startsWith(".")) continue;
      const metaFile = join(dir, viewId, "meta.json");
      let meta: any;
      try { meta = JSON.parse(readFileSync(metaFile, "utf8")); } catch { continue; }
      if (meta?.sessionFile && resolve(meta.sessionFile) === normalized && meta.name !== name) {
        meta.name = name;
        meta.updatedAt = Date.now();
        atomicWriteJson(metaFile, meta);
        debugLog(`board meta.name synced -> ${name}`);
        return;
      }
    }
  } catch { /* best-effort only */ }
}

// ---- model resolution -------------------------------------------------------------
function resolveModel(modelName: string, ctx: ExtensionContext): any {
  const sep = modelName.indexOf("/");
  if (sep <= 0 || sep === modelName.length - 1) return undefined;
  return ctx.modelRegistry.find(modelName.slice(0, sep), modelName.slice(sep + 1));
}

async function buildLlmRuntime(ctx: ExtensionContext): Promise<LlmRuntime | null> {
  const config = loadConfig();
  const configured = resolveModel(config.model, ctx);
  const candidates = [configured, ctx.model].filter(Boolean);
  for (const model of candidates) {
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (auth.ok && auth.apiKey) {
        return { ctx, model, apiKey: auth.apiKey, headers: auth.headers, env: auth.env };
      }
    } catch (e) {
      debugLog(`auth for ${model?.provider}/${model?.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return null;
}

// ---- main flow ----------------------------------------------------------------------
async function runAutoRename(pi: ExtensionAPI, ctx: ExtensionContext, opts: { force?: boolean } = {}): Promise<{ title?: string; reason: string }> {
  const config = loadConfig();
  if (!config.enabled) return { reason: "globally disabled" };

  const branch = ctx.sessionManager.getBranch();
  const st = readState(branch);
  if (st.paused && !opts.force) return { reason: `paused (${st.pausedReason ?? "manual"})` };

  const sessionFile = ctx.sessionManager.getSessionFile();
  const now = Date.now() / 1000;

  // due check
  if (!opts.force) {
    let due: boolean;
    if (st.lastRunEpoch) {
      due = now - st.lastRunEpoch >= config.repeatEveryMin * 60;
    } else {
      const start = (sessionFile ? firstTimestamp(sessionFile) : null) ?? now;
      due = now - start >= config.firstAfterMin * 60;
    }
    if (!due) return { reason: "not due yet" };
  }

  const userMsgs = scanUserMessages(branch);
  const sel = earlySelection(userMsgs);
  const early = sel.text;
  if (!early) return { reason: "no user messages" };

  // anchor = this session's own established core (stable + differentiates
  // sessions on the same branch). Drop it if it's garbage, a procedural/
  // non-goal label like "方案确认", or a process label like "Issue list
  // triage" — the last also self-heals legacy junk anchors on next refresh.
  const cw = config.maxCoreWidth;
  let anchor = st.lastCore || coreFromTitle(st.lastSetTitle ?? "");
  if (anchor && (looksLikeError(anchor) || coreIsNonGoal(anchor) || coreIsMetaActivity(anchor))) {
    debugLog(`anchor ${anchor} dropped (garbage/non-goal/meta); re-deriving`);
    anchor = "";
  }

  const prevCore = anchor ?? "";
  // The core locks only once derived from substantive intent; before that
  // every refresh re-derives (cheap) so a junk core self-corrects. A forced
  // /autorename always unlocks: the model is called again with the latest
  // context so a drifted title can be regenerated (issue #1).
  const locked = !opts.force && Boolean(st.coreLocked && prevCore);

  const rt = await buildLlmRuntime(ctx);
  if (!rt) return { reason: "no usable model (registry auth failed)" };

  // redact secrets before anything goes to the model
  const safeEarly = redact(early);
  const recent = opts.force ? redact(latestSelection(userMsgs)) : "";
  const coreRaw = await generateCore(rt, safeEarly, locked ? prevCore : "", recent, opts.force ? redact(prevCore) : "", Boolean(opts.force), config.lang);
  if (!coreRaw) return { reason: "llm failed; backed off" }; // keep current title, retry next period
  if (!locked && (coreIsNonGoal(coreRaw) || coreIsMetaActivity(coreRaw))) {
    debugLog(`core ${coreRaw.slice(0, 60)} rejected by quality gate; backed off`);
    return { reason: "core rejected by quality gate; backed off" };
  }

  const core = capTitle(locked && prevCore ? prevCore : coreRaw, MAX_TITLE_WORDS, cw);
  const title = composeTitle(core);

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
}

// ---- extension ------------------------------------------------------------------------
let lastGeneratedName: string | undefined;

export default function autoRename(pi: ExtensionAPI): void {
  loadConfig();
  let sessionCtx: ExtensionContext | undefined;
  let running = false;

  // Serialized runner shared by the periodic trigger and the /autorename
  // command: force and periodic runs can never interleave (issue #1 CR).
  const runSerialized = async (ctx: ExtensionContext, force: boolean): Promise<{ title?: string; reason: string } | null> => {
    if (running) return null; // a run is already in flight
    running = true;
    try {
      return await runAutoRename(pi, ctx, { force });
    } finally {
      running = false;
    }
  };

  const trigger = (force = false) => {
    if (!sessionCtx || running) return;
    void runSerialized(sessionCtx, force)
      .then((r) => debugLog(`run: ${r?.reason}${r?.title ? ` -> ${r.title}` : ""}`))
      .catch((e) => debugLog(`run error: ${e instanceof Error ? e.message : String(e)}`));
  };

  pi.on("session_start", async (_event, ctx) => {
    sessionCtx = ctx;
    const st = readState(ctx.sessionManager.getBranch());
    lastGeneratedName = st.lastSetTitle; // reload-safe: recognize our own past writes
    if (debugEnabled) debugLog(`restored state: ${JSON.stringify(st)}`);
  });

  // Manual-rename protection: an out-of-band name change pauses this session.
  pi.on("session_info_changed", (event, ctx) => {
    const name = event.name?.trim();
    if (!name || name === lastGeneratedName) return;
    lastGeneratedName = name;
    const st = readState(ctx.sessionManager.getBranch());
    if (st.paused) return; // already paused — don't pile up duplicate entries (issue #10)
    if (st.lastSetTitle && name !== st.lastSetTitle) {
      pi.appendEntry(STATE_ENTRY_TYPE, { ...st, paused: true, pausedReason: "manual_rename" });
      debugLog(`manual rename detected (${name}); session paused`);
    }
  });

  // Naming is best-effort background work; never hold pi's settled lifecycle.
  pi.on("agent_settled", () => trigger(false));

  pi.registerCommand("autorename", {
    description: "Force a rename now (bypasses cooldown, pause, and core lock; re-derives with latest context)",
    handler: async (_args, ctx) => {
      sessionCtx = ctx;
      const r = await runSerialized(ctx, true);
      if (!r) {
        ctx.ui.notify("auto-rename: a rename is already in flight; try again shortly", "warning");
        return;
      }
      ctx.ui.notify(
        r.title ? `auto-rename: ${r.title} (${r.reason})` : `auto-rename: ${r.reason}`,
        r.title ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("autorename-pause", {
    description: "Pause auto-rename for this session",
    handler: async (_args, ctx) => {
      const st = readState(ctx.sessionManager.getBranch());
      pi.appendEntry(STATE_ENTRY_TYPE, { ...st, paused: true, pausedReason: "user_command" });
      ctx.ui.notify("auto-rename: paused for this session", "info");
    },
  });

  pi.registerCommand("autorename-resume", {
    description: "Resume auto-rename for this session",
    handler: async (_args, ctx) => {
      const st = readState(ctx.sessionManager.getBranch());
      pi.appendEntry(STATE_ENTRY_TYPE, { ...st, paused: false, pausedReason: undefined });
      ctx.ui.notify("auto-rename: resumed", "info");
    },
  });

  pi.registerCommand("autorename-status", {
    description: "Show auto-rename state for this session",
    handler: async (_args, ctx) => {
      const st = readState(ctx.sessionManager.getBranch());
      ctx.ui.notify(
        `auto-rename: title=${st.lastSetTitle ?? "(none)"} core=${st.lastCore ?? "(none)"} ` +
        `locked=${st.coreLocked ? "yes" : "no"} ` +
        `paused=${st.paused ? st.pausedReason ?? "yes" : "no"} lastRun=${st.lastRunEpoch ? new Date(st.lastRunEpoch * 1000).toLocaleTimeString() : "never"}`,
        "info",
      );
    },
  });
}
