/**
 * Pure cron math: no imports, no I/O, no surprises.
 *
 * This lived in scheduler.ts, whose module-level Prisma and BullMQ clients
 * made every importer — including unit tests and workflow validation — pay
 * for a Redis connection it never uses. Parsing "0 9 * * 1" does not need a
 * database.
 */

function parseField(field: string, min: number, max: number): Set<number> | null {
  if (field === "*") return null; // any
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const stepSplit = part.split("/");
    const range = stepSplit[0];
    const step = stepSplit[1] ? parseInt(stepSplit[1], 10) : 1;
    if (!step || step < 1) return new Set(); // never matches
    let lo = min;
    let hi = max;
    if (range && range !== "*") {
      if (range.includes("-")) {
        const [a, b] = range.split("-").map((n) => parseInt(n, 10));
        if (Number.isNaN(a) || Number.isNaN(b)) return new Set();
        lo = a;
        hi = b;
      } else {
        const v = parseInt(range, 10);
        if (Number.isNaN(v)) return new Set();
        lo = v;
        hi = v;
      }
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/**
 * Next occurrence strictly after `from`, minute-aligned. Scans forward up to
 * 366 days so annual schedules resolve; returns null for impossible ones
 * (e.g. Feb 30). No dependency, no surprises.
 */
export function nextCronRun(cron: string, from: Date = new Date()): Date | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const [mi, hr, dom, mon, dow] = parts;
  const minutes = parseField(mi, 0, 59);
  const hours = parseField(hr, 0, 23);
  const days = parseField(dom, 1, 31);
  const months = parseField(mon, 1, 12);
  const weekdays = parseField(dow, 0, 6);
  // null means "any"; an empty set means "never matches".
  if (
    minutes?.size === 0 ||
    hours?.size === 0 ||
    days?.size === 0 ||
    months?.size === 0 ||
    weekdays?.size === 0
  ) {
    return null;
  }
  const hits = (set: Set<number> | null, value: number): boolean => set === null || set.has(value);

  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const jsDow = cursor.getDay();
    const cronDow = jsDow; // 0 = Sunday both worlds
    if (
      hits(minutes, cursor.getMinutes()) &&
      hits(hours, cursor.getHours()) &&
      hits(days, cursor.getDate()) &&
      hits(months, cursor.getMonth() + 1) &&
      hits(weekdays, cronDow)
    ) {
      return new Date(cursor);
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

/**
 * The `Workflow.nextRunAt` a row should carry, computed from the trigger and the status
 * it is *about to* have. `null` means "nothing is scheduled": not a cron trigger, a cron
 * that never matches, or a workflow that is not ACTIVE.
 *
 * The status half is not decoration. The sweep picks up `{ status: "ACTIVE", nextRunAt:
 * { lte: now } }` (`scheduler.ts:16`), so a date stored on a DRAFT row is a schedule that
 * no one is honouring while it is a draft — and when the author finally activates it, the
 * stale date is in the past, so the first thing activation does is fire an out-of-time
 * run instead of the next one. Returning null for a non-ACTIVE row is what makes
 * `nextRunAt != null` mean "this will run", and it is why every activation path has to
 * recompute.
 *
 * Lives here, with `nextCronRun`, for the same reason that function was moved out of
 * `scheduler.ts`: every writer of `trigger` or `status` needs this answer — two API routes,
 * a rollback route and a server action — and none of them should pay for a Prisma client or
 * a Redis connection to compute a date. `tests/unit/scheduler.test.ts` pins that every such
 * writer calls this one function.
 */
export function nextRunAtFor(trigger: unknown, status: unknown, from: Date = new Date()): Date | null {
  if (status !== "ACTIVE") return null;
  if (typeof trigger !== "object" || trigger === null) return null;
  const { kind, cron } = trigger as { kind?: unknown; cron?: unknown };
  if (kind !== "cron" || typeof cron !== "string") return null;
  return nextCronRun(cron, from);
}
