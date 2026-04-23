import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service.js";
import { NwsEmbeddingsService } from "./nws-embeddings.service.js";
import type { IngestAlertItemInput, IngestAlertsRequest } from "./types.js";

interface QueueJobRow {
  id: number;
  dedupe_key: string;
  payload: unknown;
  attempt_count: number;
  max_attempts: number;
  created_at: Date;
}

interface QueueStatusCountRow {
  status: string;
  count: bigint | number;
}

interface QueueDeadJobRow {
  id: number;
  dedupe_key: string;
  attempt_count: number;
  max_attempts: number;
  last_error: string | null;
  dead_lettered_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface NormalizedQueueItem {
  source: string;
  sourceDocumentId: string;
  sourceVersion: string;
  embeddingText: string;
  metadata: Record<string, unknown>;
  dedupeKey: string;
}

@Injectable()
export class NwsEmbeddingQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NwsEmbeddingQueueService.name);
  private timer: NodeJS.Timeout | undefined;
  private workerInFlight = false;
  private shuttingDown = false;
  private consecutiveEmptyPolls = 0;

  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(NwsEmbeddingsService)
    private readonly nwsEmbeddingsService: NwsEmbeddingsService,
  ) {}

  async onModuleInit() {
    if (this.workerEnabled()) {
      this.scheduleNextTick(0);
      this.logger.log("Embedding queue worker started");
    } else {
      this.logger.log("Embedding queue worker disabled by env");
    }
  }

  onModuleDestroy() {
    this.shuttingDown = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  async enqueue(body: IngestAlertsRequest): Promise<{
    accepted: number;
    enqueued: number;
    duplicate: number;
  }> {
    const normalizedItems = this.normalize(body);

    let enqueued = 0;
    let duplicate = 0;

    for (const item of normalizedItems) {
      const affected = await this.prisma.$executeRaw`
        INSERT INTO embedding_queue_jobs (
          dedupe_key,
          payload,
          status,
          attempt_count,
          max_attempts,
          next_run_at,
          created_at,
          updated_at
        )
        VALUES (
          ${item.dedupeKey},
          CAST(${JSON.stringify({
            source: item.source,
            sourceDocumentId: item.sourceDocumentId,
            sourceVersion: item.sourceVersion,
            embeddingText: item.embeddingText,
            metadata: item.metadata,
          })} AS JSONB),
          'pending',
          0,
          ${this.maxAttempts()},
          NOW(),
          NOW(),
          NOW()
        )
        ON CONFLICT (dedupe_key) DO NOTHING
      `;

      if (Number(affected) > 0) {
        enqueued += 1;
      } else {
        duplicate += 1;
      }
    }

    return {
      accepted: normalizedItems.length,
      enqueued,
      duplicate,
    };
  }

  async getQueueStats(): Promise<{
    totals: Record<string, number>;
    oldestPendingAt: string | null;
    oldestRetryingAt: string | null;
  }> {
    const rows = await this.prisma.$queryRaw<QueueStatusCountRow[]>`
      SELECT status, COUNT(*)::bigint AS count
      FROM embedding_queue_jobs
      GROUP BY status
    `;

    const totals: Record<string, number> = {
      pending: 0,
      retrying: 0,
      processing: 0,
      completed: 0,
      dead: 0,
    };

    for (const row of rows) {
      totals[row.status] = Number(row.count);
    }

    const oldestPendingRow = await this.prisma.$queryRaw<
      { created_at: Date }[]
    >`
      SELECT created_at
      FROM embedding_queue_jobs
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
    `;

    const oldestRetryingRow = await this.prisma.$queryRaw<
      { created_at: Date }[]
    >`
      SELECT created_at
      FROM embedding_queue_jobs
      WHERE status = 'retrying'
      ORDER BY created_at ASC
      LIMIT 1
    `;

    return {
      totals,
      oldestPendingAt: oldestPendingRow[0]?.created_at?.toISOString() ?? null,
      oldestRetryingAt: oldestRetryingRow[0]?.created_at?.toISOString() ?? null,
    };
  }

  async listDeadJobs(limit: number): Promise<QueueDeadJobRow[]> {
    const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 50;

    return this.prisma.$queryRaw<QueueDeadJobRow[]>`
      SELECT
        id,
        dedupe_key,
        attempt_count,
        max_attempts,
        last_error,
        dead_lettered_at,
        created_at,
        updated_at
      FROM embedding_queue_jobs
      WHERE status = 'dead'
      ORDER BY dead_lettered_at DESC NULLS LAST, id DESC
      LIMIT ${safeLimit}
    `;
  }

  async retryDeadJobs(ids?: number[]): Promise<{ retried: number }> {
    if (ids && ids.length > 0) {
      const safeIds = ids.filter((id) => Number.isInteger(id) && id > 0);
      if (!safeIds.length) {
        throw new BadRequestException("ids must contain positive integers");
      }

      const updated = await this.prisma.$executeRaw`
        UPDATE embedding_queue_jobs
        SET
          status = 'retrying',
          next_run_at = NOW(),
          leased_until = NULL,
          dead_lettered_at = NULL,
          last_error = NULL,
          updated_at = NOW()
        WHERE status = 'dead'
          AND id = ANY(${safeIds})
      `;

      return { retried: Number(updated) };
    }

    const updated = await this.prisma.$executeRaw`
      UPDATE embedding_queue_jobs
      SET
        status = 'retrying',
        next_run_at = NOW(),
        leased_until = NULL,
        dead_lettered_at = NULL,
        last_error = NULL,
        updated_at = NOW()
      WHERE status = 'dead'
    `;

    return { retried: Number(updated) };
  }

  async getQueueHealth(): Promise<{
    status: "healthy" | "stuck";
    stats: Record<string, number>;
  }> {
    const rows = await this.prisma.$queryRaw<QueueStatusCountRow[]>`
      SELECT status, COUNT(*)::bigint AS count
      FROM embedding_queue_jobs
      GROUP BY status
    `;

    const stats: Record<string, number> = {
      pending: 0,
      retrying: 0,
      processing: 0,
      completed: 0,
      dead: 0,
    };

    for (const row of rows) {
      stats[row.status] = Number(row.count);
    }

    const actionable = (stats.pending ?? 0) + (stats.retrying ?? 0);
    const dead = stats.dead ?? 0;
    const stuck = dead > 0 && actionable === 0;

    return { status: stuck ? "stuck" : "healthy", stats };
  }

  private scheduleNextTick(delayMs: number) {
    if (this.shuttingDown) {
      return;
    }

    this.timer = setTimeout(() => {
      void this.processTick();
    }, delayMs);
  }

  private async recoverStaleLeasedJobs(): Promise<number> {
    const updated = await this.prisma.$executeRaw`
      UPDATE embedding_queue_jobs
      SET
        status = 'retrying',
        leased_until = NULL,
        updated_at = NOW()
      WHERE status = 'processing'
        AND leased_until IS NOT NULL
        AND leased_until < NOW()
    `;
    const count = Number(updated);
    if (count > 0) {
      this.logger.warn(
        `event=QUEUE_STALE_LEASE_RECOVERY recovered=${count} — reset stale processing job(s) to retrying`,
      );
    }
    return count;
  }

  private async processTick() {
    if (this.shuttingDown || this.workerInFlight) {
      this.scheduleNextTick(this.pollIntervalMs());
      return;
    }

    this.workerInFlight = true;

    try {
      await this.recoverStaleLeasedJobs();
      const count = await this.processBatch();
      if (count === 0) {
        this.consecutiveEmptyPolls += 1;
        const idleDelay = Math.min(
          this.backoffMs(this.consecutiveEmptyPolls),
          this.maxBackoffMs(),
        );

        // Warn when queue is entirely stuck (dead jobs exist, nothing actionable)
        const health = await this.getQueueHealth();
        if (health.status === "stuck") {
          this.logger.warn(
            `event=QUEUE_ALL_DEAD deadCount=${health.stats.dead} — all embedding queue jobs are dead; manual retry required`,
          );
        }

        this.scheduleNextTick(idleDelay);
      } else {
        this.consecutiveEmptyPolls = 0;
        this.scheduleNextTick(this.pollIntervalMs());
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Embedding queue batch failed: ${message}`);
      this.consecutiveEmptyPolls = 0;
      this.scheduleNextTick(this.pollIntervalMs());
    } finally {
      this.workerInFlight = false;
    }
  }

  private async processBatch(): Promise<number> {
    const jobs = await this.prisma.$queryRaw<QueueJobRow[]>`
      WITH claim AS (
        SELECT id
        FROM embedding_queue_jobs
        WHERE status IN ('pending', 'retrying')
          AND next_run_at <= NOW()
          AND (leased_until IS NULL OR leased_until < NOW())
        ORDER BY next_run_at ASC
        LIMIT ${this.batchSize()}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE embedding_queue_jobs queue
      SET
        status = 'processing',
        leased_until = NOW() + (${this.leaseSeconds()} || ' seconds')::interval,
        updated_at = NOW()
      FROM claim
      WHERE queue.id = claim.id
      RETURNING
        queue.id,
        queue.dedupe_key,
        queue.payload,
        queue.attempt_count,
        queue.max_attempts,
        queue.created_at
    `;

    for (const job of jobs) {
      await this.processJob(job);
    }

    return jobs.length;
  }

  private async processJob(job: QueueJobRow): Promise<void> {
    const payload = this.parsePayload(job.payload);

    try {
      await this.nwsEmbeddingsService.ingestAlerts({ items: [payload] });

      await this.prisma.$executeRaw`
        UPDATE embedding_queue_jobs
        SET
          status = 'completed',
          completed_at = NOW(),
          leased_until = NULL,
          last_error = NULL,
          updated_at = NOW()
        WHERE id = ${job.id}
      `;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const nextAttemptCount = job.attempt_count + 1;
      const createdAtMs = new Date(job.created_at).getTime();
      const ageMs = Date.now() - createdAtMs;
      const retryWindowMs = this.retryWindowDays() * 24 * 60 * 60 * 1000;
      const isDead =
        nextAttemptCount >= job.max_attempts || ageMs >= retryWindowMs;

      if (isDead) {
        await this.prisma.$executeRaw`
          UPDATE embedding_queue_jobs
          SET
            status = 'dead',
            attempt_count = ${nextAttemptCount},
            dead_lettered_at = NOW(),
            leased_until = NULL,
            last_error = ${message.slice(0, 4000)},
            updated_at = NOW()
          WHERE id = ${job.id}
        `;
        return;
      }

      const delayMs = this.backoffMs(nextAttemptCount);
      const nextRunAt = new Date(Date.now() + delayMs);

      await this.prisma.$executeRaw`
        UPDATE embedding_queue_jobs
        SET
          status = 'retrying',
          attempt_count = ${nextAttemptCount},
          next_run_at = ${nextRunAt},
          leased_until = NULL,
          last_error = ${message.slice(0, 4000)},
          updated_at = NOW()
        WHERE id = ${job.id}
      `;
    }
  }

  private parsePayload(payload: unknown): IngestAlertItemInput {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new BadRequestException("Queue payload is invalid");
    }

    const raw = payload as Record<string, unknown>;

    const item: IngestAlertItemInput = {
      source: typeof raw.source === "string" ? raw.source : "nwsAlerts",
      sourceDocumentId:
        typeof raw.sourceDocumentId === "string" ? raw.sourceDocumentId : "",
      sourceVersion:
        typeof raw.sourceVersion === "string" ? raw.sourceVersion : undefined,
      embeddingText:
        typeof raw.embeddingText === "string" ? raw.embeddingText : undefined,
      metadata:
        raw.metadata &&
        typeof raw.metadata === "object" &&
        !Array.isArray(raw.metadata)
          ? (raw.metadata as Record<string, unknown>)
          : undefined,
    };

    if (!item.sourceDocumentId || !item.embeddingText) {
      throw new BadRequestException("Queue payload missing required fields");
    }

    return item;
  }

  private normalize(body: IngestAlertsRequest): NormalizedQueueItem[] {
    if (!body || !Array.isArray(body.items) || body.items.length === 0) {
      throw new BadRequestException("items array is required");
    }

    return body.items.map((item, index) => {
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
      const metadata =
        item.metadata &&
        typeof item.metadata === "object" &&
        !Array.isArray(item.metadata)
          ? item.metadata
          : {};

      const contentHash = this.sha256(embeddingText);
      const dedupeKey = `${source}|${sourceDocumentId}|${sourceVersion}|${contentHash}`;

      return {
        source,
        sourceDocumentId,
        sourceVersion,
        embeddingText,
        metadata,
        dedupeKey,
      };
    });
  }

  private requiredString(value: unknown, fieldName: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new BadRequestException(`${fieldName} is required`);
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

  private sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  private backoffMs(attempt: number): number {
    const base = this.baseBackoffMs();
    const cap = this.maxBackoffMs();
    const exponential = base * 2 ** Math.max(0, attempt - 1);
    const jitter = Math.floor(Math.random() * base);
    return Math.min(cap, exponential + jitter);
  }

  private workerEnabled(): boolean {
    const value = (process.env.NWS_EMBED_QUEUE_WORKER_ENABLED ?? "true")
      .trim()
      .toLowerCase();
    return value !== "false" && value !== "0";
  }

  private pollIntervalMs(): number {
    return this.readIntEnv("NWS_EMBED_QUEUE_POLL_INTERVAL_MS", 2000);
  }

  private batchSize(): number {
    return this.readIntEnv("NWS_EMBED_QUEUE_BATCH_SIZE", 10);
  }

  private leaseSeconds(): number {
    return this.readIntEnv("NWS_EMBED_QUEUE_LEASE_SECONDS", 120);
  }

  private maxAttempts(): number {
    return this.readIntEnv("NWS_EMBED_QUEUE_MAX_ATTEMPTS", 200);
  }

  private retryWindowDays(): number {
    return this.readIntEnv("NWS_EMBED_QUEUE_RETRY_WINDOW_DAYS", 7);
  }

  private baseBackoffMs(): number {
    return this.readIntEnv("NWS_EMBED_QUEUE_BASE_BACKOFF_MS", 2000);
  }

  private maxBackoffMs(): number {
    return this.readIntEnv("NWS_EMBED_QUEUE_MAX_BACKOFF_MS", 1800000);
  }

  private readIntEnv(key: string, fallback: number): number {
    const raw = process.env[key];
    if (!raw) {
      return fallback;
    }

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }

    return parsed;
  }
}
