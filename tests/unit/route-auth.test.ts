// Every exported route handler must either authenticate, delegate to something
// that does, or be on this file's explicit public list.
//
// Why this exists: withAuth does not authenticate. It maps ApiKeyError and P2002
// into responses. A handler exported through it that never calls requireApiKey /
// authedWorkspaceId / assertOwns / getSession is anonymous, and two were — leadworks
// GET /api/webhooks and abetagent GET /api/agents/[id]/runs. Every audit that
// looked for "missing scope" missed them because they were not missing scope,
// they were missing a key check.
//
// The scanner lives in ./route-handlers.ts, shared with ./route-validation.test.ts,
// because a scanner copied twice drifts twice. Distrusting it is still this test's
// job: MIN_HANDLERS below, and any export shape it cannot resolve is a thrown
// failure rather than a handler it quietly skipped.
//
// It also reads one level deeper than it used to. A handler whose whole body is
// `return trigger(request, ctx)` has no write in it and no key check in it, and both
// rules above would have passed it for the wrong reason; the scanner now appends the
// helper's block before the rules look (§8.41). What that bought is the two tests
// below that name the webhook route — one proving the resolution still happens, one
// writing down why the write it revealed is allowed.
//
// "Somewhere in the body there is a key check" is a weaker rule than the app was
// entitled to. abetagent's `PATCH /api/agents/[id]` had `assertOwns` in its body,
// two conditionals deep, and a `prisma.agent.update` at the handler's own level
// that ran on every path not naming `tools`; the presence test below passed it and
// a request with no Authorization header renamed another workspace's agent. The
// domination tests after it are the rule that catches that shape: for each write,
// some check must be on every path that reaches it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectHandlers, AUTH_NAME, unguardedWrites, writeSites, readSites, unauthenticatedReaders } from "./route-handlers";

// Set from a measured count, deliberately wide. MIN catches a scanner that
// silently stopped finding handlers (the failure mode that hid two anonymous
// routes for this long); MAX catches one that started double-counting.
const MIN_HANDLERS = 22;
const MAX_HANDLERS = 52;

// Anything that proves the caller is who they claim to be lives in ./route-handlers.ts
// as AUTH_NAME — one list, shared with the domination tests below. A check that
// counts for one rule and not the other is the gap this family has been caught in.

/**
 * Handlers that are public on purpose, with the thing that makes that safe.
 * Adding to this list is the review step: an empty-body check is not a reason.
 */
const PUBLIC: Record<string, string[]> = {
  "src/app/api/health/route.ts": ["GET"],
  // Keyed by the trigger's own secret, compared in constant time: parseTrigger
  // now rejects a webhook trigger with no secret unless public is set true.
  "src/app/api/webhooks/[...path]/route.ts": ["GET", "POST"],
};

/** Handlers that authenticate by calling something outside the body. */
const DELEGATES: Record<string, string[]> = {};

/**
 * Writes a request can reach with no key check dominating them, and the reason
 * each one is acceptable rather than merely unauthenticated. This is the list the
 * scanner's new sight created: `webhooks/[...path]` exports `GET` and `POST` as
 * `return trigger(request, ctx)`, and for as long as the scan stopped at the outer
 * block the domination test below passed that route having never seen the
 * `prisma.execution.create` inside the helper. It now sees it, and the write is
 * genuinely reachable by an anonymous caller — through the one door the workflow
 * author has to open on purpose.
 *
 * The premise is asserted, not just recorded: `public` must still be the thing that
 * opens the door, so a route that drops the opt-in fails here rather than quietly
 * becoming a hole the list excuses.
 */
const ANONYMOUS_WRITES: Record<string, string[]> = {
  // `parseTrigger` refuses a webhook trigger with no secret unless `public: true`
  // is set (definition.ts:47), the workspace the row lands in comes from the
  // matched ACTIVE workflow and not from the request, and what a stranger can
  // enqueue is an Execution for a workflow its author marked as open to the world.
  // Unbounded — no rate limit on this path — which is #32/#38's question, not this
  // list's: the guard asks who may write, not how often.
  "src/app/api/webhooks/[...path]/route.ts": ["GET", "POST"],
};

test("the scanner sees every handler it claims to", () => {
  const handlers = collectHandlers();
  const key = `${MIN_HANDLERS} handlers is the floor`;
  assert.ok(handlers.length >= MIN_HANDLERS, key);
  assert.ok(handlers.length <= MAX_HANDLERS, `${handlers.length} handlers exceeds ${MAX_HANDLERS} — the scanner is double-counting`);
});

test("every exported handler authenticates, delegates, or is listed public", () => {
  const offenders: string[] = [];
  for (const h of collectHandlers()) {
    const listed = (PUBLIC[h.file] ?? []).includes(h.method);
    const delegated = (DELEGATES[h.file] ?? []).includes(h.method);
    if (listed || delegated) continue;
    if (AUTH_NAME.test(h.body)) continue;
    offenders.push(`${h.file} ${h.method}`);
  }
  assert.deepEqual(offenders, [], `handlers with no key check and no entry in PUBLIC:\n  ${offenders.join("\n  ")}`);
});

test("the write scanner sees writes, not just handlers", () => {
  let writes = 0;
  for (const h of collectHandlers()) writes += writeSites(h.body).length;
  // Measured on abetflow's routes when this rule was written: 14 writes, 16 from
  // the day the scanner reads one level deeper (§8.41) — the two new ones are the
  // webhook helper's, counted once per exported method. The floor exists so that a
  // WRITE_NAME regex which stopped matching cannot turn the domination test below
  // into a vacuous pass.
  assert.ok(writes >= 8, `only ${writes} writes found — the write pattern has rotted, not the app`);
});

// What the 16 above are made of. A scanner that stopped reading through
// `return trigger(request, ctx)` would drop back to 14, still clear the floor, and
// hand the webhook route's write invisibility straight back — so the resolution is
// asserted on the one route that needs it, not left to a count that cannot see it.
test("a handler that returns a same-file helper is scanned as that helper's body", () => {
  const post = collectHandlers().find(
    (h) => h.file.endsWith("webhooks/[...path]/route.ts") && h.method === "POST",
  );
  assert.ok(post, "the inbound webhook route is missing from the scan — fix the scanner before believing anything below it");
  assert.ok(post.body.includes("return trigger("), `${post.file} POST no longer delegates; re-read its PUBLIC and ANONYMOUS_WRITES entries`);
  assert.ok(post.body.includes("timingSafeEqual"), `${post.file} POST is scanned without the helper it returns: the guard is blind one line deep again`);
  assert.equal(writeSites(post.body).length, 1, `${post.file} POST: the helper's write is not visible to the domination test`);
});

// Only this list, and no PUBLIC exemption: a handler that is public by design still
// has to say why a request can reach its writes without a key. The list is per
// file-and-method, so a route that grows a second, unexplained write fails here —
// the entry excuses the anonymous door it was written against, not whatever is
// added beside it later.
test("no write is reachable without a check that dominates it", () => {
  const offenders: string[] = [];
  for (const h of collectHandlers()) {
    if ((ANONYMOUS_WRITES[h.file] ?? []).includes(h.method)) continue;
    for (const w of unguardedWrites(h.body)) {
      offenders.push(`${h.file} ${h.method} body line ${w.line}: ${w.name}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `writes that a request can reach before any key check:\n  ${offenders.join("\n  ")}`,
  );
});

// §8.42, the read side. Counting first is what made this a handler-level rule rather
// than a mirror of the one above: of 193 reads across the six apps, 91 have no
// dominating check, and 81 of those are the lookup-then-check idiom a mirrored rule
// would have condemned — `assertOwns(request, row.workspaceId)` cannot run before the
// read that produces `row`. What a route must not do is read at all in a handler with
// no check anywhere in it.
test("the read scanner sees reads, not just handlers", () => {
  let reads = 0;
  for (const h of collectHandlers()) reads += readSites(h.body).length;
  // Measured on this app's routes when the rule was written: 24 reads. The floor
  // exists so that a READ_NAME pattern which stopped matching cannot turn the rule
  // below into a vacuous pass, which is the same reason the write floor is there.
  assert.ok(reads >= 8, `only ${reads} reads found — the read pattern has rotted, not the app`);
});

// No new excuse list. Every handler here that reads with no check anywhere is already
// on PUBLIC, which is what saying "this route is anonymous" is for; DELEGATES counts
// too, because a handler that authenticates by calling something outside its body
// reads the same way it writes.
test("a handler that reads rows checks the caller somewhere, or is listed public", () => {
  const offenders = unauthenticatedReaders(collectHandlers(), { ...PUBLIC, ...DELEGATES });
  assert.deepEqual(
    offenders,
    [],
    `handlers that read the database with no check anywhere in them:\n  ${offenders.join("\n  ")}`,
  );
});

test("an excused anonymous write is still the author's opt-in", () => {
  const stale: string[] = [];
  for (const file of Object.keys(ANONYMOUS_WRITES)) {
    const src = readFileSync(join(process.cwd(), file), "utf8");
    if (!/if \(!trigger\.public\) \{/.test(src)) stale.push(file);
  }
  assert.deepEqual(
    stale,
    [],
    `excused as an author-chosen public endpoint, but that guard is gone from:\n  ${stale.join("\n  ")}`,
  );
});

// The rule above is only as good as the tokenizer underneath it, and a tokenizer
// that said "guarded" for everything would pass it. These bodies are the shapes
// abetflow's real handlers turn out to contain, each with its opposite, so both
// directions are pinned. `handler()` builds the one brace block the rule compares
// against.
const handler = (...lines: string[]): string => `{\n${lines.join("\n")}\n}`;
const CHECK = "  await assertOwns(request, row.workspaceId);";
const WRITE = "  await prisma.workflow.update({ where: { id } });";

test("a check at the handler's own level guards a later write", () => {
  assert.deepEqual(unguardedWrites(handler(CHECK, WRITE)), []);
});

test("a check in a conditional does not guard a write outside it", () => {
  const bodies = [
    handler("  if (tools !== undefined) {", CHECK, "  }", WRITE),
    handler("  if (tools !== undefined) {", "    if (unknown.length > 0) {", CHECK, "    }", "  }", WRITE),
    // A check in one sibling branch cannot guard a write in the next.
    handler("  if (a) {", CHECK, "  }", "  if (b) {", WRITE, "  }"),
  ];
  for (const body of bodies) {
    const offenders = unguardedWrites(body);
    assert.equal(offenders.length, 1, `expected one unguarded write in:\n${body}`);
    assert.equal(offenders[0].name, "prisma.workflow.update");
  }
});

test("a write that runs before the check is unguarded at any depth", () => {
  assert.equal(unguardedWrites(handler(WRITE, CHECK)).length, 1);
  assert.equal(unguardedWrites(handler("  if (a) {", WRITE, CHECK, "  }")).length, 1);
  assert.deepEqual(unguardedWrites(handler("  if (a) {", CHECK, WRITE, "  }")), []);
});

test("a check and a write in the same block guard each other", () => {
  // The shapes the family already relies on: `try`, and an `?action=` dispatcher
  // where every branch checks before it writes. A rule written as "depth 1 only"
  // would fail both.
  assert.deepEqual(unguardedWrites(handler("  try {", CHECK, WRITE, "  }")), []);
  assert.deepEqual(
    unguardedWrites(
      handler(
        "  if (action === 'pause') {",
        "    const row = await prisma.workflow.findUnique({ where: { id } });",
        CHECK,
        WRITE,
        "  }",
        "  if (action === 'rename') {",
        "    const row = await prisma.workflow.findUnique({ where: { id } });",
        CHECK,
        WRITE,
        "  }",
      ),
    ),
    [],
  );
});

test("braces inside strings, comments and regexes are not blocks", () => {
  const inString = handler('  const note = "assertOwns( { }";', CHECK, "  await prisma.workflow.update({ data: { note } });");
  assert.deepEqual(unguardedWrites(inString), []);
  const inComment = handler("  // assertOwns( {", "  /* if (x) { */", CHECK, WRITE);
  assert.deepEqual(unguardedWrites(inComment), []);
  const inRegex = handler("  if (/assertOwns{/.test(h)) {", CHECK, "  }", WRITE);
  assert.equal(unguardedWrites(inRegex).length, 1);
});

test("writeSites finds the writes that unguardedWrites sorts", () => {
  const sites = writeSites(handler("  if (a) {", WRITE, "  }", "  await prisma.workflow.delete({ where: { id } });"));
  assert.deepEqual(sites.map((s) => s.name), ["prisma.workflow.update", "prisma.workflow.delete"]);
  assert.equal(writeSites(handler("  await prisma.workflow.findUnique({ where: { id } });")).length, 0);
});

test("PUBLIC, DELEGATES and ANONYMOUS_WRITES name handlers that still exist", () => {
  const seen = new Set(collectHandlers().map((h) => `${h.file} ${h.method}`));
  const stale: string[] = [];
  for (const [file, methods] of [...Object.entries(PUBLIC), ...Object.entries(DELEGATES), ...Object.entries(ANONYMOUS_WRITES)]) {
    for (const method of methods) if (!seen.has(`${file} ${method}`)) stale.push(`${file} ${method}`);
  }
  assert.deepEqual(stale, [], `listed as public but not found — delete the entry or fix the scanner:\n  ${stale.join("\n  ")}`);
});
