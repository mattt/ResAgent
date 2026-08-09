# src/shell — the Deno Desktop control plane (M3)

The menu-bar app and object inspector. It's a **viewer over a service**: it speaks the C5
protocol ([../protocol](../protocol)) to a daemon and never _is_ the daemon, so objects
keep running when the window is closed.

## Files

- **[inspector.html](inspector.html)** — the inspector UI in the ResEdit idiom: a
  three-pane resource browser (namespaces → objects → storage), a Typed ↔ **Raw/Hex**
  value view (read an object's storage like a resource fork), and Alarm/Logs tabs.
  Self-contained, no build step. It renders against, in order: an injected
  `window.__RESAGENT_API__`, the Deno Desktop `bindings` bridge, or a built-in fixture —
  so it also opens standalone in any browser for design/demo.
- **[main.ts](main.ts)** — the native wrapper: `Deno.serve`s the inspector, opens a
  `Deno.BrowserWindow`, exposes each C5 read method to the page via `win.bind(...)`, and
  adds a `Deno.Tray` menu-bar item.

## Run

```bash
deno task shell            # deno desktop src/shell/main.ts — needs Deno 2.9+ and a display
```

By default the shell runs an **in-process in-memory backend** (dev fixture). Point it at a
real daemon over a Unix socket:

```bash
RESAGENT_SOCKET=/path/to/resagent.sock deno task shell
```

To preview just the UI (no desktop runtime), open `inspector.html` in a browser — it falls
back to the fixture.

## Status

The UI and the C5 client/bridge are done and verified (the inspector renders typed
storage, the hex fallback, alarms, and logs; the layout is responsive). Still to come: a
**Celld-backed `DaemonBackend`** and the **launchd daemon + Unix-socket** wiring so the
shell views a real supervised service. The native window itself requires a display, so it
isn't covered by headless CI.
