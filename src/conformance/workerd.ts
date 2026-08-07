/**
 * The workerd engine adapter — the reference ORACLE.
 *
 * Boots the real `workerd` binary serving the op-executor Worker (workerd_worker.js) with a
 * Durable Object namespace, and forwards each op as an HTTP POST routed to a DO by the
 * `x-object-id` header. Because workerd is Cloudflare's actual Workers runtime, agreement between
 * the corpus and workerd is what proves the spec — and, transitively, Celld and the Swift core —
 * correct.
 *
 * One process is shared across the suite; each `create()` gets a unique object-id prefix so its
 * storage is isolated. Needs the `workerd` binary (npm:workerd, a download) and run/net/read/write
 * permissions — so this is used by `deno task oracle`, not the default permission-light test run.
 * `import("workerd")` is dynamic so importing this module never forces the download.
 */

import type { Engine, EngineInstance } from "./engine.ts";
import type { Op, OpResult } from "./ops.ts";

export interface WorkerdOptions {
  /** Path to the workerd binary; defaults to $WORKERD_BIN, else the npm:workerd binary. */
  binary?: string;
}

const WORKER_URL = new URL("./workerd_worker.js", import.meta.url);

interface Server {
  port: number;
  child: Deno.ChildProcess;
  dir: string;
}

async function resolveBinary(opts: WorkerdOptions): Promise<string> {
  if (opts.binary) return opts.binary;
  const fromEnv = Deno.env.get("WORKERD_BIN");
  if (fromEnv) return fromEnv;
  const pkg = await import("workerd");
  return (pkg.default as { default: string }).default;
}

function freePort(): number {
  const l = Deno.listen({ port: 0 });
  const { port } = l.addr as Deno.NetAddr;
  l.close();
  return port;
}

function configCapnp(port: number): string {
  return `
using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "main", worker = .worker) ],
  sockets = [ (name = "http", address = "127.0.0.1:${port}", http = (), service = "main") ],
);
const worker :Workerd.Worker = (
  compatibilityDate = "2024-11-01",
  modules = [ (name = "entry.js", esModule = embed "entry.js") ],
  durableObjectNamespaces = [ (className = "OpExecutor", uniqueKey = "op-executor") ],
  durableObjectStorage = (inMemory = void),
  bindings = [ (name = "OBJ", durableObjectNamespace = "OpExecutor") ],
);
`;
}

async function boot(binary: string): Promise<Server> {
  const workerJs = await Deno.readTextFile(WORKER_URL);
  const port = freePort();
  const dir = await Deno.makeTempDir({ prefix: "resagent-workerd-" });
  await Deno.writeTextFile(`${dir}/entry.js`, workerJs);
  await Deno.writeTextFile(`${dir}/config.capnp`, configCapnp(port));

  const child = new Deno.Command(binary, {
    args: ["serve", `${dir}/config.capnp`],
    stdout: "null",
    stderr: "null",
  }).spawn();

  await waitReady(port);
  return { port, child, dir };
}

async function waitReady(port: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "x-object-id": "readiness" },
        body: JSON.stringify({ kind: "getAlarm" }),
      }).then((r) => r.body?.cancel());
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("workerd did not become ready within 10s");
}

export function workerdEngine(opts: WorkerdOptions = {}): Engine {
  let server: Promise<Server> | null = null;
  let counter = 0;
  const getServer = async () => (server ??= boot(await resolveBinary(opts)));

  return {
    name: "workerd",
    async create(): Promise<EngineInstance> {
      const s = await getServer();
      const prefix = `s${counter++}`;
      return {
        async exec(objectId: string, op: Op): Promise<OpResult> {
          const res = await fetch(`http://127.0.0.1:${s.port}/`, {
            method: "POST",
            headers: { "x-object-id": `${prefix}/${objectId}` },
            body: JSON.stringify(op),
          });
          if (!res.ok) throw new Error(`workerd ${res.status}: ${await res.text()}`);
          const data = await res.json() as { result: OpResult };
          return data.result;
        },
        dispose() {},
      };
    },
    async close(): Promise<void> {
      if (!server) return;
      const s = await server;
      server = null;
      // workerd does not exit promptly on SIGTERM in serve mode; SIGKILL so status resolves.
      s.child.kill("SIGKILL");
      await s.child.status;
      await Deno.remove(s.dir, { recursive: true });
    },
  };
}
