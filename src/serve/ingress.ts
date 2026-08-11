/**
 * The tailnet ingress (M8) — an HTTP listener that gates inbound object access by tailnet identity.
 *
 * `tailscale serve` terminates the tailnet connection and proxies to this loopback listener with the
 * caller's verified identity in headers. `serveIngress` routes `/:namespace/:object/*`, evaluates the
 * identity against the manifest's serve rules ({@link "./identity.ts"}), and either 403s with a
 * reason or forwards to the object via an injected `forward`. It is deny-closed: an identity-less
 * request is refused unless `allowLocal` is set, so a plain loopback call can't impersonate a tailnet
 * user (localhost stays first-class only when explicitly opted in).
 *
 * Wired in the daemon behind RESAGENT_INGRESS (off by default). A live tailnet leg isn't verifiable
 * here; the routing + identity gating are proven with synthetic headers and a fake forward.
 */

import type { ServeRule } from "../manifest/types.ts";
import { evaluateIdentity, identityFromHeaders } from "./identity.ts";

export type ForwardFn = (target: string, req: Request) => Promise<Response>;

export interface IngressLogEntry {
  at: number;
  target: string;
  login?: string;
  allowed: boolean;
  reason: string;
}

export interface ServeIngressOptions {
  serves: ServeRule[];
  forward: ForwardFn;
  /** Forward identity-less loopback requests instead of denying them (localhost stays first-class). */
  allowLocal?: boolean;
  log?: (entry: IngressLogEntry) => void;
}

/** Extract `namespace/object` from `/namespace/object/rest…`, or null if the path is too short. */
function parseTarget(pathname: string): string | null {
  const parts = pathname.split("/").filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  return `${parts[0]}/${parts[1]}`;
}

/** Build the ingress request handler. */
export function serveIngress(
  opts: ServeIngressOptions,
): (req: Request) => Promise<Response> {
  return (req) => {
    const { pathname } = new URL(req.url);
    const target = parseTarget(pathname);
    if (!target) {
      return Promise.resolve(
        new Response("expected /<namespace>/<object>/…", { status: 404 }),
      );
    }
    const identity = identityFromHeaders(req.headers);
    const record = (allowed: boolean, reason: string) =>
      opts.log?.({ at: Date.now(), target, login: identity?.login, allowed, reason });

    if (!identity) {
      if (opts.allowLocal) {
        record(true, "loopback (allowLocal)");
        return opts.forward(target, req);
      }
      record(false, "no tailnet identity");
      return Promise.resolve(
        Response.json({ error: "no tailnet identity" }, { status: 403 }),
      );
    }

    const d = evaluateIdentity(opts.serves, target, identity);
    record(d.allowed, d.reason);
    if (!d.allowed) {
      return Promise.resolve(Response.json({ error: d.reason }, { status: 403 }));
    }
    return opts.forward(target, req);
  };
}

/**
 * A forward that posts the request to a celld node, routing to the object by the `x-object-id:
 * ns/obj` wire — the same convention the conformance engine uses (`celld.ts#exec`).
 */
export function celldForward(nodeUrl: string): ForwardFn {
  return async (target, req) => {
    const body = await req.arrayBuffer();
    return fetch(nodeUrl, {
      method: "POST",
      headers: {
        "x-object-id": target,
        "content-type": req.headers.get("content-type") ?? "application/json",
      },
      body: body.byteLength ? body : undefined,
    });
  };
}
