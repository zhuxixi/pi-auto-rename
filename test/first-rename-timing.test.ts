import { renameDue } from "../lib/auto-rename-core";
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
summary();
