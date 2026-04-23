import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { NwsEmbeddingsService } from "../../../src/api/nws-embeddings/nws-embeddings.service.js";

describe("NwsEmbeddingsService", () => {
  const baseEnv = {
    NWS_EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
    OLLAMA_TIMEOUT_MS: "1000",
    QDRANT_URL: "http://qdrant.local",
    QDRANT_COLLECTION_NWS_ALERTS_NWS: "nws_alerts_embeddings_nws_v1",
    QDRANT_COLLECTION_NWS_ALERTS_SPC: "nws_alerts_embeddings_spc_v1",
    QDRANT_COLLECTION_NWS_ALERTS_WPC: "nws_alerts_embeddings_wpc_v1",
    QDRANT_COLLECTION_NWS_ALERTS_AIRNOW: "nws_alerts_embeddings_airnow_v1",
    QDRANT_DISTANCE: "Cosine",
    QDRANT_TIMEOUT_MS: "1000",
    NWS_INGEST_MAX_BATCH_SIZE: "10",
    NWS_INGEST_MAX_TEXT_CHARS: "2000",
  };

  beforeEach(() => {
    Object.assign(process.env, baseEnv);
  });

  it("ingests and deduplicates items before upsert", async () => {
    const ollama = {
      embedText: vi.fn(async () => [0.1, 0.2, 0.3]),
    } as any;
    const qdrant = {
      ensureCollection: vi.fn(async () => undefined),
      fetchPoints: vi.fn(async () => new Set<string>()),
      upsertPoints: vi.fn(async () => undefined),
    } as any;

    const service = new NwsEmbeddingsService(ollama, qdrant);

    const result = await service.ingestAlerts({
      items: [
        { source: "nws", sourceDocumentId: "1", embeddingText: "alpha" },
        { source: "nws", sourceDocumentId: "1", embeddingText: "alpha" },
        { source: "nws", sourceDocumentId: "2", embeddingText: "beta" },
      ],
    });

    expect(result.accepted).toBe(3);
    expect(result.processed).toBe(2);
    expect(result.upserted).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.vectorDimension).toBe(3);
    expect(result.collections).toEqual(["nws_alerts_embeddings_nws_v1"]);
    expect(ollama.embedText).toHaveBeenCalledTimes(2);
    expect(qdrant.ensureCollection).toHaveBeenCalledTimes(2);
    expect(qdrant.upsertPoints).toHaveBeenCalledTimes(1);
  });

  it("routes alert families to separate collections", async () => {
    const ollama = {
      embedText: vi.fn(async () => [0.1, 0.2, 0.3]),
    } as any;
    const qdrant = {
      ensureCollection: vi.fn(async () => undefined),
      fetchPoints: vi.fn(async () => new Set<string>()),
      upsertPoints: vi.fn(async () => undefined),
    } as any;

    const service = new NwsEmbeddingsService(ollama, qdrant);

    const result = await service.ingestAlerts({
      items: [
        { source: "nws", sourceDocumentId: "1", embeddingText: "alpha" },
        { source: "spc", sourceDocumentId: "2", embeddingText: "beta" },
      ],
    });

    expect(result.collections?.sort()).toEqual([
      "nws_alerts_embeddings_nws_v1",
      "nws_alerts_embeddings_spc_v1",
    ]);
    expect(qdrant.upsertPoints).toHaveBeenCalledTimes(2);
    expect(qdrant.upsertPoints).toHaveBeenCalledWith(
      expect.objectContaining({
        collectionName: "nws_alerts_embeddings_nws_v1",
      }),
    );
    expect(qdrant.upsertPoints).toHaveBeenCalledWith(
      expect.objectContaining({
        collectionName: "nws_alerts_embeddings_spc_v1",
      }),
    );
  });

  it("validates input payload", async () => {
    const service = new NwsEmbeddingsService({} as any, {} as any);
    await expect(
      service.ingestAlerts({ items: [] } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("maps upstream failures to service unavailable", async () => {
    const ollama = {
      embedText: vi.fn(async () => {
        throw new Error("ollama down");
      }),
    } as any;
    const qdrant = {
      ensureCollection: vi.fn(async () => undefined),
      fetchPoints: vi.fn(async () => new Set<string>()),
      upsertPoints: vi.fn(async () => undefined),
    } as any;

    const service = new NwsEmbeddingsService(ollama, qdrant);

    await expect(
      service.ingestAlerts({
        items: [
          { source: "nws", sourceDocumentId: "1", embeddingText: "alpha" },
        ],
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
