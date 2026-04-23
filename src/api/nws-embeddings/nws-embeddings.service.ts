import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import {
  DEFAULT_EMBEDDING_VECTOR_SIZE,
  getEmbeddingModel,
} from "../embedding-env.js";
import {
  readAlertCollectionsFromEnv,
  resolveAlertCollectionName,
} from "../alert-source-metadata.js";
import { InProcessEmbeddingClient } from "./in-process-embedding.client.js";
import { QdrantClient } from "./qdrant.client.js";
import type {
  IngestAlertItemInput,
  IngestAlertsRequest,
  IngestAlertsResponse,
  NormalizedIngestItem,
  QdrantUpsertPoint,
} from "./types.js";

interface IngestEnv {
  embeddingModel: string;
  embeddingTimeoutMs: number;
  qdrantUrl: string;
  qdrantCollections: Record<string, string>;
  qdrantDistance: string;
  qdrantTimeoutMs: number;
  maxBatchSize: number;
  maxTextChars: number;
}

@Injectable()
export class NwsEmbeddingsService implements OnModuleInit {
  private readonly logger = new Logger(NwsEmbeddingsService.name);

  constructor(
    @Inject(InProcessEmbeddingClient)
    private readonly embeddingClient: InProcessEmbeddingClient,
    @Inject(QdrantClient)
    private readonly qdrantClient: QdrantClient,
  ) {}

  async onModuleInit(): Promise<void> {
    const config = this.readEnv();
    try {
      for (const collectionName of this.uniqueCollectionNames(config)) {
        await this.qdrantClient.ensureCollection({
          baseUrl: config.qdrantUrl,
          collectionName,
          vectorSize: this.parsePositiveInt(
            process.env.QDRANT_VECTOR_SIZE,
            DEFAULT_EMBEDDING_VECTOR_SIZE,
          ),
          distance: config.qdrantDistance,
          timeoutMs: config.qdrantTimeoutMs,
        });
      }
      this.logger.log(
        `Qdrant alert collections ready at ${config.qdrantUrl}: ${this.uniqueCollectionNames(config).join(", ")}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Qdrant collection init failed on startup (will retry on first ingest): ${message}`,
      );
    }
  }

  async ingestAlerts(body: IngestAlertsRequest): Promise<IngestAlertsResponse> {
    const config = this.readEnv();
    const normalizedItems = this.normalizeAndValidate(body, config);
    const deduplicatedItems = this.deduplicateByIdempotency(normalizedItems);

    if (deduplicatedItems.length === 0) {
      return {
        accepted: normalizedItems.length,
        processed: 0,
        upserted: 0,
        skipped: normalizedItems.length,
        failed: 0,
        collection: this.uniqueCollectionNames(config).join(","),
        collections: this.uniqueCollectionNames(config),
        model: config.embeddingModel,
        vectorDimension: 0,
      };
    }

    const itemsByCollection = this.groupItemsByCollection(
      deduplicatedItems,
      config,
    );
    const newItems: NormalizedIngestItem[] = [];
    let alreadyInQdrant = 0;

    for (const [collectionName, items] of itemsByCollection.entries()) {
      const candidatePointIds = items.map((item) => {
        const contentHash = this.sha256(item.embeddingText);
        return this.hashToUuid(
          this.sha256(this.buildIdempotencyKey(item, contentHash)),
        );
      });

      let existingPointIds = new Set<string>();
      try {
        existingPointIds = await this.qdrantClient.fetchPoints({
          baseUrl: config.qdrantUrl,
          collectionName,
          ids: candidatePointIds,
          timeoutMs: config.qdrantTimeoutMs,
        });
      } catch {
        // If Qdrant is unreachable here, proceed with all items — upsert will fail later if needed
      }

      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]!;
        if (existingPointIds.has(candidatePointIds[index]!)) {
          alreadyInQdrant += 1;
          continue;
        }
        newItems.push(item);
      }
    }

    if (newItems.length === 0) {
      return {
        accepted: normalizedItems.length,
        processed: deduplicatedItems.length,
        upserted: 0,
        skipped:
          normalizedItems.length - deduplicatedItems.length + alreadyInQdrant,
        failed: 0,
        collection: this.uniqueCollectionNames(config).join(","),
        collections: this.uniqueCollectionNames(config),
        model: config.embeddingModel,
        vectorDimension: 0,
      };
    }

    const embeddedPointsByCollection = new Map<string, QdrantUpsertPoint[]>();
    let vectorDimension = 0;

    try {
      for (const item of newItems) {
        const collectionName = this.resolveCollectionName(item, config);
        const vector = await this.embeddingClient.embedText(
          item.embeddingText,
          {
            model: config.embeddingModel,
            timeoutMs: config.embeddingTimeoutMs,
          },
        );

        if (!Array.isArray(vector) || vector.length === 0) {
          throw new Error(
            `Embedding model returned an empty vector for item "${item.sourceDocumentId ?? "(unknown)"}"`,
          );
        }

        if (!vectorDimension) {
          vectorDimension = vector.length;
        }

        await this.qdrantClient.ensureCollection({
          baseUrl: config.qdrantUrl,
          collectionName,
          vectorSize: vector.length,
          distance: config.qdrantDistance,
          timeoutMs: config.qdrantTimeoutMs,
        });

        const contentHash = this.sha256(item.embeddingText);
        const idempotencyKey = this.buildIdempotencyKey(item, contentHash);
        const pointId = this.hashToUuid(this.sha256(idempotencyKey));

        const points = embeddedPointsByCollection.get(collectionName) ?? [];
        points.push({
          id: pointId,
          vector,
          payload: {
            source: item.source,
            sourceDocumentId: item.sourceDocumentId,
            sourceVersion: item.sourceVersion,
            embeddingText: item.embeddingText,
            contentHash,
            idempotencyKey,
            ingestedAt: new Date().toISOString(),
            ...item.metadata,
          },
        });
        embeddedPointsByCollection.set(collectionName, points);
      }

      for (const [collectionName, points] of embeddedPointsByCollection) {
        await this.qdrantClient.upsertPoints({
          baseUrl: config.qdrantUrl,
          collectionName,
          points,
          timeoutMs: config.qdrantTimeoutMs,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ServiceUnavailableException(
        `Embedding ingestion failed due to upstream dependency error: ${message}`,
      );
    }

    return {
      accepted: normalizedItems.length,
      processed: deduplicatedItems.length,
      upserted: [...embeddedPointsByCollection.values()].reduce(
        (count, points) => count + points.length,
        0,
      ),
      skipped:
        normalizedItems.length - deduplicatedItems.length + alreadyInQdrant,
      failed: 0,
      collection: [...embeddedPointsByCollection.keys()].join(","),
      collections: [...embeddedPointsByCollection.keys()],
      model: config.embeddingModel,
      vectorDimension,
    };
  }

  private groupItemsByCollection(
    items: NormalizedIngestItem[],
    config: IngestEnv,
  ): Map<string, NormalizedIngestItem[]> {
    const grouped = new Map<string, NormalizedIngestItem[]>();

    for (const item of items) {
      const collectionName = this.resolveCollectionName(item, config);
      const existing = grouped.get(collectionName) ?? [];
      existing.push(item);
      grouped.set(collectionName, existing);
    }

    return grouped;
  }

  private resolveCollectionName(
    item: Pick<NormalizedIngestItem, "source">,
    config: IngestEnv,
  ): string {
    return resolveAlertCollectionName(item.source, config.qdrantCollections);
  }

  private uniqueCollectionNames(config: IngestEnv): string[] {
    return [...new Set(Object.values(config.qdrantCollections))];
  }

  private normalizeAndValidate(
    body: IngestAlertsRequest,
    config: IngestEnv,
  ): NormalizedIngestItem[] {
    if (!body || typeof body !== "object") {
      throw new BadRequestException("Request body is required");
    }

    if (!Array.isArray(body.items)) {
      throw new BadRequestException("Request body must include an items array");
    }

    if (body.items.length === 0) {
      throw new BadRequestException("items array must not be empty");
    }

    if (body.items.length > config.maxBatchSize) {
      throw new BadRequestException(
        `items array exceeds max batch size of ${config.maxBatchSize}`,
      );
    }

    return body.items.map((item, index) =>
      this.normalizeItem(item, index, config),
    );
  }

  private normalizeItem(
    item: IngestAlertItemInput,
    index: number,
    config: IngestEnv,
  ): NormalizedIngestItem {
    if (!item || typeof item !== "object") {
      throw new BadRequestException(`items[${index}] must be an object`);
    }

    const source = this.requiredString(item.source, `items[${index}].source`);
    const sourceDocumentId = this.requiredString(
      item.sourceDocumentId,
      `items[${index}].sourceDocumentId`,
    );
    const sourceVersion = this.optionalString(item.sourceVersion) ?? "v1";

    const embeddingTextCandidate =
      item.embeddingText ?? item.text ?? item.content ?? item.summary;
    const embeddingText = this.requiredString(
      embeddingTextCandidate,
      `items[${index}].embeddingText|text|content|summary`,
    );

    if (embeddingText.length > config.maxTextChars) {
      throw new BadRequestException(
        `items[${index}] text exceeds max length of ${config.maxTextChars} chars`,
      );
    }

    if (
      item.metadata &&
      (typeof item.metadata !== "object" || Array.isArray(item.metadata))
    ) {
      throw new BadRequestException(
        `items[${index}].metadata must be an object if provided`,
      );
    }

    return {
      source,
      sourceDocumentId,
      sourceVersion,
      embeddingText,
      metadata: item.metadata ?? {},
    };
  }

  private deduplicateByIdempotency(
    items: NormalizedIngestItem[],
  ): NormalizedIngestItem[] {
    const seen = new Set<string>();
    const deduplicated: NormalizedIngestItem[] = [];

    for (const item of items) {
      const contentHash = this.sha256(item.embeddingText);
      const key = this.buildIdempotencyKey(item, contentHash);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      deduplicated.push(item);
    }

    return deduplicated;
  }

  private buildIdempotencyKey(
    item: NormalizedIngestItem,
    contentHash: string,
  ): string {
    return `${item.source}|${item.sourceDocumentId}|${item.sourceVersion}|${contentHash}`;
  }

  private sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  private hashToUuid(hashHex: string): string {
    return [
      hashHex.slice(0, 8),
      hashHex.slice(8, 12),
      hashHex.slice(12, 16),
      hashHex.slice(16, 20),
      hashHex.slice(20, 32),
    ].join("-");
  }

  private requiredString(value: unknown, fieldName: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new BadRequestException(
        `${fieldName} is required and must be a non-empty string`,
      );
    }

    return value.trim();
  }

  private optionalString(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
  }

  private readEnv(): IngestEnv {
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
      maxBatchSize: this.parsePositiveInt(
        process.env.NWS_INGEST_MAX_BATCH_SIZE,
        100,
      ),
      maxTextChars: this.parsePositiveInt(
        process.env.NWS_INGEST_MAX_TEXT_CHARS,
        12000,
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
