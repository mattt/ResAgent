/**
 * Folder grants (M10): boundary-aware prefix, `..` traversal normalized out, symlink-escape defense,
 * `~` expansion, read-only refuses a write, and revoke. CI-safe (a temp dir for the symlink case).
 */

import { assert, assertEquals } from "jsr:@std/assert@^1";
import { canonicalize, memoryGrantStore } from "./grants.ts";

Deno.test("grants: prefix is boundary-aware (/foo grants /foo/bar, not /foobar)", () => {
  const store = memoryGrantStore();
  store.grant("/resagent-test/foo", "read-only", 0);
  assert(store.check("/resagent-test/foo").allowed);
  assert(store.check("/resagent-test/foo/bar/baz").allowed);
  assert(!store.check("/resagent-test/foobar").allowed);
  assert(!store.check("/resagent-test/other").allowed);
});

Deno.test("grants: a `..` traversal is normalized out and denied", () => {
  const store = memoryGrantStore();
  store.grant("/resagent-test/safe", "read-write", 0);
  const c = store.check("/resagent-test/safe/../secrets/key", "read-only");
  assert(!c.allowed);
  assert(c.reason.includes("no grant"));
});

Deno.test("grants: read-only refuses a write; read-write allows it", () => {
  const store = memoryGrantStore();
  store.grant("/resagent-test/ro", "read-only", 0);
  store.grant("/resagent-test/rw", "read-write", 0);
  assert(store.check("/resagent-test/ro/f", "read-only").allowed);
  const denied = store.check("/resagent-test/ro/f", "read-write");
  assert(!denied.allowed);
  assert(denied.reason.includes("read-only"));
  assert(store.check("/resagent-test/rw/f", "read-write").allowed);
});

Deno.test("grants: ~ expands to $HOME", () => {
  const home = Deno.env.get("HOME")!;
  assertEquals(canonicalize("~"), Deno.realPathSync(home));
  assert(canonicalize("~/ResAgent").startsWith(Deno.realPathSync(home)));
});

Deno.test("grants: revoke removes a grant", () => {
  const store = memoryGrantStore();
  store.grant("/resagent-test/x", "read-only", 0);
  assertEquals(store.list().length, 1);
  assert(store.revoke("/resagent-test/x"));
  assertEquals(store.list().length, 0);
  assert(!store.revoke("/resagent-test/x")); // already gone
});

Deno.test("grants: a symlink cannot escape its grant", async () => {
  const root = await Deno.makeTempDir({ prefix: "resagent-grants-" });
  try {
    const safe = `${root}/safe`;
    const outside = `${root}/outside`;
    await Deno.mkdir(safe);
    await Deno.mkdir(outside);
    await Deno.writeTextFile(`${outside}/secret`, "top secret");
    // safe/escape → ../outside : a path through it resolves OUTSIDE the grant.
    await Deno.symlink("../outside", `${safe}/escape`);

    const store = memoryGrantStore();
    store.grant(safe, "read-write", 0);

    // Directly inside the grant: allowed.
    assert(store.check(`${safe}/notes.md`, "read-write").allowed);
    // Through the symlink: canonicalize resolves it out of the grant → denied.
    const escaped = store.check(`${safe}/escape/secret`, "read-only");
    assert(!escaped.allowed, `expected denial, got: ${escaped.reason}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
