import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { SiteNav, SiteFooter } from "@/components/site";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * One execution's trace.
 *
 * Server-side only, because a trace is a read of rows this workspace already
 * owns — there is nothing to submit and nothing interactive beyond getting
 * here. Step outputs are printed as JSON so a person can see exactly what each
 * node produced, which is how a broken workflow actually gets fixed.
 */
export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { id, runId } = await params;

  const execution = await prisma.execution.findFirst({
    where: { id: runId, workflowId: id, workspaceId: session.workspaceId },
    include: {
      steps: { orderBy: { position: "asc" } },
      workflow: { select: { name: true } },
    },
  });
  if (!execution) notFound();

  const output = execution.output;
  const outputText =
    output === null || output === undefined ? "" : JSON.stringify(output, null, 2).slice(0, 4000);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <SiteNav />
      <main className="mx-auto max-w-4xl px-6 py-12">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
          <Link href="/workflows" className="hover:text-gray-600">
            Workflows
          </Link>
          {"  /  "}
          <Link href={`/workflows/${id}`} className="hover:text-gray-600">
            {execution.workflow.name}
          </Link>
          {"  /  "}
          <span className="font-mono">{runId.slice(0, 8)}…</span>
        </p>

        <div className="mt-4 flex items-center gap-3">
          <h1 className="text-xl font-bold tracking-tight">
            Execution <span className="font-mono">{runId.slice(0, 8)}…</span>
          </h1>
          <span
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
              execution.status === "COMPLETED"
                ? "bg-green-100 text-green-800"
                : execution.status === "FAILED"
                  ? "bg-red-100 text-red-800"
                  : "bg-gray-100 text-gray-600"
            }`}
          >
            {execution.status}
          </span>
        </div>
        {execution.error && (
          <p role="alert" className="mt-4 max-w-2xl rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-gray-800">
            {execution.error}
          </p>
        )}

        <div className="mt-6 space-y-2">
          {execution.steps.map((s) => (
            <div key={s.id} className="rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-gray-900 px-2 py-0.5 text-[11px] font-semibold text-white">
                  {s.nodeType}
                </span>
                <span className="truncate font-mono text-[12px] text-gray-500">{s.nodeId}</span>
                <span
                  className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    s.status === "OK"
                      ? "bg-green-100 text-green-800"
                      : s.status === "FAILED"
                        ? "bg-red-100 text-red-800"
                        : "bg-gray-100 text-gray-600"
                  }`}
                >
                  {s.status}
                </span>
                {s.durationMs !== null && s.durationMs !== undefined && (
                  <span className="text-[11px] text-gray-400">{s.durationMs}ms</span>
                )}
              </div>
              {s.error && <p className="mt-2 text-[12px] text-red-700">{s.error}</p>}
              {s.output !== null && s.output !== undefined && (
                <pre className="mt-2 overflow-x-auto rounded-md bg-gray-50 p-3 font-mono text-[11px] text-gray-800">
                  {JSON.stringify(s.output, null, 2).slice(0, 1500)}
                </pre>
              )}
            </div>
          ))}
          {execution.steps.length === 0 && (
            <p className="text-[13px] text-gray-500">No steps recorded.</p>
          )}
        </div>

        {outputText && (
          <div className="mt-6">
            <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Final output</p>
            <pre className="mt-2 overflow-x-auto rounded-md border border-gray-200 bg-white p-4 font-mono text-[12px] text-gray-800">
              {outputText}
            </pre>
          </div>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
