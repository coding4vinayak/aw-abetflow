// Outbound webhooks, pinned where their rot is visible: the source.
//
// The failure mode being guarded is silence, not a crash. A declared event
// with no emitter, an emitter that slipped ahead of the row that makes the
// event true, a delivery that lost its egress check or one of its two
// signatures — each still typechecks, still builds, and still passes every
// runtime test that does not know to look. A source-reading test is the one
// that looks: the menu comes from `lib/webhooks.ts` itself, the call sites
// from `runner.ts`, and the assertions below are the contract the README
// documents, so drift between the two is a failing test rather than a support
// ticket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const sender = source("../../src/lib/webhooks.ts");
const runner = source("../../src/lib/runner.ts");
const route = source("../../src/app/api/webhooks/route.ts");

const declared = sender.match(/WEBHOOK_EVENTS = \[([^\]]+)\]/)?.[1] ?? "";
const menu = [...declared.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

test("the menu is exactly the two events, in the order the docs list them", () => {
  assert.deepEqual(menu, ["execution.completed", "execution.failed"]);
});

test("every declared event has an emitter, one per terminal path", () => {
  for (const event of menu) {
    assert.ok(runner.includes(`"${event}"`), `no emitter for ${event} in runner.ts`);
  }
  assert.equal(
    (runner.match(/void triggerWebhooks\(/g) ?? []).length,
    2,
    "one emission for the success transaction, one for the catch",
  );
});

test("the completion emission sits after the transaction that commits the terminal row", () => {
  const commit = runner.indexOf("$transaction(");
  const emit = runner.indexOf('result.status === "FAILED" ? "execution.failed" : "execution.completed"');
  assert.ok(commit !== -1, "the transaction is where a run becomes true");
  assert.ok(emit !== -1, "the emission picks its event from the status that transaction wrote");
  assert.ok(commit < emit, "emitting first would tell receivers about a state that does not exist yet");
});

test("the failure emission lives in the catch, after the row that records the failure", () => {
  const catchAt = runner.indexOf("} catch (error) {");
  const emit = runner.indexOf('void triggerWebhooks(execution.workspaceId, "execution.failed"');
  assert.ok(catchAt !== -1 && emit !== -1);
  assert.ok(catchAt < emit, "the failed event is emitted from the error path");
  const record = runner.indexOf('status: "FAILED"', catchAt);
  assert.ok(record !== -1 && record < emit, "the row that says FAILED is written before the event that says so");
});

test("the dispatcher signs the body once, under both spellings", () => {
  assert.match(
    sender,
    /createHmac\("sha256", secret\)\.update\(body\)\.digest\("hex"\)/,
    "the digest is HMAC-SHA256 hex over the exact bytes sent",
  );
  assert.match(sender, /"X-Abetflow-Signature": signature,/, "this product's spelling stays");
  assert.match(
    sender,
    /"X-Webhook-Signature": `sha256=\$\{signature\}`,/,
    "the generic nuCRM-compatible spelling rides the same bytes",
  );
  assert.match(sender, /id: `evt_\$\{crypto\.randomBytes/, "the payload id is evt_-prefixed so a receiver can deduplicate");
});

test("every delivery passes the egress check immediately above its fetch", () => {
  const check = sender.indexOf('await assertAllowedTarget(rawUrl, "url")');
  const fetchAt = sender.indexOf("await fetch(rawUrl");
  assert.ok(check !== -1 && fetchAt !== -1);
  assert.ok(check < fetchAt, "the check is what makes the destination safe; the order is not incidental");
  assert.ok(fetchAt - check < 200, "'immediately above' is the rule this pins");
  assert.ok(sender.includes("AbortSignal.timeout(5000)"), "an endpoint that never answers must not hold the delivery open");
});

test("delivery failure cannot reject the batch or the run", () => {
  assert.match(sender, /await Promise\.allSettled\(matching\.map/, "one dead endpoint must not silence the others");
  assert.match(sender, /catch \(error\) \{\s*console\.error\(/, "delivery failures are logged, not thrown");
});

test("both subscription writes refuse an event name nothing emits", () => {
  assert.equal(
    (route.match(/unknownEventsProblem\(events\.values\)/g) ?? []).length,
    2,
    "POST and PATCH each refuse the typo, not just one of them",
  );
  assert.match(
    sender,
    /Unknown events: \$\{invalid\.join\(", "\)\}\. Valid events: \$\{WEBHOOK_EVENTS\.join\(", "\)\}/,
    "the refusal names what was wrong and what the menu is",
  );
});

test("read responses preview the secret; only the create response carries it", () => {
  assert.match(sender, /export function webhookPreview/);
  assert.match(route, /webhooks\.map\(webhookPreview\)/);
  assert.match(route, /webhookPreview\(webhook\)/);
});

test("item endpoints stay on ?id= — an [id] segment would shadow the inbound trigger route", () => {
  assert.ok(
    !existsSync(new URL("../../src/app/api/webhooks/[id]/route.ts", import.meta.url)),
    "measured before this shape was chosen: GET /api/webhooks/orders answered the item route's 404 and POST 405'd, " +
      "and the trigger route (which owns every /api/webhooks/{path}) was never reached. A [id] segment re-introduces that.",
  );
  assert.match(route, /searchParams\.get\("id"\)/, "the id comes from the query string");
  assert.match(route, /const id = searchParams\.get\("id"\);\n  if \(!id\)/, "and is required before anything is read or written");
  assert.match(route, /deleteMany\(\{ where: \{ id, workspaceId \} \}\)/, "the delete is tenant-scoped in the filter, the race-free form");
});

test("the subscription routes authenticate as the house pattern", () => {
  assert.match(route, /await authedWorkspaceId\(request, body\.workspaceId\)/, "POST authenticates the body's workspace");
  assert.match(
    route,
    /await authedWorkspaceId\(request, searchParams\.get\("workspaceId"\)\)/,
    "reads, updates and deletes authenticate the query's workspace",
  );
});
