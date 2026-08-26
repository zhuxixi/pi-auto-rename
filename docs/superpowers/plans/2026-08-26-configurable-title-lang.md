# Configurable Title Language (lang) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `lang` config key (`"auto"` / `"zh"` / `"en"`) to `~/.pi/agent/auto-rename.json` that forces the generated title language for newly generated and `/autorename`-forced titles (issue #3).

**Architecture:** Move the `SYSTEM_PROMPT` into `lib/auto-rename-core.ts` as a template with the language rule line replaced by a `__LANG_RULE__` placeholder; add pure `resolveLang` / `LANG_RULES` / `USER_PROMPT_LANG_LINE` / `injectLang` primitives; `index.ts` reads `config.lang` and injects the language into both prompts. The FORCE prompt stays derived from the SYSTEM template via `.replace(anchor)` so the two prompts can never drift.

**Tech Stack:** TypeScript, zero-dep unit tests bundled by esbuild (`./test/run-all.sh`), pi extension API.

## Global Constraints

- Worktree: `/home/elling/git-repo/github/pi-auto-rename/.pi/worktrees/issue-3-configurable-title-language` — ALL file edits and git commands target this worktree (use `cd <worktree>` in every bash step or absolute paths). NEVER touch the main checkout at `/home/elling/git-repo/github/pi-auto-rename`.
- Spec: `docs/superpowers/specs/2026-08-26-configurable-title-lang-design.md` (already committed as first commit `8fdcf13`). The spec governs; the exact language strings below are copied verbatim from its tables.
- lang values: `"auto"` (default) / `"zh"` / `"en"`; any invalid value falls back to `"auto"` via `resolveLang`.
- Downstream handling is ZERO changes: `capTitle` (lowercase), `truncateDisplay`, `looksLikeResponse`, `looksLikeError`, quality gates (`coreIsNonGoal` / `coreIsMetaActivity`), state schema (`auto-rename-state`), board sync, and `maxCoreWidth` must not be modified by any task.
- `lang` is NOT persisted to session state; it is read from config on every run.
- `lib/auto-rename-core.ts` stays zero-pi-dependency (pure TypeScript, no imports from pi packages).
- FORCE derivation chain: `FORCE_SYSTEM_PROMPT_TEMPLATE = SYSTEM_PROMPT_TEMPLATE.replace(strictAnchor, softAnchor)` with the anchor text verbatim from the current `index.ts` — the derivation must be preserved, never hand-copied.
- Commit style: conventional commits (`feat:`/`docs:`/`test:`), English messages, author `zhuxixi <zhuzhenxi_555@hotmail.com>`. Use `git -c user.name=zhuxixi -c user.email=zhuzhenxi_555@hotmail.com commit -m "..."` for determinism.
- Stage files explicitly (`git add <file> ...`), never `git add -A` or `git add .`.
- After every task: `./test/run-all.sh` must pass (run it from the worktree root).

---

### Task 1: Title-language primitives in the core lib

**Files:**
- Modify: `lib/auto-rename-core.ts` (append a new section at the END of the file)
- Test: `test/auto-rename-core.test.ts` (append a new section before the final `if (failed)` block, and extend the import list)

**Interfaces:**
- Consumes: nothing new (pure additions).
- Produces (exact signatures, used by Tasks 2-3):
  - `export type TitleLang = "auto" | "zh" | "en";`
  - `export function resolveLang(value: unknown): TitleLang`
  - `export const LANG_PLACEHOLDER = "__LANG_RULE__";`
  - `export const LANG_RULES: Record<TitleLang, string>`
  - `export const USER_PROMPT_LANG_LINE: Record<TitleLang, string>`
  - `export function injectLang(template: string, lang: TitleLang): string`

- [ ] **Step 1: Write the failing tests**

In `test/auto-rename-core.test.ts`, add these names to the import list at the top (alphabetical position: after `isTrivialMessage`, before `latestSelection`... simplest: insert `injectLang,` after `isTrivialMessage,`; insert `LANG_PLACEHOLDER,` and `LANG_RULES,` after `latestSelection,`; insert `resolveLang,` after `redact,`):

```ts
	injectLang,
```
```ts
	LANG_PLACEHOLDER,
	LANG_RULES,
```
```ts
	resolveLang,
```

Append this section at the end of the test file, BEFORE the final `if (failed)` block:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./test/run-all.sh`
Expected: FAIL — `resolveLang is not defined` (or similar ReferenceError from the bundle).

- [ ] **Step 3: Write the minimal implementation**

Append this section to the END of `lib/auto-rename-core.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./test/run-all.sh`
Expected: PASS — all existing tests plus the new `resolveLang`/`injectLang` cases green.

- [ ] **Step 5: Commit**

```bash
git add lib/auto-rename-core.ts test/auto-rename-core.test.ts
git -c user.name=zhuxixi -c user.email=zhuzhenxi_555@hotmail.com commit -m "feat: add title-language primitives to core lib (issue #3)"
```

---

### Task 2: Prompt templates with lang placeholder in the core lib

**Files:**
- Modify: `lib/auto-rename-core.ts` (append after the Task 1 section, at the END of the file)
- Test: `test/auto-rename-core.test.ts` (append after the Task 1 section, before the final `if (failed)` block; extend the import list)

**Interfaces:**
- Consumes (from Task 1): `LANG_PLACEHOLDER`, `LANG_RULES`, `injectLang`.
- Produces (used by Task 3):
  - `export const SYSTEM_PROMPT_TEMPLATE: string` — full SYSTEM_PROMPT text with the language rule line replaced by `LANG_PLACEHOLDER + "\n"`.
  - `export const FORCE_SYSTEM_PROMPT_TEMPLATE: string` — derived from it via `.replace(strictAnchor, softAnchor)`.

- [ ] **Step 1: Write the failing tests**

In `test/auto-rename-core.test.ts`, add to the import list (insert `FORCE_SYSTEM_PROMPT_TEMPLATE,` after `earlySelection,`; insert `SYSTEM_PROMPT_TEMPLATE,` after `scanUserMessages,`):

```ts
	FORCE_SYSTEM_PROMPT_TEMPLATE,
```
```ts
	SYSTEM_PROMPT_TEMPLATE,
```

Append this section before the final `if (failed)` block (after the Task 1 section):

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./test/run-all.sh`
Expected: FAIL — `SYSTEM_PROMPT_TEMPLATE is not defined`.

- [ ] **Step 3: Write the implementation**

Append this section to the END of `lib/auto-rename-core.ts` (after the Task 1 section). Copy every line of the prompt text exactly as given — including the em-dashes, CJK characters, and quotes — changing nothing except the language rule line, which becomes the placeholder:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./test/run-all.sh`
Expected: PASS — template invariant tests all green (placeholder exactly once in both templates, anchor swap verified, injectLang fills the real template for all three langs).

- [ ] **Step 5: Commit**

```bash
git add lib/auto-rename-core.ts test/auto-rename-core.test.ts
git -c user.name=zhuxixi -c user.email=zhuzhenxi_555@hotmail.com commit -m "feat: move prompt templates to core lib with lang placeholder (issue #3)"
```

---

### Task 3: Wire `lang` through config and title generation in index.ts

**Files:**
- Modify: `index.ts` (import block, config interface + defaults + loadConfig, generateCore, runAutoRename call site, and delete the two old prompt consts)
- Test: none new (index.ts is glue; verified by bundle + grep + existing suite)

**Interfaces:**
- Consumes (from Tasks 1-2): `FORCE_SYSTEM_PROMPT_TEMPLATE`, `SYSTEM_PROMPT_TEMPLATE`, `USER_PROMPT_LANG_LINE`, `injectLang`, `resolveLang`, `type TitleLang` — all from `./lib/auto-rename-core`.
- Produces: `generateCore(rt, early, prevCore, recent, prevTitle, force, lang: TitleLang)` — signature change consumed only by `runAutoRename` (its only call site, same file).

- [ ] **Step 1: Delete the two prompt consts from index.ts**

Delete the entire `const SYSTEM_PROMPT = ...` block, the comment above it, and the `const FORCE_SYSTEM_PROMPT = ...` block (they are being replaced by the lib templates). In `index.ts`, locate the section starting at:

```ts
// ---- LLM call -----------------------------------------------------------------
const SYSTEM_PROMPT =
```

and delete everything from that comment through the end of the `FORCE_SYSTEM_PROMPT` assignment — i.e. through the line:

```ts
  "spec/design dumps, or content quoted from another session must never become the core.\n",
);
```

Keep the `// ---- LLM call -----------------------------------------------------------------` comment? No — delete it too; the section header now belongs to the code below it. The remaining code after the deletion starts with `interface LlmRuntime {`. The section comment `// ---- LLM call ---...` should stay as the header for the LLM call helpers — delete only the two const blocks and their inline comment (`// Force re-derive ...`), keeping the section header comment. In other words: delete from `const SYSTEM_PROMPT =` down to the FORCE assignment's closing `);` (inclusive), but keep `// ---- LLM call ----...` and everything after `interface LlmRuntime`.

- [ ] **Step 2: Extend the import from ./lib/auto-rename-core**

In `index.ts`, the import block currently ends with:

```ts
  truncateDisplay,
} from "./lib/auto-rename-core";
```

Change it to:

```ts
  truncateDisplay,
  FORCE_SYSTEM_PROMPT_TEMPLATE,
  SYSTEM_PROMPT_TEMPLATE,
  USER_PROMPT_LANG_LINE,
  injectLang,
  resolveLang,
  type TitleLang,
} from "./lib/auto-rename-core";
```

- [ ] **Step 3: Add lang to the config**

In `index.ts`, change the config interface:

```ts
interface AutoRenameConfig {
  enabled: boolean;
  model: string;            // "provider/modelId" in pi's model registry
  firstAfterMin: number;    // first rename after this many minutes of session life
  repeatEveryMin: number;   // re-rename cadence after the first rename
  maxCoreWidth: number;     // core-goal cap in display columns (CJK counts 2)
  debug: boolean;
}
```

to:

```ts
interface AutoRenameConfig {
  enabled: boolean;
  model: string;            // "provider/modelId" in pi's model registry
  firstAfterMin: number;    // first rename after this many minutes of session life
  repeatEveryMin: number;   // re-rename cadence after the first rename
  maxCoreWidth: number;     // core-goal cap in display columns (CJK counts 2)
  debug: boolean;
  lang: TitleLang;          // forced title language (issue #3)
}
```

And the defaults:

```ts
const DEFAULT_CONFIG: AutoRenameConfig = {
  enabled: true,
  model: "deepseek/deepseek-v4-flash",
  firstAfterMin: 5,
  repeatEveryMin: 3,
  maxCoreWidth: MAX_CORE_WIDTH,
  debug: false,
};
```

to:

```ts
const DEFAULT_CONFIG: AutoRenameConfig = {
  enabled: true,
  model: "deepseek/deepseek-v4-flash",
  firstAfterMin: 5,
  repeatEveryMin: 3,
  maxCoreWidth: MAX_CORE_WIDTH,
  debug: false,
  lang: "auto",
};
```

And in `loadConfig`, the `configCache = { ... }` assignment — add one line after the `debug:` line:

```ts
          debug: typeof raw.debug === "boolean" ? raw.debug : DEFAULT_CONFIG.debug,
          lang: resolveLang(raw.lang),
```

- [ ] **Step 4: Thread lang through generateCore**

In `index.ts`, change the `generateCore` signature from:

```ts
async function generateCore(rt: LlmRuntime, early: string, prevCore: string, recent = "", prevTitle = "", force = false): Promise<string | null> {
```

to:

```ts
async function generateCore(rt: LlmRuntime, early: string, prevCore: string, recent = "", prevTitle = "", force = false, lang: TitleLang): Promise<string | null> {
```

And inside it, replace the hardcoded language line:

```ts
    "Output a concise noun-phrase title (3-5 English words or 6-12 Chinese chars): " +
    "what this one session is accomplishing. No punctuation, no repo name, no " +
```

with:

```ts
    USER_PROMPT_LANG_LINE[lang] +
    "what this one session is accomplishing. No punctuation, no repo name, no " +
```

And replace the `llmOnce` call's system-prompt argument:

```ts
  const core = await llmOnce(rt, user,
    "Wrong: that was a sentence/response, not a title. Output ONLY a short noun-phrase title, nothing else.",
    undefined, force ? FORCE_SYSTEM_PROMPT : SYSTEM_PROMPT);
```

with:

```ts
  const core = await llmOnce(rt, user,
    "Wrong: that was a sentence/response, not a title. Output ONLY a short noun-phrase title, nothing else.",
    undefined, injectLang(force ? FORCE_SYSTEM_PROMPT_TEMPLATE : SYSTEM_PROMPT_TEMPLATE, lang));
```

- [ ] **Step 5: Pass config.lang at the call site**

In `runAutoRename`, change:

```ts
  const coreRaw = await generateCore(rt, safeEarly, locked ? prevCore : "", recent, opts.force ? redact(prevCore) : "", Boolean(opts.force));
```

to:

```ts
  const coreRaw = await generateCore(rt, safeEarly, locked ? prevCore : "", recent, opts.force ? redact(prevCore) : "", Boolean(opts.force), config.lang);
```

- [ ] **Step 6: Update the file docblock config list**

In the header comment of `index.ts`, change:

```
 *   * ~/.pi/agent/auto-rename.json  {enabled, model, firstAfterMin, repeatEveryMin, debug}
```

to:

```
 *   * ~/.pi/agent/auto-rename.json  {enabled, model, firstAfterMin, repeatEveryMin, maxCoreWidth, debug, lang}
```

- [ ] **Step 7: Verify**

Run from the worktree root:

```bash
./test/run-all.sh
npx esbuild index.ts --bundle --format=esm --platform=node --outfile=/tmp/auto-rename-index-check.mjs --external:@earendil-works/pi-coding-agent --external:@earendil-works/pi-ai --log-level=warning
grep -n "const SYSTEM_PROMPT\|FORCE_SYSTEM_PROMPT " index.ts
```

Expected: test suite PASS; esbuild bundle succeeds (no output on success besides esbuild's banner); grep finds NO definition of the old consts in index.ts (only the new `SYSTEM_PROMPT_TEMPLATE` / `FORCE_SYSTEM_PROMPT_TEMPLATE` names inside the import list, which the grep pattern above must not match).

- [ ] **Step 8: Commit**

```bash
git add index.ts
git -c user.name=zhuxixi -c user.email=zhuzhenxi_555@hotmail.com commit -m "feat: wire lang config into title generation (issue #3)"
```

---

### Task 4: Document the lang config (README + CHANGELOG)

**Files:**
- Modify: `README.md` (config table + How It Works step 3)
- Modify: `CHANGELOG.md` (add an `### Added` section under `## [Unreleased]`, above `### Fixed`)

**Interfaces:**
- Consumes: nothing code-wise; documents the `lang` key from Task 3.

- [ ] **Step 1: Add the config table row**

In `README.md`, in the Configuration table, after the `debug` row:

```markdown
| `debug`         | `false`                     | Verbose logging to stderr                      |
```

insert:

```markdown
| `lang`          | `"auto"`                    | Forced title language: `"zh"` / `"en"` / `"auto"` (default — follows the session's original intent). Invalid values fall back to `"auto"`. Applies to newly generated and `/autorename`-forced titles only |
```

- [ ] **Step 2: Update How It Works step 3**

In `README.md`, change:

```markdown
3. Secrets are redacted, then the excerpt is sent to the configured
   model with a strict title-generation prompt.
```

to:

```markdown
3. Secrets are redacted, then the excerpt is sent to the configured
   model with a strict title-generation prompt; the configured `lang`
   forces the title language (`"auto"` follows the original intent).
```

- [ ] **Step 3: Add the CHANGELOG entry**

In `CHANGELOG.md`, under `## [Unreleased]`, insert BEFORE the existing `### Fixed` heading:

```markdown
### Added

- `lang` config (`"auto"` / `"zh"` / `"en"`): forces the title language
  for newly generated and `/autorename`-forced titles; invalid values
  fall back to `"auto"` (issue #3).
```

- [ ] **Step 4: Verify**

Run from the worktree root: `./test/run-all.sh`
Expected: PASS (no code changed; confirms nothing else broke).

Also visually confirm the README table still renders (row added under debug) via `git diff --stat` / `git diff`.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md
git -c user.name=zhuxixi -c user.email=zhuzhenxi_555@hotmail.com commit -m "docs: document lang config in README and CHANGELOG (issue #3)"
```
