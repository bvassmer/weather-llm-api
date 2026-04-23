import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  DEFAULT_EMBEDDING_VECTOR_SIZE,
  getEmbeddingModel,
} from "../embedding-env.js";
import {
  readAlertCollectionsFromEnv,
  resolveAlertCollectionNames,
} from "../alert-source-metadata.js";
import { InProcessEmbeddingClient } from "../nws-embeddings/in-process-embedding.client.js";
import { QdrantClient } from "../nws-embeddings/qdrant.client.js";
import { NwsEmbeddingQueueService } from "../nws-embeddings/nws-embedding-queue.service.js";
import { NwsAlertsBackfillService } from "./nws-alerts-backfill.service.js";
import type {
  AdminFilter,
  CollectionStatsResponse,
  DeleteByFilterRequest,
  DeleteByFilterResponse,
  EnqueueAlertsBackfillRequest,
  EnqueueAlertsBackfillResponse,
  QueueDeadJob,
  QueueStatsResponse,
  ReindexRequest,
  ReindexResponse,
  RetryDeadJobsRequest,
  RetryDeadJobsResponse,
  ResetCollectionRequest,
  ResetCollectionResponse,
} from "./types.js";

interface AdminEnv {
  embeddingModel: string;
  embeddingTimeoutMs: number;
  qdrantUrl: string;
  qdrantCollections: Record<string, string>;
  qdrantDistance: string;
  qdrantTimeoutMs: number;
  qdrantVectorSize: number;
}

@Injectable()
export class NwsAdminService {
  constructor(
    @Inject(InProcessEmbeddingClient)
    private readonly embeddingClient: InProcessEmbeddingClient,
    @Inject(QdrantClient)
    private readonly qdrantClient: QdrantClient,
    @Inject(NwsEmbeddingQueueService)
    private readonly nwsEmbeddingQueueService: NwsEmbeddingQueueService,
    @Inject(NwsAlertsBackfillService)
    private readonly nwsAlertsBackfillService: NwsAlertsBackfillService,
  ) {}

  async enqueueAlertsBackfill(
    body: EnqueueAlertsBackfillRequest,
  ): Promise<EnqueueAlertsBackfillResponse> {
    return this.nwsAlertsBackfillService.enqueueFromAlertsTable(body);
  }

  async getQueueStats(): Promise<QueueStatsResponse> {
    return this.nwsEmbeddingQueueService.getQueueStats();
  }

  async getDeadQueueJobs(limit?: number): Promise<QueueDeadJob[]> {
    const maxCap = this.parsePositiveInt(
      process.env.NWS_ADMIN_DEAD_JOBS_LIMIT_MAX,
      1000,
    );
    const safeLimit = Math.min(this.normalizePositiveInt(limit, 50), maxCap);
    const rows = await this.nwsEmbeddingQueueService.listDeadJobs(safeLimit);

    return rows.map((row) => ({
      id: row.id,
      dedupeKey: row.dedupe_key,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      lastError: row.last_error,
      deadLetteredAt: row.dead_lettered_at
        ? row.dead_lettered_at.toISOString()
        : null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  async retryDeadQueueJobs(
    body: RetryDeadJobsRequest,
  ): Promise<RetryDeadJobsResponse> {
    if (!body || typeof body !== "object") {
      return this.nwsEmbeddingQueueService.retryDeadJobs();
    }

    if (body.ids && !Array.isArray(body.ids)) {
      throw new BadRequestException("ids must be an array when provided");
    }

    const ids = body.ids?.map((id) => Number(id));
    return this.nwsEmbeddingQueueService.retryDeadJobs(ids);
  }

  async getCollectionStats(): Promise<CollectionStatsResponse> {
    const config = this.readEnv();
    const collections = await Promise.all(
      this.getAlertCollectionNames(config).map(async (collectionName) => {
        const collectionInfo = await this.qdrantClient.getCollectionInfo({
          baseUrl: config.qdrantUrl,
          collectionName,
          timeoutMs: config.qdrantTimeoutMs,
        });

        const pointsCount = collectionInfo
          ? await this.qdrantClient.countPoints({
              baseUrl: config.qdrantUrl,
              collectionName,
              timeoutMs: config.qdrantTimeoutMs,
            })
          : 0;

        return {
          collection: collectionName,
          pointsCount,
          collectionInfo,
        };
      }),
    );

    return {
      totalPointsCount: collections.reduce(
        (total, item) => total + item.pointsCount,
        0,
      ),
      collections,
    };
  }

  async deleteByFilter(
    body: DeleteByFilterRequest,
  ): Promise<DeleteByFilterResponse> {
    const config = this.readEnv();
    const filter = this.buildQdrantFilter(body?.filter);
    if (!filter) {
      throw new BadRequestException("filter is required");
    }

    const beforeCount = await this.qdrantClient.countPoints({
      baseUrl: config.qdrantUrl,
      collectionName: this.getPrimaryAlertCollectionName(config),
      timeoutMs: config.qdrantTimeoutMs,
      filter,
    });

    const dryRun = body?.dryRun ?? false;
    if (!dryRun) {
      await this.qdrantClient.deletePointsByFilter({
        baseUrl: config.qdrantUrl,
        collectionName: this.getPrimaryAlertCollectionName(config),
        timeoutMs: config.qdrantTimeoutMs,
        filter,
      });
    }

    const afterCount = dryRun
      ? beforeCount
      : await this.qdrantClient.countPoints({
          baseUrl: config.qdrantUrl,
          collectionName: this.getPrimaryAlertCollectionName(config),
          timeoutMs: config.qdrantTimeoutMs,
          filter,
        });

    return {
      beforeCount,
      afterCount,
      deleted: dryRun ? 0 : Math.max(0, beforeCount - afterCount),
      dryRun,
    };
  }

  async reindex(body: ReindexRequest): Promise<ReindexResponse> {
    const config = this.readEnv();
    const filter = this.buildQdrantFilter(body?.filter);
    const collectionNames = this.resolveTargetCollectionNames(
      config,
      body?.filter?.source,
    );
    const dryRun = body?.dryRun ?? false;
    const reindexLimitMax = this.parsePositiveInt(
      process.env.NWS_ADMIN_REINDEX_LIMIT_MAX,
      50000,
    );
    const limit = Math.min(
      this.normalizePositiveInt(body?.limit, 200),
      reindexLimitMax,
    );
    const batchSize = this.normalizePositiveInt(body?.batchSize, 50);

    let matched = 0;
    let processed = 0;
    let reindexed = 0;
    let skipped = 0;
    const collections: ReindexResponse["collections"] = [];

    for (const collectionName of collectionNames) {
      let collectionMatched = 0;
      let collectionProcessed = 0;
      let collectionReindexed = 0;
      let collectionSkipped = 0;

      if (processed < limit) {
        const collectionInfo = await this.qdrantClient.getCollectionInfo({
          baseUrl: config.qdrantUrl,
          collectionName,
          timeoutMs: config.qdrantTimeoutMs,
        });

        if (collectionInfo) {
          let offset: string | number | undefined;

          while (processed < limit) {
            const page = await this.qdrantClient.scrollPoints({
              baseUrl: config.qdrantUrl,
              collectionName,
              timeoutMs: config.qdrantTimeoutMs,
              limit: Math.min(batchSize, limit - processed),
              offset,
              filter,
            });

            if (!page.points.length) {
              break;
            }

            matched += page.points.length;
            processed += page.points.length;
            collectionMatched += page.points.length;
            collectionProcessed += page.points.length;

            if (!dryRun) {
              for (const point of page.points) {
                const embeddingText =
                  typeof point.payload.embeddingText === "string"
                    ? point.payload.embeddingText
                    : undefined;

                if (!embeddingText) {
                  skipped += 1;
                  collectionSkipped += 1;
                  continue;
                }

                try {
                  const vector = await this.embeddingClient.embedText(
                    embeddingText,
                    {
                      model: config.embeddingModel,
                      timeoutMs: config.embeddingTimeoutMs,
                    },
                  );

                  await this.qdrantClient.upsertPoints({
                    baseUrl: config.qdrantUrl,
                    collectionName,
                    timeoutMs: config.qdrantTimeoutMs,
                    points: [
                      {
                        id: point.id,
                        vector,
                        payload: {
                          ...point.payload,
                          reindexedAt: new Date().toISOString(),
                          reindexedByModel: config.embeddingModel,
                        },
                      },
                    ],
                  });

                  reindexed += 1;
                  collectionReindexed += 1;
                } catch (error) {
                  skipped += 1;
                  collectionSkipped += 1;
                  const message =
                    error instanceof Error ? error.message : String(error);
                  throw new ServiceUnavailableException(
                    `Reindex failed while processing point ${point.id} in ${collectionName}: ${message}`,
                  );
                }
              }
            }

            if (page.nextOffset == null) {
              break;
            }

            offset = page.nextOffset;
          }
        }
      }

      collections.push({
        collection: collectionName,
        matched: collectionMatched,
        processed: collectionProcessed,
        reindexed: dryRun ? 0 : collectionReindexed,
        skipped: dryRun ? 0 : collectionSkipped,
      });
    }

    return {
      matched,
      processed,
      reindexed: dryRun ? 0 : reindexed,
      skipped: dryRun ? 0 : skipped,
      dryRun,
      collections,
    };
  }

  async resetCollection(
    body: ResetCollectionRequest,
  ): Promise<ResetCollectionResponse> {
    const config = this.readEnv();

    if (!body?.confirm) {
      throw new BadRequestException(
        "confirm must be true to reset the collection",
      );
    }

    const vectorSize = this.normalizePositiveInt(
      body.vectorSize,
      config.qdrantVectorSize,
    );

    const collections = [];

    for (const collectionName of this.getAlertCollectionNames(config)) {
      const collectionInfo = await this.qdrantClient.getCollectionInfo({
        baseUrl: config.qdrantUrl,
        collectionName,
        timeoutMs: config.qdrantTimeoutMs,
      });

      if (collectionInfo) {
        await this.qdrantClient.deleteCollection({
          baseUrl: config.qdrantUrl,
          collectionName,
          timeoutMs: config.qdrantTimeoutMs,
        });
      }

      await this.qdrantClient.ensureCollection({
        baseUrl: config.qdrantUrl,
        collectionName,
        vectorSize,
        distance: config.qdrantDistance,
        timeoutMs: config.qdrantTimeoutMs,
      });

      collections.push({
        collection: collectionName,
        existed: collectionInfo != null,
        reset: true,
      });
    }

    return {
      reset: true,
      collections,
    };
  }

  private getAlertCollectionNames(config: AdminEnv): string[] {
    return resolveAlertCollectionNames(undefined, config.qdrantCollections);
  }

  private getPrimaryAlertCollectionName(config: AdminEnv): string {
    return (
      config.qdrantCollections.nws ?? this.getAlertCollectionNames(config)[0]!
    );
  }

  private resolveTargetCollectionNames(
    config: AdminEnv,
    sourceFamily: string | undefined,
  ): string[] {
    return resolveAlertCollectionNames(sourceFamily, config.qdrantCollections);
  }

  private buildQdrantFilter(
    filter: AdminFilter | undefined,
  ): Record<string, unknown> | undefined {
    if (!filter || typeof filter !== "object") {
      return undefined;
    }

    const must: Array<Record<string, unknown>> = [];

    if (filter.source) {
      must.push({ key: "source", match: { value: filter.source } });
    }

    if (filter.eventType) {
      must.push({ key: "eventType", match: { value: filter.eventType } });
    }

    if (filter.severity) {
      must.push({ key: "severity", match: { value: filter.severity } });
    }

    if (filter.stateCodes?.length) {
      must.push({ key: "stateCodes", match: { any: filter.stateCodes } });
    }

    return must.length ? { must } : undefined;
  }

  private normalizePositiveInt(
    value: number | undefined,
    fallback: number,
  ): number {
    if (value == null) {
      return fallback;
    }

    if (!Number.isInteger(value) || value <= 0) {
      throw new BadRequestException("value must be a positive integer");
    }

    return value;
  }

  private readEnv(): AdminEnv {
    return {
      embeddingModel: getEmbeddingModel(),
      embeddingTimeoutMs: this.parsePositiveInt(
        process.env.NWS_EMBEDDING_TIMEOUT_MS ?? process.env.OLLAMA_TIMEOUT_MS,
        30000,
      ),
      qdrantUrl: process.env.QDRANT_URL ?? "http://localhost:6333",
      qdrantCollections: readAlertCollectionsFromEnv(process.env),
      qdrantDistance: this.normalizeDistance(process.env.QDRANT_DISTANCE),
      qdrantTimeoutMs: this.parsePositiveInt(
        process.env.QDRANT_TIMEOUT_MS,
        30000,
      ),
      qdrantVectorSize: this.parsePositiveInt(
        process.env.QDRANT_VECTOR_SIZE,
        DEFAULT_EMBEDDING_VECTOR_SIZE,
      ),
    };
  }

  private parsePositiveInt(
    rawValue: string | undefined,
    defaultValue: number,
  ): number {
    if (!rawValue) {
      return defaultValue;
    }

    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return defaultValue;
    }

    return parsed;
  }

  private normalizeDistance(rawDistance: string | undefined): string {
    if (!rawDistance) {
      return "Cosine";
    }

    const normalized = rawDistance.trim().toLowerCase();
    if (normalized === "dot") {
      return "Dot";
    }

    if (normalized === "euclid") {
      return "Euclid";
    }

    if (normalized === "manhattan") {
      return "Manhattan";
    }

    return "Cosine";
  }
}
