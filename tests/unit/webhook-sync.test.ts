// #74. `?sync=true` runs the workflow inline and returns the finished
// Execution. On a `public: true` trigger that means an anonymous caller can
// hold a request open for the whole duration of a tenant's flow — a synchronous
// version of the same anonymous-execution surface that ANONYMOUS_WRITES already
// excuses in route-auth.test.ts. The route now refuses the combination with 400
// before it creates the QUEUED row, so a refused call leaves nothing behind.
//
// These assertions read the route as text rather than running it, matching the
// family's structural-guard style (route-auth, route-validation, ai-claim). The
// point is not "the behaviour works today" but "a change that drops the guard
// fails a test rather than shipping".
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(process.cwd(), "src/app/api/webhooks/[...path]/route.ts"),
  "utf8",
);

describe("webhook route — sync=true on a public trigger", () => {
  it("names the sync flag once and reuses it, so the check and the branch cannot diverge", () => {
    // The route reads searchParams once (`const wantsSync = …`) and both the
    // guard and the "should I run inline" branch key off that variable. Two
    // separate `searchParams.get("sync") === "true"` reads could drift.
    const gets = (SRC.match(/searchParams\.get\("sync"\)/g) ?? []).length;
    assert.equal(gets, 1, `sync is read ${gets} times from searchParams — the guard and the branch can drift`);
    assert.match(SRC, /const wantsSync = searchParams\.get\("sync"\) === "true"/);
  });

  it("refuses sync on a public trigger rather than running the flow inline", () => {
    assert.match(
      SRC,
      /if\s*\(\s*wantsSync\s*&&\s*trigger\.public\s*\)\s*\{[\s\S]*?sync=true is not available on a public trigger[\s\S]*?status:\s*400/,
    );
  });

  it("checks sync BEFORE creating the Execution row, so a refused call leaves no QUEUED behind", () => {
    const guardIdx = SRC.indexOf("wantsSync && trigger.public");
    const createIdx = SRC.indexOf("prisma.execution.create");
    assert.ok(guardIdx > -1, "the sync guard is gone from the route");
    assert.ok(createIdx > -1, "the Execution write is gone from the route — fix this test before reading anything below");
    assert.ok(guardIdx < createIdx, "sync is checked after the row is created — a refused call leaves an orphan QUEUED behind");
  });

  it("keeps sync available to a caller who presented the secret", () => {
    // The branch that runs the flow inline is still there, guarded by wantsSync
    // but not gated on !public — the secret-holder path is unchanged.
    assert.match(SRC, /if\s*\(\s*wantsSync\s*\)\s*\{[\s\S]*?await runExecution\(execution\.id\)/);
  });
});
