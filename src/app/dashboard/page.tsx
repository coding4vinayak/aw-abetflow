import Link from "next/link";
import { prisma } from "@/lib/db";
import { DashboardShell } from "@/components/dashboard-shell";
import { resolveWorkspace } from "@/lib/resolve-workspace";
import { signOut } from "@/app/auth-actions";
import { switchWorkspaceAction } from "@/app/member-actions";
import { createFirstKey } from "@/app/key-actions";
import { ApiKeyOnboarding } from "@/components/api-key-onboarding";

export const dynamic = "force-dynamic";

function Badge({ tone, children }: { tone: "green" | "blue" | "red" | "gray"; children: React.ReactNode }) {
  const tones: Record<string, string> = {
    green: "bg-green-100 text-green-800",
    blue: "bg-blue-100 text-blue-800",
    red: "bg-red-100 text-red-800",
    gray: "bg-gray-100 text-gray-600",
  };
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${tones[tone]}`}>
      {children}
    </span>
  );
}

function Card({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>
      {sub && <p className="mt-1 text-xs text-gray-500">{sub}</p>}
    </div>
  );
}

function statusTone(status: string): "green" | "blue" | "red" | "gray" {
  if (status === "COMPLETED" || status === "ACTIVE") return "green";
  if (status === "RUNNING" || status === "QUEUED") return "blue";
  if (status === "FAILED") return "red";
  return "gray";
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ workspace?: string }> }) {
  const { workspace: requestedSlug } = await searchParams;
  // One policy, shared: the demo stays public, a customer's own workspace needs
  // their session, and naming anyone else's slug is refused rather than served.
  const resolved = await resolveWorkspace(requestedSlug);
  if (!resolved.workspace) {
    return (
      <main className="min-h-screen flex items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <p className="text-gray-600">
            That workspace needs an account. Sign in to open yours.
          </p>
          <a
            href="/login"
            className="mt-4 inline-block rounded-lg bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-gray-700"
          >
            Sign in
          </a>
        </div>
      </main>
    );
  }
  const workspace = resolved.workspace;
  const session = resolved.session;

  // The bar's workspace switcher needs the full list. Anonymous visitors get
  // none — the demo badge already says what they are looking at.
  const myWorkspaces = session
    ? await prisma.membership.findMany({
        where: { userId: session.userId },
        include: { workspace: { select: { id: true, name: true, slug: true } } },
        orderBy: { createdAt: "asc" },
      })
    : [];

  const liveKeyCount = session
    ? await prisma.apiKey.count({ where: { workspaceId: workspace.id, revokedAt: null } })
    : null;

  const [workflows, executions, totalExecutions, failed] = await Promise.all([
    prisma.workflow.findMany({
      where: { workspaceId: workspace.id },
      include: { _count: { select: { executions: true, versions: true } } },
      orderBy: { updatedAt: "desc" },
      take: 20,
    }),
    prisma.execution.findMany({
      where: { workspaceId: workspace.id },
      include: { workflow: { select: { name: true } }, _count: { select: { steps: true } } },
      orderBy: { createdAt: "desc" },
      take: 15,
    }),
    prisma.execution.count({ where: { workspaceId: workspace.id } }),
    prisma.execution.count({ where: { workspaceId: workspace.id, status: "FAILED" } }),
  ]);

  return (
    <DashboardShell
      product="AbetFlow"
      accent="text-cyan-600"
      accentSoft="bg-cyan-500"
      account={
        session
          ? {
              name: session.name,
              email: session.email,
              signOut,
              workspaces: myWorkspaces.map((m) => m.workspace),
              currentWorkspaceId: session.workspaceId,
              switchWorkspace: switchWorkspaceAction,
            }
          : null
      }
      workspace={workspace.name}
      title="Workflow dashboard"
    >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <Card label="Workflows" value={workflows.length} />
          <Card label="Executions" value={totalExecutions} sub="all time, all statuses" />
          <Card label="Dead letter" value={failed} sub={failed === 0 ? "nothing failing" : "needs attention"} />
          <Card label="Active triggers" value={workflows.filter((w) => w.status === "ACTIVE").length} />
        </div>

        <div className="bg-white rounded-2xl shadow-sm p-6 mb-6">
          <h2 className="text-lg font-bold text-gray-900 mb-4">Workflows</h2>
          {workflows.length === 0 ? (
            <p className="text-sm text-gray-500">No workflows yet. Create one via <code>POST /api/workflows</code>.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="pb-2 pr-4 font-medium">Name</th>
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 pr-4 font-medium">Runs</th>
                    <th className="pb-2 font-medium">Versions</th>
                  </tr>
                </thead>
                <tbody>
                  {workflows.map((w) => (
                    <tr key={w.id} className="border-t border-gray-100">
                      <td className="py-3 pr-4 font-medium text-gray-900">{w.name}</td>
                      <td className="py-3 pr-4"><Badge tone={statusTone(w.status)}>{w.status}</Badge></td>
                      <td className="py-3 pr-4 text-gray-600">{w._count.executions}</td>
                      <td className="py-3 text-gray-600">{w._count.versions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="bg-white rounded-2xl shadow-sm p-6">
          <h2 className="text-lg font-bold text-gray-900 mb-4">Recent executions</h2>
          {executions.length === 0 ? (
            <p className="text-sm text-gray-500">No runs yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="pb-2 pr-4 font-medium">Workflow</th>
                    <th className="pb-2 pr-4 font-medium">Source</th>
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 font-medium">Steps</th>
                  </tr>
                </thead>
                <tbody>
                  {executions.map((e) => (
                    <tr key={e.id} className="border-t border-gray-100">
                      <td className="py-3 pr-4 font-medium text-gray-900">{e.workflow.name}</td>
                      <td className="py-3 pr-4 text-gray-600">{e.source}</td>
                      <td className="py-3 pr-4"><Badge tone={statusTone(e.status)}>{e.status}</Badge></td>
                      <td className="py-3 text-gray-600">{e._count.steps}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      {session && liveKeyCount === 0 && (
        // Only for a signed-in workspace with no usable key: a stranger on the
        // public demo has no account to attach a key to, and prompting them
        // would be an invitation to sign up mid-demo.
        <div className="mt-6">
          <ApiKeyOnboarding createKey={createFirstKey} />
        </div>
      )}
      </DashboardShell>
  );
}
