import type { Metadata } from "next";
import { SiteNav, SiteFooter } from "@/components/site";

export const metadata: Metadata = {
  title: "Changelog — AbetFlow",
  description: "What changed in AbetFlow, newest first.",
};

export default function Page() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <SiteNav />
      <main className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight">Changelog</h1>
        <p className="mt-2 text-gray-600">Newest first. Breaking changes are marked <strong>BREAKING</strong> and get 30 days&apos; notice here before they ship.</p>
        <div className="mt-8 space-y-8 border-l-2 border-blue-600 pl-6">
          <div>
            <p className="text-sm text-gray-600">October 2026</p>
            <h2 className="text-lg font-bold">v1.3.0 — The API contract, in the format every tool probes first</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
              <li>AbetFlow sells on its API: inbound webhooks start runs, steps call your endpoints, completed runs publish signed webhooks. That machine is now described by one OpenAPI 3.1 document — <code>/api/openapi</code> and <code>/openapi.json</code>, readable without a key.</li>
              <li>Every request body, door (key, session, or either), field limit and rollback whole-number rule in the document is checked against the routes by build: <code>npm run check:contract</code> runs in CI and fails naming the lie.</li>
              <li>When the document is written ahead of the code, it fails — it was caught claiming a key door on <code>/api/health</code> and inventing an <code>autoRetry</code> field the route never reads, and it did the same on the flagship AbetAnalytics, where it caught 4 mistakes of its own.</li>
            </ul>
          </div>
          <div>
            <p className="text-sm text-gray-600">October 2026</p>
            <h2 className="text-lg font-bold">v1.2.0 — See it run before you build it</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
              <li>A new workspace can load one example workflow in a click: a lead arrives, is read, and is routed by size. It runs immediately, so the trace on the screen is the engine&rsquo;s own — every node, what it saw, and what it produced.</li>
              <li>It needs nothing external to run: no credentials, no SMTP server, no HTTP endpoint.</li>
              <li>The example is example data by name, and one click removes it and its run. Nothing of yours is touched.</li>
            </ul>
          </div>
          <div>
            <p className="text-sm text-gray-600">October 2026</p>
            <h2 className="text-lg font-bold">v1.1.0 — Take the audit trail with you</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
              <li>Owners and admins can download a workspace JSON with workflows, version history, variables, webhook destinations and credential names.</li>
              <li>Execution audits download as a streamed CSV: one row per execution with its complete ordered step trace. Credential ciphertext/IV, webhook signing secrets, API keys and invitation tokens are never included.</li>
            </ul>
          </div>
          <div>
            <p className="text-sm text-gray-600">September 2026</p>
            <h2 className="text-lg font-bold">v1.0.0 — Initial public release</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
              <li>General availability: Triggers, nine node types, JSONata transforms, and an execution log for every step. No code execution, no hanging workers, no mystery failures.</li>
              <li>Public pricing, terms, privacy, and support pages.</li>
              <li>Live demo workspace, no card required.</li>
            </ul>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
