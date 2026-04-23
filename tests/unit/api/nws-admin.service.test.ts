import { BadRequestException } from "@nestjs/common";
import { NwsAdminService } from "../../../src/api/nws-admin/nws-admin.service.js";

describe("NwsAdminService", () => {
  beforeEach(() => {
    Object.assign(process.env, {
      NWS_EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
      OLLAMA_TIMEOUT_MS: "1000",
      QDRANT_URL: "http://qdrant.local",
      QDRANT_COLLECTION_NWS_ALERTS_NWS: "nws_alerts_embeddings_nws_v1",
      QDRANT_COLLECTION_NWS_ALERTS_SPC: "nws_alerts_embeddings_spc_v1",
      QDRANT_COLLECTION_NWS_ALERTS_WPC: "nws_alerts_embeddings_wpc_v1",
      QDRANT_COLLECTION_NWS_ALERTS_AIRNOW: "nws_alerts_embeddings_airnow_v1",
      QDRANT_TIMEOUT_MS: "1000",
      QDRANT_DISTANCE: "Cosine",
      QDRANT_VECTOR_SIZE: "384",
    });
  });

  it("returns collection stats", async () => {
    const ollama = { embedText: vi.fn() } as any;
    const qdrant = {
      getCollectionInfo: vi.fn(
        async ({ collectionName }: { collectionName: string }) => ({
          name: collectionName,
        }),
      ),
      countPoints: vi.fn(
        async ({ collectionName }: { collectionName: string }) => {
          const counts: Record<string, number> = {
            nws_alerts_embeddings_nws_v1: 10,
            nws_alerts_embeddings_spc_v1: 4,
            nws_alerts_embeddings_wpc_v1: 2,
            nws_alerts_embeddings_airnow_v1: 1,
          };
          return counts[collectionName] ?? 0;
        },
      ),
    } as any;

    const service = new NwsAdminService(ollama, qdrant);
    const result = await service.getCollectionStats();

    expect(result.totalPointsCount).toBe(17);
    expect(result.collections.map((item) => item.collection)).toEqual([
      "nws_alerts_embeddings_nws_v1",
      "nws_alerts_embeddings_spc_v1",
      "nws_alerts_embeddings_wpc_v1",
      "nws_alerts_embeddings_airnow_v1",
    ]);
  });

  it("supports dry run delete by filter", async () => {
    const service = new NwsAdminService(
      {} as any,
      {
        countPoints: vi.fn(async () => 5),
        deletePointsByFilter: vi.fn(async () => undefined),
      } as any,
    );

    const result = await service.deleteByFilter({
      filter: { source: "nws-active" },
      dryRun: true,
    });

    expect(result.beforeCount).toBe(5);
    expect(result.deleted).toBe(0);
  });

  it("validates reset confirm flag", async () => {
    const service = new NwsAdminService({} as any, {} as any);
    await expect(
      service.resetCollection({ confirm: false }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("resets all alert collections", async () => {
    const service = new NwsAdminService(
      {} as any,
      {
        getCollectionInfo: vi.fn(async () => ({ points_count: 1 })),
        deleteCollection: vi.fn(async () => undefined),
        ensureCollection: vi.fn(async () => undefined),
      } as any,
    );

    const result = await service.resetCollection({ confirm: true });

    expect(result.reset).toBe(true);
    expect(result.collections).toHaveLength(4);
    expect(result.collections.every((item) => item.reset)).toBe(true);
  });

  it("reindexes in dry-run mode without embedding calls", async () => {
    const ollama = { embedText: vi.fn() } as any;
    const qdrant = {
      getCollectionInfo: vi.fn(async () => ({ points_count: 1 })),
      scrollPoints: vi.fn(async () => ({
        points: [{ id: "p1", payload: { embeddingText: "text" } }],
        nextOffset: undefined,
      })),
    } as any;

    const service = new NwsAdminService(ollama, qdrant);
    const result = await service.reindex({
      dryRun: true,
      limit: 10,
      batchSize: 10,
    });

    expect(result.dryRun).toBe(true);
    expect(result.processed).toBe(4);
    expect(result.collections).toHaveLength(4);
    expect(ollama.embedText).not.toHaveBeenCalled();
  });

  it("reindexes only the matching family collection when source is provided", async () => {
    const ollama = { embedText: vi.fn() } as any;
    const qdrant = {
      getCollectionInfo: vi.fn(async () => ({ points_count: 1 })),
      scrollPoints: vi.fn(async () => ({
        points: [{ id: "spc-1", payload: { embeddingText: "text" } }],
        nextOffset: undefined,
      })),
    } as any;

    const service = new NwsAdminService(ollama, qdrant);
    const result = await service.reindex({
      dryRun: true,
      filter: { source: "spc" },
      limit: 10,
      batchSize: 10,
    });

    expect(result.processed).toBe(1);
    expect(result.collections).toEqual([
      {
        collection: "nws_alerts_embeddings_spc_v1",
        matched: 1,
        processed: 1,
        reindexed: 0,
        skipped: 0,
      },
    ]);
  });
});
