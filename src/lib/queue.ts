import { Queue, Worker, Job } from "bullmq";
import IORedis from "ioredis";

const connection = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  lazyConnect: true,
  // Fail fast when Redis is down: without this, commands buffer forever and
  // every request that enqueues hangs instead of answering 503.
  enableOfflineQueue: false,
});

/** Thrown when a job cannot be enqueued because Redis is unreachable. */
export class QueueUnavailableError extends Error {
  readonly status = 503;
  constructor() {
    super("job queue unavailable \u2014 Redis is unreachable; the work is saved, retry shortly");
  }
}

const CONNECTION_FAILURE = /connection is closed|connection is not open|connect econnrefused|connect etimedout|stream disconnected|loading/i;

/**
 * queues.X.add that throws QueueUnavailableError (instead of hanging or
 * leaking driver errors) when Redis is down. Genuine job errors propagate
 * untouched. API routes translate QueueUnavailableError to 503.
 */
export async function enqueue<T extends object>(
  queue: Queue,
  name: string,
  data: T,
  opts?: Parameters<Queue["add"]>[2],
): Promise<Job> {
  try {
    return await queue.add(name, data, opts);
  } catch (error) {
    if (error instanceof Error && CONNECTION_FAILURE.test(error.message)) throw new QueueUnavailableError();
    throw error;
  }
}

/**
 * The queue's BullMQ *name* is its Redis key prefix (`bull:<name>:…`), so between two
 * apps on one Redis it is the entire separation between their workers. This was
 * `"runs"` — the same name abetagent registers — and the cost is still stored in db 0
 * as of 2026-10-05: 20 jobs under one `bull:runs` id counter, 12 of them this app's
 * `run-execution` and 8 abetagent's `run-agent`, and six of the seven failed jobs are
 * `run-execution` payloads whose failedReason reads `prisma.run.findUnique()` /
 * `where: { id: undefined }`. abetflow's schema has no `model Run` (abetagent's has,
 * schema.prisma:140), so that text can only be abetagent's worker having taken
 * abetflow's job and read a `runId` this app never sends.
 *
 * Named in one place, and used by both the Queue and the Worker, because the two
 * lines must agree: a name that drifts between them enqueues into a queue nothing
 * drains, which fails silently — the same class as the collision above, one layer
 * down. `shared/check-queues.sh` asserts both across the portfolio. The `queues`
 * object key stays `runs`, so `/api/health` and the console's queue-depth view are
 * unchanged: they read the key, not the BullMQ name.
 *
 * The separator is a hyphen, not a colon, because bullmq 5.81.5 rejects a name
 * containing `:` outright (`queue-base.js:35`, `Queue name cannot contain :`). The
 * `abetflow:runs` form that namespace-separators would suggest is not merely
 * discouraged: it throws at construction, so the module cannot load. That was
 * learned from this app's own `Queue` being built against a scratch Redis db, not
 * from the docs — `shared/check-queues.sh` was green on the colon name, which is why
 * the guard now asserts constructibility as well as uniqueness.
 */
export const RUNS_QUEUE = "abetflow-runs";

/**
 * The queue the recurring cron sweep rides on, separate from `abetflow-runs` because the
 * two jobs are not the same work: a `run-execution` is one workflow's execution and is
 * worth running five at a time, while the sweep is a whole-database scan that mints
 * executions and must not overlap itself. It exists at all because `runDueCronWorkflows()`
 * had no call site anywhere in `src/` — see `registerScheduledSweep()`.
 *
 * Named in one place and used by both the Queue and the Worker, prefixed with the product
 * id and hyphen-separated, for the two reasons `RUNS_QUEUE` carries: a BullMQ name is the
 * whole separation between apps sharing this Redis, and bullmq 5.81.5 throws at
 * construction on a name containing a colon. `shared/check-queues.sh` reads this line.
 */
export const SCHEDULED_QUEUE = "abetflow-scheduled";

/**
 * BullMQ's key for the one recurring sweep this app has. Fixed rather than generated,
 * because it is what makes registering the sweep idempotent: `upsertJobScheduler` with the
 * same key updates the existing scheduler instead of adding another, and the schedule lives
 * in Redis, not in the process. A generated key would leave one scheduler per boot that
 * ever ran this app, each firing a full `workflow.findMany` per minute. Measured for this
 * app in the after-probe behind §8.31 (two boots, one scheduler row).
 */
export const SCHEDULED_SWEEP_KEY = "abetflow-scheduled-sweep";

/** The job name the `abetflow-scheduled` worker's handler runs. */
export const SCHEDULED_SWEEP_NAME = "run-cron";

/**
 * Every minute. The sweep is due-based rather than minute-matching — `nextRunAt: { lte:
 * now }` against a column `nextCronRun` keeps minute-aligned — so a coarser pattern would
 * not drop matches the way it would in leadworks, it would just delay each run by up to
 * that cadence. A minute is the finest resolution `nextRunAt` can express
 * (`cron.ts:65-66` zeroes seconds and advances whole minutes), so nothing is gained by
 * polling harder.
 */
export const SCHEDULED_SWEEP_PATTERN = "* * * * *";

/**
 * Register the recurring sweep, so the `abetflow-scheduled` Worker has a producer.
 *
 * Until now it had none, and neither did anything else: `runDueCronWorkflows()` was
 * exported from `scheduler.ts` and referenced nowhere else in `src/` (grep: one hit, its
 * own definition), while db 0 held `bull:abetflow-runs:meta` and no scheduled keyspace at
 * all. So `trigger: { kind: "cron" }` was a field the API accepted, validated and stored,
 * and a workflow could not fire on it at any hour. What the stored rows wanted, read off a
 * copy of `dev.db` before the change: 5 ACTIVE workflows, triggers `manual`/`webhook`,
 * zero cron rows, `nextRunAt` NULL on all five, and Execution sources manual 47 / webhook
 * 1 / cron 0.
 *
 * A scheduler rather than `setInterval` because `register()` runs on every server boot and
 * the sweep must run once per minute for the product, not once per process. That
 * N-boots-fire-one-sweep property is what leadworks measured for its own scheduler
 * (§8.29.2: `getJobSchedulersCount()` stays at 1 across two processes upserting the same
 * key); this app's version is measured on db 13 in the after-probe, and the hazard that
 * makes the call fragile is the same one documented there — bullmq's ESM build cannot load
 * `cron-parser` here, so this only works while the resolution stays on `dist/cjs`.
 */
export async function registerScheduledSweep(): Promise<void> {
  await queues.scheduled.upsertJobScheduler(
    SCHEDULED_SWEEP_KEY,
    { pattern: SCHEDULED_SWEEP_PATTERN },
    // removeOnComplete, because this is the one queue in the app that mints work from the
    // calendar rather than from a caller: 1,440 jobs a day whose payload is empty and whose
    // result the sweep has already written to the database. A retained completed job here
    // is a Redis key that answers no question. Failures are kept (the job's own add names
    // no removeOnFail), bounded to the most recent 100 by the construction default above —
    // a sweep that threw is the only record that it threw, and a storm cannot grow forever.
    { name: SCHEDULED_SWEEP_NAME, data: {}, opts: { removeOnComplete: true } },
  );
}

/** The bounded-sweep registration helper is vendored through
 *  shared/queue/sweep.ts (§8.55) — see ./queue-sweep for the three declarations and
 *  the measurement that set 5s. Re-exported so `startWorkers()` and callers importing
 *  from ./queue keep their existing surface while the shape lives in one file. */
export {
  awaitWithRegistrationTimeout,
  SWEEP_REGISTER_TIMEOUT_MS,
  type RegistrationOutcome,
} from "./queue-sweep";
import { awaitWithRegistrationTimeout, SWEEP_REGISTER_TIMEOUT_MS } from "./queue-sweep";

/**
 * Built on first touch, not at import, because `new Queue()` is not inert. Handed a
 * lazy-connect client it opens that connection on the next tick and writes
 * `bull:<name>:meta` before anything calls `add()` — measured on a scratch db: a
 * script that only constructed a queue was still alive 30s later, client at
 * `status=connecting`, one key in the keyspace it pointed at. So importing this
 * module used to mean connecting to Redis, and in dev `REDIS_URL` defaults to db 0:
 * an offline unit test of the queue name was possible only by writing into the live
 * keyspace, and `tsx --test` never exited. See §8.26.7 and §8.27.
 *
 * The name stays exactly where `shared/check-queues.sh` reads it — as the first
 * argument of the Queue construction — so memoising does not move the asserted fact.
 */
const built: { runs?: Queue; scheduled?: Queue } = {};

/** Every Worker this process started, so shutdownWorkers() can actually close them. */
const workers: Worker[] = [];

/**
 * Retention applied to every job both queues create, as `defaultJobOptions` on each
 * construction (not in `enqueue`) so the paths that add directly are bounded too. Port of
 * the leadgenius convention (#61, §8.33) — #64.
 *
 * `removeOnComplete: true`: `GET /api/health` reads `getJobCounts("waiting", "active",
 * "failed")` and never `completed` (read from `src/app/api/health/route.ts`), so a retained
 * completed job is a Redis key with no reader — the durable record of an execution is the
 * `Execution` table, not the queue.
 * `removeOnFail: 100`: a failed job's hash is the only place its payload and stack survive,
 * so failures are kept, bounded to survive a storm without growing forever; it makes the
 * `failed` number "recent failures" rather than cumulative. This is the bounded form of the
 * asymmetry the sweep's own add already reached for below (drop completed, keep failures).
 *
 * It is a default: bullmq merges `{ ...defaultJobOptions, ...opts }` per add, so the
 * sweep's per-add `removeOnComplete: true` (and any other add naming its own retention)
 * still wins.
 */
import { JOB_RETENTION } from "./queue-retention";

export const queues = {
  get runs(): Queue {
    return (built.runs ??= new Queue(RUNS_QUEUE, { connection, defaultJobOptions: JOB_RETENTION }));
  },
  get scheduled(): Queue {
    return (built.scheduled ??= new Queue(SCHEDULED_QUEUE, { connection, defaultJobOptions: JOB_RETENTION }));
  },
};

export async function startWorkers() {
  const { runExecution } = await import("./runner");
  const { runDueCronWorkflows } = await import("./scheduler");

  const worker = new Worker(RUNS_QUEUE, async (job: Job) => {
    const { executionId } = job.data as { executionId: string };
    await runExecution(executionId);
  }, { connection, concurrency: 5 });

  workers.push(worker);

  // Concurrency 1, deliberately: the handler is a whole-table `findMany` that mints an
  // Execution per due workflow, and two of those running at once would each see the same
  // due row before either advanced it. `scheduler.ts:24-25` advances `nextRunAt` inside the
  // same transaction that creates the Execution, so one worker is enough to make that
  // ordering hold; overlapping workers are what would break it.
  workers.push(new Worker(SCHEDULED_QUEUE, async () => {
    await runDueCronWorkflows();
  }, { connection, concurrency: 1 }));

  // Last, after the Worker that has to drain it exists: registering first would mint a job
  // into a queue nothing was listening to yet, which is not lost work — bullmq keeps it in
  // `delayed`/`wait` — but it puts the boot's first sweep ahead of the handler that runs it.
  //
  // The catch is for the shape that *rejects*, and both shapes were measured here rather
  // than carried over from leadworks' identical block (same bullmq 5.81.5, same three
  // ioredis options): a pattern cron-parser cannot resolve rejects on the spot — 22ms,
  // `Error: Invalid characters, got value: non` — and without the catch that would be the
  // boot's headline error about Workers that started fine, which is what leadworks' round
  // wrote this guard for.
  //
  // What bounds the other shape is now here, not filed. Against a Redis that answers
  // nothing (`REDIS_URL` on a scratch port, asserted ECONNREFUSED), `registerScheduledSweep()`
  // never settled — `startWorkers()` was measured still pending past 12s (past 25s when the
  // original note was written) — because bullmq awaits the shared connection's readiness while
  // ioredis reconnects forever at `maxRetriesPerRequest: null`, and no catch ever runs. A bare
  // try/catch could not save that boot; the timeout below does. The registration is raced, its
  // rejection handled at the promise, and one of three outcomes is logged, so the boot always
  // reaches "workers started" — the failure that used to be silent-hanging, not loud (#62).
  // Against a Redis that answers and refuses, the call still rejects on the spot — a pattern
  // cron-parser cannot resolve rejects immediately — and that is the `failed` branch.
  const sweep = await awaitWithRegistrationTimeout(registerScheduledSweep(), SWEEP_REGISTER_TIMEOUT_MS);
  if (sweep === "failed") {
    console.error("[AbetFlow] scheduled sweep not registered — the cron workflows will not fire until a boot succeeds");
  } else if (sweep === "timed-out") {
    console.error(`[AbetFlow] scheduled sweep registration did not complete within ${SWEEP_REGISTER_TIMEOUT_MS}ms (Redis unreachable?) — boot continues; the sweep registers on the next boot that reaches Redis`);
  }

  console.log("AbetFlow workers started");
}

/**
 * Ceiling on how long shutdown waits for in-flight Redis setup to land before tearing
 * the queue down anyway. Two seconds because the only case that waits that long is a
 * Redis that answers nothing, and that one is already measured clean.
 */
const SHUTDOWN_SETTLE_MS = 2_000;

/**
 * Graceful shutdown: settle, then Workers, then Queues, then the shared client.
 *
 * Why the settle comes first, in the order the failures were actually measured.
 *
 * (1) Closing the client while a queue's connect is still in flight is an exit. bullmq
 *     attaches `initializing.catch(err => this.emit('error', err))` to that connect
 *     (`redis-connection.js:87`), and the only suppression for the rejection lives
 *     inside `close()`'s `if (!this.extraOptions.shared)` branch
 *     (`redis-connection.js:429`) — never taken here, because this app hands bullmq a
 *     *shared* client on purpose. So the `error` lands on an EventEmitter with no
 *     listener, which Node treats as a crash:
 *
 *       Error: Connection is closed.
 *         at StandaloneConnector.js:46
 *       Emitted 'error' event on RedisConnection instance at:
 *         at bullmq/dist/cjs/classes/redis-connection.js:87:45
 *
 *     Measured rc=1 for a queue touched and closed in the same tick, rc=0 for the same
 *     script after letting the connection reach ready.
 * (2) A Worker is not ready when the client is. Its own setup issues commands after the
 *     shared connect lands, so waiting only on `connection` still died mid-drain —
 *     measured rc=1 with `Stream isn't writeable and enableOfflineQueue options is
 *     false` at `select` (`event_handler.js:41`), i.e. a Worker issuing SELECT on a
 *     client that had already been disconnected. Hence readiness is awaited on every
 *     started object, not on the client.
 * (3) `waitUntilReady()` must be caught as it is created. Abandoning one that never
 *     lands (the dead-Redis case) is itself an unhandled rejection — measured, and it
 *     exits 1 like the crash it was meant to prevent. The `.catch` below is what makes
 *     racing it safe.
 *
 * Workers are kept in `workers` precisely so they can be closed at all: the first
 * version of this function closed no Worker, because `startWorkers()` kept them in a
 * local.
 *
 * `disconnect()` rather than `quit()`: quit() sends QUIT and waits for the reply, which
 * is the part that throws on a client that never connected — `Stream isn't writeable
 * and enableOfflineQueue options is false`, because the app sets `enableOfflineQueue:
 * false` deliberately so a down Redis fails fast instead of buffering. disconnect()
 * closes what exists and is a no-op otherwise.
 *
 * Idempotent — `built` and `workers` are emptied as they close, so a second call has
 * nothing left to close and cannot double-disconnect.
 */
export async function shutdownWorkers() {
  const closingWorkers = workers.splice(0);
  const closingQueues = Object.values(built);
  for (const key of Object.keys(built)) delete (built as Record<string, Queue>)[key];

  await Promise.race([
    Promise.all([...closingQueues, ...closingWorkers].map((item) => item.waitUntilReady().catch(() => undefined))),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_SETTLE_MS)),
  ]);

  await Promise.all(closingWorkers.map((worker) => worker.close()));
  await Promise.all(closingQueues.map((queue) => queue.close()));
  connection.disconnect();
}
