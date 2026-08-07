/**
 * Flagship: a research agent as a durable object (M5, primitive form).
 *
 * It survives reboots, wakes on an alarm, runs retrieval + synthesis through a local model via
 * `env.AI`, and writes findings to durable storage. In phase two it also writes to a granted
 * folder and pings a phone over the tailnet — those bindings are declared in resagent.hcl and
 * left as TODOs here.
 *
 * Contract C1: this uses only the standard Workers/Durable Objects surface — `DurableObject`,
 * `ctx.storage`, alarms, and a service binding (`env.AI`) reached over `fetch`. Nothing here is
 * Celld-specific, so the same bundle runs on Celld or on the Swift core.
 */

/// <reference types="npm:@cloudflare/workers-types" />

interface Env {
  /** Service binding to the env.AI adapter (OpenAI-compatible, contract C3). */
  AI: Fetcher;
  /** Research topic + cadence, injected from resagent.hcl. */
  TOPIC: string;
  MODEL: string;
  INTERVAL_MS: string;
}

interface Finding {
  at: number;
  summary: string;
}

export class ResearchAgent implements DurableObject {
  constructor(private ctx: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Start the agent: schedule the first wake if none is pending.
    if (url.pathname === "/start") {
      const existing = await this.ctx.storage.getAlarm();
      if (existing === null) {
        await this.ctx.storage.setAlarm(Date.now() + this.intervalMs());
      }
      return Response.json({ status: "scheduled", nextWakeInMs: this.intervalMs() });
    }

    // Inspect: what has the agent found so far? (Read like a resource fork.)
    if (url.pathname === "/findings") {
      const findings = (await this.ctx.storage.get<Finding[]>("findings")) ?? [];
      return Response.json({ topic: this.env.TOPIC, count: findings.length, findings });
    }

    return new Response("research-agent: POST /start, GET /findings", { status: 404 });
  }

  /** Alarm handler — the durable heartbeat. Runs even after a reboot. */
  async alarm(): Promise<void> {
    const context = await this.retrieve(this.env.TOPIC);
    const summary = await this.synthesize(this.env.TOPIC, context);

    const findings = (await this.ctx.storage.get<Finding[]>("findings")) ?? [];
    findings.push({ at: Date.now(), summary });
    await this.ctx.storage.put("findings", findings);

    // TODO(phase 2): write findings to env.FINDINGS (granted folder) and ping env.NOTIFY
    // (tailnet). Both are declared in resagent.hcl and gated through Claw Patrol.

    // Reschedule: this is what makes the agent long-lived and reboot-durable.
    await this.ctx.storage.setAlarm(Date.now() + this.intervalMs());
  }

  /** Retrieval (primitive): placeholder for embeddings-backed search over granted sources. */
  private retrieve(_topic: string): Promise<string> {
    // TODO(M5+): embeddings via env.AI /v1/embeddings over a granted corpus.
    return Promise.resolve("");
  }

  /** Synthesis: call the local model through the env.AI service binding (contract C3). */
  private async synthesize(topic: string, context: string): Promise<string> {
    const res = await this.env.AI.fetch("http://ai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.env.MODEL,
        messages: [
          { role: "system", content: "You are a concise research assistant." },
          {
            role: "user",
            content: `Summarize the latest on: ${topic}\n\nContext:\n${context}`,
          },
        ],
        max_tokens: 256,
      }),
    });
    if (!res.ok) throw new Error(`env.AI ${res.status}: ${await res.text()}`);
    const data = await res.json() as {
      choices: { message: { content: string } }[];
    };
    return data.choices[0]?.message?.content ?? "";
  }

  private intervalMs(): number {
    const n = Number(this.env.INTERVAL_MS);
    return Number.isFinite(n) && n > 0 ? n : 60 * 60 * 1000; // default: hourly
  }
}
