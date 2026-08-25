# Spec: 可配置标题语言 lang（zh | en | auto）（issue #3）

日期：2026-08-26
状态：已确认，进 worktree 实现

## 背景与目标

标题语言目前由模型按原始意图隐式决定（prompt 同时允许 "3-5 words (English)"
与 "6-12 characters (Chinese)"）。混语言环境用户无法强制一种语言，session 列表
不一致。

目标：`~/.pi/agent/auto-rename.json` 新增 `lang` 字段（`"auto"` 默认 / `"zh"` /
`"en"`），强制标题语言。仅影响新生成与 `/autorename` force 重推的标题；存量
锁定 core 不迁移（用户手动 force 即可）。

## 决策表

| 决策 | 选择 |
| --- | --- |
| lang 取值 | `"auto"`(默认) / `"zh"` / `"en"`；非法值回退 `"auto"` |
| 作用范围 | 仅新生成 / force 重推；存量锁定 core 不动 |
| zh 规则 | 汉字为主（6-12 字），英文仅限不可避免的技术词/专有名词 |
| en 规则 | 3-5 English words, no Chinese |
| auto 规则 | 现状双语文案原样（模型跟随原始意图语言） |
| 下游处理 | 零改动：capTitle lowercase（CJK 不受影响）、truncateDisplay（显示列自适应）、looksLikeResponse（双语句号都识别）、maxCoreWidth=24（恰好对齐 12 汉字 / 3-5 词预算）均已语言无关 |
| 后置语言校验 | 不做（允许技术词后启发式会误伤；依赖 prompt + 现有质量门） |
| FORCE 派生链 | SYSTEM_PROMPT 模板移入 lib，语言规则行换 `__LANG_RULE__` 占位符；FORCE 模板仍由 `.replace(anchor句)` 派生；调用时 `injectLang()` 填充 |

## 组件契约

### lib/auto-rename-core.ts 新增纯逻辑（全部可单测）

```ts
export type TitleLang = "auto" | "zh" | "en";

/** Validate + fall back: unknown/invalid values resolve to "auto". */
export function resolveLang(value: unknown): TitleLang;

/** System-prompt HARD-RULES language line per lang. */
export const LANG_RULES: Record<TitleLang, string>;

/** generateCore user-prompt language line per lang. */
export const USER_PROMPT_LANG_LINE: Record<TitleLang, string>;

/** SYSTEM_PROMPT with the language rule line replaced by LANG_PLACEHOLDER. */
export const SYSTEM_PROMPT_TEMPLATE: string;

/** Derived from SYSTEM_PROMPT_TEMPLATE via .replace(anchor) — the derivation
 *  chain is preserved so the two prompts can never drift. */
export const FORCE_SYSTEM_PROMPT_TEMPLATE: string;

export const LANG_PLACEHOLDER = "__LANG_RULE__";

/** Fill the language rule into a template. No-op when placeholder absent
 *  (safe degradation, same philosophy as today's force replace). */
export function injectLang(template: string, lang: TitleLang): string;
```

- `SYSTEM_PROMPT_TEMPLATE` = 现 `index.ts` SYSTEM_PROMPT 原文，仅语言规则行
  （`- 3-5 words (English) or 6-12 characters (Chinese). Output ONLY the <core goal>.`）
  替换为 `__LANG_RULE__`。其余行（anchor 句、Good/Bad 双语示例等）逐字不动。
- `FORCE_SYSTEM_PROMPT_TEMPLATE` = 与现状完全相同的 anchor 句 replace（模块
  加载时执行一次），占位符保留在其中。
- 语言规则文案：

| lang | LANG_RULES（系统提示词行） | USER_PROMPT_LANG_LINE（user prompt 行） |
| --- | --- | --- |
| auto | 现状原文 | 现状原文 |
| zh | `- Output the title in Chinese (6-12 汉字). English is allowed only for unavoidable technical terms or proper nouns.` | `Output a concise Chinese noun-phrase title (6-12 汉字; English only for technical terms): ` |
| en | `- Output the title in English (3-5 words). No Chinese characters.` | `Output a concise English noun-phrase title (3-5 words, no Chinese): ` |

### index.ts glue 层

- `AutoRenameConfig` 加 `lang: TitleLang`；`DEFAULT_CONFIG.lang = "auto"`；
  `loadConfig` 加 `lang: resolveLang(raw.lang)`（与现有逐 key 校验同模式）。
- `generateCore` 签名加 `lang: TitleLang`：
  - user prompt 中 `"Output a concise noun-phrase title (3-5 English words or 6-12 Chinese chars): "`
    替换为 `USER_PROMPT_LANG_LINE[lang]`。
  - `llmOnce(..., force ? injectLang(FORCE_SYSTEM_PROMPT_TEMPLATE, lang) : injectLang(SYSTEM_PROMPT_TEMPLATE, lang))`。
  - 锁短路（`if (prevCore) return prevCore`）与 correctionHint 不动。
- `runAutoRename` 调 `generateCore(..., config.lang)`。

## 数据流

1. 周期/force 触发 → `loadConfig()` 读 `lang`（非法回退 auto）。
2. `generateCore(rt, safeEarly, locked ? prevCore : "", recent, prevTitle, force, lang)`。
3. system prompt = 对应模板 `injectLang(lang)`；user prompt 语言行同理。
4. 输出照旧过质量门 / capTitle / composeTitle / 写状态。lang 不进 session state。

## 降级

- 非法 lang → `resolveLang` 回退 `"auto"`（行为同现状）。
- 模板占位符缺失 → `injectLang` 原样返回模板（退化为 auto 双语行为）。
- 模型失败 / 质量门拒绝 → 现有退避不变。
- config 文件缺失 → DEFAULT_CONFIG 写出（含 lang: "auto"），无感。

## 非目标

- 不改周期刷新 / 锁定语义 / capTitle / 质量门正则 / board sync / state schema。
- 不做存量标题自动迁移（无 lastLang 字段）。
- 不做生成后语言校验重试。
- 不改 maxCoreWidth 与宽度截断逻辑。
- 不发 npm 版（发版是 post-merge 人工步骤）。

## 测试

- `resolveLang`：`"zh"`/`"en"`/`"auto"` 通过；`"EN"`/`"Chinese"`/数字/null/undefined 回退 `"auto"`。
- 模板不变量：`SYSTEM_PROMPT_TEMPLATE` 与 `FORCE_SYSTEM_PROMPT_TEMPLATE` 中
  `LANG_PLACEHOLDER` 恰好各 1 处；FORCE 模板不含严格 anchor 句、含软化 anchor 句。
- `injectLang`：三语言填充后含对应规则文案、占位符消失；缺占位符的模板原样返回。
- 现有纯函数测试全部保持通过。

## 文档

- README config 表加 `lang` 行；标题生成行为段落提一句语言强制与 force 迁移。
