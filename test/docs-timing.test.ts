import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { check, summary } from "./support/assert";

// run-all.sh bundles this file into a temp dir, where import.meta.dirname points at
// the bundle; the harness always runs from the repo root, so try cwd first.
function resolveReadme(): string {
  for (const base of [process.cwd(), import.meta.dirname ?? "."]) {
    const p = join(base, "README.md");
    if (existsSync(p)) return p;
  }
  throw new Error("README.md not found next to cwd or test dir");
}
const readme = readFileSync(resolveReadme(), "utf8");

check("config table documents the lock gate", () => {
  if (!/firstAfterMin[^\n]*lock/i.test(readme)) throw new Error("firstAfterMin row must describe the core-lock semantics");
});
check("no stale 'first rename after' wording", () => {
  for (const stale of ["First rename after this many minutes of session life", "first rename after `firstAfterMin`"]) {
    if (readme.includes(stale)) throw new Error(`stale wording present: ${stale}`);
  }
});
check("how-it-works mentions the first settle", () => {
  if (!/first settle|first `agent_settled`|first agent_settled/i.test(readme)) throw new Error("How It Works must describe settle-driven first rename");
});
summary();
