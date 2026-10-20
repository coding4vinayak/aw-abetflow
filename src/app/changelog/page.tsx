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
            <p className="text-sm text-gray-600">September 2026</p>
            <h2 className="text-lg font-bold">v1.0.0 — Initial public release</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
              <li>General availability: Triggers, nine node types, JSONata transforms, and an execution log for every step. No code execution, no hanging workers, no mystery failures.</li>
              <li>Public pricing, terms, privacy, and support pages.</li>
              <li>Live demo workspace, no card required.</li>
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
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
