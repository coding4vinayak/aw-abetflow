import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AiPanel, type AiField } from "@/components/ai-panel";
import { SiteNav, SiteFooter } from "@/components/site";
import { getSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "AI node playground — AbetFlow",
};

export const dynamic = "force-dynamic";

/**
 * Try the `llm` node before building a workflow around it.
 *
 * The node works through saved workflows, which is a slow way to find out
 * whether a task is worth using. This runs the same code against text you paste.
 * It is deliberately as unforgiving as a real run: if the provider is down, this
 * page fails too, rather than showing a result the workflow could never produce.
 */
export default async function AiPlaygroundPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <SiteNav />
      <main className="mx-auto max-w-2xl px-6 py-12">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Abetworks</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-cyan-600">AbetFlow</h1>
        <p className="mt-2 text-sm text-gray-600">
          The <code className="font-mono">llm</code> node: classify, extract, summarise or
          rewrite, using any OpenAI-compatible model you bring.
        </p>

        <div className="mt-8">
          <AiPanel
            config={{
              title: "Run the node",
              blurb:
                "Pick a task, paste some text, and see exactly what the node would put into your workflow. A classify task must pick one of the labels it was given; anything else is treated as a failure.",
              endpoint: "/api/ai/try-node",
              entityLabel: "Task",
              idField: "task",
              inputLabel: "Text to work on",
              inputField: "text",
              inputPlaceholder: "My card was charged twice this month and nobody replied",
              buttonLabel: "Run node",
              emptyText: "No tasks available.",
              options: [
                { id: "classify", label: "classify — one label from a fixed set" },
                { id: "extract", label: "extract — pull named fields out" },
                { id: "summarize", label: "summarize — two faithful sentences" },
                { id: "transform", label: "transform — rewrite" },
              ],
            }}
            fields={[
              { path: "result.label", title: "Label" },
              { path: "result.confidence", title: "Confidence" },
              { path: "result.result", title: "Result", mono: true },
              { path: "note", title: "" },
            ] satisfies AiField[]}
          />
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
