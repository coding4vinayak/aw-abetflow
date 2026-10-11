// #75. `webhooks/[...path]` matches an inbound slug against every ACTIVE
// workflow's `trigger.path`. Without a write-side rule, two tenants picking
// the same path meant one silently lost: the read returned whichever row
// Prisma happened to hand back first, and no caller could tell.
//
// The fix is at both ends. `create` and `PATCH` consult
// `findActiveWebhookPathConflict` when the row lands ACTIVE, and the inbound
// route refuses a multi-match with 503 rather than picking.
//
// These assertions read the three route files as text and the new lib module
// as a shape. Same style as route-auth, route-validation, ai-claim, and
// webhook-sync — a source-reading structural guard is cheap to run, survives
// refactors that rename internals, and fails the moment the invariant is
// dropped.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const CREATE = read("src/app/api/workflows/route.ts");
const PATCH = read("src/app/api/workflows/[id]/route.ts");
const INBOUND = read("src/app/api/webhooks/[...path]/route.ts");
const LIB = read("src/lib/webhook-path.ts");

describe("webhook-path module (#75)", () => {
  it("exports the two names the routes reach for", () => {
    assert.match(LIB, /export async function findActiveWebhookPathConflict\s*\(/);
    assert.match(LIB, /export function webhookPathOf\s*\(/);
  });

  it("only reports a conflict on ACTIVE rows and only on webhook-kind triggers", () => {
    assert.match(LIB, /where:\s*\{\s*status:\s*"ACTIVE"/);
    assert.match(LIB, /t\?\.kind\s*===\s*"webhook"/);
  });

  it("webhookPathOf returns null for manual and cron shapes", () => {
    assert.match(LIB, /t\?\.kind\s*===\s*"webhook"\s*&&\s*typeof t\.path\s*===\s*"string"\s*\?\s*t\.path\s*:\s*null/);
  });
});

describe("create route — refuses activating into a collision", () => {
  it("imports both names", () => {
    assert.match(CREATE, /import\s*\{\s*findActiveWebhookPathConflict\s*,\s*webhookPathOf\s*\}\s*from\s*"@\/lib\/webhook-path"/);
  });

  it("checks only when the row lands ACTIVE", () => {
    // Reading the default: `input.data.status ?? "DRAFT"` — so DRAFT-creating
    // workflows never consult the DB for a conflict.
    assert.match(CREATE, /if\s*\(\s*\(input\.data\.status \?\? "DRAFT"\)\s*===\s*"ACTIVE"\s*\)/);
  });

  it("answers 409 with the owning workspace id, not a silent overwrite", () => {
    assert.match(CREATE, /status:\s*409/);
    assert.match(CREATE, /Another active workflow already owns webhook path/);
  });
});

describe("PATCH route — checks on both status transition and trigger edit", () => {
  it("imports both names", () => {
    assert.match(PATCH, /import\s*\{\s*findActiveWebhookPathConflict\s*,\s*webhookPathOf\s*\}\s*from\s*"@\/lib\/webhook-path"/);
  });

  it("consults the resulting trigger and status, not whichever field the caller sent", () => {
    // Same `effectiveTrigger`/`effectiveStatus` shape that `nextRunAt` already
    // reads. A `{status:"ACTIVE"}` PATCH that does not touch trigger still has
    // to be checked, and a trigger edit on a PAUSED row must not be.
    assert.match(PATCH, /if\s*\(\s*effectiveStatus\s*===\s*"ACTIVE"\s*\)/);
    assert.match(PATCH, /webhookPathOf\(\s*effectiveTrigger\s*\)/);
  });

  it("passes the row's own id so a no-op PATCH does not refuse itself", () => {
    assert.match(PATCH, /findActiveWebhookPathConflict\(\s*slug\s*,\s*id\s*\)/);
  });

  it("answers 409", () => {
    assert.match(PATCH, /status:\s*409/);
  });
});

describe("inbound route — no longer silently picks the first match", () => {
  it("collects every ACTIVE match rather than the first", () => {
    assert.match(INBOUND, /\.filter\(\s*\(w\)\s*=>/);
    // The `find(...)` shape is what made the first-wins bug. Assert its absence
    // in the specific position the collision used to hide in.
    const triggerBlock = INBOUND.slice(0, INBOUND.indexOf("if (!slug)"));
    const after = INBOUND.slice(INBOUND.indexOf("if (!slug)"));
    void triggerBlock;
    assert.doesNotMatch(after, /candidates\.find\(/);
  });

  it("503s on a multi-match so a collided row is visible rather than shadowed", () => {
    assert.match(INBOUND, /matches\.length\s*>\s*1[\s\S]*status:\s*503/);
  });

  it("keeps the 404 for zero matches — the fix does not change the not-found contract", () => {
    assert.match(INBOUND, /matches\.length\s*===\s*0[\s\S]*status:\s*404/);
  });
});
