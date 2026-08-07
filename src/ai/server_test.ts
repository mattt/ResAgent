/**
 * Contract test for C3: env.AI speaks the OpenAI wire format.
 *
 * Drives the pure HTTP layer (createApp) with a deterministic fake backend, so it runs with no
 * permissions and no model — verifying request parsing, response shapes, SSE framing, and error
 * mapping independently of deno-mlx. This is what flips C3 from stubbed to enforced.
 */

import { assert, assertEquals } from "jsr:@std/assert@^1";
import { createApp, type InferenceBackend } from "./server.ts";

/** Deterministic backend: chat streams "Hello world" as two deltas; embed encodes text length. */
const fake: InferenceBackend = {
  async *chat(_req) {
    yield "Hello";
    yield " world";
  },
  embed(_model, texts) {
    return Promise.resolve(texts.map((t, i) => new Float32Array([t.length, i])));
  },
  residentModels() {
    return ["fake/model"];
  },
};

const post = (path: string, body: unknown) =>
  createApp(fake)(
    new Request(`http://ai${path}`, { method: "POST", body: JSON.stringify(body) }),
  );

Deno.test("chat completions (non-streaming) return the OpenAI shape", async () => {
  const res = await post("/v1/chat/completions", {
    model: "fake/model",
    messages: [{ role: "user", content: "hi" }],
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.object, "chat.completion");
  assertEquals(body.model, "fake/model");
  assertEquals(body.choices[0].message.role, "assistant");
  assertEquals(body.choices[0].message.content, "Hello world");
  assertEquals(body.choices[0].finish_reason, "stop");
});

Deno.test("chat completions (streaming) emit role, content deltas, stop, then [DONE]", async () => {
  const res = await post("/v1/chat/completions", {
    model: "fake/model",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  assertEquals(res.headers.get("content-type"), "text/event-stream");

  const payloads = (await res.text())
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice("data: ".length));

  assertEquals(payloads.at(-1), "[DONE]");
  const chunks = payloads.slice(0, -1).map((p) => JSON.parse(p));
  for (const c of chunks) assertEquals(c.object, "chat.completion.chunk");
  assertEquals(chunks[0].choices[0].delta.role, "assistant");
  const content = chunks.map((c) => c.choices[0].delta.content ?? "").join("");
  assertEquals(content, "Hello world");
  assertEquals(chunks.at(-1).choices[0].finish_reason, "stop");
});

Deno.test("embeddings accept a string and a string[]", async () => {
  const one = await (await post("/v1/embeddings", { model: "fake/model", input: "abc" }))
    .json();
  assertEquals(one.object, "list");
  assertEquals(one.data.length, 1);
  assertEquals(one.data[0].object, "embedding");
  assert(Array.isArray(one.data[0].embedding));

  const many =
    await (await post("/v1/embeddings", { model: "fake/model", input: ["a", "bb"] }))
      .json();
  assertEquals(many.data.length, 2);
  assertEquals(many.data[1].index, 1);
});

Deno.test("GET /v1/models lists resident models", async () => {
  const res = await createApp(fake)(new Request("http://ai/v1/models"));
  const body = await res.json();
  assertEquals(body.object, "list");
  assertEquals(body.data[0].id, "fake/model");
});

Deno.test("GET /healthz returns ok", async () => {
  const res = await createApp(fake)(new Request("http://ai/healthz"));
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "ok");
});

Deno.test("missing model -> 400 with an OpenAI error body", async () => {
  const res = await post("/v1/chat/completions", { messages: [] });
  assertEquals(res.status, 400);
  const body = await res.json();
  assert(String(body.error.message).includes("model"));
});

Deno.test("invalid message role -> 400", async () => {
  const res = await post("/v1/chat/completions", {
    model: "m",
    messages: [{ role: "boss", content: "x" }],
  });
  assertEquals(res.status, 400);
});

Deno.test("unknown route -> 404", async () => {
  const res = await createApp(fake)(new Request("http://ai/nope"));
  assertEquals(res.status, 404);
});

Deno.test("backend failure -> 500", async () => {
  const boom: InferenceBackend = {
    // deno-lint-ignore require-yield
    async *chat() {
      throw new Error("boom");
    },
    embed() {
      return Promise.resolve([]);
    },
  };
  const res = await createApp(boom)(
    new Request("http://ai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }] }),
    }),
  );
  assertEquals(res.status, 500);
});
