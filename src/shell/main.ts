/**
 * ResAgent shell — the Deno Desktop control plane (M3).
 *
 * Serves the inspector UI (inspector.html) and bridges the C5 protocol into it: each read method is
 * exposed to the web page via `win.bind(...)`, callable as `bindings.<name>()`. The page prefers
 * those bindings, falling back to a fixture when opened in a plain browser.
 *
 * Backend: connects to a running daemon over a Unix socket when RESAGENT_SOCKET is set (the "app is
 * a viewer over a launchd service" posture), otherwise runs an in-process in-memory backend for
 * development. Run with a display: `deno desktop src/shell/main.ts` (Deno 2.9+). This entrypoint
 * uses desktop-only globals (Deno.BrowserWindow, Deno.Tray) via a typed shim so it still
 * type-checks under plain `deno check`.
 */

import { ProtocolClient } from "../protocol/client.ts";
import { memoryBackend, type MemorySeed } from "../protocol/memory_backend.ts";
import type { LogsTailOptions, StorageListOptions } from "../protocol/server.ts";
import type {
  DaemonStatus,
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
}

const BOUND_METHODS = [
  "status",
  "namespaces",
  "objects",
  "storageList",
  "storageGet",
  "alarmGet",
  "logsTail",
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
};

async function resolveApi(): Promise<ShellApi> {
  const socket = Deno.env.get("RESAGENT_SOCKET");
  if (socket) {
    const conn = await Deno.connect({ path: socket, transport: "unix" });
    return new ProtocolClient(conn);
  }
  return memoryBackend(DEV_SEED);
}

if (import.meta.main) {
  const api = await resolveApi();
  const apiRecord = api as unknown as Record<string, (...args: unknown[]) => unknown>;

  const html = await Deno.readTextFile(new URL("./inspector.html", import.meta.url));
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/" || pathname === "/inspector.html") {
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("not found", { status: 404 });
  });
  const url = `http://127.0.0.1:${server.addr.port}/`;

  const win = new desktop.BrowserWindow({ title: "ResAgent", width: 980, height: 660 });
  for (const name of BOUND_METHODS) {
    win.bind(name, (...args: unknown[]) => apiRecord[name](...args));
  }
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
