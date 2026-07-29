import { resolve, relative, isAbsolute } from "node:path";

export function safeChild(root: string, ...segments: string[]): string {
  const absoluteRoot = resolve(root);
  const child = resolve(absoluteRoot, ...segments);
  const rel = relative(absoluteRoot, child);
  if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) return child;
  throw new Error(`Resolved path escapes managed root: ${child}`);
}

export function assertSafeArchiveEntry(entry: string): void {
  const normalized = entry.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").includes("..") ||
    normalized.includes("\0")
  ) {
    throw new Error(`Unsafe archive entry: ${entry}`);
  }
}

export function projectProcessName(projectId: string, releaseId: string): string {
  return `wdp-${projectId.replaceAll("-", "").slice(0, 12)}-${releaseId.replaceAll("-", "").slice(0, 8)}`;
}
