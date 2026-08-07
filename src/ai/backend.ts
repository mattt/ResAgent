/**
 * The deno-mlx inference backend (contract C3 implementation).
 *
 * Implements `InferenceBackend` over `@deno-mlx/models`: MLX on Apple Silicon via `mlx-c` FFI.
 * Models are Hugging Face Hub repo ids, loaded lazily from the shared HF cache and cached in
 * process. This is the only file that touches FFI — keeping it out of server.ts is what lets the
 * contract test run without a model.
 */

import {
  type Embedder,
  generate,
  type GenerateOptions,
  type LoadedModel,
  loadEmbedder,
  loadModel,
} from "@deno-mlx/models";
import type { ChatRequest, InferenceBackend } from "./server.ts";

export function denoMlxBackend(): InferenceBackend {
  const chatModels = new Map<string, Promise<LoadedModel>>();
  const embedders = new Map<string, Promise<Embedder>>();

  const getChatModel = (repoId: string): Promise<LoadedModel> => {
    let m = chatModels.get(repoId);
    if (!m) {
      m = loadModel(repoId);
      chatModels.set(repoId, m);
    }
    return m;
  };

  const getEmbedder = (repoId: string): Promise<Embedder> => {
    let e = embedders.get(repoId);
    if (!e) {
      e = loadEmbedder(repoId);
      embedders.set(repoId, e);
    }
    return e;
  };

  return {
    async *chat(req: ChatRequest): AsyncIterable<string> {
      const loaded = await getChatModel(req.model);
      const promptIds = loaded.tokenizer.applyChatTemplate(req.messages);
      const opts: GenerateOptions = {
        maxTokens: req.maxTokens,
        temperature: req.temperature,
        ...(req.seed !== undefined ? { seed: req.seed } : {}),
      };
      for await (const tok of generate(loaded.model, loaded.tokenizer, promptIds, opts)) {
        yield tok.text;
      }
    },

    async embed(model: string, texts: string[]): Promise<Float32Array[]> {
      const embedder = await getEmbedder(model);
      return embedder.embedAll(texts);
    },

    residentModels(): string[] {
      return [...chatModels.keys(), ...embedders.keys()];
    },
  };
}
