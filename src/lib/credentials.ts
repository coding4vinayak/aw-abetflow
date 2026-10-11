import { prisma } from "./db";
import { openCredential } from "./crypto";

/**
 * Resolve every credential in a workspace to plaintext for one execution.
 * Plaintext lives only in memory for the duration of the run — the table
 * holds ciphertext exclusively.
 */
export async function resolveCredentials(workspaceId: string): Promise<Record<string, Record<string, string>>> {
  const rows = await prisma.credential.findMany({ where: { workspaceId } });
  const out: Record<string, Record<string, string>> = {};
  for (const row of rows) {
    try {
      out[row.name] = JSON.parse(openCredential(row.ciphertext, row.iv)) as Record<string, string>;
    } catch {
      // A row that no longer decrypts (rotated key, tamper) is skipped, not
      // fatal: the node that needs it fails loudly with its own name on it.
      continue;
    }
  }
  return out;
}
