/**
 * serve:translate (M8): the example manifest lowers to the expected `tailscale serve` command line,
 * and a funnel rule emits the funnel verb. CI-safe (no Tailscale binary needed).
 */

import { assertEquals } from "jsr:@std/assert@^1";
import { DEFAULT_INGRESS, serveCommands } from "./translate.ts";
import { parseManifest } from "../manifest/parse.ts";
import type { ServeRule } from "../manifest/types.ts";

const exampleUrl = new URL("../../examples/research-agent/resagent.hcl", import.meta.url);
const example = await Deno.readTextFile(exampleUrl);

Deno.test("serve:translate lowers the example serve rule to a set-path command", async () => {
  const serves = (await parseManifest(example)).serves;
  const cmds = serveCommands(serves);
  assertEquals(cmds.length, 1);
  assertEquals(cmds[0], {
    pattern: "research/*",
    namespace: "research",
    funnel: false,
    line: `tailscale serve --bg --set-path /research http://${DEFAULT_INGRESS}/research`,
  });
});

Deno.test("serve:translate emits the funnel verb for a funnel rule", () => {
  const serves: ServeRule[] = [
    { pattern: "public/*", tailnetUsers: ["mattt@"], funnel: true },
  ];
  const [cmd] = serveCommands(serves, "127.0.0.1:9999");
  assertEquals(cmd.funnel, true);
  assertEquals(
    cmd.line,
    "tailscale funnel --bg --set-path /public http://127.0.0.1:9999/public",
  );
});
