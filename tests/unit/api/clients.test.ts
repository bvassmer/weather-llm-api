import { OllamaGenerationClient } from "../../../src/api/nws-answer/ollama-generation.client.js";
import { InProcessEmbeddingClient } from "../../../src/api/nws-embeddings/in-process-embedding.client.js";
import { QdrantClient } from "../../../src/api/nws-embeddings/qdrant.client.js";

describe("API clients", () => {
  describe("InProcessEmbeddingClient", () => {
    afterEach(() => {
      InProcessEmbeddingClient.resetPipelineFactoryForTesting();
    });

    it("returns embedding from tensor-like output", async () => {
      const pipeline = vi.fn(async () => ({
        data: Float32Array.from([0.1, 0.2]),
      }));
      InProcessEmbeddingClient.setPipelineFactoryForTesting(
        vi.fn(async () => pipeline as any),
      );

      const client = new InProcessEmbeddingClient();
      const vector = await client.embedText("test", {
        model: "Xenova/all-MiniLM-L6-v2",
        timeoutMs: 1000,
      });

      expect(vector[0]).toBeCloseTo(0.1, 6);
      expect(vector[1]).toBeCloseTo(0.2, 6);
    });

    it("wraps local model failures as service unavailable", async () => {
      InProcessEmbeddingClient.setPipelineFactoryForTesting(
        vi.fn(async () => {
          throw new Error("model download failed");
        }),
      );

      const client = new InProcessEmbeddingClient();
      await expect(
        client.embedText("test", {
          model: "Xenova/all-MiniLM-L6-v2",
          timeoutMs: 1000,
        }),
      ).rejects.toThrow("In-process embedding failed");
    });
  });

  describe("OllamaGenerationClient", () => {
    it("returns generated text", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: " summary " }),
      } as any);

      const client = new OllamaGenerationClient();
      await expect(
        client.generate({
          baseUrl: "http://ollama.local",
          model: "qwen2.5:14b",
          prompt: "Prompt",
          timeoutMs: 1000,
          temperature: 0.2,
          maxTokens: 100,
        }),
      ).resolves.toBe("summary");
    });

    it("wraps terminated upstream errors as service unavailable", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({ error: "terminated" }),
      } as any);

      const client = new OllamaGenerationClient();
      await expect(
        client.generate({
          baseUrl: "http://ollama.local",
          model: "qwen2.5:14b",
          prompt: "Prompt",
          timeoutMs: 1000,
          temperature: 0.2,
          maxTokens: 100,
        }),
      ).rejects.toThrow("terminated before completion");
    });
  });

  describe("QdrantClient", () => {
    it("skips ensureCollection when collection already exists", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
      } as any);

      const client = new QdrantClient();
      await client.ensureCollection({
        baseUrl: "http://qdrant.local",
        collectionName: "nws",
        vectorSize: 2,
        distance: "Cosine",
        timeoutMs: 1000,
      });

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("maps search response points", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: [{ id: 1, score: 0.9, payload: { source: "nws" } }],
        }),
      } as any);

      const client = new QdrantClient();
      const result = await client.searchPoints({
        baseUrl: "http://qdrant.local",
        collectionName: "nws",
        vector: [0.1, 0.2],
        limit: 3,
        timeoutMs: 1000,
      });

      expect(result).toEqual([
        { id: "1", score: 0.9, payload: { source: "nws" } },
      ]);
    });
  });
});
