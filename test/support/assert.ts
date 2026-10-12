let failed = 0;
export function eq(name: string, got: unknown, expect: unknown): void {
  if (Object.is(got, expect)) { console.log(`ok   ${name}`); return; }
  failed += 1;
  console.error(`FAIL ${name} — got ${JSON.stringify(got)} want ${JSON.stringify(expect)}`);
}
export function check(name: string, fn: () => void): void {
  try { fn(); } catch (e) { failed += 1; console.error(`FAIL ${name} — ${e instanceof Error ? e.message : String(e)}`); }
}
export function summary(): void {
  if (failed > 0) { console.error(`\n${failed} checks FAILED`); process.exit(1); }
  console.log("\nall checks passed");
}
