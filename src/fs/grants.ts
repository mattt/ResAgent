/**
 * Folder grants (M10) — the persisted allow-list of directories objects may touch, and the
 * canonicalization + boundary logic that makes "granted" mean what it says.
 *
 * A grant is a canonical path + a mode (read-only / read-write). {@link canonicalize} expands `~`,
 * normalizes `.`/`..`, and `realpath`s the deepest EXISTING ancestor — so a symlink can't smuggle a
 * path outside its grant (the classic escape). {@link GrantStore.check} is deny-closed and
 * boundary-aware: `/foo` grants `/foo/bar` but NOT `/foobar`, and a write demands a read-write grant.
 * Persisted at ~/.resagent/grants.json with the same atomic tmp+rename writes as the object registry.
 *
 * This is the non-sandboxed-Deno stand-in for macOS security-scoped bookmarks (meaningless for a
 * non-sandboxed process); the Swift hedge upgrades to real bookmarks behind the same interface.
 */

import { basename, dirname, join, resolve } from "jsr:@std/path@^1";

const HOME = Deno.env.get("HOME") ?? "";

export type GrantMode = "read-only" | "read-write";

export interface Grant {
  /** Canonical absolute path (symlinks in the existing ancestor resolved). */
  path: string;
  mode: GrantMode;
  grantedAt: number;
}

export interface GrantCheck {
  allowed: boolean;
  reason: string;
  grant?: Grant;
}

export interface GrantStore {
  list(): Grant[];
  /** Add or update a grant (upsert by canonical path); persists. */
  grant(path: string, mode: GrantMode, at?: number): Grant;
  /** Remove a grant; returns whether one was removed. Persists. */
  revoke(path: string): boolean;
  /** Is `path` covered by a grant at the requested `mode`? Deny-closed, boundary-aware. */
  check(path: string, mode?: GrantMode): GrantCheck;
}

function expandHome(p: string): string {
  if (p === "~") return HOME || p;
  if (p.startsWith("~/")) return HOME ? HOME + p.slice(1) : p;
  return p;
}

/**
 * Resolve `input` to a canonical absolute path: expand `~`, normalize, then realpath the deepest
 * existing ancestor and re-append the non-existing tail literally. The realpath step is the
 * symlink-escape defense — a grant on `/safe` can't be dodged via `/safe/link → /etc`.
 */
export function canonicalize(input: string): string {
  const abs = resolve(expandHome(input));
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = Deno.realPathSync(head);
      return tail.length ? join(real, ...tail) : real;
    } catch {
      const parent = dirname(head);
      if (parent === head) return abs; // reached root; nothing exists — normalized abs is canonical
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

/** Boundary-aware containment: `/foo` contains `/foo` and `/foo/bar`, but not `/foobar`. */
function contains(parent: string, child: string): boolean {
  if (child === parent) return true;
  const p = parent.endsWith("/") ? parent : `${parent}/`;
  return child.startsWith(p);
}

function makeStore(
  initial: Grant[],
  persist: (grants: Grant[]) => void,
): GrantStore {
  const grants = [...initial];

  const store: GrantStore = {
    list: () => [...grants],

    grant(path, mode, at) {
      const canonical = canonicalize(path);
      const grantedAt = at ?? Date.now();
      const existing = grants.find((g) => g.path === canonical);
      if (existing) {
        existing.mode = mode;
        existing.grantedAt = grantedAt;
      } else {
        grants.push({ path: canonical, mode, grantedAt });
      }
      persist(grants);
      return grants.find((g) => g.path === canonical)!;
    },

    revoke(path) {
      const canonical = canonicalize(path);
      const i = grants.findIndex((g) => g.path === canonical);
      if (i < 0) return false;
      grants.splice(i, 1);
      persist(grants);
      return true;
    },

    check(path, mode = "read-only") {
      const target = canonicalize(path);
      const grant = grants.find((g) => contains(g.path, target));
      if (!grant) return { allowed: false, reason: `no grant covers ${target}` };
      if (mode === "read-write" && grant.mode !== "read-write") {
        return { allowed: false, reason: `grant for ${grant.path} is read-only`, grant };
      }
      return {
        allowed: true,
        reason: `covered by grant ${grant.path} (${grant.mode})`,
        grant,
      };
    },
  };
  return store;
}

function readGrants(path: string): Grant[] | null {
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((g): g is Grant =>
      g && typeof g.path === "string" &&
      (g.mode === "read-only" || g.mode === "read-write") &&
      typeof g.grantedAt === "number"
    );
  } catch {
    return null; // corrupt file: recover to the seed
  }
}

function writeGrants(path: string, grants: Grant[]): void {
  const dir = dirname(path);
  try {
    Deno.mkdirSync(dir, { recursive: true });
  } catch { /* exists */ }
  const tmp = `${path}.tmp-${Deno.pid}`;
  Deno.writeTextFileSync(tmp, JSON.stringify(grants, null, 2));
  Deno.renameSync(tmp, path);
}

/** A file-backed grant store at `path` (default ~/.resagent/grants.json). */
export function fileGrantStore(path?: string, seed: Grant[] = []): GrantStore {
  const file = path ?? `${HOME || "."}/.resagent/grants.json`;
  const loaded = readGrants(file);
  const initial = loaded ?? seed;
  const store = makeStore(initial, (grants) => writeGrants(file, grants));
  if (loaded === null && seed.length > 0) writeGrants(file, initial);
  return store;
}

/** An in-memory grant store (tests). */
export function memoryGrantStore(seed: Grant[] = []): GrantStore {
  return makeStore(seed, () => {});
}
