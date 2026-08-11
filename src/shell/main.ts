/**
 * ResAgent shell — the Deno Desktop control plane (M3).
 *
 * Serves the inspector UI (inspector.html) and proxies the C5 protocol to it over HTTP: the page
 * POSTs { method, args } to /rpc and the shell forwards to its backend. (An earlier attempt used the
 * Deno Desktop `win.bind` bridge, but the callbacks weren't reliably reaching the webview; plain
 * fetch is robust and testable in any browser.)
 *
 * Backend: connects to a running daemon over a Unix socket when RESAGENT_SOCKET is set (the "app is
 * a viewer over a launchd service" posture), otherwise runs an in-process in-memory backend for
 * development. Run with a display: `deno task shell` (Deno 2.9+). This entrypoint uses desktop-only
 * globals (Deno.BrowserWindow, Deno.Tray) via a typed shim so it still type-checks under plain
 * `deno check`.
 */

import inspectorHtml from "./inspector.html" with { type: "text" };
import { ProtocolClient } from "../protocol/client.ts";
import { memoryBackend, type MemorySeed } from "../protocol/memory_backend.ts";
import type {
  AutomationRunParams,
  GateLogOptions,
  LogsTailOptions,
  StorageListOptions,
} from "../protocol/server.ts";
import type {
  AutomationRunResult,
  DaemonStatus,
  FolderGrantInfo,
  FsWriteResult,
  GateLogEntry,
  GateRuleInfo,
  Json,
  LogLine,
  NamespaceInfo,
  ObjectInfo,
  StorageEntries,
} from "../protocol/messages.ts";

/** The read surface the UI binds to — satisfied by both ProtocolClient and memoryBackend. */
interface ShellApi {
  status(): Promise<DaemonStatus> | DaemonStatus;
  namespaces(): Promise<NamespaceInfo[]> | NamespaceInfo[];
  objects(namespace: string): Promise<ObjectInfo[]> | ObjectInfo[];
  storageList(
    ns: string,
    id: string,
    opts: StorageListOptions,
  ): Promise<StorageEntries> | StorageEntries;
  storageGet(ns: string, id: string, key: string): Promise<Json> | Json;
  alarmGet(ns: string, id: string): Promise<number | null> | (number | null);
  logsTail(opts: LogsTailOptions): Promise<LogLine[]> | LogLine[];
  // Optional to match DaemonBackend (engines without a gate omit them); both the ProtocolClient and
  // memoryBackend provide them at runtime, and the inspector's Gate tab tolerates their absence.
  gateRules?(): Promise<GateRuleInfo[]> | GateRuleInfo[];
  gateLog?(opts: GateLogOptions): Promise<GateLogEntry[]> | GateLogEntry[];
  // Mutating (M9); absent on backends that don't broker automation. No mutating UI this pass — the
  // verdict surfaces in the Gate → Log tab; this keeps the protocol surface complete.
  automationRun?(
    params: AutomationRunParams,
  ): Promise<AutomationRunResult> | AutomationRunResult;
  // Folder grants (M10): grantsList is the Grants tab's read surface; the fs pair is protocol
  // plumbing (no mutating UI this pass), optional to match DaemonBackend.
  grantsList?(): Promise<FolderGrantInfo[]> | FolderGrantInfo[];
  fsRead?(path: string): Promise<string> | string;
  fsWrite?(path: string, data: string): Promise<FsWriteResult> | FsWriteResult;
}

const BOUND_METHODS = [
  "status",
  "namespaces",
  "objects",
  "storageList",
  "storageGet",
  "alarmGet",
  "logsTail",
  "gateRules",
  "gateLog",
  "automationRun",
  "grantsList",
  "fsRead",
  "fsWrite",
] as const;

// ── Desktop API shim (typed so `deno check` passes without the desktop lib) ──
interface DesktopWindow {
  navigate(url: string): void;
  bind(name: string, handler: (...args: unknown[]) => unknown): void;
}
interface DesktopTray {
  setTooltip(text: string): void;
  setMenu(items: unknown[]): void;
  addEventListener(type: "menuclick", cb: (e: { detail: { id: string } }) => void): void;
}
interface DesktopDeno {
  BrowserWindow: new (opts: Record<string, unknown>) => DesktopWindow;
  Tray: new () => DesktopTray;
}
const desktop = Deno as unknown as DesktopDeno;

/** A small dev fixture so the shell shows something before Celld is wired. */
const DEV_SEED: MemorySeed = {
  version: "0.0.0",
  engine: "memory (dev)",
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
  // The compiled example policy (compileGates → policyToGateRules), so the Gate tab shows rules
  // even against the in-memory dev backend.
  gate: [
    {
      name: "research-ResearchAgent-allow",
      hosts: ["huggingface.co", "*.hf.co"],
      endpoint: "https.research-ResearchAgent",
      condition: 'http.method == "GET"',
      verdict: "allow",
      credential: "hf",
      priority: 0,
      reason: "allow https to huggingface.co, *.hf.co",
    },
    {
      name: "research-ResearchAgent-deny",
      hosts: ["huggingface.co", "*.hf.co"],
      endpoint: "https.research-ResearchAgent",
      verdict: "deny",
      priority: -100,
      reason: "default deny for research/ResearchAgent",
    },
  ],
  grants: [
    {
      path: "/Users/you/ResAgent/research",
      mode: "read-write",
      grantedAt: 1786200000000,
    },
  ],
};

async function resolveApi(): Promise<ShellApi> {
  // Env access is optional: without --allow-env (or the var), fall back to the in-memory backend.
  let socket: string | undefined;
  try {
    socket = Deno.env.get("RESAGENT_SOCKET");
  } catch {
    socket = undefined;
  }
  if (socket) {
    const conn = await Deno.connect({ path: socket, transport: "unix" });
    return new ProtocolClient(conn);
  }
  return memoryBackend(DEV_SEED);
}

if (import.meta.main) {
  const api = await resolveApi();
  const apiRecord = api as unknown as Record<string, (...args: unknown[]) => unknown>;

  // The page reaches the daemon through this HTTP server (POST /rpc), not the native bridge —
  // standard fetch is reliable in the webview and testable in a plain browser. Only the read
  // methods in `allowed` are callable.
  const allowed = new Set<string>(BOUND_METHODS);
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, async (req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/" || pathname === "/inspector.html") {
      return new Response(inspectorHtml, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (req.method === "POST" && pathname === "/rpc") {
      try {
        const { method, args } = await req.json() as { method: string; args?: unknown[] };
        if (!allowed.has(method)) {
          return Response.json({ ok: false, error: `unknown method: ${method}` }, {
            status: 400,
          });
        }
        const result = await apiRecord[method](...(args ?? []));
        return Response.json({ ok: true, result });
      } catch (e) {
        return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
      }
    }
    return new Response("not found", { status: 404 });
  });
  const url = `http://127.0.0.1:${server.addr.port}/`;

  const win = new desktop.BrowserWindow({ title: "ResAgent", width: 980, height: 660 });
  win.navigate(url);

  const tray = new desktop.Tray();
  tray.setTooltip("ResAgent");
  tray.setMenu([
    { item: { label: "Open Inspector", id: "open", enabled: true } },
    { separator: true },
    { item: { label: "Quit", id: "quit", enabled: true } },
  ]);
  tray.addEventListener("menuclick", (e) => {
    if (e.detail.id === "open") win.navigate(url);
    else if (e.detail.id === "quit") Deno.exit(0);
  });

  console.info(`ResAgent shell serving inspector at ${url}`);
}
