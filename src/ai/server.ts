/**
 * env.AI — the OpenAI-compatible HTTP adapter (contract C3).
 *
 * Celld objects run in V8 and cannot use Deno FFI, so they can't call deno-mlx in-process.
 * Instead `env.AI` inside an object is an HTTP client to this adapter, which runs in-process to
 * the Deno Desktop shell and wraps `@deno-mlx/models` (MLX on Apple Silicon via `mlx-c` FFI).
 *
 * Endpoints (OpenAI wire format):
 *   POST /v1/chat/completions   streaming (SSE) and non-streaming
 *   POST /v1/embeddings         single string or array
 *   GET  /v1/models             models currently resident
 *   GET  /healthz
 *
 * Models are Hugging Face Hub repo ids (e.g. "HuggingFaceTB/SmolLM2-360M-Instruct"), loaded
 * lazily and cached. Run: `deno task env-ai` (needs `mlx-c` + a downloaded model — see
 * scripts/bootstrap.sh).
 */

import {
  type ChatMessage,
  type Embedder,
  generate,
  type GenerateOptions,
  loadEmbedder,
  loadModel,
  type LoadedModel,
} from "@deno-mlx/models";

const DEFAULT_MAX_TOKENS = 512;
const PORT = Number(Deno.env.get("RESAGENT_ENV_AI_PORT") ?? "8788");

// ── Model registry (lazy, cached, deduplicated) ──────────────────────────────

const chatModels = new Map<string, Promise<LoadedModel>>();
const embedders = new Map<string, Promise<Embedder>>();

function getChatModel(repoId: string): Promise<LoadedModel> {
  let m = chatModels.get(repoId);
  if (!m) {
    m = loadModel(repoId);
    chatModels.set(repoId, m);
  }
  return m;
}

function getEmbedder(repoId: string): Promise<Embedder> {
  let e = embedders.get(repoId);
  if (!e) {
    e = loadEmbedder(repoId);
    embedders.set(repoId, e);
  }
  return e;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function oaiError(message: string, status: number, type = "invalid_request_error"): Response {
  return json({ error: { message, type } }, status);
}

function genOptions(body: Record<string, unknown>): GenerateOptions {
  return {
    maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : DEFAULT_MAX_TOKENS,
    temperature: typeof body.temperature === "number" ? body.temperature : 0,
    ...(typeof body.seed === "number" ? { seed: body.seed } : {}),
  };
}

function toChatMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) throw new Error("`messages` must be an array");
  return raw.map((m) => {
    const role = (m as ChatMessage).role;
    const content = (m as ChatMessage).content;
    if (role !== "system" && role !== "user" && role !== "assistant") {
      throw new Error(`unsupported message role: ${String(role)}`);
    }
    if (typeof content !== "string") throw new Error("message `content` must be a string");
    return { role, content };
  });
}

// ── POST /v1/chat/completions ────────────────────────────────────────────────

async function chatCompletions(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.model !== "string") {
    return oaiError("missing `model`", 400);
  }

  let messages: ChatMessage[];
  try {
    messages = toChatMessages(body.messages);
  } catch (e) {
    return oaiError((e as Error).message, 400);
  }

  const loaded = await getChatModel(body.model);
  const promptIds = loaded.tokenizer.applyChatTemplate(messages);
  const opts = genOptions(body);
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${created}-${Math.floor(Math.random() * 1e6)}`;
  const stream = body.stream === true;

  if (!stream) {
    let text = "";
    for await (const tok of generate(loaded.model, loaded.tokenizer, promptIds, opts)) {
      text += tok.text;
    }
    return json({
      id,
      object: "chat.completion",
      created,
      model: body.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      }],
    });
  }

  // Streaming: Server-Sent Events, one delta per token, terminated by [DONE].
  const encoder = new TextEncoder();
  const sse = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const frame = (delta: Record<string, unknown>, finish: string | null) => ({
        id,
        object: "chat.completion.chunk",
        created,
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      try {
        send(frame({ role: "assistant" }, null));
        for await (const tok of generate(loaded.model, loaded.tokenizer, promptIds, opts)) {
          send(frame({ content: tok.text }, null));
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

// ── POST /v1/embeddings ──────────────────────────────────────────────────────

async function embeddings(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.model !== "string") return oaiError("missing `model`", 400);

  const input = body.input;
  const texts = typeof input === "string"
    ? [input]
    : Array.isArray(input) && input.every((t) => typeof t === "string")
    ? input as string[]
    : null;
  if (!texts) return oaiError("`input` must be a string or string[]", 400);

  const embedder = await getEmbedder(body.model);
  const vectors = embedder.embedAll(texts);
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

// ── Router ───────────────────────────────────────────────────────────────────

function route(req: Request): Promise<Response> | Response {
  const { pathname } = new URL(req.url);
  if (req.method === "GET" && pathname === "/healthz") return new Response("ok");
  if (req.method === "GET" && pathname === "/v1/models") {
    const data = [...chatModels.keys(), ...embedders.keys()].map((id) => ({
      id,
      object: "model",
      owned_by: "deno-mlx",
    }));
    return json({ object: "list", data });
  }
  if (req.method === "POST" && pathname === "/v1/chat/completions") return chatCompletions(req);
  if (req.method === "POST" && pathname === "/v1/embeddings") return embeddings(req);
  return oaiError(`no route for ${req.method} ${pathname}`, 404, "not_found");
}

if (import.meta.main) {
  Deno.serve({ port: PORT, hostname: "127.0.0.1" }, (req) => route(req));
  console.info(`env.AI adapter listening on http://127.0.0.1:${PORT} (backend: deno-mlx)`);
}

export { route };
