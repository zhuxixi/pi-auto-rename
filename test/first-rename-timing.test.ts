import { renameDue, coreLocksNow } from "../lib/auto-rename-core";
import { eq, summary } from "./support/assert";

// A1: 首个 run 不再看墙钟（issue #9 D1）
eq("first run due at age 0", renameDue({ st: {}, nowSec: 1000, repeatEveryMin: 3 }), true);
eq("first run due right after settle", renameDue({ st: {}, nowSec: 1000.5, repeatEveryMin: 3 }), true);
// 冷却分支保持现状
eq("repeat not due inside cooldown", renameDue({ st: { lastRunEpoch: 1000 }, nowSec: 1000 + 179, repeatEveryMin: 3 }), false);
eq("repeat due at cooldown edge", renameDue({ st: { lastRunEpoch: 1000 }, nowSec: 1000 + 180, repeatEveryMin: 3 }), true);
// force / final 恒 true
eq("force always due", renameDue({ st: { lastRunEpoch: 1000 }, nowSec: 1000, repeatEveryMin: 3, force: true }), true);
eq("final always due", renameDue({ st: { lastRunEpoch: 1000 }, nowSec: 1000, repeatEveryMin: 3, final: true }), true);
// firstAfterMin 不再参与 due 判定（签名里已无该参数）

// A2: 5 分钟是「修正窗口」，不是「没标题窗口」
eq("substantive locks after window", coreLocksNow({ substantive: true, ageSec: 300, firstAfterMin: 5 }), true);
eq("substantive stays unlocked before window", coreLocksNow({ substantive: true, ageSec: 299, firstAfterMin: 5 }), false);
eq("trivial never locks", coreLocksNow({ substantive: false, ageSec: 9999, firstAfterMin: 5 }), false);
eq("already locked stays locked", coreLocksNow({ alreadyLocked: true, substantive: false, ageSec: 1, firstAfterMin: 5 }), true);
eq("force locks regardless of age", coreLocksNow({ substantive: true, ageSec: 1, firstAfterMin: 5, force: true }), true);
eq("evidence re-derive locks", coreLocksNow({ substantive: true, ageSec: 1, firstAfterMin: 5, rederive: true }), true);
summary();
