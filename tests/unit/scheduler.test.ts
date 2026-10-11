// #55 — abetflow's cron workflows could not fire, and these assertions are the shape that
// keeps them firing.
//
// The before-state, read from source and from stored rows: `runDueCronWorkflows()` was
// exported from `src/lib/scheduler.ts` and had no call site anywhere in `src/`; the only
// queue was `abetflow-runs`; there was no `setInterval`, no `upsertJobScheduler` and no
// cron route. So `parseTrigger` validated `{kind:"cron"}`, `POST /api/workflows` computed a
// `nextRunAt`, and nothing ever read the pair again — while the copy of `dev.db` taken for
// this round held 5 ACTIVE workflows, zero cron triggers, `nextRunAt` NULL on every row,
// and Execution sources of manual 47 / webhook 1 / cron 0. A setting with no effect.
//
// Two failure shapes, and the second is the one a fix can reintroduce:
//   (1) a sweep with no caller — what #55 was;
//   (2) a sweep whose due-query never matches, because a writer of `trigger`/`status`
//       left `nextRunAt` NULL. `{ lte: now }` does not match NULL in SQL, so an ACTIVE
//       cron workflow with a NULL column is invisible to the very query that exists to
//       fire it, and it fails silently — no error, no execution, no log.
// Both are structural, so both are asserted structurally over the whole `src/` tree rather
// than over a list of files this test happens to remember. What is *measured* over HTTP
// (one scheduler across two boots, an Execution with source "cron" appearing inside a
// minute) is in the after-probe behind §8.31, not here.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { nextCronRun, nextRunAtFor } from "../../src/lib/cron";
import { parseTrigger } from "../../src/lib/definition";

/** Comment-free module text: the comments talk about `nextRunAt` and must not count as code. */
function code(absPath: string): string {
  return readFileSync(absPath, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");
}

function sourceTree(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = `${dir}/${entry.name}`;
    if (entry.isDirectory()) sourceTree(abs, into);
    else if (/\.(ts|tsx)$/.test(entry.name)) into.push(abs);
  }
  return into;
}

const SRC = new URL("../../src", import.meta.url).pathname;
const ROOT = new URL("../..", import.meta.url).pathname;
const writers = sourceTree(SRC).filter((file) => /prisma\.workflow\.(create|update)\(/.test(code(file)));

/** Text inside the parentheses that open at `open`. Balanced; a paren inside a string
 *  literal would desynchronise it, and none of this app's write payloads has one — the
 *  coverage assertion below is what makes a silent desync visible rather than a pass. */
function balanced(text: string, open: number, pairs: [string, string][]): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (pairs.some(([a]) => text[i] === a)) depth++;
    else if (pairs.some(([, b]) => text[i] === b)) {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return "";
}

/** The `data:` object of a Prisma write, or "" when the call has none. */
function dataOf(callArg: string): string {
  const at = callArg.indexOf("data:");
  if (at < 0) return "";
  const brace = callArg.indexOf("{", at);
  if (brace < 0) return "";
  return balanced(callArg, brace, [["{", "}"]]);
}

const SCHEDULED_QUEUE_MODULE = code(`${SRC}/lib/queue.ts`);
const SCHEDULED_SWEEP_MODULE = code(`${SRC}/lib/queue-sweep.ts`);

describe("the cron sweep has a caller", () => {
  it("runDueCronWorkflows is called from somewhere other than its own definition", () => {
    const callers = sourceTree(SRC).filter((file) => {
      const text = code(file);
      const hits = (text.match(/runDueCronWorkflows\s*\(/g) ?? []).length;
      const definitions = (text.match(/export async function runDueCronWorkflows\s*\(/g) ?? []).length;
      return hits - definitions > 0;
    });
    assert.deepEqual(
      callers.map((file) => file.slice(SRC.length + 1)),
      ["lib/queue.ts"],
      "the sweep's handler is the one call site: more callers means more of one sweep per minute",
    );
  });

  it("the caller is a Worker handler, on this app's own scheduled queue", () => {
    assert.match(
      SCHEDULED_QUEUE_MODULE,
      /new Worker\(SCHEDULED_QUEUE, async \(\) => \{\s*await runDueCronWorkflows\(\);/,
    );
    assert.match(SCHEDULED_QUEUE_MODULE, /export const SCHEDULED_QUEUE = "abetflow-[a-z-]+";/);
    assert.ok(!/export const SCHEDULED_QUEUE = "[^"]*:/.test(SCHEDULED_QUEUE_MODULE), "no colon: bullmq throws");
  });

  it("startWorkers registers the sweep bounded — a Redis that never answers cannot hang the boot", () => {
    const start = /export async function startWorkers\(\) \{([\s\S]*?)\n\}/.exec(SCHEDULED_QUEUE_MODULE);
    assert.ok(start, "startWorkers is defined in this module");
    const body = start[1];
    // #62: the old `try { await registerScheduledSweep(); } catch` could not save the
    // never-answering case — the call doesn't reject, it stays pending past 12s (measured,
    // bullmq awaits connection readiness while ioredis retries forever), so the catch never
    // runs and the boot hangs. Bounding it with a raced timeout is what makes this title true.
    assert.match(body, /await awaitWithRegistrationTimeout\(registerScheduledSweep\(\), SWEEP_REGISTER_TIMEOUT_MS\)/,
      "the registration is raced against a timeout, not awaited bare");
    assert.doesNotMatch(body, /try \{\s*await registerScheduledSweep\(\)/, "the hanging unbounded form is gone");
    assert.match(body, /=== "failed"/, "a rejected registration is named separately");
    assert.match(body, /=== "timed-out"/, "a hung registration is named separately from a rejected one");
    assert.ok(
      body.indexOf("new Worker(SCHEDULED_QUEUE") < body.indexOf("awaitWithRegistrationTimeout"),
      "the worker that drains the sweep exists before the schedule that mints it",
    );
  });

  it("declares the timeout constant and the racing helper that bounds it", () => {
    // §8.55: the helper is vendored through shared/queue/sweep.ts; queue.ts reads it
    // from ./queue-sweep and re-exports so `startWorkers`'s own block can still call
    // awaitWithRegistrationTimeout without importing anything but ./queue-sweep itself.
    assert.match(SCHEDULED_QUEUE_MODULE, /from "\.\/queue-sweep"/,
      "queue.ts reads the helper from ./queue-sweep, not from a local copy");
    assert.match(SCHEDULED_SWEEP_MODULE, /export const SWEEP_REGISTER_TIMEOUT_MS = [\d_]+;/);
    assert.match(SCHEDULED_SWEEP_MODULE, /export async function awaitWithRegistrationTimeout\(/);
    assert.match(SCHEDULED_SWEEP_MODULE, /work\.then\(\(\) => "registered" as const, \(\) => "failed" as const\)/);
  });

  it("registration is an upsert of a fixed, product-named key onto a every-minute pattern", () => {
    assert.match(SCHEDULED_QUEUE_MODULE, /export const SCHEDULED_SWEEP_KEY = "abetflow-scheduled-sweep";/);
    assert.match(SCHEDULED_QUEUE_MODULE, /export const SCHEDULED_SWEEP_PATTERN = "\* \* \* \* \*";/);
    assert.match(
      SCHEDULED_QUEUE_MODULE,
      /queues\.scheduled\.upsertJobScheduler\(\s*SCHEDULED_SWEEP_KEY,\s*\{ pattern: SCHEDULED_SWEEP_PATTERN \},\s*\{ name: SCHEDULED_SWEEP_NAME, data: \{\s*\}, opts: \{ removeOnComplete: true \} \},/,
      "a generated key would leave one scheduler per boot that ever ran this app",
    );
  });

  it("the sweep's own completed jobs do not pile up, while a failed one is kept (bounded)", () => {
    // This queue mints 1,440 jobs a day from the calendar and no caller ever asks for
    // their payloads, so a completed job is a key that answers no question. The sweep's ADD
    // names only `removeOnComplete` — it does not drop failures; a sweep that threw is the
    // only record that it threw. Since #64 the failure cap lives at the Queue construction
    // (the shared JOB_RETENTION), not in this add, so the whole module legitimately contains
    // `removeOnFail` now. The invariant is about the add opts, so it is asserted there —
    // following the guard to the new truth rather than deleting the check.
    const sweepAdd = /\{ name: SCHEDULED_SWEEP_NAME, data: \{\}, opts: (\{[^}]*\}) \}/.exec(SCHEDULED_QUEUE_MODULE)?.[1] ?? "";
    assert.equal(sweepAdd, "{ removeOnComplete: true }", "the sweep add names only removeOnComplete");
    assert.ok(!/removeOnFail/.test(sweepAdd),
      "the sweep add must not drop failures; they are capped by the construction default, not by this add");
  });

  it("the queue is built on touch and closed on shutdown, like the one it sits beside", () => {
    assert.match(SCHEDULED_QUEUE_MODULE, /built\.scheduled \?\?= new Queue\(SCHEDULED_QUEUE, \{ connection, defaultJobOptions: JOB_RETENTION \}\)/);
    assert.match(SCHEDULED_QUEUE_MODULE, /const built: \{ runs\?: Queue; scheduled\?: Queue \} = \{\};/);
    // shutdownWorkers closes `Object.values(built)`, so a queue registered outside `built`
    // would be a leak the drain cannot reach.
    assert.match(SCHEDULED_QUEUE_MODULE, /const closingQueues = Object\.values\(built\);/);
  });

  it("boot reaches it: instrumentation calls startWorkers", () => {
    assert.match(code(`${ROOT}/instrumentation.ts`), /startWorkers\(\)/);
  });
});

describe("the sweep only matches rows a writer scheduled", () => {
  const schedulerModule = code(`${SRC}/lib/scheduler.ts`);

  it("its due query is ACTIVE with a nextRunAt that has passed", () => {
    assert.match(schedulerModule, /where: \{ status: "ACTIVE", nextRunAt: \{ lte: now \} \}/);
  });

  it("one row, one execution, and the advance lands in the same transaction as the execution", () => {
    assert.match(schedulerModule, /await prisma\.\$transaction\(\[/);
    const advance = schedulerModule.indexOf("prisma.workflow.update");
    const create = schedulerModule.indexOf("prisma.execution.create");
    const enqueueAt = schedulerModule.indexOf('await enqueue(queues.runs, "run-execution"');
    assert.ok(advance >= 0 && create > advance, "the Execution is created beside the advance");
    assert.ok(enqueueAt > create, "enqueueing after the rows exist is what makes a retried sweep not double-fire");
    assert.match(schedulerModule, /source: "cron"/);
  });

  it("advances from the sweep's `now`, so a stopped server resumes forward rather than as a burst", () => {
    // Read from source, not from the cron docs: nextCronRun is "strictly after `from`"
    // (`cron.ts:43`), so a workflow three days late gets one run at the next boundary.
    const from = new Date("2026-01-01T10:00:00Z");
    assert.equal(nextCronRun("0 9 * * *", from)?.toISOString(), "2026-01-02T09:00:00.000Z");
    assert.match(schedulerModule, /nextRunAtFor\(trigger, wf\.status, now\)/);
  });
});

describe("nextRunAt is computed once, at every writer", () => {
  it("the scan sees every file that writes a Workflow row", () => {
    assert.deepEqual(
      writers.map((file) => file.slice(SRC.length + 1)).sort(),
      [
        "app/api/workflows/[id]/route.ts",
        "app/api/workflows/[id]/versions/route.ts",
        "app/api/workflows/route.ts",
        "app/workflow-actions.ts",
        "lib/scheduler.ts",
      ],
      "if a writer appears here that this list does not hold, the rules below now cover it — that is the point",
    );
  });

  it("a write of trigger or status computes nextRunAt; a write of nextRunAt goes through nextRunAtFor", () => {
    for (const file of writers) {
      const text = code(file);
      const re = /prisma\.workflow\.(create|update)\(/g;
      let match: RegExpExecArray | null;
      let site = 0;
      while ((match = re.exec(text))) {
        site++;
        const data = dataOf(balanced(text, match.index + match[0].length - 1, [["(", ")"]]));
        // The site is named by file and ordinal, not by line: collapsing block comments
        // changes the line count, and a failure that points at the wrong line is worse
        // than one that points at the right file.
        const at = `${file.slice(SRC.length + 1)} #${site}`;
        assert.ok(data, `${at} has a data object for this test to read`);
        const touchesSchedule = /\btrigger\b/.test(data) || /\bstatus\b/.test(data);
        if (touchesSchedule || /\bnextRunAt\b/.test(data)) {
          assert.match(
            data,
            /nextRunAtFor\(/,
            `${at} writes ${touchesSchedule ? "trigger/status" : "nextRunAt"} without the shared computation, ` +
              "which is how a cron workflow ends up with a NULL nextRunAt the sweep can never match",
          );
        }
      }
    }
  });

  it("the computation itself: only an ACTIVE cron row is scheduled", () => {
    const at = new Date("2026-01-01T10:00:00Z");
    const cron = { kind: "cron", cron: "* * * * *" };
    assert.equal(nextRunAtFor(cron, "ACTIVE", at)?.toISOString(), "2026-01-01T10:01:00.000Z");
    for (const status of ["DRAFT", "PAUSED", "ARCHIVED", "active", undefined, null]) {
      assert.equal(nextRunAtFor(cron, status, at), null, `"${String(status)}" is not ACTIVE`);
    }
    assert.equal(nextRunAtFor({ kind: "manual" }, "ACTIVE", at), null);
    assert.equal(nextRunAtFor({ kind: "webhook", path: "x" }, "ACTIVE", at), null);
    assert.equal(nextRunAtFor({ kind: "cron" }, "ACTIVE", at), null, "a cron trigger with no expression");
    assert.equal(nextRunAtFor({ kind: "cron", cron: "0 0 30 2 *" }, "ACTIVE", at), null, "an impossible schedule");
    for (const junk of [null, undefined, "cron", 42, []]) {
      assert.equal(nextRunAtFor(junk, "ACTIVE", at), null, `${JSON.stringify(junk)} is not a trigger`);
    }
  });

  it("an unparseable cron is refused at the boundary, so the sweep is never handed one", () => {
    assert.equal(parseTrigger({ kind: "cron", cron: "0 0 30 2 *" }).ok, false);
    assert.equal(parseTrigger({ kind: "cron", cron: "not a cron" }).ok, false);
    assert.equal(parseTrigger({ kind: "cron", cron: "0 9 * * *" }).ok, true);
  });
});
