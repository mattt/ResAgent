/**
 * The celld alarm-gap probe.
 *
 * The conformance corpus proved *that* celld's alarm handling diverges from workerd (the far-future
 * `setAlarm` case panics the node); this probe characterizes *where* the cliff is. It sweeps a
 * matrix of `setAlarm` deadlines from +2s out to past-2189 and, for each, records whether the engine
 * ACCEPTED it, returned an ERROR (a live node's error frame), or NODE-PANICKED (the connection died —
 * celld's whole-node crash). For an accepted alarm it round-trips `getAlarm`, and for the +2s row it
 * waits ~4s and re-reads `getAlarm` as fire evidence (a fired alarm reads back as null).
 *
 * Engine-neutral: it drives the same {@link Engine} the conformance harness uses, so it runs against
 * `celld` (local-only — the binary isn't in CI, exactly like `conformance:celld`) or `workerd` (the
 * oracle, downloadable via npm — runs here). The workerd column is the ground-truth reference the
 * celld column is read against.
 *
 *   deno task probe:alarm            # celld (local-only)
 *   deno task probe:alarm workerd    # workerd oracle — runs here
 */

import type { Engine, EngineInstance } from "./engine.ts";
import { celldEngine } from "./celld.ts";
import { workerdEngine } from "./workerd.ts";

/** ~4s: long enough for a +2s alarm to have fired before we re-read it. */
const FIRE_WAIT_MS = 4000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type AlarmOutcome = "accepted" | "error" | "node-panic";

/** One row of the deadline sweep. */
interface DeadlineSpec {
  label: string;
  deadline: number;
  /** Wait ~4s after an accepted setAlarm and re-read getAlarm as fire evidence (+2s only). */
  waitFire?: boolean;
}

export interface AlarmProbeRow {
  label: string;
  deadline: number;
  outcome: AlarmOutcome;
  /** Error/panic detail, if the setAlarm did not succeed. */
  detail?: string;
  /** getAlarm value after an accepted setAlarm. */
  getAlarm?: number | null;
  /** Did getAlarm read back the deadline we set? */
  roundTrip?: boolean;
  /** For the +2s row: did the alarm fire (getAlarm === null after the wait)? */
  fired?: boolean;
}

export interface AlarmProbeReport {
  engine: string;
  rows: AlarmProbeRow[];
}

/** The deadline matrix, computed relative to `now` for the near rows and absolute for the far ones. */
export function deadlineMatrix(now: number): DeadlineSpec[] {
  const DAY = 86_400_000;
  return [
    { label: "+2s", deadline: now + 2_000, waitFire: true },
    { label: "+1min", deadline: now + 60_000 },
    { label: "+1h", deadline: now + 3_600_000 },
    { label: "+1d", deadline: now + DAY },
    { label: "+30d", deadline: now + 30 * DAY },
    { label: "+1y", deadline: now + 365 * DAY },
    { label: "+10y", deadline: now + 3650 * DAY },
    { label: "year 2100", deadline: Date.UTC(2100, 0, 1) },
    { label: "year 2188 (under cliff)", deadline: Date.UTC(2188, 0, 1) },
    { label: "year 2190 (over cliff)", deadline: Date.UTC(2190, 0, 1) },
  ];
}

/**
 * A live node reports a rejected op as an HTTP error frame the adapter surfaces as `<engine> NNN:
 * …`; anything else (a torn-down connection) means the node itself died — a celld panic.
 */
function classifyFailure(err: unknown): { outcome: AlarmOutcome; detail: string } {
  const detail = err instanceof Error ? err.message : String(err);
  const liveError = /^(celld|workerd)\s+\d+:/.test(detail);
  return { outcome: liveError ? "error" : "node-panic", detail };
}

async function safeGetAlarm(inst: EngineInstance, obj: string): Promise<number | null> {
  const v = await inst.exec(obj, { kind: "getAlarm" });
  return typeof v === "number" ? v : null;
}

async function probeRow(
  engine: Engine,
  index: number,
  spec: DeadlineSpec,
): Promise<AlarmProbeRow> {
  const obj = `probe-${index}`;
  // A fresh instance per row: for celld this reboots a node a previous row may have panicked.
  const inst = await engine.create();
  try {
    await inst.exec(obj, { kind: "setAlarm", scheduledTime: spec.deadline });
  } catch (e) {
    return { label: spec.label, deadline: spec.deadline, ...classifyFailure(e) };
  }

  const row: AlarmProbeRow = {
    label: spec.label,
    deadline: spec.deadline,
    outcome: "accepted",
  };
  try {
    const got = await safeGetAlarm(inst, obj);
    row.getAlarm = got;
    row.roundTrip = got === spec.deadline;
    if (spec.waitFire) {
      await sleep(FIRE_WAIT_MS);
      row.fired = (await safeGetAlarm(inst, obj)) === null;
    }
  } catch (e) {
    // setAlarm was accepted, but reading it back failed — for a fire-wait row that means the engine
    // did not survive the alarm actually firing (a finding in itself); otherwise the node died after
    // accepting. Either way the accept stands; the read failure is a note, not a rejected setAlarm.
    const c = classifyFailure(e);
    row.detail = spec.waitFire
      ? `engine did not survive the fire window (${c.detail})`
      : `after accept: ${c.detail}`;
  }
  return row;
}

export async function probeAlarms(engine: Engine): Promise<AlarmProbeReport> {
  const specs = deadlineMatrix(Date.now());
  const rows: AlarmProbeRow[] = new Array(specs.length);
  // Run every non-firing row first, and any fire-wait row LAST. A live +2s alarm firing mid-sweep
  // can tear down a shared-process engine (observed on workerd's in-memory `serve` build, which
  // exits on live alarm delivery); running it last keeps that from cascading as false panics into
  // the deadline rows. celld recovers between rows via its node auto-reboot regardless. Results are
  // stored by matrix index so the printed table keeps the natural deadline order.
  const order = [...specs.keys()].sort(
    (a, b) => Number(Boolean(specs[a].waitFire)) - Number(Boolean(specs[b].waitFire)),
  );
  for (const i of order) rows[i] = await probeRow(engine, i, specs[i]);
  return { engine: engine.name, rows };
}

const MARK: Record<AlarmOutcome, string> = {
  "accepted": "✓ accept",
  "error": "· error ",
  "node-panic": "✗ PANIC ",
};

export function formatAlarmProbe(report: AlarmProbeReport): string {
  const lines = [`alarm probe: ${report.engine}`];
  for (const r of report.rows) {
    const iso = new Date(r.deadline).toISOString();
    const parts = [`  ${MARK[r.outcome]}  ${r.label.padEnd(24)} ${iso}`];
    if (r.outcome === "accepted") {
      parts.push(r.roundTrip ? "getAlarm ✓" : `getAlarm=${r.getAlarm}`);
      if (r.fired !== undefined) parts.push(r.fired ? "fired ✓" : "did not fire");
    }
    if (r.detail) parts.push(`(${r.detail})`);
    lines.push(parts.join("  "));
  }
  const panics = report.rows.filter((r) => r.outcome === "node-panic").length;
  lines.push(
    panics > 0
      ? `${panics} deadline(s) panicked the node`
      : "no node panics — every deadline accepted or errored cleanly",
  );
  return lines.join("\n");
}

function engineByName(name: string): Engine {
  switch (name) {
    case "celld":
      return celldEngine();
    case "workerd":
      return workerdEngine();
    default:
      throw new Error(`unknown engine "${name}" (have: celld, workerd)`);
  }
}

if (import.meta.main) {
  const engine = engineByName(Deno.args[0] ?? "celld");
  try {
    const report = await probeAlarms(engine);
    console.log(formatAlarmProbe(report));
  } finally {
    await engine.close?.();
  }
}
