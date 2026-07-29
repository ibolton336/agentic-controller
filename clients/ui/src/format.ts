/** Small display helpers shared by the pages. */

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** kubectl-style age: 42s, 12m, 3h, 5d. */
export function formatAge(creationTimestamp?: string): string {
  if (!creationTimestamp) return "—";
  const ms = Date.now() - new Date(creationTimestamp).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 120) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** AgentRun.status.duration is wall-clock seconds. */
export function formatDuration(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m}m ${rest}s` : `${m}m`;
}

export function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

// ----------------------------------------------------- git host URL helpers

/**
 * {owner, repo} when the URL is a github.com repository (the one host whose
 * REST API is CORS-open to browsers, so the console can show a commit feed
 * without credentials). Everything else — GitLab, Gitea, ssh remotes —
 * returns undefined and callers degrade to plain text.
 */
export function parseGitHubRepo(repoUrl?: string): { owner: string; repo: string } | undefined {
  if (!repoUrl) return undefined;
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
    repoUrl.trim(),
  );
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

/** Web URL of a branch on the repo's host; undefined when the host shape is unknown. */
export function repoBranchUrl(repoUrl: string | undefined, branch: string): string | undefined {
  if (!repoUrl) return undefined;
  const base = repoUrl.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const gh = parseGitHubRepo(repoUrl);
  if (gh) return `${base}/tree/${encodeURIComponent(branch)}`;
  if (/^https?:\/\/(?:www\.)?gitlab\.com\//.test(base)) {
    return `${base}/-/tree/${encodeURIComponent(branch)}`;
  }
  return undefined;
}

/** Web URL of a file on a branch (GitHub/GitLab shapes only). */
export function repoFileUrl(
  repoUrl: string | undefined,
  branch: string,
  path: string,
): string | undefined {
  if (!repoUrl) return undefined;
  const base = repoUrl.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  if (parseGitHubRepo(repoUrl)) {
    return `${base}/blob/${encodeURIComponent(branch)}/${encodedPath}`;
  }
  if (/^https?:\/\/(?:www\.)?gitlab\.com\//.test(base)) {
    return `${base}/-/blob/${encodeURIComponent(branch)}/${encodedPath}`;
  }
  return undefined;
}
