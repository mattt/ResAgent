/**
 * The ResAgent daemon — the always-on service the shell views (contract C5).
 *
 * Listens on a Unix socket and serves the C5 protocol per connection over a DaemonBackend. This is
 * the "service" half of "the app is a viewer over a service": it keeps running (objects, alarms)
 * when the shell window is closed. Today it's backed by an in-memory backend; a Celld-backed one
 * plugs into the same `DaemonBackend` interface later.
 *
 * Run: `deno task daemon` (listens on $RESAGENT_SOCKET or ~/.resagent/run/resagent.sock).
 * The shell connects with `RESAGENT_SOCKET=<path> deno task shell`.
 */

import { createDaemon, type DaemonBackend, serveConn } from "../protocol/server.ts";
import { memoryBackend, type MemorySeed } from "../protocol/memory_backend.ts";
import { celldBackend } from "./celld_backend.ts";
import type { GateLogEntry, GateRuleInfo } from "../protocol/messages.ts";
import type { GateLogOptions } from "../protocol/server.ts";
import { parseManifest } from "../manifest/parse.ts";
import { compileGates } from "../gate/compile.ts";
import { policyToGateRules } from "../gate/inspector.ts";
import type { Policy } from "../gate/policy.ts";
import { GateLog, loggingGate, toGateLogEntries } from "../gate/log.ts";
import { ReferenceGate } from "../gate/reference.ts";
import { corpus } from "../gate/corpus.ts";
import type { ServeRule } from "../manifest/types.ts";
import { celldForward, type ForwardFn, serveIngress } from "../serve/ingress.ts";

export interface RunningDaemon {
  path: string;
  /** Resolves once the accept loop has stopped. */
  done: Promise<void>;
  close(): Promise<void>;
}

/** Serve the C5 protocol on a Unix socket. One `serveConn` per accepted connection. */
export function serveUnix(path: string, backend: DaemonBackend): RunningDaemon {
  try {
    Deno.removeSync(path); // clear a stale socket from a previous run
  } catch { /* nothing to remove */ }

  const listener = Deno.listen({ path, transport: "unix" });
  const handler = createDaemon(backend);
  const conns = new Set<Deno.Conn>();

  const done = (async () => {
    try {
      for await (const conn of listener) {
        conns.add(conn);
        // A bad connection must not take down the daemon.
        serveConn(conn, handler).catch(() => {}).finally(() => conns.delete(conn));
      }
    } catch { /* listener closed */ }
  })();

  return {
    path,
    done,
    async close() {
      try {
        listener.close();
      } catch { /* already closed */ }
      await done;
      for (const conn of conns) {
        try {
          conn.close();
        } catch { /* already closed */ }
      }
      try {
        Deno.removeSync(path);
      } catch { /* already gone */ }
    },
  };
}

interface GateSurface {
  rules: GateRuleInfo[];
  log: GateLog;
}

/**
 * Build the egress-gate read surface the daemon serves over C5 (`gate.rules` + `gate.log`) from the
 * C4 manifest at RESAGENT_MANIFEST (default the flagship example). The gate lives above the engine,
 * so this wraps whichever backend rather than teaching celld_backend.ts about gates. A missing or
 * invalid manifest degrades to an empty policy (a warning), never a failed boot. Set
 * RESAGENT_GATE_SEED=corpus to replay the M6 corpus through an in-process reference gate so the Log
 * view isn't empty in a fresh daemon (dev/demo aid — real verdicts arrive from the running gateway).
 */
async function loadGate(): Promise<GateSurface> {
  const path = Deno.env.get("RESAGENT_MANIFEST") ??
    "examples/research-agent/resagent.hcl";
  let policy: Policy = { endpoints: [], credentials: [], rules: [] };
  try {
    policy = compileGates(await parseManifest(await Deno.readTextFile(path)));
  } catch (e) {
    console.warn(`gate policy: could not load ${path}: ${(e as Error).message}`);
  }

  const log = new GateLog();
  if (Deno.env.get("RESAGENT_GATE_SEED") === "corpus") {
    const gate = loggingGate(new ReferenceGate(), log);
    await gate.applyPolicy(policy);
    for (const c of corpus.cases) await gate.evaluate(c.facts);
  }
  return { rules: policyToGateRules(policy), log };
}

/** Add the `gate.rules` + `gate.log` views to any backend without the backend knowing about gates. */
function withGate(backend: DaemonBackend, gate: GateSurface): DaemonBackend {
  return {
    ...backend,
    gateRules: () => gate.rules,
    gateLog: (opts: GateLogOptions): GateLogEntry[] =>
      toGateLogEntries(gate.log.entries(opts.limit)),
  };
}

/** The manifest's tailnet serve rules (M8), for the identity-gated ingress. Degrades to none. */
async function loadServes(): Promise<ServeRule[]> {
  const path = Deno.env.get("RESAGENT_MANIFEST") ??
    "examples/research-agent/resagent.hcl";
  try {
    return (await parseManifest(await Deno.readTextFile(path))).serves;
  } catch {
    return [];
  }
}

/**
 * Start the tailnet ingress (M8) when RESAGENT_INGRESS=host:port is set — an HTTP listener that gates
 * inbound object access by tailnet identity. Off by default. RESAGENT_INGRESS_NODE points forwarding
 * at a celld node; without it, forwarding is a stub that echoes the routed target (the identity
 * gating is the point). RESAGENT_INGRESS_ALLOW_LOCAL=1 lets identity-less loopback calls through.
 */
function startIngress(serves: ServeRule[]): { close(): Promise<void> } | null {
  const addr = Deno.env.get("RESAGENT_INGRESS");
  if (!addr) return null;
  const [hostname, portStr] = addr.split(":");
  const port = Number(portStr);
  const node = Deno.env.get("RESAGENT_INGRESS_NODE");
  const forward: ForwardFn = node ? celldForward(node) : (target) =>
    Promise.resolve(
      Response.json({
        routed: target,
        note: "set RESAGENT_INGRESS_NODE to reach a celld node",
      }),
    );
  const server = Deno.serve(
    { hostname, port },
    serveIngress({
      serves,
      forward,
      allowLocal: Deno.env.get("RESAGENT_INGRESS_ALLOW_LOCAL") === "1",
      log: (e) =>
        console.info(
          `ingress ${e.allowed ? "ALLOW" : "DENY"} ${e.target} ${
            e.login ?? "(local)"
          } — ${e.reason}`,
        ),
    }),
  );
  console.info(`ResAgent tailnet ingress on ${addr}`);
  return { close: () => server.shutdown() };
}

function defaultSocketPath(): string {
  const explicit = Deno.env.get("RESAGENT_SOCKET");
  if (explicit) return explicit;
  const home = Deno.env.get("HOME") ?? ".";
  return `${home}/.resagent/run/resagent.sock`;
}

/** A small seed so a freshly-started daemon shows something in the inspector. */
const DEV_SEED: MemorySeed = {
  version: "0.0.0",
  engine: "memory (daemon)",
  namespaces: [
    {
      name: "research",
      objects: [{
        id: "agent-1",
        name: "ResearchAgent",
        alarm: 4102444800000,
        storage: { "cfg:topic": "on-device inference", "run:count": 3 },
      }],
    },
  ],
};

if (import.meta.main) {
  const path = defaultSocketPath();
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true }).catch(
    () => {},
  );

  // RESAGENT_ENGINE=celld boots a real celld (MinIO + deploy + node) and serves live objects;
  // otherwise the in-memory dev backend.
  let backend: DaemonBackend;
  let closeBackend: () => Promise<void> = () => Promise.resolve();
  if (Deno.env.get("RESAGENT_ENGINE") === "celld") {
    console.info("starting celld backend (MinIO + celld deploy + node)…");
    const handle = await celldBackend();
    backend = handle.backend;
    closeBackend = handle.close;
  } else {
    backend = memoryBackend(DEV_SEED);
  }

  // The gate rides above the engine: serve the compiled manifest's rules + verdict log over C5.
  backend = withGate(backend, await loadGate());

  const daemon = serveUnix(path, backend);
  console.info(`ResAgent daemon listening on ${path}`);

  // Optional tailnet ingress (M8) — identity-gated inbound access, off unless RESAGENT_INGRESS is set.
  const ingress = startIngress(await loadServes());

  const shutdown = () => {
    console.info("\nshutting down…");
    Promise.resolve(ingress?.close())
      .then(() => daemon.close())
      .then(closeBackend)
      .finally(() => Deno.exit(0));
  };
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  await daemon.done;
}
