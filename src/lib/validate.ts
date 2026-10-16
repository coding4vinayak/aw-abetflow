import { NextResponse } from "next/server";

/**
 * A wrong-typed scalar used to be the database's problem, and the database answers
 * in one of two unhelpful ways. The table below is what abetflow's write routes
 * did before this existed. Every row was recorded by `n5-af-before.mts`: 75 cases
 * sent over HTTP to this app's own dev server on :3510, one wrong field per case
 * in an otherwise-valid body, with a minted key (output: `n5-af-before.txt`). The
 * server's `DATABASE_URL` pointed at a COPY of `prisma/dev.db`, so the rows this
 * table describes were real rows in a real database that was not the product's.
 * The stored-data half of each row is the read-back at the end of that file.
 *
 *   POST /api/workflows         body "prose"          500 — request.json() throws
 *   POST /api/workflows         body (nothing)        500, same throw
 *   POST /api/workflows         name: 42              500 PrismaClientValidationError
 *   POST /api/workflows         name: []              500
 *   POST /api/workflows         name: "   "           201, name "   " stored
 *   POST /api/workflows         description: 42       500
 *   POST /api/workflows         status: "BOGUS"       201, and stored
 *   POST /api/workflows         status: "archived"    201, stored lowercase: `status`
 *                                                    filters and every `!== "ACTIVE"`
 *                                                    guard now treat it as neither
 *   POST /api/workflows         status: 42 / true     500
 *   POST /api/workflows         status: ""            201, stored DRAFT — the
 *                                                    `...(status ? { status } : {})`
 *                                                    spread read "" as "not sent"
 *   POST /api/workflows         definition absent     422 "definition.nodes must be a
 *                                                    non-empty array" — the route's own
 *                                                    default `{ nodes: [] }` is refused
 *                                                    by the validator it calls
 *   PATCH /api/workflows/:id    body "prose"          500
 *   PATCH /api/workflows/:id    name: 42              500
 *   PATCH /api/workflows/:id    description: 42       500
 *   PATCH /api/workflows/:id    status: 42            500
 *   PATCH /api/workflows/:id    status: "PAUSEDX"     200, and stored
 *   PATCH /api/workflows/:id    note: 42              200, note dropped, snapshot still written
 *   PATCH /api/workflows/:id    {}                    200, and a WorkflowVersion row:
 *                                                    counted on the copy, 1 version → 3
 *   POST /api/workflows/:id/versions  version: 1.5    200 — it rolled back to v1, and
 *                                                    the new snapshot's note says
 *                                                    "Rollback to v1.5"
 *   POST /api/workflows/:id/versions  version: -3     404 "Version not found"
 *   POST /api/workflows/:id/versions  body "prose"    500
 *   POST /api/variables         name: ["ok"]          500 — `/…/.test(["ok"])` coerces a
 *                                                    one-element array to "ok" and passes
 *   POST /api/variables         name: {}              422 "name must be a valid
 *                                                    identifier", said to an object
 *   POST /api/variables         name 5000 chars       201, stored
 *   POST /api/variables         body "prose"          500
 *   POST /api/credentials       name: 42              500 — the name regex accepts "42"
 *   POST /api/credentials       name: ["n5_carr"]     500, same coercion
 *   POST /api/credentials       provider: 42 / []     500
 *   POST /api/credentials       name 4000 chars       201, stored
 *   POST /api/credentials       body "prose"          500
 *   POST /api/executions        input: 42 / "prose" / [1,2]
 *                                                   202, and stored as the run's input
 *   POST /api/executions        sync: "yes"           202, queued instead of run inline
 *   POST /api/executions        body "prose"          500
 *   POST /api/ai/try-node       text: 42              400 "Paste some text to work on."
 *                                                    — a wrong type answered as a missing one
 *   POST /api/ai/try-node       task: 42              200 {configured:false} — no key on
 *                                                    this server, so what it *would* have
 *                                                    run is `readTask`'s fallback to
 *                                                    summarize [code], not a measurement
 *   POST /api/ai/try-node       labels: "a,b"         200, same reason; the string reached
 *                                                    `runLlmNode`'s config, where
 *                                                    `readStringList` reads a non-array
 *                                                    as no labels at all [code]
 *
 * The 75 cases were replayed once the tables were wired: `n5-af-after.mts`, 83
 * expected answers (the 75 plus top-level `[]` and `null` bodies, a 201-character
 * name, a note-only PATCH, the identifier pattern, and both playground payload
 * shapes), 83 matched, 0 failed, against a second copy. The stored-data read-back
 * came out as the tables should: no `n5-*` workflow row with a refused status, no
 * blank name, `PATCH {}` and `PATCH {note}` each leaving the version count alone
 * (1 → 1), no fractional `WorkflowVersion.version`, and the two long names never
 * written — the 5003-character variable and 4003-character credential the before
 * run stored are gone.
 *
 * Three rows came out right and are here because a boundary is only worth
 * replacing if you know what it already protected: `PATCH` with no key 401s, a
 * demo key on another workspace's workflow 404s, `workspaceId: 42` 403s.
 *
 * abetflow's shape is neither leadworks' (a wrong value stored) nor abetagent's
 * (a value quietly not stored). It is the third one: a wrong type reaches a
 * column the schema only *describes*. `Workflow.status` is a `String` whose legal
 * words live in a comment, so `"BOGUS"` is an insert, and — this is the part a
 * 500 would have made obvious — the workflow still appears in every list and runs
 * nothing. And a PATCH whose body changed nothing still writes a numbered
 * snapshot, so the rollback history fills with identical versions and the newest
 * one is what a rollback restores.
 *
 * So the check belongs at the boundary, against a declared table per route:
 *
 *  - No coercion. `/^…$/.test(name)` runs `String(name)` first, which is how
 *    `["ok"]` was told it was a valid identifier's shape and then 500'd on the way
 *    into Prisma.
 *  - Nothing dropped in silence. A field the route declares must arrive in the
 *    shape the route reads, or the request is refused naming it.
 *  - An absent key means "not mentioned" and is omitted, so a PATCH cannot reset a
 *    column the caller never named. `null` means "clear it" and only works where
 *    the column is nullable.
 *  - Every problem is reported at once, named by field.
 *  - Text is trimmed. `name: "   "` passes a type check and becomes a row no one
 *    can find by name.
 *  - A field the route did not declare never reaches Prisma.
 *
 * This is `src/lib/validate.ts` in leadworks, leadgenius and abetagent — same
 * engine, trimmed to what abetflow's tables use. Dropped rather than carried "for
 * parity": `number` (no column here takes a non-whole number — `version` and
 * `position` are integers, and the ones a run might want are inside Json), `bool`
 * (no boolean column; `sync` is a route-control flag, which is what `boolFlag`
 * below is for), `date` (`nextRunAt` is the scheduler's, computed from a cron
 * expression, never taken from a caller) and `format` (no email or URL column at
 * this boundary).
 *
 * Two Json columns keep their own validator rather than this one: `trigger` and
 * `definition`. Their *shape* is checked here — object or array, under the byte
 * cap — and their contents by `./definition.ts`, which knows about node ids, edge
 * targets and cron expressions. That split is what the UI relies on: a browser
 * action can save an empty DRAFT, and `POST /api/workflows` refuses it.
 */

import { collectBody, describe, short } from "./validation-engine";
import type { Schema, Validated, ValidationProblem } from "./validation-engine";

export type { FieldKind, Field, JsonObject, JsonArray, Schema, Validated, ValidationProblem } from "./validation-engine";
export { NO_FIELD_TO_UPDATE } from "./validation-engine";


export type Validation<S extends Schema> =
  | { ok: true; data: Validated<S>; error?: undefined }
  | { ok: false; data?: undefined; error: NextResponse };

/**
 * The engine's walk, projected into this app's envelope. Every rule — which kinds
 * exist, what a wrong value is called, what `null` and an absent key mean — is in
 * `./validation-engine`, one file for all six apps. This function is here because
 * what a problem *becomes* on the wire is this app's own decision, and the six
 * have never agreed about it: five answer 400 with `{ error, fields }`, abetapi
 * answers 422 with `{ error: { code, message }, fields }` because that envelope is
 * what its published OpenAPI document promises. Reunited rules, forked answer.
 */
export function validateBody<S extends Schema>(
  body: unknown,
  schema: S,
  opts: { requireWrite?: boolean } = {},
): Validation<S> {
  const result = collectBody(body, schema, opts);
  return result.ok ? result : fail(result.problems);
}

/**
 * Parse the body of a request that is required to carry one, and require that it
 * is a JSON *object*. Two failures, both measured as a 500 before: `request.json()`
 * throws — and a throw inside a handler is Next's 500 — so a client sending `prose`
 * or nothing at all was told the server broke; and a body that parses as a scalar
 * or an array reaches `body.workspaceId` in the handler's very next line, which
 * throws the same way. Naming the shape here is also what lets every handler pass
 * `body.workspaceId` straight to `authedWorkspaceId` before validating anything
 * else, so an anonymous caller never gets a field-level answer to read.
 *
 * A well-shaped body is still checked field by field by `validateBody`, which
 * keeps its own copy of this rule because the unit tests call it directly.
 */
export async function readJson(
  request: Request,
): Promise<{ ok: true; body: Record<string, unknown>; error?: undefined } | { ok: false; body?: undefined; error: NextResponse }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, error: bad("request body is not valid JSON") };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: bad(`request body must be a JSON object, got ${describe(body)}`) };
  }
  return { ok: true, body: body as Record<string, unknown> };
}

/**
 * A route-control flag that is not a column — `sync`, which decides whether the
 * run executes inline or goes on the queue. `sync === true` is the only thing the
 * route has ever honoured, and every truthy value that is not `true` was accepted
 * by the client and quietly ignored by the server: measured, `sync: "yes"`
 * answered 202 with a QUEUED row. Refusing it costs the caller one round trip;
 * ignoring it costs them the result they came to read.
 */
export function boolFlag(
  value: unknown,
  name: string,
): { ok: true; value: boolean | undefined; error?: undefined } | { ok: false; value?: undefined; error: NextResponse } {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "boolean") {
    return {
      ok: false,
      error: bad(`${name} must be true or false, got ${describe(value)}${typeof value === "string" ? " — send it unquoted" : ""}`),
    };
  }
  return { ok: true, value };
}

/* ---------- the per-field walk ---------- */

function bad(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * One message per field, plus a `fields` object keyed the same way as the body the
 * caller sent. The key is the point: the 500s above named an argument only inside
 * a Prisma stack line that never reached the client.
 */
function fail(problems: ValidationProblem[]): { ok: false; error: NextResponse } {
  const fields: Record<string, string> = {};
  for (const [name, message] of problems) fields[name] = message;
  return {
    ok: false,
    error: NextResponse.json({ error: problems.map(([, message]) => message).join("; "), fields }, { status: 400 }),
  };
}

/* ---------- the event-list boundary ---------- */

const EVENT_NAME = /^[A-Za-z][A-Za-z0-9._-]*$/;

/**
 * Both shapes of an event list are accepted at the boundary and one shape is
 * stored, so a caller following the README gets an answer instead of a 500 —
 * measured in the sibling products, `events: ["a.b", "c.d"]` was a 500 on
 * `.split` and `events: 42` a 500 on `.length`. Names are trimmed, deduped and
 * held to the one character class every product's events share; at least one
 * name is required, because a subscription that names nothing is a
 * subscription nobody meant to create.
 */
export function eventNames(
  value: unknown,
  name = "events",
  max = 50,
): { ok: true; values: string[]; error?: undefined } | { ok: false; values?: undefined; error: NextResponse } {
  const parts: string[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== "string") {
        return { ok: false, error: bad(`${name} holds ${describe(entry)}; every event must be text`) };
      }
      parts.push(entry);
    }
  } else if (typeof value === "string") {
    parts.push(...value.split(","));
  } else {
    return {
      ok: false,
      error: bad(`${name} must be an array of event names or a comma-separated string, got ${describe(value)}`),
    };
  }
  const values: string[] = [];
  for (const part of parts) {
    const token = part.trim();
    if (!token) continue;
    if (!EVENT_NAME.test(token)) {
      return { ok: false, error: bad(`${name} holds ${short(token)}; an event name is letters, digits, dot, dash or underscore`) };
    }
    if (!values.includes(token)) values.push(token);
  }
  if (!values.length) return { ok: false, error: bad(`${name} must name at least one event`) };
  if (values.length > max) return { ok: false, error: bad(`${name} names ${values.length} events; at most ${max}`) };
  return { ok: true, values };
}
