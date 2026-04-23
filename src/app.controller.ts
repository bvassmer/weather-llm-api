import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Req,
} from "@nestjs/common";
import { getEmbeddingModel } from "./api/embedding-env.js";
import { OllamaGenerationClient } from "./api/nws-answer/ollama-generation.client.js";
import { InProcessEmbeddingClient } from "./api/nws-embeddings/in-process-embedding.client.js";
import { getOllamaChatBaseUrl, getOllamaChatModel } from "./api/ollama-env.js";
import { PrismaService } from "./prisma/prisma.service.js";
import { NwsEmbeddingQueueService } from "./api/nws-embeddings/nws-embedding-queue.service.js";

const DEFAULT_DEV_ORIGIN_PATTERN =
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

const PRIVATE_NETWORK_ORIGIN_PATTERN =
  /^https?:\/\/(10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(:\d+)?$/i;

const resolveAllowedOrigins = (): string[] => {
  const raw = process.env.CORS_ORIGIN?.trim();
  if (!raw) {
    return ["http://localhost:5173"];
  }

  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
};

@Controller()
export class AppController {
  constructor(
    @Inject(PrismaService)
    private readonly prismaService: PrismaService,
    @Inject(NwsEmbeddingQueueService)
    private readonly queueService: NwsEmbeddingQueueService,
    @Inject(OllamaGenerationClient)
    private readonly generationClient: OllamaGenerationClient,
    @Inject(InProcessEmbeddingClient)
    private readonly embeddingClient: InProcessEmbeddingClient,
  ) {}

  @Get("health")
  async getHealth() {
    try {
      await this.prismaService.$queryRaw`SELECT 1`;
      return {
        status: "ok",
        service: "weather-llm-api",
        database: "connected",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpException(
        {
          status: "degraded",
          service: "weather-llm-api",
          database: "error",
          error: message,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  @Get("health/queue")
  async getQueueHealth() {
    const health = await this.queueService.getQueueHealth();
    if (health.status === "stuck") {
      throw new HttpException(
        {
          status: "stuck",
          service: "weather-llm-api",
          queue: health.stats,
          message: "All embedding queue jobs are dead; manual retry required",
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return {
      status: "ok",
      service: "weather-llm-api",
      queue: health.stats,
    };
  }

  @Get("health/generation")
  async getGenerationHealth() {
    const timeoutMs = this.parsePositiveInt(
      process.env.NWS_HEALTH_GENERATION_TIMEOUT_MS,
      5000,
    );
    const model = getOllamaChatModel();

    try {
      const response = await this.generationClient.generate({
        baseUrl: getOllamaChatBaseUrl(),
        model,
        prompt: "Reply with the single word ok.",
        timeoutMs,
        temperature: 0,
        maxTokens: 8,
      });

      return {
        status: "ok",
        service: "weather-llm-api",
        generation: {
          model,
          responseChars: response.length,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpException(
        {
          status: "degraded",
          service: "weather-llm-api",
          generation: "error",
          model,
          error: message,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  @Get("health/embedding")
  async getEmbeddingHealth() {
    const timeoutMs = this.parsePositiveInt(
      process.env.NWS_HEALTH_EMBED_TIMEOUT_MS,
      5000,
    );
    const model = getEmbeddingModel();

    try {
      const vector = await this.embeddingClient.embedText(
        "weather embedding health check",
        {
          model,
          timeoutMs,
        },
      );

      return {
        status: "ok",
        service: "weather-llm-api",
        embedding: {
          model,
          vectorDimension: vector.length,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpException(
        {
          status: "degraded",
          service: "weather-llm-api",
          embedding: "error",
          model,
          error: message,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  @Get("health/cors")
  getCorsHealth(@Req() req: any) {
    const allowedOrigins = resolveAllowedOrigins();
    const allowAnyOrigin = allowedOrigins.includes("*");
    const originHeader =
      typeof req?.headers?.origin === "string" ? req.headers.origin : null;

    const originAllowed =
      originHeader == null ||
      allowAnyOrigin ||
      allowedOrigins.includes(originHeader) ||
      DEFAULT_DEV_ORIGIN_PATTERN.test(originHeader) ||
      PRIVATE_NETWORK_ORIGIN_PATTERN.test(originHeader);

    return {
      status: "ok",
      service: "weather-llm-api",
      cors: {
        origin: originHeader,
        requestMethod: req?.method ?? null,
        accessControlRequestMethod:
          typeof req?.headers?.["access-control-request-method"] === "string"
            ? req.headers["access-control-request-method"]
            : null,
        accessControlRequestHeaders:
          typeof req?.headers?.["access-control-request-headers"] === "string"
            ? req.headers["access-control-request-headers"]
            : null,
        configuredOrigins: allowedOrigins,
        allowAnyOrigin,
        originAllowed,
      },
    };
  }

  private parsePositiveInt(rawValue: string | undefined, fallback: number) {
    if (!rawValue) {
      return fallback;
    }

    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }

    return parsed;
  }
}
