import { assert, assertEquals } from "jsr:@std/assert@^1";
import { deleteSecret, getSecret, redact, setSecret } from "./keychain.ts";

const SERVICE = "resagent.gate.__test__";

// The round-trip needs `security`; the shared `deno task test` runs without --allow-run, so gate on
// it and let `deno task test:keychain` (run-enabled) exercise the real Keychain.
const hasRun =
  (await Deno.permissions.query({ name: "run", command: "/usr/bin/security" })).state ===
    "granted";

Deno.test(
  { name: "keychain: set, get, delete round-trip", ignore: !hasRun },
  async () => {
    await deleteSecret(SERVICE); // clean slate
    assertEquals(await getSecret(SERVICE), null);

    await setSecret(SERVICE, "s3cr3t-value");
    assertEquals(await getSecret(SERVICE), "s3cr3t-value");

    // -U updates in place rather than duplicating.
    await setSecret(SERVICE, "rotated");
    assertEquals(await getSecret(SERVICE), "rotated");

    await deleteSecret(SERVICE);
    assertEquals(await getSecret(SERVICE), null);
  },
);

Deno.test("keychain: redact reveals only length", () => {
  assertEquals(redact("supersecrettoken"), "<redacted:16 chars>");
  assert(!redact("supersecrettoken").includes("secret"));
});
