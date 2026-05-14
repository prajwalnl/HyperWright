import { run } from "./exec.js";

export interface PullRequest {
  number: string;
  title: string;
  body: string;
  diff: string;
}

/**
 * Fetch a pull request via `gh` CLI. Returns null if `gh` isn't installed,
 * isn't authed, or the PR doesn't exist. Pass `repo` (owner/name) so the
 * lookup does not depend on the caller's current working directory — this
 * is important because setupContext runs `gh pr view` *before* the target
 * repo has been cloned. Output is size-capped so prompt tokens stay bounded.
 */
export async function fetchPullRequest(
  number: string,
  opts: { maxDiffChars?: number; repo?: string } = {},
): Promise<PullRequest | null> {
  const maxDiff = opts.maxDiffChars ?? 20_000;
  const repoArgs = opts.repo ? ["--repo", opts.repo] : [];
  const [meta, diff] = await Promise.all([
    run("gh", ["pr", "view", number, ...repoArgs, "--json", "title,body"]),
    run("gh", ["pr", "diff", number, ...repoArgs]),
  ]);

  if (meta.code !== 0) return null;

  let title = "";
  let body = "";
  try {
    const parsed = JSON.parse(meta.stdout) as { title?: string; body?: string };
    title = parsed.title ?? "";
    body = (parsed.body ?? "").slice(0, 4000);
  } catch {
    return null;
  }

  const cappedDiff =
    diff.code === 0
      ? diff.stdout.length > maxDiff
        ? diff.stdout.slice(0, maxDiff) + "\n…(diff truncated)"
        : diff.stdout
      : "";

  return { number, title, body, diff: cappedDiff };
}
