import { HttpException, HttpStatus } from "@nestjs/common";
import { AppController } from "../../src/app.controller.js";

const makeController = (
  prismaOverrides?: Partial<{ $queryRaw: () => Promise<unknown> }>,
  queueOverrides?: Partial<{ getQueueHealth: () => Promise<unknown> }>,
  generationOverrides?: Partial<{
    generate: (options: unknown) => Promise<string>;
  }>,
  embeddingOverrides?: Partial<{
    embedText: (text: string, options: unknown) => Promise<number[]>;
  }>,
) => {
  const prismaService = {
    $queryRaw: vi.fn(async () => 1),
    ...prismaOverrides,
  } as any;
  const queueService = {
    getQueueHealth: vi.fn(async () => ({
      status: "healthy",
      stats: { pending: 0, retrying: 0, processing: 0, completed: 5, dead: 0 },
    })),
    ...queueOverrides,
  } as any;
  const generationClient = {
    generate: vi.fn(async () => "ok"),
    ...generationOverrides,
  } as any;
  const embeddingClient = {
    embedText: vi.fn(async () => [0.1, 0.2, 0.3]),
    ...embeddingOverrides,
  } as any;

  return new AppController(
    prismaService,
    queueService,
    generationClient,
    embeddingClient,
  );
};

describe("AppController", () => {
  it("returns healthy payload when database query succeeds", async () => {
    const prismaService = {
      $queryRaw: vi.fn(async () => 1),
    } as any;
    const queueService = { getQueueHealth: vi.fn() } as any;
    const generationClient = { generate: vi.fn() } as any;
    const embeddingClient = { embedText: vi.fn() } as any;

    const controller = new AppController(
      prismaService,
      queueService,
      generationClient,
      embeddingClient,
    );
    const result = await controller.getHealth();

    expect(prismaService.$queryRaw).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: "ok",
      service: "weather-llm-api",
      database: "connected",
    });
  });

  it("throws SERVICE_UNAVAILABLE when database query fails", async () => {
    const controller = makeController({
      $queryRaw: async () => {
        throw new Error("Connection refused");
      },
    });

    await expect(controller.getHealth()).rejects.toThrow(HttpException);

    try {
      await controller.getHealth();
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      const ex = e as HttpException;
      expect(ex.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      const body = ex.getResponse() as Record<string, unknown>;
      expect(body.status).toBe("degraded");
      expect(body.database).toBe("error");
      expect(body.error).toBe("Connection refused");
    }
  });

  it("returns generation health payload when inference probe succeeds", async () => {
    process.env.OLLAMA_CHAT_MODEL = "qwen3:1.7b";

    const controller = makeController(
      undefined,
      undefined,
      {
        generate: vi.fn(async () => "ok"),
      },
      undefined,
    );

    const result = await controller.getGenerationHealth();
    expect(result).toEqual({
      status: "ok",
      service: "weather-llm-api",
      generation: {
        model: "qwen3:1.7b",
        responseChars: 2,
      },
    });
  });

  it("throws SERVICE_UNAVAILABLE when generation probe fails", async () => {
    process.env.OLLAMA_CHAT_MODEL = "qwen3:1.7b";

    const controller = makeController(
      undefined,
      undefined,
      {
        generate: async () => {
          throw new Error("generation offline");
        },
      },
      undefined,
    );

    await expect(controller.getGenerationHealth()).rejects.toThrow(
      HttpException,
    );
  });

  it("returns embedding health payload when embed probe succeeds", async () => {
    process.env.NWS_EMBEDDING_MODEL = "mini-embed";

    const controller = makeController(undefined, undefined, undefined, {
      embedText: vi.fn(async () => [0.1, 0.2, 0.3, 0.4]),
    });

    const result = await controller.getEmbeddingHealth();
    expect(result).toEqual({
      status: "ok",
      service: "weather-llm-api",
      embedding: {
        model: "mini-embed",
        vectorDimension: 4,
      },
    });
  });

  it("throws SERVICE_UNAVAILABLE when embed probe fails", async () => {
    process.env.NWS_EMBEDDING_MODEL = "mini-embed";

    const controller = makeController(undefined, undefined, undefined, {
      embedText: async () => {
        throw new Error("embed offline");
      },
    });

    await expect(controller.getEmbeddingHealth()).rejects.toThrow(
      HttpException,
    );
  });

  describe("getQueueHealth", () => {
    it("returns 200 ok when queue is healthy", async () => {
      const controller = makeController();
      const result = await controller.getQueueHealth();
      expect(result).toEqual({
        status: "ok",
        service: "weather-llm-api",
        queue: {
          pending: 0,
          retrying: 0,
          processing: 0,
          completed: 5,
          dead: 0,
        },
      });
    });

    it("throws 503 when queue is stuck", async () => {
      const controller = makeController(undefined, {
        getQueueHealth: async () => ({
          status: "stuck",
          stats: {
            pending: 0,
            retrying: 0,
            processing: 0,
            completed: 2,
            dead: 3,
          },
        }),
      });

      await expect(controller.getQueueHealth()).rejects.toThrow(HttpException);

      try {
        await controller.getQueueHealth();
      } catch (e) {
        const ex = e as HttpException;
        expect(ex.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
        const body = ex.getResponse() as Record<string, unknown>;
        expect(body.status).toBe("stuck");
        expect((body.queue as Record<string, number>).dead).toBe(3);
      }
    });
  });

  it("returns cors diagnostics payload", () => {
    const controller = makeController();
    const result = controller.getCorsHealth({
      method: "OPTIONS",
      headers: {
        origin: "http://192.168.7.243:5173",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,accept",
      },
    });

    expect(result.status).toBe("ok");
    expect(result.service).toBe("weather-llm-api");
    expect(result.cors.origin).toBe("http://192.168.7.243:5173");
    expect(result.cors.requestMethod).toBe("OPTIONS");
    expect(result.cors.accessControlRequestMethod).toBe("POST");
    expect(result.cors.accessControlRequestHeaders).toBe("content-type,accept");
    expect(result.cors.originAllowed).toBe(true);
  });

  afterEach(() => {
    delete process.env.OLLAMA_CHAT_MODEL;
    delete process.env.NWS_EMBEDDING_MODEL;
  });
});
