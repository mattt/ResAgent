/**
 * A narrow macOS Keychain wrapper over the `security` CLI (M6). The gate reads wire secrets from the
 * Keychain at injection time so the object never carries them — this is the "the object never held
 * the token" half of M6. Scope is deliberately tight: generic passwords under a `resagent.gate.*`
 * service name and a fixed account, nothing else. Secret VALUES are returned to the caller but never
 * logged here; callers (the demo, the gateway wiring) redact before printing.
 *
 * Needs `--allow-run` for `/usr/bin/security`. Adding/reading a generic password created by the same
 * user session is non-interactive (no GUI prompt), verified on this host.
 */

const SECURITY = "/usr/bin/security";
export const DEFAULT_ACCOUNT = "resagent";

async function security(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const r = await new Deno.Command(SECURITY, { args, stdout: "piped", stderr: "piped" })
    .output();
  const dec = new TextDecoder();
  return { code: r.code, stdout: dec.decode(r.stdout), stderr: dec.decode(r.stderr) };
}

/** Read a secret, or null if the item does not exist. */
export async function getSecret(
  service: string,
  account = DEFAULT_ACCOUNT,
): Promise<string | null> {
  const r = await security(["find-generic-password", "-s", service, "-a", account, "-w"]);
  if (r.code !== 0) return null;
  return r.stdout.replace(/\n$/, "");
}

/** Create or update a secret (used for demo setup, not on the read path). */
export async function setSecret(
  service: string,
  value: string,
  account = DEFAULT_ACCOUNT,
): Promise<void> {
  const r = await security([
    "add-generic-password",
    "-U",
    "-s",
    service,
    "-a",
    account,
    "-w",
    value,
  ]);
  if (r.code !== 0) {
    throw new Error(`keychain: could not set ${service}: ${r.stderr.trim()}`);
  }
}

/** Remove a secret; resolves even if it was absent. */
export async function deleteSecret(
  service: string,
  account = DEFAULT_ACCOUNT,
): Promise<void> {
  await security(["delete-generic-password", "-s", service, "-a", account]);
}

/** Redact a secret for display — reveals only its length, never any bytes. */
export function redact(secret: string): string {
  return `<redacted:${secret.length} chars>`;
}
