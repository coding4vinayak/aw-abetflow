# AbetFlow

![CI](https://github.com/coding4vinayak/aw-abetflow/actions/workflows/ci.yml/badge.svg)


Workflow automation your ops team can ship on a Tuesday. Define a trigger,
chain nodes, watch every step land in the execution log.

Rebuilt from the `aw-flowforge` prototype with the weak spots removed: no
`vm2` (no arbitrary code execution — transforms are JSONata expressions),
SQLite by default with a verified Postgres path, and every behavior covered
by a check you can run.

## Quick start

```bash
npm install
npx prisma migrate dev      # creates the SQLite database
npm run db:seed             # demo workspace + deal-triage workflow + sample run
npm run dev                 # http://localhost:3500
```

`npm run test` runs 145 unit tests (`# tests 145`, `# pass 145`, `# fail 0`, measured
2026-10-06) over the executor, the cron parser, the queue module, the route handlers and
the auth and validation guards, with no server and no database.

## Nodes

| Type | What it does |
| --- | --- |
| `trigger` | Entry point. Passes the input through. |
| `http_request` | `GET/POST/...` a URL. JSON bodies are parsed, so `'db is ' & input.body.db` works. 10s timeout, 8KB cap. |
| `transform` | JSONata expression over `{input, vars}`. Both `vars.x` and `$vars.x` read. |
| `condition` | JSONata truth test → `nextTrue` / `nextFalse`. Input passes through untouched. |
| `set_variable` | Stores `{{input.*}}`/`{{vars.*}}` into `vars.name`. On object flows the field joins the object so downstream `input.*` keeps working. |
| `delay` | Sleeps up to 300s. |
| `llm` | `classify` \| `extract` \| `summarize` \| `transform` via an OpenAI-compatible model. Fails loudly without a key — route failures through `onError`/`continueOnFail`. |
| `loop` | Evaluates `items` to an array, runs the `do` node(s) per item (max 100), collects outputs. |
| `merge` | Emits the collected loop outputs as one array. |
| `note` | No-op log line. Useful as a branch terminator. |

Every node accepts `continueOnFail: true` (record the failure, keep walking to
`onError` or `next`) and every walk stops at a 200-step budget, so a cycle
fails loudly naming its node instead of hanging a worker.

Templates use `{{input.a.b}}` / `{{vars.name}}`. Unknown paths render empty —
a silent empty string beats a leaked placeholder reaching a customer.

## Triggers

- **manual** — `POST /api/executions { workflowId, input }`.
- **webhook** — `POST /api/webhooks/{path}`, authenticated by the trigger's
  `secret` via `x-api-key` header or `?key=` (`?sync=true` waits for the
  result). The secret is required: a webhook trigger with none is an open
  endpoint that runs the tenant's workflow, so create/update rejects it unless
  the trigger says `public: true`. `GET` on the same path works the same way.
- **cron** — five-field expression. A Worker sweeps every minute on the
  `abetflow-scheduled` queue: it reads `{ status: "ACTIVE", nextRunAt <= now }` and, per
  row, advances `nextRunAt` in the *same* transaction that creates the Execution before
  enqueueing, so a slow run never double-fires. `nextRunAtFor` (`src/lib/cron.ts`) is the
  one computation behind every value of that column — the four write paths use it and so
  does the sweep's own advance, which is why the guard test needs no exceptions. Two
  invariants follow: SQL `{ lte: now }` never matches NULL, so a writer that left the
  column NULL would unschedule an ACTIVE cron row silently and forever; and a DRAFT row
  stores NULL rather than a future date, because `nextRunAt != null` is what "this will
  run" means. Measured over HTTP against the running app on a copy of the dev database:
  an ACTIVE `* * * * *` workflow created just before 07:34 fired on the 07:34 and 07:35
  boundaries — 2 cron Executions, the graph writing its step row — and its `nextRunAt`
  then read `07:36:00Z`, while the DRAFT twin created in the same probe stayed NULL and
  got nothing. Before #55 the sweep existed as an exported function with no call site, so
  none of this happened.

## Accounts (browser)

Machine callers authenticate with an API key above. Humans sign in:

```
GET  /login                # sign in
POST /signup               # create a workspace and an account
GET  /dashboard            # your own workspace (needs the session cookie)
GET  /members              # seats, invites, roles (owner/admin)
GET  /invite/{token}       # accept a one-time invitation link
```

A signup mints a `User` and a `Workspace` in one transaction and drops the
browser straight into it. Passwords are scrypt with the work factor recorded
beside the digest, so the cost can be raised later without invalidating anyone.
The session cookie holds a random 32-byte token and the database keeps only its
sha256; it is httpOnly, sameSite=lax, and `secure` outside development.

`?workspace=demo` stays public on purpose — it is what the landing pages link to
and what a prospect evaluates. Every other workspace requires the session that
owns it: naming someone else's slug is refused rather than served, and an
anonymous visitor is pointed at the login form instead of the data.

Sign-in is rate-limited per address (10 failures, 15-minute lock) and signup to
5 workspaces, so one client cannot grind through a list of accounts. Failed
logins take the same time whether or not the address exists.

A brand-new account has no API key, so the dashboard offers to mint one and
shows it exactly once — only a hash is stored. The prompt is scoped to
signed-in workspaces: a stranger on the public demo is never nagged to sign up.
It is a server action rather than a `POST /api/keys` call so the plaintext goes
straight into the page and never into a URL, a referrer, or an access log.

### Password reset and email verification

```
GET  /forgot-password             # request a reset link
GET  /reset-password?token=       # choose a new password
GET  /verify-email?token=         # confirm the address
```

Both links are **POST-only**: the page reads the token, the button redeems it. A
GET that changes state is triggered by link previewers, chat clients and
corporate scanners, so a single Slack unfurl would spend the token before the
person read it.

Tokens are stored hashed (sha256), single-use, and expired — reset in 1 hour,
verification in 24. Issuing a new one deletes the previous, so a link forwarded
last year stops working the moment a fresh one is requested. Reset requests are
rate limited to 3 per address per hour.

Redeeming a reset also **destroys every session on that account**. A password
change that leaves old cookies working evicts nobody, which defeats the entire
point of resetting. The same gap existed in abetConnect and is fixed there too.

The request endpoint answers identically whether or not the address has an
account — a "no such user" there is a customer enumeration oracle.

### Email delivery is honest about itself

`send()` returns which transport actually ran, and the UI says so:

| State | Behaviour |
|---|---|
| `RESEND_API_KEY` or `EMAIL_WEBHOOK_URL` set | Message is delivered; verification is enforced at sign-in |
| Neither set | Link is written to the server log, and the page says plainly that nothing was sent |

An account created with no provider configured starts **pre-verified**, because
enforcing a click on a message that can never arrive would lock the account out
of its own product. With a provider set, sign-up starts unverified, sends the
link, and `signIn` refuses until it is confirmed. A provider outage at
verification is swallowed deliberately — the account exists, and the link can be
re-sent from the dashboard — because failing signup after the row is written
would leave an account nobody can reach.

No new dependency: the HTTP sender is `fetch` only, and `setEmailSender()`
accepts SMTP, SES or anything else without touching a route.

### Teams

Anyone with an account belongs to one or more workspaces, each with a role:
`OWNER` (created at signup, never issuable by invite), `ADMIN`, or `MEMBER`.
Owners and admins invite by email from `/members`; the link is single-use,
expires in 7 days, names one address, and is shown once because only its hash
is stored. Re-inviting rotates the old link dead. Accepting moves the browser
into the new workspace. Removing a seat destroys that person's sessions in it
immediately — revoking access and leaving the cookie working would be the same
mistake twice. The dashboard bar lists every workspace the account can open.

An admin can invite members but cannot mint another admin; only an owner can.
A member cannot invite, see keys, or change seats. Ownership never transfers
through the invite path — that is a decision, not a missing feature.

Set `SESSION_COOKIE` if several of these products ever share one hostname, so
their cookies stay apart. It defaults to `abetworks_session`, which is safe as
long as each product has its own database — a token from one is simply not found
in another's session table.

This file's provenance: the auth surface shipped as one source, byte-copied across six
apps during the Abetworks campaign. The vendoring scripts and drift gate that enforced
identity are retired. This app's copy is its own and can evolve independently.
Full context: `abetworks-history` §8.20 and §8.44.

## Authentication

Every management route is workspace-scoped and requires an API key. A browser session is the other half — see [Accounts](#accounts-browser). `workspaceId`
in the query or body is **checked against the key** — a mismatch is a `403`,
not a silent cross-tenant read.

```bash
# Mint a key for the demo workspace (side-effect free, mints a fresh key)
npm run seed:key            # prints the plaintext once

# Call anything
curl http://127.0.0.1:3500/api/workflows?workspaceId=cmuatgyr80000niz7fcz5oqcr \
  -H "Authorization: Bearer <paste-key>"
```

Keys are prefixed `af_live_` so a leaked one is self-identifying. Only a sha256
hash is stored; the plaintext is shown once and cannot be recovered.

| Response | Meaning |
|---|---|
| `401` | No key, unknown key, or a revoked key |
| `403` | Valid key, but that `workspaceId` is not its workspace |

Deliberately **not** key-gated: `GET /api/health`, the provider inbound
webhook receivers (Twilio/WhatsApp/LinkedIn — they authenticate by their own
protocol), and `POST /api/billing/webhook` (Stripe signature).

## API

All routes below need the key from [Authentication](#authentication) —
the snippets omit the header for width.

```
GET    /api/health                         # liveness + DB ping, no key
GET    /api/workflows?workspaceId=         # list
POST   /api/workflows                      # create (validated: unknown nodes, dangling edges, bad cron)
GET    /api/workflows/{id}                 # detail + recent versions + executions
PATCH  /api/workflows/{id}                 # edit, snapshots a version, prunes past 50
DELETE /api/workflows/{id}
GET    /api/workflows/{id}/versions        # version history
POST   /api/workflows/{id}/versions        # rollback to { version }
GET    /api/executions?workspaceId=        # list, filter status=FAILED for the dead letter
POST   /api/executions                     # manual trigger
GET    /api/executions/{id}                # full step trace
POST   /api/executions/{id}?action=retry   # re-run a failed execution
GET    /api/credentials?workspaceId=       # names only — values never list
POST   /api/credentials                    # seal a value (needs ENCRYPTION_KEY)
GET    /api/variables?workspaceId=         # shared {{vars.*}}
DELETE /api/variables?workspaceId=&name=   # 404 if the name is not in this workspace
DELETE /api/credentials?workspaceId=&name= # 404 likewise
```

**A DELETE for a row that is not there answers 404, never 500.** The `{id}` routes look the
row up first and return `{ error: "Not found" }` before deleting it. The two `?name=` routes
(`variables`, `credentials`) delete by the composite `workspaceId`+`name`, and Prisma's
`delete` throws `P2025` on a key that names no row — which `withAuth` does not recognise and
so rethrows as a 500. They use `deleteMany` instead, whose `where` is the general filter and
which reports a `count` rather than throwing: `count === 0` is the same 404, and because the
filter carries the caller's authenticated `workspaceId`, deleting a name that exists only in
another workspace counts 0 and leaves that row untouched (measured offline on a copy of
`dev.db`). `tests/unit/delete-missing-row.test.ts` pins both handlers on that shape.

## AI nodes (optional)

An `llm` node needs `{ task, prompt }`, plus `labels[]` (2+, closed set) for
`classify` or `fields[]` for `extract`. The prompt is template-rendered with
`{input, vars}`; the input sent to the provider is truncated to `maxChars`
(default 8000). Unlike every other node, `llm` never guesses: no key,
provider outage, or unusable answer **throws**, and the run's existing
`onError`/`continueOnFail` wiring decides what happens. A `classify` label
outside the author's list is rejected, not passed downstream. Misconfigured
nodes are refused at save time (422), not on the 400th run.

Setup: `LLM_API_KEY`, optional `LLM_BASE_URL`, `LLM_MODEL`,
`LLM_TIMEOUT_MS`. Node plus validation unit-tested offline in
`tests/unit/llm-node.test.ts` (13 tests, stub provider, no network).

## Building workflows in the browser

`/workflows` lists what exists and creates the next one. Opening one shows the
editor: a structured list of nodes with a type picker, per-type fields, and
wiring (Next, and both branches on a condition). It is deliberately a form
editor rather than a drag-and-drop canvas — what is saved is exactly what the
API's `parseDefinition` accepts, so the UI cannot build what cannot run. Save
failures surface the validator's message inline.

Two rules the UI follows because the engine does:

- A workflow is born `DRAFT` and can only run `ACTIVE`. Activation re-validates
  the *saved* definition, so an old graph that no longer validates cannot be
  switched on. Pausing stops new runs; it does not erase history.
- **Try it** runs the saved workflow now, synchronously, and links to the trace
  page, which prints every step's output as JSON. That is how a broken workflow
  actually gets fixed.

`GET /ai-playground` does the smaller job for the `llm` node specifically:
paste text, pick a task, and see what the node would emit before building a
workflow around it.

## Credentials

Values are sealed with AES-256-GCM (`ENCRYPTION_KEY`, 32 bytes hex) and only
ciphertext is stored. Listing returns names, never values. A row that no
longer decrypts is skipped at resolve time; the node that needed it fails
with its own name on the error.

## Putting it somewhere

```bash
npm ci
npm run db:deploy
npm run build
npm start                 # or: node .next/standalone/server.js
```

Point the load balancer at `GET /api/health` (200 = serving, 503 = DB down; its `queues`
object is `Object.entries(queues)`, so it names `runs` and `scheduled` — measured).
For Postgres, follow the same three steps as abetConnect: provider switch,
fresh migration history, regenerate. Queue workers (`src/lib/queue.ts`, BullMQ +
Redis) drain two queues. `abetflow-runs` holds the executions API callers
enqueue. `abetflow-scheduled` holds the cron sweep, which is what makes a cron trigger
fire at all: `startWorkers()` registers one bullmq job scheduler on it — key
`abetflow-scheduled-sweep`, pattern `* * * * *` — and the sweep's own handler runs
`runDueCronWorkflows()`. The key is fixed rather than generated because a fixed key is what
makes the registration idempotent across processes: three registrations from two processes
left `getJobSchedulersCount()` at 1 with `iterationCount` and the single `:repeat` member
untouched (§8.29.2, re-measured here). Registration is the last statement of
`startWorkers()`, after the Worker that drains it, and **bounded** by a raced timeout (#62).
Two shapes, measured and named apart: a pattern cron-parser cannot resolve *rejects* in 22ms
(`Error: Invalid characters, got value: non`) — the `failed` branch; against a Redis that
answers nothing, `registerScheduledSweep()` never settles (bullmq awaits the shared connection's
readiness while ioredis reconnects forever at `maxRetriesPerRequest: null`, and
`enableOfflineQueue: false` fails only commands that are actually issued), so the old bare
`try { await … } catch` left `startWorkers()` pending past 25s (re-measured past 12s) — the
catch never ran, "workers started" never printed, and the boot hung rather than failing. That
was `Filed as #62`; it is now `awaitWithRegistrationTimeout`, racing the registration against
`SWEEP_REGISTER_TIMEOUT_MS` (5s, ~25× the healthy ~0.2s) and returning
`registered` / `failed` / `timed-out`, logging the non-registered outcomes distinctly. The
rejection handler sits on the registration promise itself (two-arg `then`, not a `.catch` on
the race) so a connection that errors *after* a timeout is consumed there and cannot surface as
an unhandledRejection — the discipline `shutdownWorkers` applies to an abandoned
`waitUntilReady()`. Measured after: dead-Redis `startWorkers()` resolves at ~5.3s and the boot
finishes; live resolves in 0.3–0.7s and the scheduler lands. `GET /api/health` on the dead URL
already answered 200 with `{"db":"up","queues":{"error":"redis unreachable"}}`, so what changed
is the boot completing. Guarded in `tests/unit/scheduler.test.ts` (structural: startWorkers must
bound it, not await bare, and branch the outcomes; the timeout constant and helper exist and
attach the rejection at the promise). The identical block is ported to leadworks (`queue.test.ts`
also drives the helper offline). Retention is a family-wide convention (#64, port of the
leadgenius #61 rule): both queues pass `defaultJobOptions: { removeOnComplete: true,
removeOnFail: 100 }` at construction, so a completed job is dropped — `GET /api/health`
here reads only `waiting`/`active`/`failed` (read from `src/app/api/health/route.ts`) and the
`Execution` table is the durable record — while a failed job is kept, capped at 100, because
its hash is the only surviving record of a failure. It is a *default*: the sweep's own
template still names `removeOnComplete: true`, and the sweep is the one queue that mints work
from the calendar rather than from a caller — 1,440 empty jobs a day whose result the sweep
has already written to the database (measured: `bull:abetflow-scheduled:completed` zcard 0
while its `:events` stream carried 3 completed events); its failures are now bounded to 100
by the construction default rather than kept forever. Both names carry the product because a BullMQ queue
name
*is* its Redis key prefix: while this and abetagent's were both
`runs`, abetagent's worker took abetflow's jobs. The separator is a hyphen because
bullmq rejects a `:` in a queue name outright. The API serves `sync=true`
executions inline with no Redis at all. The Queue is built on first touch rather than
at import — constructing one connects to Redis even on a `lazyConnect` client, so an
import wrote `bull:abetflow-runs:meta` into db 0 and left the test runner unable to
exit. Every site is handed the module's one shared `new IORedis(...)` client as the
shorthand `{ connection }`, never a URL string: bullmq does not parse a string, it copies
the string's characters into options and finds no `url`, so the client lands on
`127.0.0.1:6379` db 0 and the constructor writes `bull:<name>:meta` there.
`src/lib/shutdown.ts` drains it: Next 16.2.12 exposes no shutdown hook
(`InstrumentationModule` is `register` and `onRequestError`, read from its own
`.d.ts`), so `instrumentation.ts` installs SIGTERM/SIGINT handlers in production and
waits for the workers' in-flight Redis setup to land before closing anything.
