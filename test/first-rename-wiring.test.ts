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
// A7: 重开自愈（有内容、从未命名、非 reload）
{
  resetStub();
  const branch = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello fix the bug" }] } }];
  const sessionFile = writeSessionFile(join(home, "s2"), Date.now() / 1000 - 600, ["hello fix the bug"]);
  const h = makeHarness({ sessionFile, branch, sessionName: "hello" });
  autoRename(h.pi);
  await h.fire("session_start", { reason: "resume" });
  await new Promise((r) => setTimeout(r, 50));
  eq("resume self-heal names the session", h.names.at(-1), "fix login bug");
}
// A7 反例：reload 不自愈
{
  resetStub();
  const branch = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello fix the bug" }] } }];
  const sessionFile = writeSessionFile(join(home, "s3"), Date.now() / 1000 - 600, ["hello fix the bug"]);
  const h = makeHarness({ sessionFile, branch, sessionName: "hello" });
  autoRename(h.pi);
  await h.fire("session_start", { reason: "reload" });
  await new Promise((r) => setTimeout(r, 50));
  eq("reload does not rename", h.names.length, 0);
}
// A8: 退出兜底（从未命名 → 命名；已命名 → 不动；reload → 不动）
{
  resetStub();
  const branch = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello fix the bug" }] } }];
  const sessionFile = writeSessionFile(join(home, "s4"), Date.now() / 1000 - 30, ["hello fix the bug"]);
  const h = makeHarness({ sessionFile, branch, sessionName: "hello" });
  autoRename(h.pi);
  await h.fire("session_shutdown", { reason: "quit" });
  eq("quit final-run names the session", h.names.at(-1), "fix login bug");
}
{
  resetStub();
  const branch = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello fix the bug" }] } }];
  const sessionFile = writeSessionFile(join(home, "s5"), Date.now() / 1000 - 30, ["hello fix the bug"]);
  const h = makeHarness({ sessionFile, branch, sessionName: "hello" });
  autoRename(h.pi);
  await h.fire("session_shutdown", { reason: "reload" });
  eq("reload final-run is skipped", h.names.length, 0);
}
// A8 反例：已命名（有 lastRunEpoch）的会话退出时不动
{
  resetStub();
  const branch = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "hello fix the bug" }] } },
    { type: "custom", customType: "auto-rename-state", data: { lastRunEpoch: 1000, lastSetTitle: "fix login bug", lastCore: "fix login bug" } },
  ];
  const sessionFile = writeSessionFile(join(home, "s5b"), Date.now() / 1000 - 30, ["hello fix the bug"]);
  const h = makeHarness({ sessionFile, branch, sessionName: "fix login bug" });
  autoRename(h.pi);
  await h.fire("session_shutdown", { reason: "quit" });
  eq("already-named session is not re-run at exit", h.names.length, 0);
}
// A11a: final 失败分支不阻塞退出、不写半状态
{
  resetStub();
  stubState.mode = "fail";
  const branch = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello fix the bug" }] } }];
  const sessionFile = writeSessionFile(join(home, "s6"), Date.now() / 1000 - 30, ["hello fix the bug"]);
  const h = makeHarness({ sessionFile, branch, sessionName: "hello" });
  autoRename(h.pi);
  let threw = false;
  try { await h.fire("session_shutdown", { reason: "quit" }); } catch { threw = true; }
  eq("failing final run does not throw", threw, false);
  eq("failing final run writes no title", h.names.length, 0);
  check("failing final run writes no state", () => {
    if (h.entries.some((e) => e.customType === "auto-rename-state")) throw new Error("state written on failure");
  });
}
// A11b: 在途碰撞 — 后台 run 卡住时 final run 被吞（有日志），退出路径不抛、不写
{
  resetStub();
  stubState.mode = "hang";
  const branch = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello fix the bug" }] } }];
  const sessionFile = writeSessionFile(join(home, "s7"), Date.now() / 1000 - 30, ["hello fix the bug"]);
  const h = makeHarness({ sessionFile, branch, sessionName: "hello" });
  autoRename(h.pi);
  await h.fire("session_start", { reason: "resume" }); // 自愈 run 进入 llm 并挂起
  await new Promise((r) => setTimeout(r, 50));
  let threw = false;
  try { await h.fire("session_shutdown", { reason: "quit" }); } catch { threw = true; }
  eq("in-flight collision does not throw", threw, false);
  eq("in-flight collision writes no title", h.names.length, 0);
  check("in-flight collision writes no state", () => {
    if (h.entries.some((e) => e.customType === "auto-rename-state")) throw new Error("state written on collision");
  });
}
summary();
