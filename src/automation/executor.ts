/**
 * The Mac automation executor (M9) — runs Shortcuts and osascript via subprocess (`Deno.Command`),
 * the same pattern as the Keychain and Claw Patrol wrappers.
 *
 * Scope is deliberately narrow: `/usr/bin/shortcuts run <name>` and `/usr/bin/osascript -l
 * JavaScript -e <script>`. It performs NO policy checks — {@link "./binding.ts".gatedAutomation}
 * gates every call through the reference gate first, so this executor only ever runs already-allowed
 * actions. Needs `--allow-run`; the first real Shortcut/AppleScript may raise a TCC prompt (a user
 * action, not scriptable).
 */

const SHORTCUTS = "/usr/bin/shortcuts";
const OSASCRIPT = "/usr/bin/osascript";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface AutomationExecutor {
  /** `shortcuts run <name>`, optionally piping `input` on stdin. */
  runShortcut(name: string, input?: string): Promise<ExecResult>;
  /** `osascript -l JavaScript -e <script>`. */
  runScript(script: string): Promise<ExecResult>;
}

async function run(bin: string, args: string[], stdin?: string): Promise<ExecResult> {
  const cmd = new Deno.Command(bin, {
    args,
    stdin: stdin !== undefined ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  if (stdin !== undefined) {
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(stdin));
    await w.close();
  }
  const out = await child.output();
  const dec = new TextDecoder();
  return {
    code: out.code,
    stdout: dec.decode(out.stdout).trimEnd(),
    stderr: dec.decode(out.stderr).trimEnd(),
  };
}

/** The real macOS executor. */
export function systemExecutor(): AutomationExecutor {
  return {
    runShortcut(name, input) {
      // `--input-path -` reads the piped stdin as the shortcut's input.
      const args = input !== undefined
        ? ["run", name, "--input-path", "-"]
        : ["run", name];
      return run(SHORTCUTS, args, input);
    },
    runScript(script) {
      return run(OSASCRIPT, ["-l", "JavaScript", "-e", script]);
    },
  };
}
