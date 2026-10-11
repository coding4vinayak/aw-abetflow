// #29 — a DELETE for a name that is not there must be a 404, not a 500.
//
// Measured from source before this round touched anything: `DELETE /api/variables` and
// `DELETE /api/credentials` called `prisma.{variable,credential}.delete` on the composite
// `workspaceId_name` key. Prisma throws `P2025` ("...does not exist") when that key names no
// row, `conflictFor` recognises only `P2002` (asserted in `conflict.test.ts`: a P2025 maps to
// null), and `withAuth` rethrows anything it does not recognise — so an absent name answered
// 500. The two handlers that delete by `:id` (`workflows/[id]`, `executions/[id]`) were never
// in scope: each does a lookup first and returns `{ error: "Not found" }` at 404 before the
// delete, which is the convention this fix matches.
//
// The guard reads comment-stripped source so a prose mention of the old call or of a "404"
// in a sentence cannot satisfy it — the same reason `route-auth` and `route-validation` strip
// before matching. What it pins: each handler `deleteMany`s (reports `count`, never throws
// P2025), names no bare `.delete(` (the throwing form), and turns a zero count into the app's
// 404 body.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const strip = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

const HANDLERS: Record<string, { src: string; model: string }> = {
  variables: { src: strip("../../src/app/api/variables/route.ts"), model: "variable" },
  credentials: { src: strip("../../src/app/api/credentials/route.ts"), model: "credential" },
};

for (const [name, { src, model }] of Object.entries(HANDLERS)) {
  test(`${name} DELETE maps a missing name to 404, not a thrown P2025`, () => {
    // `.delete(` with an open paren immediately after is the throwing form; `.deleteMany(`
    // has `Many` between `delete` and `(`, so this regex only matches the one that throws.
    assert.doesNotMatch(src, new RegExp(`prisma\\.${model}\\.delete\\(`),
      `${model}.delete throws P2025 on a missing key and withAuth turns it into a 500`);
    assert.match(src, new RegExp(`prisma\\.${model}\\.deleteMany\\(\\s*\\{\\s*where:\\s*\\{\\s*workspaceId,\\s*name`),
      "the tenant-scoped deleteMany is the race-free form that reports count");
    assert.match(src, new RegExp(`\\.count === 0[\\s\\S]*?status: 404`),
      "a zero count — the name was not in this workspace — is the app's 404");
  });
}

test("the two :id DELETE handlers keep their prior existence check and stay out of this rule", () => {
  // They use a bare `.delete({ where: { id } })` and that is correct *because* they look the
  // row up first and 404 before reaching it. Pinning that they still do stops a future edit
  // from deleting the guard and turning these into the same 500, or from "fixing" them to
  // deleteMany and silently dropping the not-found branch.
  for (const file of ["workflows/[id]", "executions/[id]"]) {
    const src = strip(`../../src/app/api/${file}/route.ts`);
    assert.match(src, /status: 404/, `${file} still answers a miss with 404`);
  }
});
