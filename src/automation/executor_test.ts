/**
 * LIVE macOS automation executor (M9) — needs `--allow-run` and real /usr/bin binaries. The shared
 * `deno task test` runs without --allow-run, so these gate on the permission and are exercised by
 * `deno task test:automation` (run-enabled), which also runs on macos-latest CI (like test:keychain).
 * osascript is non-interactive; `shortcuts list` just reads.
 */

import { assert, assertEquals } from "jsr:@std/assert@^1";
import { systemExecutor } from "./executor.ts";

const canRun = async (command: string) =>
  (await Deno.permissions.query({ name: "run", command })).state === "granted";

const hasOsascript = await canRun("/usr/bin/osascript");
const hasShortcuts = await canRun("/usr/bin/shortcuts");

Deno.test({
  name: "executor: osascript evaluates a JavaScript expression",
  ignore: !hasOsascript,
}, async () => {
  const r = await systemExecutor().runScript("1 + 1");
  assertEquals(r.code, 0);
  assertEquals(r.stdout, "2");
});

Deno.test({
  name: "executor: `shortcuts list` succeeds (read-only, no TCC prompt)",
  ignore: !hasShortcuts,
}, async () => {
  const r = await new Deno.Command("/usr/bin/shortcuts", {
    args: ["list"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(r.code, 0);
  assert(r.stdout instanceof Uint8Array);
});
