/**
 * env.AI — the OpenAI-compatible HTTP layer (contract C3).
 *
 * This module is pure: it maps OpenAI requests/responses to an `InferenceBackend` and knows
 * nothing about MLX, FFI, or any particular model runtime. The backend is injected, which is how
 * C3's "the backend is swappable behind the wire format" promise is realized concretely — deno-mlx
 * is one backend (see backend.ts), a llama-server proxy or an in-test fake are others. Keeping this
 * layer FFI-free is also what lets the contract test (server_test.ts) run without a model.
 *
 * Endpoints:
 *   POST /v1/chat/completions   streaming (SSE) and non-streaming
 *   POST /v1/embeddings         single string or array
 *   GET  /v1/models             models the backend has resident
 *   GET  /healthz
 */

export type Role = "system" | "user" | "assistant";
export interface ChatMessage {
  role: Role;
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  seed?: number;
}

/** The seam (C3): anything that can stream chat text and produce embeddings. */
export interface InferenceBackend {
  /** Stream assistant text deltas for a chat request. */
  chat(req: ChatRequest): AsyncIterable<string>;
  /** Embed each input; one vector per text, in order. */
  embed(model: string, texts: string[]): Promise<Float32Array[]>;
  /** Ids of models currently resident (for GET /v1/models). */
  residentModels?(): string[];
}

const DEFAULT_MAX_TOKENS = 512;

// ── OpenAI response helpers ──────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function oaiError(
  message: string,
  status: number,
  type = "invalid_request_error",
): Response {
  return json({ error: { message, type } }, status);
}

function parseChatRequest(body: Record<string, unknown>): ChatRequest {
  if (typeof body.model !== "string") throw new Error("missing `model`");
  if (!Array.isArray(body.messages)) throw new Error("`messages` must be an array");
  const messages = body.messages.map((m): ChatMessage => {
    const role = (m as ChatMessage)?.role;
    const content = (m as ChatMessage)?.content;
    if (role !== "system" && role !== "user" && role !== "assistant") {
      throw new Error(`unsupported message role: ${String(role)}`);
    }
    if (typeof content !== "string") {
      throw new Error("message `content` must be a string");
    }
    return { role, content };
  });
  return {
    model: body.model,
    messages,
    maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : DEFAULT_MAX_TOKENS,
    temperature: typeof body.temperature === "number" ? body.temperature : 0,
    ...(typeof body.seed === "number" ? { seed: body.seed } : {}),
  };
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async function chatCompletions(
  req: Request,
  backend: InferenceBackend,
): Promise<Response> {
  const raw = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!raw) return oaiError("invalid JSON body", 400);

  let parsed: ChatRequest;
  try {
    parsed = parseChatRequest(raw);
  } catch (e) {
    return oaiError((e as Error).message, 400);
  }

  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${created}-${Math.floor(Math.random() * 1e6)}`;

  if (raw.stream !== true) {
    let text = "";
    try {
      for await (const delta of backend.chat(parsed)) text += delta;
    } catch (e) {
      return oaiError((e as Error).message, 500, "server_error");
    }
    return json({
      id,
      object: "chat.completion",
      created,
      model: parsed.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      }],
    });
  }

  // Streaming: Server-Sent Events, one delta per chunk, terminated by [DONE].
  const encoder = new TextEncoder();
  const sse = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const frame = (delta: Record<string, unknown>, finish: string | null) => ({
        id,
        object: "chat.completion.chunk",
        created,
        model: parsed.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      try {
        send(frame({ role: "assistant" }, null));
        for await (const delta of backend.chat(parsed)) {
          send(frame({ content: delta }, null));
        }
        send(frame({}, "stop"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (e) {
        send({ error: { message: (e as Error).message, type: "server_error" } });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(sse, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    },
  });
}

async function embeddings(req: Request, backend: InferenceBackend): Promise<Response> {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.model !== "string") return oaiError("missing `model`", 400);

  const input = body.input;
  const texts = typeof input === "string"
    ? [input]
    : Array.isArray(input) && input.every((t) => typeof t === "string")
    ? input as string[]
    : null;
  if (!texts) return oaiError("`input` must be a string or string[]", 400);

  let vectors: Float32Array[];
  try {
    vectors = await backend.embed(body.model, texts);
  } catch (e) {
    return oaiError((e as Error).message, 500, "server_error");
  }
  return json({
    object: "list",
    model: body.model,
    data: vectors.map((v, index) => ({
      object: "embedding",
      index,
      embedding: Array.from(v),
    })),
  });
}

// ── App factory ──────────────────────────────────────────────────────────────

/** Build the request handler for a given inference backend. */
export function createApp(
  backend: InferenceBackend,
): (req: Request) => Promise<Response> {
  return (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);
    if (req.method === "GET" && pathname === "/healthz") {
      return Promise.resolve(new Response("ok"));
    }
    if (req.method === "GET" && pathname === "/v1/models") {
      const ids = backend.residentModels?.() ?? [];
      return Promise.resolve(json({
        object: "list",
        data: ids.map((id) => ({ id, object: "model", owned_by: "resagent" })),
      }));
    }
    if (req.method === "POST" && pathname === "/v1/chat/completions") {
      return chatCompletions(req, backend);
    }
    if (req.method === "POST" && pathname === "/v1/embeddings") {
      return embeddings(req, backend);
    }
    return Promise.resolve(
      oaiError(`no route for ${req.method} ${pathname}`, 404, "not_found"),
    );
  };
}
