// #50, held in place: importing `src/lib/queue.ts` used to connect to Redis.
//
// `new Queue(name, {connection})` is not inert even when the client is
// `lazyConnect: true` — measured on a scratch db, a script that only constructed a
// queue was still alive 30s later with the client at `status=connecting` and one key
// (`bull:<name>:meta`) in the db it pointed at. In dev `REDIS_URL` defaults to db 0,
// so this file could not exist: importing the module to assert anything about it wrote
// into the live keyspace, and `tsx --test` never exited (§8.26.7 — four variants of
// that import, all rc=124). The fix is that the Queue is built on first touch, and
// what this file pins is the shape that keeps it that way, plus the teardown that
// became testable because of it.
//
// Two kinds of assertion, labelled as such:
//   source  — scanned from the module text, offline, always runs
//   probe   — runs only when QUEUE_PROBE_URL names a Redis db explicitly, refuses to
//             run against db 0, and then checks the db the connection actually
//             landed on. The last part is not decoration: the first version of this
//             file assigned `process.env.REDIS_URL` inside the probe test, which runs
//             after the runtime-touch test has already imported the module — so the
//             shared client had long since been built from the unset default. Measured
//             with `redis-cli MONITOR` on the `QUEUE_PROBE_URL=…/13` run:
//               1791257942.524843 [0 [::1]:59140] "hset" "bull:abetflow-runs:meta" …
//             i.e. the probe that prints "refuses db 0" wrote to db 0, and db 13 stayed
//             at 0 keys. A guard that inspects the URL string instead of the connection
//             is the §8.20 defect again, so the assignment is hoisted above every
//             import and the destination is asserted.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

const queueModule = source("../../src/lib/queue.ts");
const retentionModule = source("../../src/lib/queue-retention.ts");
const instrumentation = source("../../instrumentation.ts");

const probeUrl = process.env.QUEUE_PROBE_URL;
const probeNamesLiveDb = /\/0$/.test(probeUrl ?? "");
// Must happen before anything imports the queue module: `connection` is built from
// REDIS_URL at import time, so assigning it later changes nothing.
if (probeUrl && !probeNamesLiveDb) process.env.REDIS_URL = probeUrl;

// --- name shape ------------------------------------------------------------
describe("the queue name is this product's own, and constructible", () => {
  it("is prefixed with the product id", () => {
    assert.match(queueModule, /export const RUNS_QUEUE = "abetflow-[a-z0-9-]+";/);
  });

  it("contains no colon, because bullmq throws on one at construction", () => {
    const name = /export const RUNS_QUEUE = "([^"]+)"/.exec(queueModule)?.[1];
    assert.ok(name, "the queue name is where this test can read it");
    assert.ok(!name.includes(":"), `bullmq rejects "${name}" outright (queue-base.js:35)`);
  });
});

// --- import must stay inert --------------------------------------------------
describe("importing the queue module does not connect to Redis", () => {
  it("builds the Queue inside a getter, not in the object literal", () => {
    const literal = /export const queues = \{([\s\S]*?)\n\};/.exec(queueModule);
    assert.ok(literal, "queues is declared as an object literal");
    assert.match(literal[1], /get runs\(\): Queue \{/);
    assert.doesNotMatch(literal[1], /^\s*runs: new Queue\(/m);
  });

  it("memoises it, so /api/health polling does not leak one Queue per request", () => {
    assert.match(queueModule, /built\.runs \?\?= new Queue\(RUNS_QUEUE, \{ connection, defaultJobOptions: JOB_RETENTION \}\)/);
  });

  it("is a lazy accessor on the imported object, at runtime", async () => {
    const { queues } = await import("../../src/lib/queue");
    const descriptor = Object.getOwnPropertyDescriptor(queues, "runs");
    assert.equal(typeof descriptor?.get, "function", "queues.runs is an accessor");
    assert.equal(descriptor?.value, undefined, "and nothing was built to import it");
  });
});

// --- both queues bound what they keep (#64, port of the leadgenius #61 convention) ---
// Measured locally, not inherited: `GET /api/health` here reads
// `getJobCounts("waiting", "active", "failed")` (read from src/app/api/health/route.ts) and
// never `completed`, so a completed job's hash is a Redis key with no reader — the durable
// record of an execution is the `Execution` table. The default sits at construction, so it
// bounds every add path; and it is a default, so the sweep's per-add `removeOnComplete:
// true` (asserted in scheduler.test.ts) still wins its own way.
describe("both queues declare retention at construction", () => {
  it("names one shared default that drops completed and caps failures", () => {
    assert.match(queueModule, /import \{ JOB_RETENTION \} from "\.\/queue-retention";/);
    assert.match(retentionModule, /export const JOB_RETENTION[^=]*= \{ removeOnComplete: true, removeOnFail: \d+ \};/);
  });

  it("hands that default to both the runs and the scheduled Queue", () => {
    assert.match(queueModule, /new Queue\(RUNS_QUEUE, \{ connection, defaultJobOptions: JOB_RETENTION \}\)/);
    assert.match(queueModule, /new Queue\(SCHEDULED_QUEUE, \{ connection, defaultJobOptions: JOB_RETENTION \}\)/);
  });

  it("constructs no queue with the bare `{ connection }` that this convention removes", () => {
    assert.doesNotMatch(queueModule, /new Queue\([A-Za-z_]+, \{ connection \}\)/);
  });

  it("keeps recent failures rather than dropping them — the failed hash is the only record", () => {
    const cap = Number(/removeOnFail: (\d+)/.exec(retentionModule)?.[1] ?? "0");
    assert.ok(cap > 0, `failed jobs are kept, capped at ${cap} — not dropped the way completed are`);
  });
});

// --- the drain ---------------------------------------------------------------
describe("shutdownWorkers closes what startWorkers started", () => {
  it("keeps every Worker, so the drain has a reference to close", () => {
    assert.match(queueModule, /const workers: Worker\[\] = \[\];/);
    assert.match(queueModule, /workers\.push\(worker\);/);
  });

  it("lets in-flight Redis setup land before closing anything", () => {
    const drain = /export async function shutdownWorkers\(\) \{([\s\S]*?)\n\}/.exec(queueModule);
    assert.ok(drain, "shutdownWorkers is defined in this module");
    const body = drain[1];
    assert.ok(
      body.indexOf("waitUntilReady") < body.indexOf(".close()"),
      "waitUntilReady must come first: closing a Queue mid-connect is the crash at redis-connection.js:87",
    );
  });

  it("disconnects rather than quitting, so a never-connected client does not throw", () => {
    assert.match(queueModule, /connection\.disconnect\(\);/);
    assert.doesNotMatch(queueModule, /connection\.quit\(\)/);
  });
});

// --- who calls it ------------------------------------------------------------
describe("the drain is wired to something", () => {
  it("installs the signal handlers from instrumentation, in production only", () => {
    assert.match(
      instrumentation,
      /if \(process\.env\.NODE_ENV === "production"\) \{[\s\S]*installShutdownHandlers\(\)/,
    );
  });

  it("binds both SIGTERM and SIGINT", () => {
    const shutdown = source("../../src/lib/shutdown.ts");
    assert.match(shutdown, /\["SIGTERM", "SIGINT"\] as const/);
  });
});

// --- probe: only against an explicitly named, non-zero db --------------------
if (probeUrl) {
  const expectedDb = Number(/\/(\d+)$/.exec(probeUrl)?.[1] ?? 0);
  describe("probe: building and draining the queue on a scratch db", () => {
    // A skipped assertion is invisible, so a probe pointed at the live keyspace is a
    // failure first and a skip second — otherwise the run just looks one test shorter.
    it("refuses db 0, which is where dev state lives", () => {
      assert.ok(!probeNamesLiveDb, `QUEUE_PROBE_URL=${probeUrl} names the live db; name a scratch one`);
    });

    it("returns the same Queue on repeated touch, and shuts down without throwing", { skip: probeNamesLiveDb ? "refusing db 0" : false }, async () => {
      const mod = await import("../../src/lib/queue");
      const first = mod.queues.runs;
      assert.equal(mod.queues.runs, first);

      // The connection's own view of where it went, not the string we handed it.
      const client = await first.waitUntilReady();
      assert.equal((client as unknown as { options?: { db?: number } }).options?.db, expectedDb,
        "the probe must land on the db it was given, not on the import-time default");

      await mod.shutdownWorkers();
      assert.notEqual(mod.queues.runs, first, "a second build after shutdown is a fresh Queue");
    });
  });
}
