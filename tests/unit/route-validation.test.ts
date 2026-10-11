// N5, held in place: a request body that reaches Prisma unvalidated is a 500 or a
// wrong row, and nothing in the type system notices when the next route forgets.
//
// Measured against this app's own routes, over HTTP, before the field tables
// existed — 75 cases through a dev server whose `DATABASE_URL` pointed at a copy of
// `prisma/dev.db` (full table in the header of `src/lib/validate.ts`, read-back in
// `/tmp/abectorial/n5-af-before.txt`). Eight of the rows that matter most:
//
//   POST /api/workflows            name: 42           500 PrismaClientValidationError
//   POST /api/workflows            status: "BOGUS"    201, stored: SQLite has no enum
//   POST /api/workflows            body "prose"       500 — request.json() throws
//   PATCH /api/workflows/:id       {}                 200, and a WorkflowVersion row
//   PATCH /api/workflows/:id       note: 42           200, note dropped, snapshot written
//   POST /api/workflows/:id/versions  version: 1.5    200 — rolled back to v1
//   POST /api/variables            name: ["ok"]       500, after the regex called it valid
//   POST /api/executions           sync: "yes"        202, queued instead of run inline
//
// All of them are 400s now, with the field named. What this file pins is that they
// stay that way: `validate.test.ts` proves the engine, and these prove that every
// route is actually plugged into it. The scanner is shared with `route-auth.test.ts`
// for the reason given there — a copy scanned twice drifts twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectHandlers,
  countCodeMentions,
  functionBody,
  schemaArgs,
  unresolvedTailCalls,
} from "./route-handlers";
import * as FIELDS from "../../src/lib/fields";
import * as ENUMS from "../../src/lib/enums";

/** The calls that decide what a body may contain. */
const VALIDATES = /validateBody\s*\(|boolFlag\s*\(/;

/** Reading a body at all, however the handler spells it. */
const READS_A_BODY = /readJson\s*\(|\brequest\.json\s*\(\s*\)/;

/**
 * Handlers that read a body and are not excused above, each with the reason it
 * is acceptable. Adding a line here is the review step, same as `PUBLIC` is for
 * authentication.
 */
const UNVALIDATED: Record<string, string[]> = {
  // The inbound trigger. Its payload *is* the product: whatever the caller posts
  // becomes `Execution.input`, which the workflow's own nodes read, so refusing a
  // bare string or an array would break the thing the endpoint is for. It is safe
  // to leave unvalidated rather than merely convenient: the path must match an
  // ACTIVE workflow's trigger, `parseTrigger` now requires a signing secret or an
  // explicit `public: true`, the secret is compared with `timingSafeEqual`, and a
  // body that fails to parse stores `null` instead of throwing — so there is no
  // 500 here and no wrong-typed scalar either. Both values go into a Json column,
  // which takes any JSON value by design. `sync` is read from the query string,
  // not the body, which is why this route never calls `boolFlag`.
  //
  // GET is the same helper, excused on its own terms: resolving the delegation
  // gives a GET body containing `await request.json()`, and that read is inside
  // `if (request.method === "POST")` (route.ts:50), so a GET reads no body and
  // stores `input: null`. Listed rather than special-cased in the regex, so the day
  // that guard moves, this entry is wrong and the test says so.
  "src/app/api/webhooks/[...path]/route.ts": ["GET", "POST"],
};

test("every handler that reads a body validates it", () => {
  const offenders: string[] = [];
  for (const h of collectHandlers()) {
    if (!READS_A_BODY.test(h.body)) continue;
    if (VALIDATES.test(h.body)) continue;
    if ((UNVALIDATED[h.file] ?? []).includes(h.method)) continue;
    offenders.push(`${h.file} ${h.method}`);
  }
  assert.deepEqual(offenders, [], `handlers that read a body and hand it to Prisma unchecked:\n  ${offenders.join("\n  ")}`);
});

/**
 * This file used to append the delegated helper's block by hand, from a list of
 * exactly one route, because the scanner stopped at the outer block. The scan reads
 * through it now (§8.41), so the list is gone and what is pinned instead is the
 * scanner's own sight — the assertion that would have failed before the fix, and
 * fails today if the resolution is ever taken back out. A handler whose body is a
 * tail call, scanned without the callee in it, is a route that reads no body and
 * validates nothing as far as the rule above can tell.
 */
test("a handler that returns a same-file helper is scanned with that helper's block", () => {
  const file = "src/app/api/webhooks/[...path]/route.ts";
  const exported = collectHandlers().filter((h) => h.file === file);
  assert.equal(exported.length, 2, `${file}: expected GET and POST, found ${exported.map((h) => h.method).join(", ") || "nothing"}`);
  for (const h of exported) {
    assert.ok(h.body.includes("return trigger("), `${file} ${h.method} no longer delegates — re-read its UNVALIDATED entry`);
    const inner = functionBody(readFileSync(join(process.cwd(), file), "utf8"), "trigger");
    assert.ok(inner !== null, `${file}: trigger() is no longer a function in this file`);
    assert.ok(h.body.includes(inner), `${file} ${h.method}: the scanner returned the outer block only`);
  }
});

test("UNVALIDATED names handlers that still exist", () => {
  const seen = new Set(collectHandlers().map((h) => `${h.file} ${h.method}`));
  const stale = Object.entries(UNVALIDATED).flatMap(([file, methods]) => methods.filter((m) => !seen.has(`${file} ${m}`)));
  assert.deepEqual(stale, [], `excused but not found — delete the entry or fix the scanner:\n  ${stale.join("\n  ")}`);
});

// The routes' source, not the handlers' resolved bodies: an import is outside
// the body, and the schema argument is read out of the call where it is used.
const ROUTE_FILES = [...new Set(collectHandlers().map((h) => h.file))];
const routeSource = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

test("a route validates against a declared table, never an inline one", () => {
  const declared = new Set(Object.keys(FIELDS));
  const offenders: string[] = [];
  for (const file of ROUTE_FILES) {
    for (const arg of schemaArgs(routeSource(file))) {
      if (arg.startsWith("{")) offenders.push(`${file} — an inline schema`);
      else if (!declared.has(arg)) offenders.push(`${file} — ${arg} is not exported from lib/fields`);
    }
  }
  assert.deepEqual(offenders, [], `validate calls with no table in lib/fields:\n  ${offenders.join("\n  ")}`);
});

test("every declared table is used by a route, and every enum set by a table", () => {
  const fieldSource = routeSource("src/lib/fields.ts");
  const unusedTables = Object.keys(FIELDS).filter(
    (name) => !ROUTE_FILES.some((file) => new RegExp(`\\b${name}\\b`).test(routeSource(file)))
      && countCodeMentions(fieldSource, name) === 0,
  );
  assert.deepEqual(unusedTables, [], `tables in lib/fields nothing uses — delete them or wire them:\n  ${unusedTables.join("\n  ")}`);

  const unusedEnums = Object.keys(ENUMS).filter((name) => countCodeMentions(fieldSource, name) === 0);
  assert.deepEqual(unusedEnums, [], `enum sets no field table checks against:\n  ${unusedEnums.join("\n  ")}`);
});

/**
 * A text field called `somethingId` names a row rather than filling a column, so
 * the type check is only half the rule: measured, `POST /api/executions` with
 * `workflowId: 42` threw on the way into `findUnique` — a 500 for a value that is
 * simply not an id — and a real id from another workspace has to 404, not run.
 * The route has to say whether the row exists and belongs to this workspace,
 * either through a batch helper that 422s naming the ones it did not find, or
 * through a lookup that 404s — where "no such row" is the whole answer. The
 * lookup may be spelled `id: workflowId` or `id: input.data.workflowId`, because
 * the validated value comes out of the engine under a prefix.
 */
test("an id-typed field is checked for existence where it is accepted", () => {
  const offenders: string[] = [];
  for (const [name, schema] of Object.entries(FIELDS)) {
    const idFields = Object.entries(schema as Record<string, { kind?: string }>)
      .filter(([field, spec]) => /Id$/.test(field) && spec?.kind === "text")
      .map(([field]) => field);
    if (!idFields.length) continue;
    for (const file of ROUTE_FILES.filter((f) => new RegExp(`\\b${name}\\b`).test(routeSource(f)))) {
      const src = routeSource(file);
      for (const field of idFields) {
        const batchChecked = new RegExp(`(unknownIdError|unknownIdsError|missingIds)[^)]*\\b${field}\\b`).test(src);
        const lookedUp = new RegExp(`where:\\s*\\{[^}]*\\bid:\\s*(?:[\\w.]+\\.)?${field}\\b`).test(src);
        if (!batchChecked && !lookedUp) {
          offenders.push(`${file} accepts ${name}.${field} without checking the row exists`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `foreign keys taken on faith:\n  ${offenders.join("\n  ")}`);
});

/**
 * A handler whose body is `return helper(request)` validates nothing and writes nothing
 * until the helper is read. The scanner resolves same-file tail calls (§8.41); this asks
 * it, once per handler, whether the callee's block actually came back — so the day the
 * resolution breaks, the rules above fail loudly instead of passing on a thinner body.
 * Vendored mechanism, local assertion: 181 handlers across the six apps, none hidden.
 */
test("no handler hides a same-file helper behind a tail call", () => {
  const hidden = unresolvedTailCalls(collectHandlers());
  assert.deepEqual(hidden, [], `scanned without the function they return:\n  ${hidden.join("\n  ")}`);
});
