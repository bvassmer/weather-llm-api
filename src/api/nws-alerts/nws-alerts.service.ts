import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
} from "@nestjs/common";
import mysql from "mysql2/promise";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type {
  AlertDetails,
  AlertListItem,
  AlertSortBy,
  DeleteAlertResponse,
  ListAlertsQuery,
  ListAlertsResponse,
  SortDirection,
  UpdateAlertRequest,
} from "./types.js";

interface AlertsApiEnv {
  alertsDbHost: string;
  alertsDbPort: number;
  alertsDbUser: string;
  alertsDbPassword: string;
  alertsDbName: string;
  listPageSizeDefault: number;
  listPageSizeMax: number;
}

interface AlertListRow extends RowDataPacket {
  id: number;
  event: string | null;
  headline: string | null;
  effectiveAt: Date | string | null;
}

interface AlertDetailsRow extends RowDataPacket {
  id: number;
  nwsId: string | null;
  event: string | null;
  headline: string | null;
  description: string | null;
  shortDescription: string | null;
  geometry: string | null;
  sent: Date | string | null;
  effective: Date | string | null;
  onset: Date | string | null;
  expires: Date | string | null;
  ends: Date | string | null;
}

interface CountRow extends RowDataPacket {
  total: number;
}

@Injectable()
export class NwsAlertsService implements OnModuleDestroy {
  private pool: mysql.Pool | null = null;

  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async listAlerts(query: ListAlertsQuery): Promise<ListAlertsResponse> {
    const env = this.readEnv();
    const page = this.normalizePositiveInt(query?.page, 1, "page");
    const pageSize = Math.min(
      this.normalizePositiveInt(
        query?.pageSize,
        env.listPageSizeDefault,
        "pageSize",
      ),
      env.listPageSizeMax,
    );

    const sortBy = this.normalizeSortBy(query?.sortBy);
    const sortDir = this.normalizeSortDirection(query?.sortDir);
    const offset = (page - 1) * pageSize;

    const where = this.buildWhereClause(query);

    const pool = this.getPool();
    const [countRows] = await pool.query<CountRow[]>(
      `SELECT COUNT(*) AS total FROM Alerts ${where.sql}`,
      where.params,
    );

    const [rows] = await pool.query<AlertListRow[]>(
      `SELECT
        id,
        event,
        headline,
        effective AS effectiveAt
      FROM Alerts
      ${where.sql}
      ORDER BY ${this.mapSortBy(sortBy)} ${sortDir.toUpperCase()}
      LIMIT ?
      OFFSET ?`,
      [...where.params, pageSize, offset],
    );

    const items: AlertListItem[] = rows.map((row) => ({
      id: row.id,
      event: row.event,
      headline: row.headline,
      effectiveAt: this.toIsoString(row.effectiveAt),
    }));

    return {
      items,
      page,
      pageSize,
      total: Number(countRows[0]?.total ?? 0),
      sortBy,
      sortDir,
    };
  }

  async getAlertById(idValue: string): Promise<AlertDetails> {
    const id = this.parseId(idValue);
    const row = await this.fetchAlertById(id);

    if (!row) {
      throw new NotFoundException(`Alert ${id} was not found`);
    }

    return this.mapDetailsRow(row);
  }

  async updateAlertById(
    idValue: string,
    body: UpdateAlertRequest,
  ): Promise<AlertDetails> {
    const id = this.parseId(idValue);

    if (!body || typeof body !== "object") {
      throw new BadRequestException("Body must be a JSON object");
    }

    const updateFields = this.buildUpdateFields(body);
    if (!updateFields.length) {
      throw new BadRequestException(
        "At least one updatable field must be provided",
      );
    }

    const pool = this.getPool();
    const assignments = updateFields.map((field) => `${field.column} = ?`);
    const values = updateFields.map((field) => field.value);

    const [result] = await pool.query<ResultSetHeader>(
      `UPDATE Alerts SET ${assignments.join(", ")} WHERE id = ?`,
      [...values, id],
    );

    if (!result.affectedRows) {
      throw new NotFoundException(`Alert ${id} was not found`);
    }

    const updated = await this.fetchAlertById(id);
    if (!updated) {
      throw new NotFoundException(`Alert ${id} was not found`);
    }

    return this.mapDetailsRow(updated);
  }

  async deleteAlertById(idValue: string): Promise<DeleteAlertResponse> {
    const id = this.parseId(idValue);
    const pool = this.getPool();

    const [result] = await pool.query<ResultSetHeader>(
      "DELETE FROM Alerts WHERE id = ?",
      [id],
    );

    if (!result.affectedRows) {
      throw new NotFoundException(`Alert ${id} was not found`);
    }

    return {
      id,
      deleted: true,
    };
  }

  private async fetchAlertById(id: number): Promise<AlertDetailsRow | null> {
    const pool = this.getPool();
    const [rows] = await pool.query<AlertDetailsRow[]>(
      `SELECT
        id,
        nwsId,
        event,
        headline,
        description,
        shortDescription,
        geometry,
        sent,
        effective,
        onset,
        expires,
        ends
      FROM Alerts
      WHERE id = ?
      LIMIT 1`,
      [id],
    );

    return rows[0] ?? null;
  }

  private mapDetailsRow(row: AlertDetailsRow): AlertDetails {
    return {
      id: row.id,
      nwsId: row.nwsId,
      event: row.event,
      headline: row.headline,
      description: row.description,
      shortDescription: row.shortDescription,
      geometry: row.geometry,
      sent: this.toIsoString(row.sent),
      effective: this.toIsoString(row.effective),
      onset: this.toIsoString(row.onset),
      expires: this.toIsoString(row.expires),
      ends: this.toIsoString(row.ends),
    };
  }

  private buildWhereClause(query: ListAlertsQuery): {
    sql: string;
    params: Array<string | Date>;
  } {
    const clauses: string[] = [];
    const params: Array<string | Date> = [];

    const freeText = this.normalizeOptionalString(query?.query);
    if (freeText) {
      clauses.push(
        "(event LIKE ? OR headline LIKE ? OR description LIKE ? OR nwsId LIKE ?)",
      );
      const wildcard = `%${freeText}%`;
      params.push(wildcard, wildcard, wildcard, wildcard);
    }

    const event = this.normalizeOptionalString(query?.event);
    if (event) {
      clauses.push("event LIKE ?");
      params.push(`%${event}%`);
    }

    const headline = this.normalizeOptionalString(query?.headline);
    if (headline) {
      clauses.push("headline LIKE ?");
      params.push(`%${headline}%`);
    }

    if (query?.effectiveFrom != null && String(query.effectiveFrom).trim()) {
      clauses.push("effective >= ?");
      params.push(this.parseDateString(query.effectiveFrom, "effectiveFrom"));
    }

    if (query?.effectiveTo != null && String(query.effectiveTo).trim()) {
      clauses.push("effective <= ?");
      params.push(this.parseDateString(query.effectiveTo, "effectiveTo"));
    }

    if (!clauses.length) {
      return {
        sql: "",
        params,
      };
    }

    return {
      sql: `WHERE ${clauses.join(" AND ")}`,
      params,
    };
  }

  private buildUpdateFields(
    body: UpdateAlertRequest,
  ): Array<{ column: string; value: string | Date | null }> {
    const updates: Array<{ column: string; value: string | Date | null }> = [];

    const stringColumns: Array<keyof UpdateAlertRequest> = [
      "nwsId",
      "event",
      "headline",
      "description",
      "shortDescription",
      "geometry",
    ];

    for (const key of stringColumns) {
      if (!(key in body)) {
        continue;
      }

      const value = body[key];
      if (value !== null && typeof value !== "string") {
        throw new BadRequestException(`${key} must be a string or null`);
      }

      updates.push({
        column: key,
        value,
      });
    }

    const dateColumns: Array<keyof UpdateAlertRequest> = [
      "sent",
      "effective",
      "onset",
      "expires",
      "ends",
    ];

    for (const key of dateColumns) {
      if (!(key in body)) {
        continue;
      }

      const value = body[key];
      if (value === null) {
        updates.push({ column: key, value: null });
        continue;
      }

      if (typeof value !== "string") {
        throw new BadRequestException(
          `${key} must be an ISO datetime string or null`,
        );
      }

      updates.push({
        column: key,
        value: this.parseDateString(value, key),
      });
    }

    return updates;
  }

  private parseId(value: string): number {
    const id = Number.parseInt(String(value), 10);

    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestException("id must be a positive integer");
    }

    return id;
  }

  private normalizeSortBy(value: string | undefined): AlertSortBy {
    if (value == null || value.length === 0) {
      return "effectiveAt";
    }

    if (
      value === "event" ||
      value === "headline" ||
      value === "effectiveAt" ||
      value === "id"
    ) {
      return value;
    }

    throw new BadRequestException(
      "sortBy must be one of event, headline, effectiveAt, id",
    );
  }

  private normalizeSortDirection(value: string | undefined): SortDirection {
    if (value == null || value.length === 0) {
      return "desc";
    }

    const normalized = value.toLowerCase();
    if (normalized === "asc" || normalized === "desc") {
      return normalized;
    }

    throw new BadRequestException("sortDir must be asc or desc");
  }

  private mapSortBy(value: AlertSortBy): string {
    switch (value) {
      case "event":
        return "event";
      case "headline":
        return "headline";
      case "id":
        return "id";
      case "effectiveAt":
      default:
        return "effective";
    }
  }

  private normalizePositiveInt(
    value: number | string | undefined,
    fallback: number,
    fieldName: string,
  ): number {
    if (value == null || value === "") {
      return fallback;
    }

    const parsed =
      typeof value === "number" ? value : Number.parseInt(String(value), 10);

    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new BadRequestException(`${fieldName} must be a positive integer`);
    }

    return parsed;
  }

  private normalizeOptionalString(
    value: string | undefined,
  ): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
  }

  private parseDateString(value: string, fieldName: string): Date {
    const trimmed = value.trim();
    const parsed = new Date(trimmed);

    if (!trimmed.length || Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(
        `${fieldName} must be a valid datetime string`,
      );
    }

    return parsed;
  }

  private toIsoString(value: Date | string | null): string | null {
    if (!value) {
      return null;
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return String(value);
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

  private readEnv(): AlertsApiEnv {
    return {
      alertsDbHost: process.env.NWS_ALERTS_DB_HOST ?? "localhost",
      alertsDbPort: this.parsePositiveInt(process.env.NWS_ALERTS_DB_PORT, 3307),
      alertsDbUser: process.env.NWS_ALERTS_DB_USER ?? "emwin_user",
      alertsDbPassword: process.env.NWS_ALERTS_DB_PASSWORD ?? "emwin_pass",
      alertsDbName: process.env.NWS_ALERTS_DB_NAME ?? "emwin",
      listPageSizeDefault: this.parsePositiveInt(
        process.env.NWS_ALERTS_LIST_PAGE_SIZE_DEFAULT,
        50,
      ),
      listPageSizeMax: this.parsePositiveInt(
        process.env.NWS_ALERTS_LIST_PAGE_SIZE_MAX,
        200,
      ),
    };
  }

  private parsePositiveInt(
    value: string | undefined,
    fallback: number,
  ): number {
    if (!value) {
      return fallback;
    }

    const parsed = Number.parseInt(value, 10);

    if (!Number.isInteger(parsed) || parsed <= 0) {
      return fallback;
    }

    return parsed;
  }
}
