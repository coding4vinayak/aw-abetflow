import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { SiteNav, SiteFooter } from "@/components/site";
import { getSession } from "@/lib/session";
import { WorkflowEditor, type EditorNode } from "@/components/workflow-editor";
import { StatusToggle } from "@/components/status-toggle";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return { title: `Edit workflow — AbetFlow` };
}

/**
 * The editor page.
 *
 * Server-rendered shell, client component inside. The definition is passed as
 * plain data and the editor hands back a JSON document on save, so what is
 * stored is exactly what the API's `parseDefinition` accepts — there is no
 * second format that only the UI produces.
 */
export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { id } = await params;

  const workflow = await prisma.workflow.findFirst({
    where: { id, workspaceId: session.workspaceId },
    include: {
      versions: { orderBy: { createdAt: "desc" }, take: 5 },
      executions: { orderBy: { createdAt: "desc" }, take: 5 },
    },
  });
  if (!workflow) notFound();

  const definition = (workflow.definition ?? {}) as { nodes?: unknown };
  const nodes = (Array.isArray(definition.nodes) ? definition.nodes : []) as EditorNode[];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <SiteNav />
      <main className="mx-auto max-w-4xl px-6 py-12">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
          <Link href="/workflows" className="hover:text-gray-600">
            Workflows
          </Link>
          {"  /  "}
          {workflow.name}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
              workflow.status === "ACTIVE" ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"
            }`}
          >
            {workflow.status}
          </span>
          <StatusToggle workflowId={workflow.id} status={workflow.status} />
          <span className="text-[12px] text-gray-500">
            {workflow.versions.length} saved version{workflow.versions.length === 1 ? "" : "s"}
          </span>
        </div>

        <div className="mt-8">
          <WorkflowEditor workflowId={workflow.id} initialNodes={nodes} initialName={workflow.name} />
        </div>

        <div className="mt-10 grid gap-6 sm:grid-cols-2">
          <div className="max-w-md rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-900">Recent runs</h2>
            {workflow.executions.length === 0 ? (
              <p className="mt-2 text-[12px] text-gray-500">No runs yet. Save the workflow, activate it, and run it above.</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {workflow.executions.map((e) => (
                  <li key={e.id} className="text-[12px]">
                    <Link
                      href={`/workflows/${workflow.id}/runs/${e.id}`}
                      className="font-mono text-gray-700 hover:text-gray-900 hover:underline"
                    >
                      {e.id.slice(0, 8)}…
                    </Link>{" "}
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        e.status === "COMPLETED"
                          ? "bg-green-100 text-green-800"
                          : e.status === "FAILED"
                            ? "bg-red-100 text-red-800"
                            : "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {e.status}
                    </span>{" "}
                    <span className="text-gray-400">{e.source}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="max-w-md rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-900">Saved versions</h2>
            <ul className="mt-2 space-y-1.5 text-[12px] text-gray-600">
              {workflow.versions.map((v) => (
                <li key={v.id} className="font-mono">
                  {v.id.slice(0, 8)}… · {new Date(v.createdAt).toLocaleString()}
                </li>
              ))}
              {workflow.versions.length === 0 && <li>No saved versions yet.</li>}
            </ul>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
