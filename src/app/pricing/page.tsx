import type { Metadata } from "next";
import { SiteNav, SiteFooter } from "@/components/site";

export const metadata: Metadata = {
  title: "Pricing — AbetFlow",
  description: "AbetFlow pricing: $0 included with the Abetworks suite.",
};

export default function Page() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <SiteNav />
      <main className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight">Pricing</h1>
        <p className="mt-2 text-gray-600">AbetFlow is included with the Abetworks suite at no extra charge — every workspace gets the full engine.</p>
        <div className="mt-8 grid gap-6 sm:grid-cols-3">
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-wide text-gray-600">Monthly</p>
            <p className="mt-2 text-4xl font-bold">$0</p>
            <p className="mt-1 text-sm text-gray-600">included with the Abetworks suite</p>
            <a href="/dashboard?workspace=demo" className="mt-6 block rounded-lg bg-blue-600 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-blue-700 transition">Start now</a>
          </div>
          <div className="rounded-2xl border-2 border-blue-600 p-6 bg-blue-50">
            <p className="text-sm font-semibold uppercase tracking-wide text-blue-600">Annual — 2 months free</p>
            <p className="mt-2 text-4xl font-bold">$0</p>
            <p className="mt-1 text-sm text-gray-600">included with the Abetworks suite, billed yearly</p>
            <a href="mailto:support@abetworks.in?subject=AbetFlow%20annual%20plan" className="mt-6 block rounded-lg bg-blue-600 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-blue-700 transition">Go annual</a>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-wide text-gray-600">Enterprise</p>
            <p className="mt-2 text-4xl font-bold">Custom</p>
            <p className="mt-1 text-sm text-gray-600">SSO, audit exports, SLA and onboarding by custom arrangement</p>
            <a href="mailto:support@abetworks.in?subject=AbetFlow%20enterprise" className="mt-6 block rounded-lg border border-blue-600 px-4 py-2 text-center text-sm font-semibold text-blue-600 hover:bg-blue-50 transition">Talk to us</a>
          </div>
        </div>
        <h2 className="mt-12 text-xl font-bold">Also in the Abetworks suite</h2>
        <p className="mt-2 text-gray-600">
          AbetFlow is free because it is the plumbing the rest of the suite sits on. These are the
          products teams pair it with — each has its own sign-up, and{" "}
          <a href="mailto:support@abetworks.in?subject=One%20workspace%20across%20the%20Abetworks%20suite" className="underline">
            one contract can set up a workspace across all of them
          </a>
          .
        </p>
        <div className="mt-6 space-y-3">
          <a href="https://abetagent.abetworks.in" className="block rounded-2xl border border-gray-200 bg-white p-4 shadow-sm hover:bg-gray-50 transition">
            <span className="font-semibold text-gray-900">AbetAgent</span> <span className="text-gray-600">— agents with citations, step traces and human escalation. $99 per month.</span>
          </a>
          <a href="https://leadgenius.abetworks.in" className="block rounded-2xl border border-gray-200 bg-white p-4 shadow-sm hover:bg-gray-50 transition">
            <span className="font-semibold text-gray-900">LeadGenius</span> <span className="text-gray-600">— multichannel outreach with warmup and deliverability guardrails. $29 per user per month.</span>
          </a>
          <a href="https://leadworks.abetworks.in" className="block rounded-2xl border border-gray-200 bg-white p-4 shadow-sm hover:bg-gray-50 transition">
            <span className="font-semibold text-gray-900">LeadWorks</span> <span className="text-gray-600">— sources, scraping, enrichment, validation and exports in one pipeline. $49 per month.</span>
          </a>
        </div>
        <h2 className="mt-12 text-xl font-bold">Questions</h2>
        <div className="mt-4 space-y-4">
          <div><p className="font-semibold text-gray-900">Is there a trial?</p><p className="mt-1 text-gray-600">There is better than a trial: it is included. Open the live demo and run the deal-triage flow now.</p></div>
          <div><p className="font-semibold text-gray-900">What happens when a node fails?</p><p className="mt-1 text-gray-600">Your choice per node: fail loudly with the error attached, or continueOnFail and keep walking.</p></div>
          <div><p className="font-semibold text-gray-900">Can workflows loop forever?</p><p className="mt-1 text-gray-600">No — the 200-step budget stops cycles and tells you exactly where.</p></div>
          <div><p className="font-semibold text-gray-900">Where do secrets live?</p><p className="mt-1 text-gray-600">In the credentials vault, referenced by name. Definitions contain no secrets.</p></div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
