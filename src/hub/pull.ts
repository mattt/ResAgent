/**
 * HF Hub model downloads for env.AI — native TypeScript, Xet-accelerated.
 *
 * Uses @huggingface/hub's `snapshotDownload`, which engages Xet automatically for Xet-backed repos
 * (the Hub default since 2025): content-addressed, deduplicated, adaptive-concurrency transfers.
 * Files land in the canonical HF cache that deno-mlx reads
 * (`…/models--org--repo/snapshots/<rev>/…`), so there is one shared copy — no second store, and no
 * Python `hf` CLI on the critical path.
 *
 * CLI: `deno task pull <org/repo> [revision]`
 */

import { snapshotDownload } from "@huggingface/hub";

/**
 * Root of the HF hub cache. Mirrors deno-mlx's resolution exactly
 * (HF_HUB_CACHE → HF_HOME/hub → ~/.cache/huggingface/hub) so downloads and reads share one dir.
 */
export function hubCacheDir(): string {
  const explicit = Deno.env.get("HF_HUB_CACHE");
  if (explicit) return explicit;
  const home = Deno.env.get("HF_HOME");
  if (home) return `${home}/hub`;
  const userHome = Deno.env.get("HOME") ?? ".";
  return `${userHome}/.cache/huggingface/hub`;
}

export interface PullOptions {
  revision?: string;
  accessToken?: string;
}

/**
 * Download an entire model repo into the shared HF cache (Xet-accelerated where available).
 * Returns the absolute snapshot directory — the same path deno-mlx's `resolveSnapshot` returns.
 */
export async function pull(repoId: string, opts: PullOptions = {}): Promise<string> {
  const accessToken = opts.accessToken ?? Deno.env.get("HF_TOKEN") ?? undefined;
  return await snapshotDownload({
    repo: repoId,
    cacheDir: hubCacheDir(),
    revision: opts.revision,
    accessToken,
  });
}

if (import.meta.main) {
  const [repo, revision] = Deno.args;
  if (!repo) {
    console.error("usage: deno task pull <org/repo> [revision]");
    Deno.exit(2);
  }
  console.info(`Pulling ${repo}${revision ? `@${revision}` : ""} (Xet-accelerated)…`);
  const dir = await pull(repo, { revision });
  console.info(`Ready: ${dir}`);
}
