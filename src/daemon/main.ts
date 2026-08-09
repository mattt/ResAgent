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

  const daemon = serveUnix(path, backend);
  console.info(`ResAgent daemon listening on ${path}`);

  const shutdown = () => {
    console.info("\nshutting down…");
    daemon.close().then(closeBackend).finally(() => Deno.exit(0));
  };
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  await daemon.done;
}
