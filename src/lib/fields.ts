import type { Schema } from "./validate";
import { LLM_TASKS, WORKFLOW_STATUSES } from "./enums";

/**
 * What each write route accepts, one declared table per route. It lives here
 * rather than beside its handler because a collection route and its `[id]`
 * sibling write the same columns — `PATCH /api/workflows/:id` and
 * `POST /api/workflows` disagreeing about what `status` may hold is exactly the
 * drift a table you can read in one screen prevents. The API's whole input
 * contract is this file.
 *
 * `workspaceId` and `id` are absent everywhere on purpose: they come from the key
 * and the path, never the body. A handler reads `body.workspaceId` only to hand it
 * to `authedWorkspaceId`, which refuses anything that is not the key's own
 * workspace — measured before this file existed, `workspaceId: 42` was already a
 * 403 rather than a 500 — and then returns the id to use.
 *
 * A field not listed here never reaches Prisma. That retires two shapes this app
 * was written with: the `...(name !== undefined ? { name } : {})` spread on every
 * PATCH, and the per-field guards that were the whole check before — `/^[a-zA-Z_
 * ][a-zA-Z0-9_]*$/.test(name)`, which runs `String(name)` first, so `["ok"]` passed
 * as a valid identifier and then 500'd into Prisma, and `{}` was told its name was
 * the wrong shape.
 *
 * No `json` field below is `nullable`. Prisma writes a NULL in a JSON column with
 * its own `DbNull` sentinel rather than `null`, so "clear this" has no shape a
 * client can send that is not a translation at the boundary; `{}` is the empty
 * value in the same form every reader of those columns expects.
 *
 * Deliberately missing, because no handler has ever written them from a body:
 * `Workflow.nextRunAt` (the scheduler's, computed from a cron expression), every
 * `ExecutionStep` column and `Execution.output`/`error`/`startedAt`/`completedAt`
 * (`runner.ts`'s), `Execution.source` and `Execution.status` (set by the route that
 * creates the row: `manual`, `webhook`, `retry`), `WorkflowVersion.version` (the
 * route numbers it from the highest existing one), and `Credential.ciphertext`/`iv`
 * (`sealCredential`'s, from `value`). `sync` on an execution is a route-control
 * flag rather than a column, which the handler checks with `boolFlag` because
 * `sync === true` is the only thing it has ever honoured — measured, `sync: "yes"`
 * answered 202 with a QUEUED row.
 *
 * `note` is in `WORKFLOW_PATCH` although it writes `WorkflowVersion`, not the
 * workflow, because it is caller text heading for a NOT NULL-except-nullable String
 * column. A PATCH that sends only `note` is still refused: see the handler.
 */

export const WORKFLOW_CREATE = {
  name: { kind: "text", required: true, max: 200 },
  description: { kind: "text", nullable: true, max: 2000 },
  /**
   * Shape only. What a trigger may hold is `parseTrigger`'s decision — a webhook
   * needs a path and a secret or `public: true`, a cron needs a real expression —
   * and the route runs it on whatever this lets through. Absent means the route's
   * own `{ kind: "manual" }`, which that validator accepts.
   */
  trigger: { kind: "json" },
  /**
   * Required, because the route's default was `{ nodes: [] }` and `parseDefinition`
   * refuses an empty graph: `POST /api/workflows {name:"x"}` measured as a 422
   * about `definition.nodes` from a caller who never sent one. Saying "required"
   * is the same refusal in words the caller can act on.
   */
  definition: { kind: "json", required: true },
  status: { kind: "enum", values: WORKFLOW_STATUSES },
} satisfies Schema;

/**
 * Every field is optional here, which is what makes an omitted key mean "not
 * mentioned". The `definition` a create requires, a patch may leave alone.
 */
export const WORKFLOW_PATCH = {
  name: { kind: "text", max: 200 },
  description: { kind: "text", nullable: true, max: 2000 },
  trigger: { kind: "json" },
  definition: { kind: "json" },
  status: { kind: "enum", values: WORKFLOW_STATUSES },
  note: { kind: "text", nullable: true, max: 500 },
} satisfies Schema;

/**
 * `version` is an `int` for a reason worth stating: the route's check was
 * `typeof version !== "number"`, and measured, `version: 1.5` passed it and
 * answered 200 — the workflow rolled back to v1 while the new snapshot's note
 * read "Rollback to v1.5". The truncation is Prisma's, not SQLite's: binding a
 * non-whole number to an `Int` field sends its integer part, so the composite
 * `findUnique` looked up version 1. Measured on a copy of the database — 9001.5
 * and 9001.4 both returned the row for 9001, while the same values through
 * `$queryRawUnsafe` returned nothing, which is what identifies the layer. A
 * whole-number rule turns that into a 400 that says what the field wants.
 */
export const WORKFLOW_ROLLBACK = {
  version: { kind: "int", required: true, min: 1 },
} satisfies Schema;

/**
 * `name` is the template word `{{vars.name}}`, so it also has to survive
 * `resolve-workspace`'s identifier pattern; the route keeps that check and this
 * says the shape. Before: a 5000-character name was stored, and `name: ["ok"]`
 * was a 500.
 *
 * `value` has to be non-empty, which is a change: `value: ""` used to store an
 * empty string. A caller who wants a variable to hold nothing deletes it — the
 * route answers `DELETE ?name=…` — because `{{vars.x}}` resolving to "" and
 * resolving to a missing variable are the same text downstream and only one of
 * them is the caller's decision.
 */
export const VARIABLE_PUT = {
  name: { kind: "text", required: true, max: 100 },
  value: { kind: "text", required: true, max: 10000 },
} satisfies Schema;

/**
 * `provider` names a connector — "http", "openai" — and is free-form in the schema,
 * so it is text rather than an enum: a new connector must not need a code change at
 * the boundary. `value` is the secret itself; it is sealed by `sealCredential` and
 * never returned, so this table is the only place it is ever described. The cap is
 * generous on purpose — a service-account JSON blob is a legitimate value and is
 * several kilobytes.
 */
export const CREDENTIAL_PUT = {
  name: { kind: "text", required: true, max: 100 },
  provider: { kind: "text", required: true, max: 60 },
  value: { kind: "text", required: true, max: 32000 },
} satisfies Schema;

/**
 * `input` is the run's payload, and a workflow's nodes read it as an object or an
 * array. Measured, `42`, `"prose"` and `[1,2]` were all accepted and stored, so a
 * template like `{{input.name}}` resolved to nothing rather than saying the caller
 * sent a number. The inbound webhook route keeps taking any payload including a
 * bare string — that is the caller's data, not a run this API was asked to start.
 */
export const EXECUTION_CREATE = {
  workflowId: { kind: "text", required: true, max: 32 },
  input: { kind: "json" },
} satisfies Schema;

/**
 * The playground. Nothing here is a column, which is why it still needs a table:
 * `text: 42` was refused as "Paste some text to work on." — a wrong type answered as
 * a missing one — and `text: "   "` the same way. Measured over HTTP
 * (`n5-af-before.txt`); what the two other rows were *doing* is read from
 * `llm-node.ts`, because this server had no `LLM_API_KEY` and so answered
 * `{configured: false}` before the node ran: `task: 42` reaches `readTask`, whose
 * fallback is summarize, and `labels: "a,b"` reaches `readStringList`, which reads
 * a non-array as no labels at all. Both are now 400s naming the field
 * (`n5-af-after.txt`), which is the point either way.
 */
export const LLM_TRY_NODE = {
  text: { kind: "text", required: true, max: 200000 },
  task: { kind: "enum", values: LLM_TASKS },
  labels: { kind: "strings", max: 50 },
  fields: { kind: "strings", max: 50 },
  model: { kind: "text", max: 120 },
} satisfies Schema;
