import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Minimal pi session file: timestamped entries so firstTimestamp() can age the session. */
export function writeSessionFile(dir: string, startedAtSec: number, msgs: string[]): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.jsonl");
  const lines = [
    JSON.stringify({ type: "session", id: "test", timestamp: new Date(startedAtSec * 1000).toISOString(), cwd: dir }),
    ...msgs.map((text, i) =>
      JSON.stringify({
        type: "message",
        id: `m${i}`,
        timestamp: new Date((startedAtSec + i) * 1000).toISOString(),
        message: { role: "user", content: [{ type: "text", text }], timestamp: (startedAtSec + i) * 1000 },
      }),
    ),
  ];
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

export function makeHarness(opts: { sessionFile: string; branch: any[]; sessionName?: string }) {
  const handlers = new Map<string, ((...args: any[]) => any)[]>();
  const names: string[] = [];
  const entries: { customType: string; data: any }[] = [];
  let currentName = opts.sessionName;
  const model = { provider: "stub", id: "stub" };
  const pi: any = {
    on(event: string, handler: (...args: any[]) => any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerCommand() {}, registerShortcut() {}, registerFlag() {}, registerTool() {},
    // appendEntry must also land in the branch: readState() scans the branch,
    // so state written by a run has to be visible to the next run (real pi
    // behaves the same way).
    appendEntry(customType: string, data: any) {
      entries.push({ customType, data });
      opts.branch.push({ type: "custom", customType, data });
    },
    setSessionName(name: string) { currentName = name; names.push(name); },
    getSessionName() { return currentName; },
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  const ctx: any = {
    cwd: process.cwd(),
    hasUI: false,
    ui: { notify() {} },
    model,
    modelRegistry: { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "stub" }) },
    sessionManager: {
      getBranch: () => opts.branch,
      getEntries: () => opts.branch,
      getSessionFile: () => opts.sessionFile,
      getSessionName: () => currentName,
    },
  };
  const fire = async (event: string, payload: any = {}) => {
    for (const h of handlers.get(event) ?? []) await h({ type: event, ...payload }, ctx);
  };
  return { pi, ctx, names, entries, fire, handlers };
}
