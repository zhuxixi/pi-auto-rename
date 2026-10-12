import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, summary, check } from "./support/assert";

// Module-level paths (CONFIG_PATH / BOARD_ROOT) are evaluated at import time,
// so the env has to be redirected BEFORE importing the extension.
const home = mkdtempSync(join(tmpdir(), "ar-home-"));
const board = mkdtempSync(join(tmpdir(), "ar-board-"));
process.env.HOME = home;
process.env.AGENT_BOARD_ROOT = board;

const { makeHarness, writeSessionFile } = await import("./support/fake-pi");
const { resetStub, stubState } = await import("./support/pi-ai-stub");
const autoRename = (await import("../index")).default;

async function runGreetingSettle(startedAtSec: number) {
  resetStub();
  const branch = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } }];
  const sessionFile = writeSessionFile(join(home, "s"), startedAtSec, ["hello"]);
  const h = makeHarness({ sessionFile, branch, sessionName: "hello" });
  autoRename(h.pi);
  await h.fire("session_start", { reason: "resume" });
  await new Promise((r) => setTimeout(r, 50)); // trigger() runs detached
  await h.fire("agent_settled");
  await new Promise((r) => setTimeout(r, 50));
  return h;
}

// A5: 首个 settle 即命名（不等 5 分钟），琐碎锚点零模型调用
const h = await runGreetingSettle(Date.now() / 1000 - 10);
eq("greeting session named at first settle", h.names.at(-1), "Greeting exchange");
eq("greeting path never calls the model", stubState.calls, 0);
check("state written without lastRunEpoch (A4)", () => {
  const last = h.entries.at(-1)?.data ?? {};
  if (last.lastRunEpoch !== undefined) throw new Error(`lastRunEpoch must stay unset, got ${last.lastRunEpoch}`);
});
summary();
