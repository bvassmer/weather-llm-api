import { NwsAdminController } from "../../../src/api/nws-admin/nws-admin.controller.js";
import { NwsAnswerController } from "../../../src/api/nws-answer/nws-answer.controller.js";
import { NwsEmbeddingsController } from "../../../src/api/nws-embeddings/nws-embeddings.controller.js";
import { NwsSearchController } from "../../../src/api/nws-search/nws-search.controller.js";

describe("API controllers", () => {
  it("delegates embeddings ingest to service", async () => {
    const service = {
      ingestAlerts: vi.fn(async () => ({ upserted: 1 })),
    } as any;

    const controller = new NwsEmbeddingsController(service);
    const body = {
      items: [{ source: "nws", sourceDocumentId: "1", embeddingText: "x" }],
    };

    const result = await controller.ingest(body as any);
    expect(service.ingestAlerts).toHaveBeenCalledWith(body);
    expect(result).toEqual({ upserted: 1 });
  });

  it("delegates search to service", async () => {
    const service = {
      search: vi.fn(async () => ({ hits: [] })),
    } as any;

    const controller = new NwsSearchController(service);
    const body = { query: "storm" };

    const result = await controller.search(body as any);
    expect(service.search).toHaveBeenCalledWith(body);
    expect(result).toEqual({ hits: [] });
  });

  it("streams answer events over SSE", async () => {
    const service = {
      streamAnswer: vi.fn(async (_body, handlers) => {
        handlers.onStage({ type: "stage", stage: "constraints_started" });
        handlers.onComplete({
          type: "complete",
          response: {
            question: "What now?",
            answer: "ok",
            model: "qwen2.5:14b",
            citations: [],
          },
        });
      }),
    } as any;

    const controller = new NwsAnswerController(service);
    const body = { question: "What now?" };
    const req = {
      on: vi.fn(),
      removeListener: vi.fn(),
    } as any;
    const res = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      writableEnded: false,
    } as any;

    await controller.answer(body as any, req, res);
    expect(service.streamAnswer).toHaveBeenCalledWith(
      body,
      expect.objectContaining({
        onStage: expect.any(Function),
        onToken: expect.any(Function),
        onComplete: expect.any(Function),
      }),
      expect.any(Object),
    );
    expect(res.write).toHaveBeenCalled();
    expect(res.end).toHaveBeenCalled();
  });

  it("delegates admin operations", async () => {
    const service = {
      getCollectionStats: vi.fn(async () => ({ pointsCount: 1 })),
      deleteByFilter: vi.fn(async () => ({ deleted: 0 })),
      reindex: vi.fn(async () => ({ processed: 0 })),
      resetCollection: vi.fn(async () => ({ reset: true })),
    } as any;

    const controller = new NwsAdminController(service);

    await expect(controller.getCollectionStats()).resolves.toEqual({
      pointsCount: 1,
    });
    await expect(
      controller.deleteByFilter({ filter: { source: "nws" } } as any),
    ).resolves.toEqual({ deleted: 0 });
    await expect(controller.reindex({ dryRun: true } as any)).resolves.toEqual({
      processed: 0,
    });
    await expect(
      controller.resetCollection({ confirm: true } as any),
    ).resolves.toEqual({ reset: true });
  });
});
