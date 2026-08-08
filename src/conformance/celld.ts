/**
 * The Celld engine adapter for the conformance harness — measures Celld against the same corpus
 * workerd (the oracle) passes.
 *
 * Lifecycle: a shared MinIO (Celld requires an S3 bucket) + one `celld deploy` of the op-executor
 * happen once; a single celld node then serves. Each `create()` gets a unique object-id prefix so
 * cases are isolated even though storage replicates through the shared bucket. Celld v0.1.0 is alpha
 * and can *panic the whole node* on unsupported behavior (e.g. far-future setAlarm), so the node is
 * rebooted automatically after it dies — the crashing case fails, later cases still run.
 *
 * Needs celld + minio + mc + esbuild on disk (see the *_BIN env overrides) and run/net/read/write
 * permissions. Used by `deno task conformance celld`; `import("...")`-free of any heavy dep so
 * importing this module is cheap.
 */

import type { Engine, EngineInstance } from "./engine.ts";
import type { Op, OpResult } from "./ops.ts";

export interface CelldOptions {
  celldBin?: string;
  minioBin?: string;
  mcBin?: string;
  esbuildBin?: string;
}

const HOME = Deno.env.get("HOME") ?? "";
const WORKER_URL = new URL("./workerd_worker.js", import.meta.url);
const ACCESS_KEY = "resagent";
const SECRET_KEY = "resagentsecret";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): number {
  const l = Deno.listen({ port: 0 });
  const { port } = l.addr as Deno.NetAddr;
  l.close();
  return port;
}

interface Bin {
  celld: string;
  minio: string;
  mc: string;
  esbuild: string;
}

function resolveBins(opts: CelldOptions): Bin {
  return {
    celld: opts.celldBin ?? Deno.env.get("CELLD_BIN") ?? `${HOME}/.local/bin/celld`,
    minio: opts.minioBin ?? Deno.env.get("MINIO_BIN") ?? `${HOME}/.local/bin/minio`,
    mc: opts.mcBin ?? Deno.env.get("MC_BIN") ?? `${HOME}/.local/bin/mc`,
    esbuild: opts.esbuildBin ?? Deno.env.get("CELLD_ESBUILD") ??
      "/opt/homebrew/bin/esbuild",
  };
}

/** Shared, one-time infrastructure: MinIO + a bucket + a deployed op-executor. */
interface Base {
  bin: Bin;
  s3: string;
  awsEnv: Record<string, string>;
  minio: Deno.ChildProcess;
  dirs: string[];
}

async function initBase(bin: Bin): Promise<Base> {
  for (const [name, path] of Object.entries(bin)) {
    try {
      await Deno.stat(path);
    } catch {
      throw new Error(
        `celld adapter: ${name} not found at ${path} (set the *_BIN env override)`,
      );
    }
  }

  const minioPort = freePort();
  const consolePort = freePort();
  const s3 = `http://127.0.0.1:${minioPort}`;
  const dataDir = await Deno.makeTempDir({ prefix: "resagent-celld-minio-" });
  const mcDir = await Deno.makeTempDir({ prefix: "resagent-celld-mc-" });
  const projDir = await Deno.makeTempDir({ prefix: "resagent-celld-proj-" });
  const dirs = [dataDir, mcDir, projDir];
  const awsEnv = {
    AWS_ACCESS_KEY_ID: ACCESS_KEY,
    AWS_SECRET_ACCESS_KEY: SECRET_KEY,
    AWS_REGION: "us-east-1",
  };
  const path = `${HOME}/.local/bin:/opt/homebrew/bin:${Deno.env.get("PATH") ?? ""}`;

  const minio = new Deno.Command(bin.minio, {
    args: [
      "server",
      dataDir,
      "--address",
      `127.0.0.1:${minioPort}`,
      "--console-address",
      `127.0.0.1:${consolePort}`,
    ],
    env: { MINIO_ROOT_USER: ACCESS_KEY, MINIO_ROOT_PASSWORD: SECRET_KEY },
    stdout: "null",
    stderr: "null",
  }).spawn();

  for (let i = 0;; i++) {
    try {
      const r = await fetch(`${s3}/minio/health/live`);
      await r.body?.cancel();
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (i > 100) throw new Error("celld adapter: MinIO did not become ready");
    await sleep(100);
  }

  const mc = (args: string[]) =>
    new Deno.Command(bin.mc, {
      args,
      env: { MC_CONFIG_DIR: mcDir },
      stdout: "null",
      stderr: "null",
    })
      .output();
  await mc(["alias", "set", "local", s3, ACCESS_KEY, SECRET_KEY]);
  await mc(["mb", "--ignore-existing", "local/resagent"]);

  // Project: the standard-Workers op-executor + a wrangler.jsonc (celld reads jsonc/json).
  await Deno.copyFile(WORKER_URL, `${projDir}/entry.js`);
  await Deno.writeTextFile(
    `${projDir}/wrangler.jsonc`,
    JSON.stringify({
      name: "conformance",
      main: "entry.js",
      compatibility_date: "2024-11-01",
      durable_objects: { bindings: [{ name: "OBJ", class_name: "OpExecutor" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["OpExecutor"] }],
    }),
  );

  const deploy = await new Deno.Command(bin.celld, {
    args: [
      "deploy",
      projDir,
      "--bucket",
      "s3://resagent",
      "--endpoint",
      s3,
      "--region",
      "us-east-1",
    ],
    env: { ...awsEnv, CELLD_ESBUILD: bin.esbuild, PATH: path },
    stdout: "null",
    stderr: "piped",
  }).output();
  if (deploy.code !== 0) {
    throw new Error(
      `celld deploy failed: ${new TextDecoder().decode(deploy.stderr).trim()}`,
    );
  }

  return { bin, s3, awsEnv, minio, dirs };
}

interface Node {
  child: Deno.ChildProcess;
  port: number;
  watch: string;
  alive: boolean;
}

async function bootNode(base: Base): Promise<Node> {
  const port = freePort();
  const watch = await Deno.makeTempDir({ prefix: "resagent-celld-watch-" });
  const path = `${HOME}/.local/bin:/opt/homebrew/bin:${Deno.env.get("PATH") ?? ""}`;
  const child = new Deno.Command(base.bin.celld, {
    args: [
      "--bucket",
      "s3://resagent",
      "--endpoint",
      base.s3,
      "--region",
      "us-east-1",
      "--listen",
      `127.0.0.1:${port}`,
    ],
    env: { ...base.awsEnv, CELLD_WATCH: watch, PATH: path },
    stdout: "null",
    stderr: "null",
  }).spawn();

  const node: Node = { child, port, watch, alive: true };
  child.status.then(() => node.alive = false).catch(() => node.alive = false);

  for (let i = 0;; i++) {
    if (!node.alive) throw new Error("celld node exited during startup");
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "x-object-id": "readiness" },
        body: JSON.stringify({ kind: "getAlarm" }),
      });
      await r.body?.cancel();
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (i > 150) throw new Error("celld node did not become ready");
    await sleep(200);
  }
  return node;
}

async function killNode(node: Node): Promise<void> {
  try {
    node.child.kill("SIGKILL");
    await node.child.status;
  } catch { /* already gone */ }
  try {
    await Deno.remove(node.watch, { recursive: true });
  } catch { /* ignore */ }
}

export function celldEngine(opts: CelldOptions = {}): Engine {
  const bin = resolveBins(opts);
  let base: Promise<Base> | null = null;
  let node: Node | null = null;
  let counter = 0;

  async function ensureNode(): Promise<Node> {
    const b = await (base ??= initBase(bin));
    if (node && node.alive) return node;
    if (node) await killNode(node); // dead: clean up before rebooting
    node = await bootNode(b);
    return node;
  }

  return {
    name: "celld",
    async create(): Promise<EngineInstance> {
      const n = await ensureNode();
      const prefix = `s${counter++}`;
      return {
        async exec(objectId: string, op: Op): Promise<OpResult> {
          const res = await fetch(`http://127.0.0.1:${n.port}/`, {
            method: "POST",
            headers: { "x-object-id": `${prefix}/${objectId}` },
            body: JSON.stringify(op),
          });
          if (!res.ok) throw new Error(`celld ${res.status}: ${await res.text()}`);
          const data = await res.json() as { result: OpResult };
          return data.result;
        },
        dispose() {},
      };
    },
    async close(): Promise<void> {
      if (node) await killNode(node);
      node = null;
      if (base) {
        const b = await base;
        base = null;
        try {
          b.minio.kill("SIGKILL");
          await b.minio.status;
        } catch { /* ignore */ }
        for (const d of b.dirs) {
          try {
            await Deno.remove(d, { recursive: true });
          } catch { /* ignore */ }
        }
      }
    },
  };
}
