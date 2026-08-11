/**
 * The scoped filesystem broker (M10) — the daemon brokers FS access on behalf of objects, since a
 * celld object can't touch the host FS itself. Every read/write/list checks the {@link GrantStore}
 * first and throws {@link GrantError} on a denial, so an object can only ever reach inside a granted
 * folder at the granted mode. This is the FS analog of the egress gate and the automation binding:
 * the policy decides, the broker enforces.
 *
 * `grantsService` adapts a store to the C5 read/write methods (grants.list / fs.read / fs.write), so
 * the daemon and the protocol tests share one mapping.
 */

import { canonicalize, type GrantStore } from "./grants.ts";
import type { FolderGrantInfo, FsWriteResult } from "../protocol/messages.ts";

export class GrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantError";
  }
}

export interface ScopedFs {
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  list(path: string): Promise<string[]>;
}

export function scopedFs(store: GrantStore): ScopedFs {
  const require = (path: string, mode: "read-only" | "read-write"): string => {
    const c = store.check(path, mode);
    if (!c.allowed) throw new GrantError(c.reason);
    return canonicalize(path);
  };
  return {
    // async so a synchronous grant-check failure surfaces as a rejected promise, not a throw.
    async read(path) {
      return await Deno.readTextFile(require(path, "read-only"));
    },
    async write(path, data) {
      await Deno.writeTextFile(require(path, "read-write"), data);
    },
    async list(path) {
      const dir = require(path, "read-only");
      const names: string[] = [];
      for await (const e of Deno.readDir(dir)) names.push(e.name);
      names.sort();
      return names;
    },
  };
}

/** The C5 grants surface for a store: grants.list (read) + fs.read/fs.write (the scoped pair). */
export function grantsService(store: GrantStore): {
  grantsList(): FolderGrantInfo[];
  fsRead(path: string): Promise<string>;
  fsWrite(path: string, data: string): Promise<FsWriteResult>;
} {
  const fs = scopedFs(store);
  return {
    grantsList: () =>
      store.list().map((g) => ({ path: g.path, mode: g.mode, grantedAt: g.grantedAt })),
    fsRead: (path) => fs.read(path),
    async fsWrite(path, data) {
      await fs.write(path, data);
      return { bytes: new TextEncoder().encode(data).length };
    },
  };
}
