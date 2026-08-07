/**
 * env.AI entrypoint: wire the deno-mlx backend into the OpenAI HTTP layer and serve on localhost.
 *
 * Run: `deno task env-ai` (needs `mlx-c` + a downloaded model — see scripts/bootstrap.sh and
 * `deno task pull`).
 */

import { createApp } from "./server.ts";
import { denoMlxBackend } from "./backend.ts";

const PORT = Number(Deno.env.get("RESAGENT_ENV_AI_PORT") ?? "8788");

if (import.meta.main) {
  Deno.serve({ port: PORT, hostname: "127.0.0.1" }, createApp(denoMlxBackend()));
  console.info(
    `env.AI adapter listening on http://127.0.0.1:${PORT} (backend: deno-mlx)`,
  );
}
