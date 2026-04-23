import { Injectable, OnModuleDestroy } from "@nestjs/common";
import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import type { SearchFilter } from "../nws-search/types.js";
import type {
  Citation,
  LiveContextMetadata,
  LiveContextMode,
  LiveContextSource,
} from "./types.js";

interface LiveContextEnv {
  alertsDbHost: string;
  alertsDbPort: number;
  alertsDbUser: string;
  alertsDbPassword: string;
  alertsDbName: string;
  homeLat: number;
  homeLon: number;
  userAgent: string;
  localGuidanceLookbackHours: number;
  localAqiLookbackHours: number;
  maxGuidanceRows: number;
  maxAqiRows: number;
  maxActiveAlerts: number;
  maxHourlyPeriods: number;
}

export interface LiveContextRequest {
  question: string;
  filter?: SearchFilter;
  liveMode?: LiveContextMode;
  signal?: AbortSignal;
}

export interface LiveContextResult {
  citations: Citation[];
  metadata: LiveContextMetadata;
}

interface AlertsRow extends RowDataPacket {
  id: number;
  nwsId: string | null;
  sourceFamily: string | null;
  sourceProduct: string | null;
  event: string | null;
  headline: string | null;
  shortDescription: string | null;
  description: string | null;
  sent: Date | string | null;
  effective: Date | string | null;
  expires: Date | string | null;
  ends: Date | string | null;
}

type NwsPointsResponse = {
  properties?: {
    forecastHourly?: string;
    observationStations?: string;
    relativeLocation?: {
      properties?: {
        city?: string;
        state?: string;
      };
    };
  };
};

type GeoJsonFeatureCollection = {
  features?: Array<{
    id?: string;
    properties?: Record<string, unknown>;
  }>;
};

type NwsObservationResponse = {
  properties?: {
    timestamp?: string;
    textDescription?: string;
    temperature?: {
      value?: number | null;
      unitCode?: string;
    };
    windSpeed?: {
      value?: number | null;
      unitCode?: string;
    };
    windDirection?: {
      value?: number | null;
    };
    relativeHumidity?: {
      value?: number | null;
    };
  };
};

type NwsForecastHourlyResponse = {
  properties?: {
    updated?: string;
    periods?: Array<Record<string, unknown>>;
  };
};

type NwsActiveAlertsResponse = {
  features?: Array<{
    id?: string;
    properties?: Record<string, unknown>;
  }>;
};

type DatasetSelection = {
  activeAlerts: boolean;
  currentConditions: boolean;
  guidance: boolean;
  aqi: boolean;
};

type ProviderResult = {
  citations: Citation[];
  sources: LiveContextSource[];
};

interface GuidanceQueryProfile {
  sourceFamilies: string[];
  sourceProducts?: string[];
  requestedEventTypes: string[];
  preferredDayNumbers: number[];
  keywords: string[];
  familyWeights: Record<string, number>;
  productWeights: Record<string, number>;
  lookbackHours: number;
  candidateLimit: number;
}

interface RankedGuidanceRow {
  row: AlertsRow;
  relevanceScore: number;
}

const DEFAULT_HOME_LAT = 36.41164391680596;
const DEFAULT_HOME_LON = -95.93253616680347;

@Injectable()
export class NwsLiveContextService implements OnModuleDestroy {
  private pool: mysql.Pool | null = null;

  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  shouldFetchLiveContext(input: Omit<LiveContextRequest, "signal">): boolean {
    const mode = this.normalizeMode(input.liveMode);
    if (mode === "off") {
      return false;
    }

    if (mode === "required") {
      return true;
    }

    const combinedText = this.buildFilterText(input.question, input.filter);
    return this.hasCurrentIntent(combinedText);
  }

  async getLiveContext(
    input: LiveContextRequest,
  ): Promise<LiveContextResult | null> {
    if (!this.shouldFetchLiveContext(input)) {
      return null;
    }

    const env = this.readEnv();
    const selection = this.selectDatasets(input.question, input.filter);
    const fetchedAt = new Date().toISOString();
    const warnings: string[] = [];
    const citations: Citation[] = [];
    const sources: LiveContextSource[] = [];

    if (selection.currentConditions) {
      try {
        const result = await this.fetchCurrentConditions(env, input.signal);
        citations.push(...result.citations);
        sources.push(...result.sources);
      } catch (error) {
        warnings.push(
          `Current conditions unavailable: ${this.describeError(error)}`,
        );
      }
    }

    if (selection.activeAlerts) {
      try {
        const result = await this.fetchActiveAlerts(
          env,
          input.filter,
          input.signal,
        );
        citations.push(...result.citations);
        sources.push(...result.sources);
      } catch (error) {
        warnings.push(
          `Active alerts unavailable: ${this.describeError(error)}`,
        );
      }
    }

    if (selection.guidance) {
      try {
        const result = await this.fetchLocalGuidance(
          input.question,
          input.filter,
        );
        citations.push(...result.citations);
        sources.push(...result.sources);
      } catch (error) {
        warnings.push(
          `Local guidance unavailable: ${this.describeError(error)}`,
        );
      }
    }

    if (selection.aqi) {
      try {
        const result = await this.fetchLocalAirQuality(input.filter);
        citations.push(...result.citations);
        sources.push(...result.sources);
      } catch (error) {
        warnings.push(`Air quality unavailable: ${this.describeError(error)}`);
      }
    }

    const dedupedCitations = this.dedupeCitations(citations);
    const dedupedSources = this.dedupeSources(sources);

    return {
      citations: dedupedCitations,
      metadata: {
        mode: this.normalizeMode(input.liveMode),
        status: dedupedCitations.length
          ? warnings.length
            ? "partial"
            : "ok"
          : "unavailable",
        fetchedAt,
        warnings,
        sources: dedupedSources,
      },
    };
  }

  private selectDatasets(
    question: string,
    filter?: SearchFilter,
  ): DatasetSelection {
    const combinedText = this.buildFilterText(question, filter);
    const mentionsAqi = /\b(aqi|air quality|ozone|pm2\.?5|smoke)\b/i.test(
      combinedText,
    );
    const mentionsAlerts =
      /\b(alert|alerts|warning|warnings|watch|watches|advisory|advisories|hazard|hazards)\b/i.test(
        combinedText,
      );
    const mentionsGuidance =
      /\b(outlook|risk|discussion|mesoscale|convective|fire weather|excessive rain|snow forecast|pwpf|severe)\b/i.test(
        combinedText,
      );
    const mentionsWeather =
      /\b(weather|conditions?|temperature|temp|wind|humidity|dew point|outside|forecast|rain|snow|ice|heat|cold)\b/i.test(
        combinedText,
      );
    const currentIntent = this.hasCurrentIntent(combinedText);

    return {
      activeAlerts: currentIntent || mentionsAlerts || mentionsGuidance,
      currentConditions:
        mentionsWeather || (currentIntent && !mentionsAqi && !mentionsGuidance),
      guidance: mentionsGuidance,
      aqi: mentionsAqi,
    };
  }

  private hasCurrentIntent(text: string): boolean {
    return /\b(current|currently|right now|now|latest|today|tonight|this morning|this afternoon|this evening|active)\b/i.test(
      text,
    );
  }

  private buildFilterText(question: string, filter?: SearchFilter): string {
    return [
      question,
      filter?.eventType,
      ...(filter?.includeEventTypes ?? []),
      ...(filter?.excludeEventTypes ?? []),
    ]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .toLowerCase();
  }

  private async fetchCurrentConditions(
    env: LiveContextEnv,
    signal?: AbortSignal,
  ): Promise<ProviderResult> {
    const points = await this.fetchJson<NwsPointsResponse>(
      `https://api.weather.gov/points/${env.homeLat},${env.homeLon}`,
      env.userAgent,
      signal,
    );
    const locationName = this.formatLocationName(points);
    const citations: Citation[] = [];
    const sources: LiveContextSource[] = [];
    const nowMs = Date.now();

    const observationStationsUrl = points.properties?.observationStations;
    if (typeof observationStationsUrl === "string") {
      const stations = await this.fetchJson<GeoJsonFeatureCollection>(
        observationStationsUrl,
        env.userAgent,
        signal,
      );
      const station = stations.features?.[0];
      const stationId = this.readStationId(station);
      const stationName = this.readStationName(station);
      if (stationId) {
        const observation = await this.fetchJson<NwsObservationResponse>(
          `https://api.weather.gov/stations/${stationId}/observations/latest`,
          env.userAgent,
          signal,
        );
        const observationCitation = this.toObservationCitation(
          observation,
          stationId,
          stationName,
          locationName,
          nowMs,
        );
        if (observationCitation) {
          citations.push(observationCitation);
          sources.push({
            dataset: "current-conditions",
            origin: "live-upstream",
            source: "weather.gov",
            sourceFamily: "nws",
            sourceProduct: "latest-observation",
            asOf: this.readMetadataString(observationCitation, "sent"),
            itemCount: 1,
          });
        }
      }
    }

    const forecastHourlyUrl = points.properties?.forecastHourly;
    if (typeof forecastHourlyUrl === "string") {
      const forecast = await this.fetchJson<NwsForecastHourlyResponse>(
        forecastHourlyUrl,
        env.userAgent,
        signal,
      );
      const forecastCitation = this.toForecastCitation(
        forecast,
        locationName,
        env.maxHourlyPeriods,
        nowMs,
      );
      if (forecastCitation) {
        citations.push(forecastCitation);
        sources.push({
          dataset: "hourly-forecast",
          origin: "live-upstream",
          source: "weather.gov",
          sourceFamily: "nws",
          sourceProduct: "forecast-hourly",
          asOf: this.readMetadataString(forecastCitation, "sent"),
          itemCount: 1,
        });
      }
    }

    return {
      citations,
      sources,
    };
  }

  private async fetchActiveAlerts(
    env: LiveContextEnv,
    filter: SearchFilter | undefined,
    signal?: AbortSignal,
  ): Promise<ProviderResult> {
    const response = await this.fetchJson<NwsActiveAlertsResponse>(
      `https://api.weather.gov/alerts/active?point=${env.homeLat},${env.homeLon}`,
      env.userAgent,
      signal,
    );
    const features = response.features ?? [];
    const nowMs = Date.now();
    const citations = features
      .filter((feature) => this.matchesEventFilter(feature.properties, filter))
      .slice(0, env.maxActiveAlerts)
      .map((feature, index) =>
        this.toActiveAlertCitation(feature, nowMs, index),
      )
      .filter((citation): citation is Citation => citation != null);

    return {
      citations,
      sources: citations.length
        ? [
            {
              dataset: "active-alerts",
              origin: "live-upstream",
              source: "nws-active",
              sourceFamily: "nws",
              sourceProduct: "active-alert",
              asOf: this.findLatestCitationTimestamp(citations),
              itemCount: citations.length,
            },
          ]
        : [],
    };
  }

  private async fetchLocalGuidance(
    question: string,
    filter: SearchFilter | undefined,
  ): Promise<ProviderResult> {
    const env = this.readEnv();
    const guidanceQueryProfile = this.buildGuidanceQueryProfile(
      env,
      question,
      filter,
    );
    if (!guidanceQueryProfile.sourceFamilies.length) {
      return {
        citations: [],
        sources: [],
      };
    }

    const rows = await this.fetchLatestAlertsRows({
      sourceFamilies: guidanceQueryProfile.sourceFamilies,
      sourceProducts: guidanceQueryProfile.sourceProducts,
      sentFrom: new Date(
        Date.now() - guidanceQueryProfile.lookbackHours * 60 * 60 * 1000,
      ).toISOString(),
      limit: guidanceQueryProfile.candidateLimit,
      filter,
    });
    const rankedRows = this.rankGuidanceRows(rows, guidanceQueryProfile).slice(
      0,
      env.maxGuidanceRows,
    );
    const citations = rankedRows.map(({ row, relevanceScore }) =>
      this.toLocalAlertCitation(row, "guidance", relevanceScore),
    );

    const sources = guidanceQueryProfile.sourceFamilies.reduce<
      LiveContextSource[]
    >((items, sourceFamily) => {
      const familyRows = rankedRows
        .map((item) => item.row)
        .filter((row) => row.sourceFamily === sourceFamily);
      if (!familyRows.length) {
        return items;
      }

      items.push({
        dataset: `${sourceFamily}-guidance`,
        origin: "live-local",
        source: "nwsAlerts",
        sourceFamily,
        sourceProduct: "tracked-guidance",
        asOf: this.normalizeIso(familyRows[0]?.sent),
        itemCount: familyRows.length,
      });
      return items;
    }, []);

    return {
      citations,
      sources,
    };
  }

  private async fetchLocalAirQuality(
    filter: SearchFilter | undefined,
  ): Promise<ProviderResult> {
    const env = this.readEnv();
    const rows = await this.fetchLatestAlertsRows({
      sourceFamilies: ["airnow"],
      sentFrom: new Date(
        Date.now() - env.localAqiLookbackHours * 60 * 60 * 1000,
      ).toISOString(),
      limit: env.maxAqiRows,
      filter,
    });
    const sortedRows = [...rows].sort((left, right) => {
      if (left.sourceProduct === right.sourceProduct) {
        return this.toTimestamp(right.sent) - this.toTimestamp(left.sent);
      }

      if (left.sourceProduct === "aqi-threshold-alert") {
        return -1;
      }

      if (right.sourceProduct === "aqi-threshold-alert") {
        return 1;
      }

      return 0;
    });

    const citations = sortedRows.map((row, index) =>
      this.toLocalAlertCitation(row, "air-quality", undefined, index),
    );

    return {
      citations,
      sources: citations.length
        ? [
            {
              dataset: "air-quality",
              origin: "live-local",
              source: "nwsAlerts",
              sourceFamily: "airnow",
              sourceProduct: "tracked-airnow",
              asOf: this.normalizeIso(sortedRows[0]?.sent),
              itemCount: citations.length,
            },
          ]
        : [],
    };
  }

  private async fetchLatestAlertsRows(input: {
    sourceFamilies: string[];
    sourceProducts?: string[];
    sentFrom: string;
    limit: number;
    filter?: SearchFilter;
  }): Promise<AlertsRow[]> {
    if (!input.sourceFamilies.length) {
      return [];
    }

    const eventTypes = this.collectRequestedEventTypes(input.filter);
    const familyPlaceholders = input.sourceFamilies.map(() => "?").join(", ");
    const productSql = input.sourceProducts?.length
      ? ` AND sourceProduct IN (${input.sourceProducts.map(() => "?").join(", ")})`
      : "";
    const eventSql = eventTypes.length
      ? ` AND (${eventTypes.map(() => "event LIKE ?").join(" OR ")})`
      : "";

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
        description,
        sent,
        effective,
        expires,
        ends
      FROM Alerts
      WHERE sourceFamily IN (${familyPlaceholders})
        AND COALESCE(sent, effective) >= ?
        ${productSql}
        ${eventSql}
      ORDER BY COALESCE(sent, effective) DESC, id DESC
      LIMIT ?`,
      [
        ...input.sourceFamilies,
        input.sentFrom,
        ...(input.sourceProducts ?? []),
        ...eventTypes.map((eventType) => `%${eventType}%`),
        input.limit,
      ],
    );

    return rows;
  }

  private toObservationCitation(
    response: NwsObservationResponse,
    stationId: string,
    stationName: string | undefined,
    locationName: string,
    nowMs: number,
  ): Citation | null {
    const timestamp = this.normalizeOptionalString(
      response.properties?.timestamp,
    );
    const textDescription = this.normalizeOptionalString(
      response.properties?.textDescription,
    );
    const temperatureF = this.toFahrenheit(
      response.properties?.temperature?.value,
      response.properties?.temperature?.unitCode,
    );
    const windMph = this.toMph(
      response.properties?.windSpeed?.value,
      response.properties?.windSpeed?.unitCode,
    );
    const windDirection = this.toCompassDirection(
      response.properties?.windDirection?.value,
    );
    const humidity = this.toRoundedNumber(
      response.properties?.relativeHumidity?.value,
    );

    const details = [
      textDescription,
      temperatureF != null ? `${temperatureF.toFixed(0)} F` : null,
      windMph != null
        ? `wind ${windDirection ? `${windDirection} ` : ""}${windMph.toFixed(0)} mph`
        : null,
      humidity != null ? `humidity ${humidity}%` : null,
    ].filter((value): value is string => Boolean(value));

    if (!details.length) {
      return null;
    }

    const snippet = `${locationName} current conditions from ${
      stationName ?? stationId
    }: ${details.join(", ")}.${timestamp ? ` Observed at ${timestamp}.` : ""}`;

    return {
      id: `live-upstream:observation:${stationId}`,
      score: 1,
      source: "weather.gov",
      citationLabel: stationId,
      sourceDocumentId: stationId,
      origin: "live-upstream",
      ...(timestamp ? { fetchedAt: timestamp } : {}),
      ...(timestamp
        ? {
            freshnessMs: Math.max(0, nowMs - this.toTimestamp(timestamp)),
          }
        : {}),
      snippet,
      metadata: {
        eventType: "Current Conditions",
        headline: `${locationName} current conditions`,
        sourceFamily: "nws",
        sourceProduct: "latest-observation",
        stationId,
        stationName,
        sent: timestamp,
        effectiveAt: timestamp,
      },
    };
  }

  private toForecastCitation(
    response: NwsForecastHourlyResponse,
    locationName: string,
    maxPeriods: number,
    nowMs: number,
  ): Citation | null {
    const updated = this.normalizeOptionalString(response.properties?.updated);
    const periods = Array.isArray(response.properties?.periods)
      ? response.properties?.periods.slice(0, maxPeriods)
      : [];
    if (!periods.length) {
      return null;
    }

    const summary = periods
      .map((period) => {
        const startTime = this.normalizeOptionalString(period.startTime);
        const shortForecast = this.normalizeOptionalString(
          period.shortForecast,
        );
        const windSpeed = this.normalizeOptionalString(period.windSpeed);
        const windDirection = this.normalizeOptionalString(
          period.windDirection,
        );
        const temperature =
          typeof period.temperature === "number" &&
          Number.isFinite(period.temperature)
            ? `${period.temperature.toFixed(0)} ${
                this.normalizeOptionalString(period.temperatureUnit) ?? "F"
              }`
            : null;

        return [
          startTime,
          shortForecast,
          temperature,
          windSpeed && windDirection
            ? `${windDirection} ${windSpeed}`
            : windSpeed,
        ]
          .filter((value): value is string => Boolean(value))
          .join(" · ");
      })
      .filter(Boolean)
      .join(" | ");

    if (!summary) {
      return null;
    }

    return {
      id: "live-upstream:forecast-hourly",
      score: 0.99,
      source: "weather.gov",
      citationLabel: "forecast-hourly",
      sourceDocumentId: "forecast-hourly",
      origin: "live-upstream",
      ...(updated ? { fetchedAt: updated } : {}),
      ...(updated
        ? {
            freshnessMs: Math.max(0, nowMs - this.toTimestamp(updated)),
          }
        : {}),
      snippet: `${locationName} hourly forecast: ${summary}`,
      metadata: {
        eventType: "Hourly Forecast",
        headline: `${locationName} hourly forecast`,
        sourceFamily: "nws",
        sourceProduct: "forecast-hourly",
        sent: updated,
        effectiveAt: updated,
      },
    };
  }

  private toActiveAlertCitation(
    feature: { id?: string; properties?: Record<string, unknown> },
    nowMs: number,
    index: number,
  ): Citation | null {
    const eventType = this.normalizeOptionalString(feature.properties?.event);
    const headline = this.normalizeOptionalString(feature.properties?.headline);
    const sent = this.normalizeOptionalString(feature.properties?.sent);
    const effectiveAt = this.normalizeOptionalString(
      feature.properties?.effective,
    );
    const expiresAt = this.normalizeOptionalString(feature.properties?.expires);
    const endsAt = this.normalizeOptionalString(feature.properties?.ends);
    const description = this.normalizeOptionalString(
      feature.properties?.description,
    );
    const identifier =
      this.normalizeOptionalString(feature.id) ??
      this.normalizeOptionalString(feature.properties?.id) ??
      `active-alert-${index + 1}`;

    const snippet = this.truncateText(
      [headline, description]
        .filter((value): value is string => Boolean(value))
        .join(" "),
      420,
    );

    if (!snippet) {
      return null;
    }

    const freshnessSource = sent ?? effectiveAt;

    return {
      id: `live-upstream:active-alert:${identifier}`,
      score: 0.98 - index * 0.01,
      source: "nws-active",
      citationLabel: identifier,
      sourceDocumentId: identifier,
      origin: "live-upstream",
      ...(freshnessSource ? { fetchedAt: freshnessSource } : {}),
      ...(freshnessSource
        ? {
            freshnessMs: Math.max(0, nowMs - this.toTimestamp(freshnessSource)),
          }
        : {}),
      snippet,
      metadata: {
        eventType,
        headline,
        sourceFamily: "nws",
        sourceProduct: "active-alert",
        sent,
        effectiveAt,
        expiresAt,
        endsAt,
        severity: this.normalizeOptionalString(feature.properties?.severity),
        urgency: this.normalizeOptionalString(feature.properties?.urgency),
        certainty: this.normalizeOptionalString(feature.properties?.certainty),
      },
    };
  }

  private toLocalAlertCitation(
    row: AlertsRow,
    dataset: string,
    relevanceScore?: number,
    orderIndex = 0,
  ): Citation {
    const sent = this.normalizeIso(row.sent);
    const effectiveAt = this.normalizeIso(row.effective);
    const expiresAt = this.normalizeIso(row.expires);
    const endsAt = this.normalizeIso(row.ends);
    const freshnessSource = sent || effectiveAt;
    const citationScore =
      relevanceScore != null
        ? this.normalizeLocalCitationScore(relevanceScore)
        : 0.95 - orderIndex * 0.01;
    return {
      id: `live-local:${row.id}`,
      score: citationScore,
      source: "nwsAlerts",
      citationLabel: row.nwsId ?? `${row.sourceProduct ?? dataset}-${row.id}`,
      sourceDocumentId: String(row.id),
      origin: "live-local",
      ...(freshnessSource ? { fetchedAt: freshnessSource } : {}),
      ...(freshnessSource
        ? {
            freshnessMs: Math.max(
              0,
              Date.now() - this.toTimestamp(freshnessSource),
            ),
          }
        : {}),
      snippet: this.truncateText(
        row.shortDescription ??
          row.headline ??
          row.description ??
          `${dataset} update`,
        500,
      ),
      metadata: {
        eventType: row.event,
        headline: row.headline,
        shortDescription: row.shortDescription,
        description: row.description,
        sourceFamily: row.sourceFamily,
        sourceProduct: row.sourceProduct,
        sent,
        effectiveAt,
        expiresAt,
        endsAt,
      },
    };
  }

  private collectRequestedEventTypes(filter?: SearchFilter): string[] {
    return [
      ...(filter?.eventType ? [filter.eventType] : []),
      ...(filter?.includeEventTypes ?? []),
    ]
      .map((value) => value.trim())
      .filter(Boolean);
  }

  private matchesEventFilter(
    properties: Record<string, unknown> | undefined,
    filter: SearchFilter | undefined,
  ): boolean {
    const requestedEventTypes = this.collectRequestedEventTypes(filter);
    if (!requestedEventTypes.length) {
      return true;
    }

    const eventType = this.normalizeOptionalString(
      properties?.event,
    )?.toLowerCase();
    if (!eventType) {
      return false;
    }

    return requestedEventTypes.some((requestedEventType) =>
      eventType.includes(requestedEventType.toLowerCase()),
    );
  }

  private selectGuidanceFamilies(
    question: string,
    filter?: SearchFilter,
  ): string[] {
    return this.buildGuidanceQueryProfile(this.readEnv(), question, filter)
      .sourceFamilies;
  }

  private buildGuidanceQueryProfile(
    env: LiveContextEnv,
    question: string,
    filter?: SearchFilter,
  ): GuidanceQueryProfile {
    const combinedText = this.buildFilterText(question, filter);
    const requestedEventTypes = this.collectRequestedEventTypes(filter).map(
      (value) => value.toLowerCase(),
    );
    const preferredDayNumbers = this.extractRequestedDayNumbers(combinedText);
    const keywords = this.collectGuidanceKeywords(
      combinedText,
      requestedEventTypes,
    );
    const familyWeights: Record<string, number> = {};
    const productWeights: Record<string, number> = {};
    const families = new Set<string>();
    let lookbackHours = env.localGuidanceLookbackHours;

    const addFamily = (family: string, weight: number) => {
      families.add(family);
      familyWeights[family] = Math.max(familyWeights[family] ?? 0, weight);
    };

    const addProduct = (product: string, weight: number) => {
      productWeights[product] = Math.max(productWeights[product] ?? 0, weight);
    };

    const mentionsSevere =
      /\b(severe|storm|storms|thunderstorm|tornado|hail|wind|convective|mesoscale|risk)\b/i.test(
        combinedText,
      ) ||
      this.matchesRequestedEventTypes(requestedEventTypes, [
        "tornado",
        "thunderstorm",
        "convective",
        "mesoscale discussion",
      ]);
    const mentionsFire =
      /\b(fire weather|red flag|wildfire|critical fire)\b/i.test(
        combinedText,
      ) || this.matchesRequestedEventTypes(requestedEventTypes, ["fire"]);
    const mentionsFloodRain =
      /\b(flood|flooding|rain|rainfall|excessive rain)\b/i.test(combinedText) ||
      this.matchesRequestedEventTypes(requestedEventTypes, ["flood", "rain"]);
    const mentionsSnowIce =
      /\b(snow|winter|ice|sleet|freezing rain|pwpf)\b/i.test(combinedText) ||
      this.matchesRequestedEventTypes(requestedEventTypes, [
        "snow",
        "winter",
        "ice",
        "pwpf",
      ]);
    const mentionsMesoscaleDiscussion =
      /\b(mesoscale|discussion)\b/i.test(combinedText) ||
      this.matchesRequestedEventTypes(requestedEventTypes, [
        "mesoscale discussion",
      ]);
    const currentIntent = this.hasCurrentIntent(combinedText);

    if (mentionsSevere || mentionsFire) {
      addFamily("spc", mentionsFire && !mentionsSevere ? 0.95 : 1);
    }

    if (mentionsFloodRain || mentionsSnowIce) {
      addFamily("wpc", mentionsSnowIce && !mentionsFloodRain ? 1 : 0.95);
    }

    if (mentionsSevere) {
      addProduct("convective-outlook", 1);
      addProduct(
        "mesoscale-discussion",
        mentionsMesoscaleDiscussion || currentIntent ? 0.95 : 0.7,
      );
    }

    if (mentionsFire) {
      addProduct("fire-weather-outlook", 1.05);
    }

    if (mentionsFloodRain) {
      addProduct("excessive-rainfall", 1.05);
    }

    if (mentionsSnowIce) {
      addProduct("snow-forecast", 1.05);
    }

    if (!families.size) {
      addFamily("spc", 0.6);
      addFamily("wpc", 0.6);
    }

    if (!Object.keys(productWeights).length) {
      if (families.has("spc")) {
        addProduct("convective-outlook", 0.8);
        addProduct("mesoscale-discussion", 0.65);
      }
      if (families.has("wpc")) {
        addProduct("excessive-rainfall", 0.8);
        addProduct("snow-forecast", 0.8);
      }
    }

    if (mentionsMesoscaleDiscussion) {
      lookbackHours = Math.min(12, env.localGuidanceLookbackHours);
    } else if (currentIntent || preferredDayNumbers.includes(1)) {
      lookbackHours = Math.min(18, env.localGuidanceLookbackHours);
    } else if (
      preferredDayNumbers.some((dayNumber) => dayNumber >= 2 && dayNumber <= 3)
    ) {
      lookbackHours = Math.min(24, env.localGuidanceLookbackHours);
    } else if (mentionsFire || mentionsFloodRain || mentionsSnowIce) {
      lookbackHours = Math.min(30, env.localGuidanceLookbackHours);
    }

    const sourceFamilies = [...families].sort(
      (left, right) => (familyWeights[right] ?? 0) - (familyWeights[left] ?? 0),
    );
    const sourceProducts = Object.entries(productWeights)
      .sort((left, right) => right[1] - left[1])
      .map(([product]) => product);

    return {
      sourceFamilies,
      sourceProducts: sourceProducts.length ? sourceProducts : undefined,
      requestedEventTypes,
      preferredDayNumbers,
      keywords,
      familyWeights,
      productWeights,
      lookbackHours,
      candidateLimit: Math.max(
        env.maxGuidanceRows * 3,
        sourceFamilies.length > 1 ? 10 : 8,
      ),
    };
  }

  private rankGuidanceRows(
    rows: AlertsRow[],
    guidanceQueryProfile: GuidanceQueryProfile,
  ): RankedGuidanceRow[] {
    return rows
      .map((row) => ({
        row,
        relevanceScore: this.computeGuidanceRelevanceScore(
          row,
          guidanceQueryProfile,
        ),
      }))
      .sort((left, right) => {
        if (right.relevanceScore !== left.relevanceScore) {
          return right.relevanceScore - left.relevanceScore;
        }

        const rightTimestamp = this.toTimestamp(
          right.row.sent ?? right.row.effective,
        );
        const leftTimestamp = this.toTimestamp(
          left.row.sent ?? left.row.effective,
        );
        if (rightTimestamp !== leftTimestamp) {
          return rightTimestamp - leftTimestamp;
        }

        return right.row.id - left.row.id;
      });
  }

  private computeGuidanceRelevanceScore(
    row: AlertsRow,
    guidanceQueryProfile: GuidanceQueryProfile,
  ): number {
    const rowText = [
      row.event,
      row.headline,
      row.shortDescription,
      row.description,
      row.sourceProduct,
    ]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .toLowerCase();
    const family = (row.sourceFamily ?? "").toLowerCase();
    const sourceProduct = (row.sourceProduct ?? "").toLowerCase();

    let score = 0;
    score += guidanceQueryProfile.familyWeights[family] ?? 0.15;
    score += guidanceQueryProfile.productWeights[sourceProduct] ?? 0.05;

    if (guidanceQueryProfile.sourceProducts?.length) {
      score += guidanceQueryProfile.sourceProducts.includes(sourceProduct)
        ? 0.15
        : -0.1;
    }

    if (guidanceQueryProfile.requestedEventTypes.length > 0) {
      score += guidanceQueryProfile.requestedEventTypes.some((eventType) =>
        rowText.includes(eventType),
      )
        ? 0.45
        : -0.05;
    }

    const keywordHits = guidanceQueryProfile.keywords.filter((keyword) =>
      rowText.includes(keyword),
    ).length;
    score += Math.min(0.4, keywordHits * 0.12);

    if (guidanceQueryProfile.preferredDayNumbers.length > 0) {
      const rowDayNumber = this.extractGuidanceDayNumber(row);
      if (
        rowDayNumber != null &&
        guidanceQueryProfile.preferredDayNumbers.includes(rowDayNumber)
      ) {
        score += 0.3;
      } else if (rowDayNumber != null) {
        score -= 0.05;
      }
    }

    score +=
      this.computeGuidanceRecencyScore(
        row,
        guidanceQueryProfile.lookbackHours,
      ) * 0.35;

    return Math.max(0, Math.min(1, score / 2.6));
  }

  private computeGuidanceRecencyScore(
    row: AlertsRow,
    lookbackHours: number,
  ): number {
    const timestamp = this.toTimestamp(row.sent ?? row.effective);
    if (!timestamp) {
      return 0.05;
    }

    const ageHours = Math.max(0, (Date.now() - timestamp) / (60 * 60 * 1000));
    const timeConstantHours = Math.max(6, lookbackHours / 2);
    return Math.exp(-ageHours / timeConstantHours);
  }

  private collectGuidanceKeywords(
    combinedText: string,
    requestedEventTypes: string[],
  ): string[] {
    const candidateKeywords = [
      "tornado",
      "hail",
      "wind",
      "convective",
      "mesoscale",
      "discussion",
      "fire weather",
      "red flag",
      "flood",
      "excessive rain",
      "rainfall",
      "snow",
      "winter",
      "ice",
      "pwpf",
      "outlook",
      "risk",
      "day 1",
      "day 2",
      "day 3",
      "day 4",
      "day 5",
      "day 6",
      "day 7",
      "day 8",
    ];

    return candidateKeywords.filter(
      (keyword) =>
        combinedText.includes(keyword) ||
        requestedEventTypes.some((eventType) => eventType.includes(keyword)),
    );
  }

  private extractRequestedDayNumbers(text: string): number[] {
    const matches = [...text.matchAll(/\bday\s*([1-8])\b/gi)];
    return [
      ...new Set(
        matches
          .map((match) => Number.parseInt(match[1] ?? "", 10))
          .filter(Number.isFinite),
      ),
    ];
  }

  private extractGuidanceDayNumber(row: AlertsRow): number | null {
    const rowText = [row.event, row.headline]
      .filter((value): value is string => typeof value === "string")
      .join(" ");
    const match = rowText.match(/\bday\s*([1-8])\b/i);
    if (!match) {
      return null;
    }

    const parsed = Number.parseInt(match[1] ?? "", 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private matchesRequestedEventTypes(
    requestedEventTypes: string[],
    fragments: string[],
  ): boolean {
    return requestedEventTypes.some((requestedEventType) =>
      fragments.some((fragment) => requestedEventType.includes(fragment)),
    );
  }

  private normalizeLocalCitationScore(relevanceScore: number): number {
    const normalized = Math.max(0, Math.min(1, relevanceScore));
    return Number((0.55 + normalized * 0.4).toFixed(4));
  }

  private async fetchJson<T>(
    url: string,
    userAgent: string,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetch(url, {
      headers: {
        Accept: "application/geo+json, application/json;q=0.9",
        "User-Agent": userAgent,
      },
      signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }

    return (await response.json()) as T;
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
      connectionLimit: 4,
      waitForConnections: true,
      queueLimit: 0,
      timezone: "Z",
    });

    return this.pool;
  }

  private readEnv(): LiveContextEnv {
    return {
      alertsDbHost: process.env.NWS_ALERTS_DB_HOST ?? "localhost",
      alertsDbPort: this.parseInteger(process.env.NWS_ALERTS_DB_PORT, 3307),
      alertsDbUser: process.env.NWS_ALERTS_DB_USER ?? "emwin_user",
      alertsDbPassword: process.env.NWS_ALERTS_DB_PASSWORD ?? "emwin_pass",
      alertsDbName: process.env.NWS_ALERTS_DB_NAME ?? "emwin",
      homeLat: this.parseFloatValue(process.env.MY_LAT, DEFAULT_HOME_LAT),
      homeLon: this.parseFloatValue(process.env.MY_LON, DEFAULT_HOME_LON),
      userAgent:
        this.normalizeOptionalString(process.env.NWS_LIVE_USER_AGENT) ??
        "weather-llm-api/0.1 live-context",
      localGuidanceLookbackHours: this.parseInteger(
        process.env.NWS_LIVE_GUIDANCE_LOOKBACK_HOURS,
        36,
      ),
      localAqiLookbackHours: this.parseInteger(
        process.env.NWS_LIVE_AQI_LOOKBACK_HOURS,
        30,
      ),
      maxGuidanceRows: this.parseInteger(
        process.env.NWS_LIVE_GUIDANCE_MAX_ROWS,
        4,
      ),
      maxAqiRows: this.parseInteger(process.env.NWS_LIVE_AQI_MAX_ROWS, 2),
      maxActiveAlerts: this.parseInteger(
        process.env.NWS_LIVE_ACTIVE_ALERTS_MAX_ROWS,
        4,
      ),
      maxHourlyPeriods: this.parseInteger(
        process.env.NWS_LIVE_HOURLY_PERIODS_MAX,
        3,
      ),
    };
  }

  private normalizeMode(mode: LiveContextMode | undefined): LiveContextMode {
    return mode ?? "auto";
  }

  private parseInteger(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private parseFloatValue(value: string | undefined, fallback: number): number {
    const parsed = Number.parseFloat(value ?? "");
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private formatLocationName(points: NwsPointsResponse): string {
    const city = this.normalizeOptionalString(
      points.properties?.relativeLocation?.properties?.city,
    );
    const state = this.normalizeOptionalString(
      points.properties?.relativeLocation?.properties?.state,
    );

    if (city && state) {
      return `${city}, ${state}`;
    }

    return `${this.readEnv().homeLat.toFixed(2)}, ${this.readEnv().homeLon.toFixed(2)}`;
  }

  private readStationId(
    feature: { id?: string; properties?: Record<string, unknown> } | undefined,
  ): string | undefined {
    const stationIdentifier = this.normalizeOptionalString(
      feature?.properties?.stationIdentifier,
    );
    if (stationIdentifier) {
      return stationIdentifier;
    }

    const featureId = this.normalizeOptionalString(feature?.id);
    if (!featureId) {
      return undefined;
    }

    const match = featureId.match(/\/stations\/([^/]+)$/i);
    return match?.[1];
  }

  private readStationName(
    feature: { id?: string; properties?: Record<string, unknown> } | undefined,
  ): string | undefined {
    return this.normalizeOptionalString(feature?.properties?.name);
  }

  private toRoundedNumber(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }

    return Math.round(value);
  }

  private toFahrenheit(value: unknown, unitCode: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }

    const normalizedUnitCode =
      this.normalizeOptionalString(unitCode)?.toLowerCase();
    if (normalizedUnitCode?.includes("degc")) {
      return value * (9 / 5) + 32;
    }

    return value;
  }

  private toMph(value: unknown, unitCode: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }

    const normalizedUnitCode =
      this.normalizeOptionalString(unitCode)?.toLowerCase();
    if (normalizedUnitCode?.includes("km_h-1")) {
      return value * 0.621371;
    }

    if (normalizedUnitCode?.includes("m_s-1")) {
      return value * 2.23694;
    }

    return value;
  }

  private toCompassDirection(value: unknown): string | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }

    const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const normalized = ((value % 360) + 360) % 360;
    return directions[Math.round(normalized / 45) % directions.length] ?? null;
  }

  private findLatestCitationTimestamp(
    citations: Citation[],
  ): string | undefined {
    const timestamps = citations
      .map(
        (citation) =>
          citation.fetchedAt ?? this.readMetadataString(citation, "sent"),
      )
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => this.toTimestamp(right) - this.toTimestamp(left));

    return timestamps[0];
  }

  private readMetadataString(
    citation: Citation,
    key: string,
  ): string | undefined {
    const value = citation.metadata[key];
    return this.normalizeOptionalString(value);
  }

  private normalizeIso(
    value: Date | string | null | undefined,
  ): string | undefined {
    if (!value) {
      return undefined;
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return typeof value === "string" ? value : undefined;
    }

    return parsed.toISOString();
  }

  private toTimestamp(value: Date | string | null | undefined): number {
    if (!value) {
      return 0;
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
  }

  private normalizeOptionalString(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
  }

  private truncateText(value: string, maxChars: number): string {
    if (value.length <= maxChars) {
      return value;
    }

    return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
  }

  private dedupeCitations(citations: Citation[]): Citation[] {
    const seen = new Set<string>();
    const deduped: Citation[] = [];

    for (const citation of citations) {
      const key = [
        citation.origin ?? "search",
        citation.sourceDocumentId ?? citation.id,
        citation.citationLabel ?? "",
        this.readMetadataString(citation, "sourceProduct") ?? "",
      ].join("|");
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      deduped.push(citation);
    }

    return deduped;
  }

  private dedupeSources(sources: LiveContextSource[]): LiveContextSource[] {
    const seen = new Set<string>();
    const deduped: LiveContextSource[] = [];

    for (const source of sources) {
      const key = [
        source.dataset,
        source.origin,
        source.sourceFamily ?? "",
        source.sourceProduct ?? "",
      ].join("|");
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      deduped.push(source);
    }

    return deduped;
  }

  private describeError(error: unknown): string {
    if (error instanceof Error && error.message.trim().length) {
      return error.message;
    }

    return "unknown error";
  }
}
