import {
  BadRequestException,
  Inject,
  Injectable,
  OnModuleDestroy,
} from "@nestjs/common";
import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import { resolveAlertSourceMetadata } from "../alert-source-metadata.js";
import { NwsEmbeddingQueueService } from "../nws-embeddings/nws-embedding-queue.service.js";
import type { IngestAlertItemInput } from "../nws-embeddings/types.js";
import type {
  EnqueueAlertsBackfillRequest,
  EnqueueAlertsBackfillResponse,
} from "./types.js";

interface AlertsBackfillEnv {
  alertsDbHost: string;
  alertsDbPort: number;
  alertsDbUser: string;
  alertsDbPassword: string;
  alertsDbName: string;
  batchDefault: number;
  batchMax: number;
}

interface AlertsMaxIdRow extends RowDataPacket {
  maxId: number | null;
}

interface AlertsBackfillWindow {
  sentFrom?: string;
  sentTo?: string;
}

interface AlertsRow extends RowDataPacket {
  id: number;
  nwsId: string | null;
  sourceFamily: string | null;
  sourceProduct: string | null;
  event: string | null;
  headline: string | null;
  shortDescription: string | null;
  sent: Date | string | null;
  effective: Date | string | null;
  onset: Date | string | null;
  expires: Date | string | null;
  ends: Date | string | null;
}

@Injectable()
export class NwsAlertsBackfillService implements OnModuleDestroy {
  private pool: mysql.Pool | null = null;

  constructor(
    @Inject(NwsEmbeddingQueueService)
    private readonly nwsEmbeddingQueueService: NwsEmbeddingQueueService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async enqueueFromAlertsTable(
    body: EnqueueAlertsBackfillRequest,
  ): Promise<EnqueueAlertsBackfillResponse> {
    const env = this.readEnv();
    const runId = `alerts-backfill-${Date.now()}`;
    const cursorId = this.normalizeNonNegativeInt(
      body?.cursorId,
      0,
      "cursorId",
    );
    const dryRun = body?.dryRun ?? false;
    const window = this.normalizeWindow(body);

    const requestedLimit = this.normalizePositiveInt(
      body?.limit,
      env.batchDefault,
      "limit",
    );
    const limit = Math.min(requestedLimit, env.batchMax);

    const snapshotMaxIdCandidate = this.normalizeNonNegativeInt(
      body?.snapshotMaxId,
      -1,
      "snapshotMaxId",
    );

    const snapshotMaxId =
      snapshotMaxIdCandidate >= 0
        ? snapshotMaxIdCandidate
        : await this.fetchSnapshotMaxId(window);

    if (cursorId >= snapshotMaxId) {
      return {
        runId,
        cursorId,
        nextCursorId: cursorId,
        snapshotMaxId,
        rowsRead: 0,
        accepted: 0,
        enqueued: 0,
        duplicate: 0,
        skippedInvalid: 0,
        dryRun,
        hasMore: false,
        monitor: {
          queueStatsPath: "/nws-alerts/admin/queue/stats",
          deadQueuePath: "/nws-alerts/admin/queue/dead",
        },
      };
    }

    const rows = await this.fetchAlertsRows(
      cursorId,
      snapshotMaxId,
      limit,
      window,
    );

    let skippedInvalid = 0;
    const items: IngestAlertItemInput[] = [];

    for (const row of rows) {
      const item = this.toIngestItem(row);
      if (!item) {
        skippedInvalid += 1;
        continue;
      }

      items.push(item);
    }

    const nextCursorId = rows.length ? rows[rows.length - 1].id : cursorId;

    let accepted = items.length;
    let enqueued = 0;
    let duplicate = 0;

    if (!dryRun && items.length > 0) {
      const result = await this.nwsEmbeddingQueueService.enqueue({ items });
      accepted = result.accepted;
      enqueued = result.enqueued;
      duplicate = result.duplicate;
    }

    return {
      runId,
      cursorId,
      nextCursorId,
      snapshotMaxId,
      rowsRead: rows.length,
      accepted,
      enqueued,
      duplicate,
      skippedInvalid,
      dryRun,
      hasMore: nextCursorId < snapshotMaxId,
      monitor: {
        queueStatsPath: "/nws-alerts/admin/queue/stats",
        deadQueuePath: "/nws-alerts/admin/queue/dead",
      },
    };
  }

  private async fetchSnapshotMaxId(
    window: AlertsBackfillWindow,
  ): Promise<number> {
    const pool = this.getPool();
    const [rows] = await pool.query<AlertsMaxIdRow[]>(
      `SELECT COALESCE(MAX(id), 0) AS maxId
      FROM Alerts
      WHERE (? IS NULL OR sent >= ?)
        AND (? IS NULL OR sent <= ?)`,
      [
        window.sentFrom ?? null,
        window.sentFrom ?? null,
        window.sentTo ?? null,
        window.sentTo ?? null,
      ],
    );

    return Number(rows[0]?.maxId ?? 0);
  }

  private async fetchAlertsRows(
    cursorId: number,
    snapshotMaxId: number,
    limit: number,
    window: AlertsBackfillWindow,
  ): Promise<AlertsRow[]> {
    const pool = this.getPool();
    const [rows] = await pool.query<AlertsRow[]>(
      `SELECT
        id,
        nwsId,
        sourceFamily,
        sourceProduct,
        event,
        headline,
        shortDescription,
        sent,
        effective,
        onset,
        expires,
        ends
      FROM Alerts
      WHERE id > ?
        AND id <= ?
        AND (? IS NULL OR sent >= ?)
        AND (? IS NULL OR sent <= ?)
      ORDER BY id ASC
      LIMIT ?`,
      [
        cursorId,
        snapshotMaxId,
        window.sentFrom ?? null,
        window.sentFrom ?? null,
        window.sentTo ?? null,
        window.sentTo ?? null,
        limit,
      ],
    );

    return rows;
  }

  private toIngestItem(row: AlertsRow): IngestAlertItemInput | null {
    if (!row.nwsId || !row.nwsId.trim().length) {
      return null;
    }

    const sourceMetadata = resolveAlertSourceMetadata({
      sourceFamily: row.sourceFamily,
      sourceProduct: row.sourceProduct,
      nwsId: row.nwsId,
      event: row.event,
    });

    const sentIso = this.normalizeIso(row.sent);
    const effectiveIso = this.normalizeIso(row.effective);
    const onsetIso = this.normalizeIso(row.onset);
    const expiresIso = this.normalizeIso(row.expires);
    const endsIso = this.normalizeIso(row.ends);

    return {
      source: sourceMetadata.sourceFamily,
      sourceDocumentId: String(row.id),
      sourceVersion: sentIso,
      embeddingText: [
        `nwsId: ${row.nwsId ?? ""}`,
        `sourceFamily: ${sourceMetadata.sourceFamily}`,
        `sourceProduct: ${sourceMetadata.sourceProduct}`,
        `event: ${row.event ?? ""}`,
        `headline: ${row.headline ?? ""}`,
        `shortDescription: ${row.shortDescription ?? ""}`,
        `sent: ${sentIso}`,
        `effective: ${effectiveIso}`,
        `onset: ${onsetIso}`,
        `expires: ${expiresIso}`,
        `ends: ${endsIso}`,
      ].join("\n"),
      metadata: {
        nwsId: row.nwsId,
        alertId: row.id,
        sourceFamily: sourceMetadata.sourceFamily,
        sourceProduct: sourceMetadata.sourceProduct,
        eventType: row.event,
        headline: row.headline,
        shortDescription: row.shortDescription ?? "",
        sent: sentIso,
        effectiveAt: effectiveIso || undefined,
        onsetAt: onsetIso || undefined,
        expiresAt: expiresIso || undefined,
        endsAt: endsIso || undefined,
      },
    };
  }

  private normalizeIso(value: Date | string | null): string {
    if (!value) {
      return "";
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return String(value);
    }

    return parsed.toISOString();
  }

  private normalizeWindow(
    body: EnqueueAlertsBackfillRequest | undefined,
  ): AlertsBackfillWindow {
    const sentFrom = this.normalizeIsoBound(body?.sentFrom, "sentFrom");
    const sentTo = this.normalizeIsoBound(body?.sentTo, "sentTo");

    if (sentFrom && sentTo && sentFrom > sentTo) {
      throw new BadRequestException(
        "sentFrom must be less than or equal to sentTo",
      );
    }

    return {
      ...(sentFrom ? { sentFrom } : {}),
      ...(sentTo ? { sentTo } : {}),
    };
  }

  private normalizeIsoBound(
    value: string | undefined,
    fieldName: string,
  ): string | undefined {
    if (value == null) {
      return undefined;
    }

    if (typeof value !== "string" || value.trim().length === 0) {
      throw new BadRequestException(
        `${fieldName} must be a non-empty ISO datetime string when provided`,
      );
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(
        `${fieldName} must be a valid ISO datetime string`,
      );
    }

    return parsed.toISOString();
  }

  private getPool(): mysql.Pool {
    if (this.pool) {
      return this.pool;
    }

    const env = this.readEnv();

    this.pool = mysql.createPool({
      host: env.alertsDbHost,
      port: env.alertsDbPort,
      user: env.alertsDbUser,
      password: env.alertsDbPassword,
      database: env.alertsDbName,
      connectionLimit: 5,
      waitForConnections: true,
      queueLimit: 0,
      charset: "utf8mb4",
    });

    return this.pool;
  }

  private readEnv(): AlertsBackfillEnv {
    return {
      alertsDbHost: process.env.NWS_ALERTS_DB_HOST ?? "localhost",
      alertsDbPort: this.parsePositiveInt(process.env.NWS_ALERTS_DB_PORT, 3307),
      alertsDbUser: process.env.NWS_ALERTS_DB_USER ?? "emwin_user",
      alertsDbPassword: process.env.NWS_ALERTS_DB_PASSWORD ?? "emwin_pass",
      alertsDbName: process.env.NWS_ALERTS_DB_NAME ?? "emwin",
      batchDefault: this.parsePositiveInt(
        process.env.NWS_ALERTS_BACKFILL_BATCH_DEFAULT,
        500,
      ),
      batchMax: this.parsePositiveInt(
        process.env.NWS_ALERTS_BACKFILL_BATCH_MAX,
        5000,
      ),
    };
  }

  private normalizePositiveInt(
    value: number | undefined,
    fallback: number,
    fieldName: string,
  ): number {
    if (value == null) {
      return fallback;
    }

    if (!Number.isInteger(value) || value <= 0) {
      throw new BadRequestException(`${fieldName} must be a positive integer`);
    }

    return value;
  }

  private normalizeNonNegativeInt(
    value: number | undefined,
    fallback: number,
    fieldName: string,
  ): number {
    if (value == null) {
      return fallback;
    }

    if (!Number.isInteger(value) || value < 0) {
      throw new BadRequestException(
        `${fieldName} must be a non-negative integer`,
      );
    }

    return value;
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
}
