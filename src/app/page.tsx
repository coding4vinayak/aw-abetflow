import type { Metadata } from "next";
import Link from "next/link";
import { SiteNav, SiteFooter } from "@/components/site";

export const metadata: Metadata = {
  title: "AbetFlow — Automation your ops team can ship on a Tuesday.",
  description: "Triggers, nine node types, JSONata transforms, and an execution log for every step. No code execution, no hanging workers, no mystery failures.",
};

export default function Home() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <SiteNav />
      <main>
        <section className="mx-auto max-w-4xl px-6 pb-16 pt-20 text-center">
          <p className="inline-block rounded-full bg-blue-50 text-blue-700 px-3 py-1 text-xs font-semibold uppercase tracking-wide">
            v1.2 · Now generally available
          </p>
          <h1 className="mt-6 text-5xl font-bold tracking-tight">AbetFlow</h1>
          <p className="mx-auto mt-4 max-w-2xl text-xl text-gray-600">Automation your ops team can ship on a Tuesday.</p>
          <p className="mx-auto mt-3 max-w-2xl text-gray-600">Triggers, nine node types, JSONata transforms, and an execution log for every step. No code execution, no hanging workers, no mystery failures.</p>
          <div className="mt-8 flex justify-center gap-4">
            <a href="/dashboard?workspace=demo" className="rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700 transition">
              Open live demo
            </a>
            <Link href="/pricing" className="rounded-lg border border-gray-300 hover:bg-gray-50 px-6 py-3 font-semibold transition">
              Pricing · $0 included with the Abetworks suite
            </Link>
          </div>
        </section>
        <section id="features" className="mx-auto max-w-6xl px-6 py-12">
          <h2 className="text-center text-2xl font-bold">Why teams pick AbetFlow</h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">Nine node types, zero surprises</h3>
            <p className="mt-2 text-sm text-gray-600">Trigger, HTTP, transform, condition, variables, delay, loop, merge, note — each doing exactly one thing.</p>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">JSONata, not eval</h3>
            <p className="mt-2 text-sm text-gray-600">Transforms and conditions are expressions over input and vars. No arbitrary code execution, ever.</p>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">Failures that keep walking</h3>
            <p className="mt-2 text-sm text-gray-600">continueOnFail records the failure and walks on to onError or next — your Tuesday-night job survives one bad API.</p>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">Cycles that confess</h3>
            <p className="mt-2 text-sm text-gray-600">A 200-step budget stops loops and names the node it stopped at. Nothing hangs a worker silently.</p>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">Cron that respects calendars</h3>
            <p className="mt-2 text-sm text-gray-600">Schedules down to the minute, with impossible dates rejected instead of scheduled.</p>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">Credentials in a vault</h3>
            <p className="mt-2 text-sm text-gray-600">Secrets live outside workflow definitions, referenced by name — never pasted into a node.</p>
          </div>
          </div>
        </section>
        <section className="border-y border-gray-200 bg-gray-50">
          <div className="mx-auto max-w-4xl space-y-6 px-6 py-12">
            <h2 className="text-2xl font-bold">Live in three steps</h2>
          <div className="flex gap-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">1</span>
            <div><p className="font-bold text-gray-900">Pick the deal-triage flow</p><p className="mt-1 text-sm text-gray-600">The demo workspace ships a real workflow with a sample run. Load it into your own workspace in one click, or start blank.</p></div>
          </div>
          <div className="flex gap-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">2</span>
            <div><p className="font-bold text-gray-900">Chain your nodes</p><p className="mt-1 text-sm text-gray-600">HTTP calls, JSONata transforms, conditions, loops — watch each step land in the log.</p></div>
          </div>
          <div className="flex gap-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">3</span>
            <div><p className="font-bold text-gray-900">Schedule it and forget it</p><p className="mt-1 text-sm text-gray-600">Cron triggers and versioned definitions mean v3 can run while you draft v4.</p></div>
          </div>
          </div>
        </section>
        <section className="mx-auto max-w-4xl px-6 py-12">
          <h2 className="text-2xl font-bold">Questions, answered</h2>
          <div className="mt-6 space-y-4">
          <div><p className="font-semibold text-gray-900">Is there a trial?</p><p className="mt-1 text-gray-600">There is better than a trial: it is included. Open the live demo and run the deal-triage flow now.</p></div>
          <div><p className="font-semibold text-gray-900">What happens when a node fails?</p><p className="mt-1 text-gray-600">Your choice per node: fail loudly with the error attached, or continueOnFail and keep walking.</p></div>
          <div><p className="font-semibold text-gray-900">Can workflows loop forever?</p><p className="mt-1 text-gray-600">No — the 200-step budget stops cycles and tells you exactly where.</p></div>
          <div><p className="font-semibold text-gray-900">Where do secrets live?</p><p className="mt-1 text-gray-600">In the credentials vault, referenced by name. Definitions contain no secrets.</p></div>
          </div>
        </section>
        <section className="mx-auto max-w-4xl px-6 pb-16 text-center">
          <h2 className="text-2xl font-bold">Try the live demo — no card, no call.</h2>
          <div className="mt-6 flex justify-center gap-4">
            <a href="/dashboard?workspace=demo" className="rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700 transition">
              Open live demo
            </a>
            <Link href="/pricing" className="rounded-lg border border-gray-300 hover:bg-gray-50 px-6 py-3 font-semibold transition">
              See pricing
            </Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
