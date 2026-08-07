/**
 * The workerd engine adapter — the reference ORACLE (scaffold).
 *
 * Plan: write the op-executor Worker (op_executor.ts) plus a generated capnp config to a temp dir,
 * spawn `workerd serve`, and forward each op as an HTTP POST routed to the target Durable Object;
 * the executor applies it to real `ctx.storage` and returns the JSON result. Because workerd is
 * Cloudflare's actual Workers runtime, agreement between the corpus and workerd is what proves the
 * spec (and, transitively, Celld and the Swift core) correct.
 *
 * This needs the `workerd` binary, which is a download (npm:workerd) — so `create()` throws an
 * actionable error until the binary is present and the deploy/forward path is wired. Nothing here
 * pretends to work unverified.
 */

import type { Engine, EngineInstance } from "./engine.ts";

export interface WorkerdOptions {
  /** Path to the workerd binary; defaults to $WORKERD_BIN or `workerd` on PATH. */
  binary?: string;
}

export function workerdEngine(opts: WorkerdOptions = {}): Engine {
  const binary = opts.binary ?? Deno.env.get("WORKERD_BIN") ?? "workerd";
  return {
    name: "workerd",
    create(): Promise<EngineInstance> {
      return Promise.reject(
        new Error(
          `workerd engine not yet wired. Install the binary (\`deno run npm:workerd\` or ` +
            `\`npm i workerd\`), then implement deploy-and-forward for op_executor.ts. ` +
            `Looked for: ${binary}.`,
        ),
      );
    },
  };
}
