import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import {
  readAlertCollectionsFromEnv,
  resolveAlertCollectionNames,
} from "../alert-source-metadata.js";
import { getEmbeddingModel } from "../embedding-env.js";
import { InProcessEmbeddingClient } from "../nws-embeddings/in-process-embedding.client.js";
import { QdrantClient } from "../nws-embeddings/qdrant.client.js";
import type {
  SearchCorpus,
  SearchFilter,
  SearchHit,
  SearchRequest,
  SearchResponse,
} from "./types.js";

interface SearchEnv {
  embeddingModel: string;
  embeddingTimeoutMs: number;
  qdrantUrl: string;
  qdrantCollections: {
    alerts: Record<string, string>;
    afd: string;
  };
  qdrantTimeoutMs: number;
  searchTopKDefault: number;
  searchTopKMax: number;
  searchCandidateMultiplier: number;
  searchCandidateTopKMax: number;
  searchMinRelativeScore: number;
  searchMinAbsoluteScore?: number;
}

interface RankedSearchHit {
  hit: SearchHit;
  rankingScore: number;
}

interface CurrentAlertRankingContext {
  prefersOperationalAlertProducts: boolean;
  prefersGuidanceProducts: boolean;
  preferredGuidanceSource?: string;
}

const TEMPORAL_FILTER_KEYS = [
  "effectiveAt",
  "onsetAt",
  "sent",
  "expiresAt",
  "endsAt",
  "effective",
  "onset",
  "expires",
  "ends",
] as const;
const HOUR_IN_MS = 60 * 60 * 1000;
const DAY_IN_MS = 24 * HOUR_IN_MS;

const VALID_FILTER_KEYS = new Set<string>([
  "source",
  "eventType",
  "includeEventTypes",
  "excludeEventTypes",
  "severity",
  "stateCodes",
  "effectiveFrom",
  "effectiveTo",
  "afdIssuedFrom",
  "afdIssuedTo",
  "afdSections",
] satisfies Array<keyof SearchFilter>);

@Injectable()
export class NwsSearchService {
  constructor(
    @Inject(InProcessEmbeddingClient)
    private readonly embeddingClient: InProcessEmbeddingClient,
    @Inject(QdrantClient)
    private readonly qdrantClient: QdrantClient,
  ) {}

  async search(body: SearchRequest): Promise<SearchResponse> {
    const config = this.readEnv();
    const query = this.requireString(body?.query, "query");
    const corpus = this.normalizeCorpus(body?.corpus);
    const collectionNames = this.resolveCollectionNames(
      corpus,
      body?.filter,
      config,
    );
    const topK = this.normalizeTopK(body?.topK, config);

    const minRelativeScore = this.normalizeRelativeScore(
      body?.minRelativeScore,
      config.searchMinRelativeScore,
    );
    const minAbsoluteScore = this.normalizeOptionalNumber(
      body?.minAbsoluteScore,
      config.searchMinAbsoluteScore,
    );

    const candidateLimit = this.computeCandidateLimit(topK, config);

    const queryEmbedding = await this.embeddingClient.embedText(query, {
      model: config.embeddingModel,
      timeoutMs: config.embeddingTimeoutMs,
    });

    const qdrantFilter = this.buildQdrantFilter(body?.filter);
    const resultSets = await Promise.all(
      collectionNames.map(async (collectionName) => ({
        collectionName,
        points: await this.searchCollection({
          config,
          collectionName,
          vector: queryEmbedding,
          limit: candidateLimit,
          filter: qdrantFilter,
        }),
      })),
    );

    const mappedHits = resultSets
      .flatMap(({ collectionName, points }) =>
        points.map((point) => this.toSearchHit(point, collectionName)),
      )
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return left.id.localeCompare(right.id);
      });
    const currentAlertRankingContext = this.shouldApplyCurrentAlertRerank(
      query,
      corpus,
      body?.filter,
    )
      ? this.buildCurrentAlertRankingContext(query, body?.filter)
      : undefined;
    const nowMs = currentAlertRankingContext ? Date.now() : 0;
    const rankedHits = currentAlertRankingContext
      ? mappedHits
          .map((hit) => ({
            hit,
            rankingScore: this.computeCurrentAlertBaseRankScore(
              hit,
              currentAlertRankingContext,
              nowMs,
            ),
          }))
          .sort((left, right) => {
            if (right.rankingScore !== left.rankingScore) {
              return right.rankingScore - left.rankingScore;
            }

            return this.compareHitsForRepresentative(left.hit, right.hit);
          })
      : mappedHits.map((hit) => ({ hit, rankingScore: hit.score }));
    const qualityHits = this.filterByScoreQuality(
      rankedHits,
      minRelativeScore,
      minAbsoluteScore,
    );
    const groupByEvent = body?.groupByEvent ?? true;
    const groupedHits = groupByEvent
      ? this.groupHitsByEvent(qualityHits)
      : qualityHits;
    const finalHits = currentAlertRankingContext
      ? this.rerankCurrentAlertHits(
          groupedHits,
          currentAlertRankingContext,
          nowMs,
        )
      : groupedHits;

    return {
      query,
      corpus,
      topK,
      model: config.embeddingModel,
      collection: collectionNames.join(","),
      collections: collectionNames,
      hits: finalHits.slice(0, topK),
    };
  }

  private async searchCollection(options: {
    config: SearchEnv;
    collectionName: string;
    vector: number[];
    limit: number;
    filter?: Record<string, unknown>;
  }): Promise<
    Array<{ id: string; score: number; payload: Record<string, unknown> }>
  > {
    try {
      return await this.qdrantClient.searchPoints({
        baseUrl: options.config.qdrantUrl,
        collectionName: options.collectionName,
        vector: options.vector,
        limit: options.limit,
        timeoutMs: options.config.qdrantTimeoutMs,
        filter: options.filter,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("status 404")) {
        return [];
      }
      throw error;
    }
  }

  private resolveCollectionNames(
    corpus: SearchCorpus,
    filter: SearchFilter | undefined,
    config: SearchEnv,
  ): string[] {
    if (corpus === "afd") {
      return [config.qdrantCollections.afd];
    }

    return resolveAlertCollectionNames(
      filter?.source,
      config.qdrantCollections.alerts,
    );
  }

  private groupHitsByEvent(hits: SearchHit[]): SearchHit[] {
    if (hits.length <= 1) {
      return hits;
    }

    const bestByKey = new Map<string, SearchHit>();
    const firstIndexByKey = new Map<string, number>();

    for (const [index, hit] of hits.entries()) {
      const key = this.buildEventGroupKey(hit);
      if (!firstIndexByKey.has(key)) {
        firstIndexByKey.set(key, index);
      }

      const currentBest = bestByKey.get(key);
      if (
        !currentBest ||
        this.compareHitsForRepresentative(hit, currentBest) < 0
      ) {
        bestByKey.set(key, hit);
      }
    }

    return [...bestByKey.entries()]
      .sort((a, b) => {
        const leftIndex = firstIndexByKey.get(a[0]) ?? Number.MAX_SAFE_INTEGER;
        const rightIndex = firstIndexByKey.get(b[0]) ?? Number.MAX_SAFE_INTEGER;
        return leftIndex - rightIndex;
      })
      .map(([, hit]) => hit);
  }

  private shouldApplyCurrentAlertRerank(
    query: string,
    corpus: SearchCorpus,
    filter: SearchFilter | undefined,
  ): boolean {
    if (corpus !== "alerts") {
      return false;
    }

    const normalizedQuery = this.normalizeText(query);
    const currentIntentPhrases = [
      "current",
      "currently",
      "right now",
      "active",
      "today",
      "this morning",
      "this afternoon",
      "tonight",
    ];
    const guidanceIntentPhrases = [
      "outlook",
      "outlooks",
      "forecast",
      "forecasts",
      "discussion",
      "discussions",
      "guidance",
      "probabilistic",
    ];

    if (
      currentIntentPhrases.some((phrase) => normalizedQuery.includes(phrase))
    ) {
      return true;
    }

    if (
      guidanceIntentPhrases.some((phrase) => normalizedQuery.includes(phrase))
    ) {
      return true;
    }

    const nowMs = Date.now();
    const effectiveFromMs = this.toEpochMs(filter?.effectiveFrom ?? "");
    const effectiveToMs = this.toEpochMs(filter?.effectiveTo ?? "");

    return (
      (effectiveFromMs > 0 && effectiveFromMs >= nowMs - 7 * DAY_IN_MS) ||
      (effectiveToMs > 0 && effectiveToMs >= nowMs - 7 * DAY_IN_MS)
    );
  }

  private buildCurrentAlertRankingContext(
    query: string,
    filter: SearchFilter | undefined,
  ): CurrentAlertRankingContext {
    return {
      prefersOperationalAlertProducts:
        this.shouldPreferOperationalAlertProducts(query, filter),
      prefersGuidanceProducts: this.shouldPreferGuidanceProducts(query, filter),
      preferredGuidanceSource: this.detectPreferredGuidanceSource(
        query,
        filter,
      ),
    };
  }

  private rerankCurrentAlertHits(
    hits: SearchHit[],
    context: CurrentAlertRankingContext,
    nowMs: number,
  ): SearchHit[] {
    if (hits.length <= 1) {
      return hits;
    }

    const remaining = [...hits];
    const reranked: SearchHit[] = [];
    const selectedEventTypes = new Map<string, number>();

    while (remaining.length > 0) {
      let bestIndex = 0;
      let bestScore = Number.NEGATIVE_INFINITY;

      for (const [index, hit] of remaining.entries()) {
        const rerankScore = this.computeCurrentAlertRerankScore(
          hit,
          context,
          selectedEventTypes,
          nowMs,
        );
        if (rerankScore > bestScore) {
          bestScore = rerankScore;
          bestIndex = index;
          continue;
        }

        if (
          rerankScore === bestScore &&
          this.compareHitsForRepresentative(hit, remaining[bestIndex]) < 0
        ) {
          bestIndex = index;
        }
      }

      const [selectedHit] = remaining.splice(bestIndex, 1);
      reranked.push(selectedHit);

      const eventTypeKey = this.normalizeToken(
        this.readMetaString(selectedHit, ["eventType", "event"]),
      );
      if (eventTypeKey) {
        selectedEventTypes.set(
          eventTypeKey,
          (selectedEventTypes.get(eventTypeKey) ?? 0) + 1,
        );
      }
    }

    return reranked;
  }

  private computeCurrentAlertRerankScore(
    hit: SearchHit,
    context: CurrentAlertRankingContext,
    selectedEventTypes: Map<string, number>,
    nowMs: number,
  ): number {
    let score = this.computeCurrentAlertBaseRankScore(hit, context, nowMs);

    const eventTypeKey = this.normalizeToken(
      this.readMetaString(hit, ["eventType", "event"]),
    );
    const priorCount = eventTypeKey
      ? (selectedEventTypes.get(eventTypeKey) ?? 0)
      : 0;

    if (priorCount > 0) {
      score -= Math.min(0.12, priorCount * 0.04);
    }

    return score;
  }

  private computeCurrentAlertBaseRankScore(
    hit: SearchHit,
    context: CurrentAlertRankingContext,
    nowMs: number,
  ): number {
    return (
      hit.score +
      this.computeCurrentAlertRecencyAdjustment(hit, nowMs) +
      this.computeCurrentAlertSemanticAdjustment(hit, context)
    );
  }

  private computeCurrentAlertSemanticAdjustment(
    hit: SearchHit,
    context: CurrentAlertRankingContext,
  ): number {
    let adjustment = 0;

    if (context.prefersOperationalAlertProducts) {
      if (this.isOperationalAlertProduct(hit)) {
        adjustment += 0.12;
      }

      if (this.isGuidanceStyleProduct(hit)) {
        adjustment -= 0.16;
      }

      if (this.hasNoLocalRiskNarrative(hit)) {
        adjustment -= 0.12;
      }
    }

    if (context.prefersGuidanceProducts) {
      if (this.isGuidanceStyleProduct(hit)) {
        adjustment += 0.16;
      }

      if (this.isOperationalAlertProduct(hit)) {
        adjustment -= 0.16;
      }

      const preferredSource = context.preferredGuidanceSource;
      const hitSource = this.normalizeToken(hit.source);
      if (preferredSource && hitSource) {
        adjustment += hitSource === preferredSource ? 0.12 : -0.08;
      }
    }

    return adjustment;
  }

  private shouldPreferGuidanceProducts(
    query: string,
    filter: SearchFilter | undefined,
  ): boolean {
    const explicitlyRequestedEventTypes = this.uniqueStrings([
      ...(filter?.eventType ? [filter.eventType] : []),
      ...(filter?.includeEventTypes ?? []),
    ]);

    if (explicitlyRequestedEventTypes.length > 0) {
      const guidanceProductCount = explicitlyRequestedEventTypes.filter(
        (eventType) => this.isGuidanceStyleEventType(eventType),
      ).length;

      if (guidanceProductCount === explicitlyRequestedEventTypes.length) {
        return true;
      }

      if (guidanceProductCount === 0) {
        return false;
      }
    }

    const normalizedQuery = this.normalizeText(query);
    return [
      "outlook",
      "outlooks",
      "forecast",
      "forecasts",
      "discussion",
      "discussions",
      "guidance",
      "probabilistic",
    ].some((token) => normalizedQuery.includes(token));
  }

  private detectPreferredGuidanceSource(
    query: string,
    filter: SearchFilter | undefined,
  ): string | undefined {
    const explicitSource = this.normalizeToken(filter?.source);
    if (explicitSource === "spc" || explicitSource === "wpc") {
      return explicitSource;
    }

    const normalizedQuery = this.normalizeText(query);
    if (
      normalizedQuery.includes("spc") ||
      normalizedQuery.includes("severe weather outlook") ||
      normalizedQuery.includes("convective outlook")
    ) {
      return "spc";
    }

    if (
      normalizedQuery.includes("wpc") ||
      normalizedQuery.includes("excessive rainfall") ||
      normalizedQuery.includes("snow forecast") ||
      normalizedQuery.includes("winter precipitation")
    ) {
      return "wpc";
    }

    return undefined;
  }

  private shouldPreferOperationalAlertProducts(
    query: string,
    filter: SearchFilter | undefined,
  ): boolean {
    const explicitlyRequestedEventTypes = this.uniqueStrings([
      ...(filter?.eventType ? [filter.eventType] : []),
      ...(filter?.includeEventTypes ?? []),
    ]);

    if (explicitlyRequestedEventTypes.length > 0) {
      const activeProductCount = explicitlyRequestedEventTypes.filter(
        (eventType) => this.isOperationalAlertEventType(eventType),
      ).length;

      if (activeProductCount === explicitlyRequestedEventTypes.length) {
        return true;
      }

      if (activeProductCount === 0) {
        return false;
      }
    }

    const normalizedQuery = this.normalizeText(query);
    if (
      [
        "outlook",
        "outlooks",
        "forecast",
        "forecasts",
        "discussion",
        "discussions",
        "probabilistic",
        "guidance",
      ].some((token) => normalizedQuery.includes(token))
    ) {
      return false;
    }

    return [
      "alert",
      "alerts",
      "warning",
      "warnings",
      "watch",
      "watches",
      "advisory",
      "advisories",
    ].some((token) => normalizedQuery.includes(token));
  }

  private isOperationalAlertProduct(hit: SearchHit): boolean {
    const sourceProduct = this.normalizeToken(
      this.readMetaString(hit, ["sourceProduct"]),
    );
    if (
      sourceProduct === "active-alert" ||
      sourceProduct === "aqi-threshold-alert"
    ) {
      return true;
    }

    return this.isOperationalAlertEventType(
      this.readMetaString(hit, ["eventType", "event"]),
    );
  }

  private isGuidanceStyleProduct(hit: SearchHit): boolean {
    const sourceProduct = this.normalizeToken(
      this.readMetaString(hit, ["sourceProduct"]),
    );
    if (
      [
        "convective-outlook",
        "fire-weather-outlook",
        "mesoscale-discussion",
        "excessive-rainfall",
        "snow-forecast",
        "aqi-forecast-alert",
      ].includes(sourceProduct)
    ) {
      return true;
    }

    return this.isGuidanceStyleEventType(
      this.readMetaString(hit, ["eventType", "event"]),
    );
  }

  private isOperationalAlertEventType(eventType: string): boolean {
    return /\b(warning|watch|advisory|alert)$/i.test(eventType.trim());
  }

  private isGuidanceStyleEventType(eventType: string): boolean {
    return /\b(outlook|forecast|discussion)\b/i.test(eventType);
  }

  private hasNoLocalRiskNarrative(hit: SearchHit): boolean {
    const narrative = this.normalizeText(
      [
        this.readMetaString(hit, ["headline", "eventHeadline", "title"]),
        this.extractDescriptionText(hit),
      ]
        .filter(Boolean)
        .join(" "),
    );

    return narrative.includes("no local risk");
  }

  private computeCurrentAlertRecencyAdjustment(
    hit: SearchHit,
    nowMs: number,
  ): number {
    const effectiveMs = this.toEpochMs(
      this.extractTemporalValue(hit, [
        "onsetAt",
        "effectiveAt",
        "sent",
        "onset",
        "effective",
      ]),
    );
    const expiresMs = this.toEpochMs(
      this.extractTemporalValue(hit, [
        "endsAt",
        "expiresAt",
        "ends",
        "expires",
      ]),
    );

    if (expiresMs > 0 && expiresMs >= nowMs) {
      if (effectiveMs > 0 && effectiveMs <= nowMs) {
        return 0.12;
      }

      return 0.08;
    }

    const freshestMs = Math.max(effectiveMs, expiresMs);
    if (freshestMs <= 0) {
      return 0;
    }

    const ageMs = Math.max(0, nowMs - freshestMs);
    if (ageMs <= DAY_IN_MS) {
      return 0.08;
    }
    if (ageMs <= 3 * DAY_IN_MS) {
      return 0.05;
    }
    if (ageMs <= 7 * DAY_IN_MS) {
      return 0.03;
    }
    if (ageMs <= 30 * DAY_IN_MS) {
      return 0.01;
    }
    if (ageMs <= 180 * DAY_IN_MS) {
      return -0.02;
    }
    if (ageMs <= 365 * DAY_IN_MS) {
      return -0.06;
    }

    return -0.12;
  }

  private compareHitsForRepresentative(
    left: SearchHit,
    right: SearchHit,
  ): number {
    if (left.score !== right.score) {
      return right.score - left.score;
    }

    const leftSent = this.toEpochMs(this.extractTemporalValue(left, ["sent"]));
    const rightSent = this.toEpochMs(
      this.extractTemporalValue(right, ["sent"]),
    );
    if (leftSent !== rightSent) {
      return rightSent - leftSent;
    }

    const leftVersion = this.toVersionNumber(left.sourceVersion);
    const rightVersion = this.toVersionNumber(right.sourceVersion);
    if (leftVersion !== rightVersion) {
      return rightVersion - leftVersion;
    }

    const leftEnd = this.toEpochMs(
      this.extractTemporalValue(left, [
        "endsAt",
        "expiresAt",
        "ends",
        "expires",
      ]),
    );
    const rightEnd = this.toEpochMs(
      this.extractTemporalValue(right, [
        "endsAt",
        "expiresAt",
        "ends",
        "expires",
      ]),
    );
    if (leftEnd !== rightEnd) {
      return rightEnd - leftEnd;
    }

    const leftTextLength = this.extractDescriptionText(left).length;
    const rightTextLength = this.extractDescriptionText(right).length;
    if (leftTextLength !== rightTextLength) {
      return rightTextLength - leftTextLength;
    }

    return left.id.localeCompare(right.id);
  }

  private buildEventGroupKey(hit: SearchHit): string {
    const source = this.normalizeToken(hit.source);
    const eventType = this.normalizeToken(
      this.readMetaString(hit, ["eventType", "event"]),
    );
    const endTime = this.normalizeTimestamp(
      this.extractTemporalValue(hit, [
        "endsAt",
        "expiresAt",
        "ends",
        "expires",
      ]),
    );
    const startTime = this.normalizeTimestamp(
      this.extractTemporalValue(hit, [
        "onsetAt",
        "effectiveAt",
        "sent",
        "onset",
        "effective",
      ]),
    );
    const headline = this.normalizeText(
      this.readMetaString(hit, ["headline", "eventHeadline", "title"]),
    );
    const description = this.normalizeText(this.extractDescriptionText(hit));
    const narrativeFingerprint = this.buildNarrativeFingerprint(
      headline,
      description,
    );
    const afdSection = this.normalizeToken(
      this.readMetaString(hit, ["afdSectionKey", "afdSectionName", "section"]),
    );

    const strongParts = [
      source,
      eventType,
      endTime,
      startTime,
      narrativeFingerprint,
    ];
    if (strongParts.every((part) => part.length > 0)) {
      return afdSection
        ? `strong|${strongParts.join("|")}|section=${afdSection}`
        : `strong|${strongParts.join("|")}`;
    }

    const weakParts = [
      source || "unknown-source",
      eventType || "unknown-event",
      endTime || startTime || "unknown-time",
      narrativeFingerprint ||
        this.normalizeToken(hit.citationLabel) ||
        "unknown-narrative",
    ];
    return afdSection
      ? `weak|${weakParts.join("|")}|section=${afdSection}`
      : `weak|${weakParts.join("|")}`;
  }

  private buildNarrativeFingerprint(
    headline: string,
    description: string,
  ): string {
    const headlineTokens = headline
      .split(" ")
      .filter(Boolean)
      .slice(0, 12)
      .join(" ");
    const descriptionTokens = description
      .split(" ")
      .filter(Boolean)
      .slice(0, 20)
      .join(" ");
    const combined = [headlineTokens, descriptionTokens]
      .filter(Boolean)
      .join(" |");
    return combined;
  }

  private extractDescriptionText(hit: SearchHit): string {
    return this.readMetaString(hit, [
      "shortDescription",
      "description",
      "summary",
      "message",
      "embeddingText",
    ]);
  }

  private extractTemporalValue(hit: SearchHit, keys: string[]): string {
    for (const key of keys) {
      const value = this.readMetaString(hit, [key]);
      if (value) {
        return value;
      }
    }
    return "";
  }

  private readMetaString(hit: SearchHit, keys: string[]): string {
    const metadata = hit.metadata;
    for (const key of keys) {
      if (key === "eventType" && hit.eventType) {
        return hit.eventType;
      }
      if (key === "effectiveAt" && hit.effectiveAt) {
        return hit.effectiveAt;
      }
      if (key === "expiresAt" && hit.expiresAt) {
        return hit.expiresAt;
      }

      const value = metadata?.[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }
    return "";
  }

  private normalizeTimestamp(value: string): string {
    if (!value) {
      return "";
    }

    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      return "";
    }

    return new Date(parsed).toISOString();
  }

  private toEpochMs(value: string): number {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private toVersionNumber(value: string | undefined): number {
    if (!value) {
      return 0;
    }

    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }

    return 0;
  }

  private normalizeToken(value: string | undefined): string {
    if (!value) {
      return "";
    }

    return value.trim().toLowerCase();
  }

  private normalizeText(value: string): string {
    if (!value) {
      return "";
    }

    return value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private filterByScoreQuality(
    hits: RankedSearchHit[],
    minRelativeScore: number,
    minAbsoluteScore?: number,
  ): SearchHit[] {
    if (!hits.length) {
      return [];
    }

    const topScore = hits[0].rankingScore;

    return hits
      .filter(({ hit, rankingScore }) => {
        const relativeScore = this.computeRelativeScore(rankingScore, topScore);
        if (relativeScore < minRelativeScore) {
          return false;
        }

        if (minAbsoluteScore == null) {
          return true;
        }

        return hit.score >= minAbsoluteScore;
      })
      .map(({ hit }) => hit);
  }

  private computeRelativeScore(score: number, topScore: number): number {
    if (topScore === 0) {
      return score === 0 ? 1 : 0;
    }

    if (topScore > 0) {
      return score / topScore;
    }

    return Math.abs(topScore) / Math.max(Math.abs(score), Number.EPSILON);
  }

  private computeCandidateLimit(topK: number, config: SearchEnv): number {
    const scaled = Math.ceil(topK * config.searchCandidateMultiplier);
    const base = Math.max(topK, scaled);
    return Math.min(base, config.searchCandidateTopKMax);
  }

  private toSearchHit(
    point: {
      id: string;
      score: number;
      payload: Record<string, unknown>;
    },
    collectionName: string,
  ): SearchHit {
    const payload = point.payload;
    const embeddingText =
      typeof payload.embeddingText === "string" ? payload.embeddingText : "";

    return {
      id: point.id,
      score: point.score,
      collection: collectionName,
      source: this.asString(payload.source),
      citationLabel:
        this.asString(payload.nwsId) ?? this.asString(payload.sourceDocumentId),
      sourceDocumentId: this.asString(payload.sourceDocumentId),
      sourceVersion: this.asString(payload.sourceVersion),
      eventType: this.asString(payload.eventType),
      severity: this.asString(payload.severity),
      stateCodes: this.asStringArray(payload.stateCodes),
      effectiveAt: this.asString(payload.effectiveAt),
      expiresAt: this.asString(payload.expiresAt),
      afdIssuedAt: this.firstString(payload, [
        "afdIssuedAt",
        "issuedAt",
        "issuanceDate",
      ]),
      afdSectionName: this.firstString(payload, ["afdSectionName", "section"]),
      snippet: embeddingText.slice(0, 280),
      metadata: payload,
    };
  }

  private buildQdrantFilter(
    filter: SearchFilter | undefined,
  ): Record<string, unknown> | undefined {
    if (!filter || typeof filter !== "object") {
      return undefined;
    }

    const unknownKeys = Object.keys(filter).filter(
      (k) => !VALID_FILTER_KEYS.has(k),
    );
    if (unknownKeys.length > 0) {
      throw new BadRequestException(
        `Unknown filter keys: ${unknownKeys.join(", ")}`,
      );
    }

    const must: Array<Record<string, unknown>> = [];
    const mustNot: Array<Record<string, unknown>> = [];

    if (filter.source) {
      must.push({ key: "source", match: { value: filter.source } });
    }

    if (filter.eventType) {
      must.push({ key: "eventType", match: { value: filter.eventType } });
    }

    if (filter.includeEventTypes?.length) {
      must.push({
        key: "eventType",
        match: { any: this.uniqueStrings(filter.includeEventTypes) },
      });
    }

    if (filter.excludeEventTypes?.length) {
      mustNot.push({
        key: "eventType",
        match: { any: this.uniqueStrings(filter.excludeEventTypes) },
      });
    }

    if (filter.severity) {
      must.push({ key: "severity", match: { value: filter.severity } });
    }

    if (filter.stateCodes?.length) {
      must.push({ key: "stateCodes", match: { any: filter.stateCodes } });
    }

    if (filter.effectiveFrom || filter.effectiveTo) {
      const range: Record<string, string> = {};
      if (filter.effectiveFrom) {
        range.gte = filter.effectiveFrom;
      }
      if (filter.effectiveTo) {
        range.lte = filter.effectiveTo;
      }
      must.push({
        should: TEMPORAL_FILTER_KEYS.map((key) => ({ key, range })),
      });
    }

    if (filter.afdIssuedFrom || filter.afdIssuedTo) {
      const range: Record<string, string> = {};
      if (filter.afdIssuedFrom) {
        range.gte = filter.afdIssuedFrom;
      }
      if (filter.afdIssuedTo) {
        range.lte = filter.afdIssuedTo;
      }
      must.push({
        should: [
          { key: "afdIssuedAt", range },
          { key: "issuedAt", range },
          { key: "issuanceDate", range },
        ],
      });
    }

    const afdSections = this.uniqueStrings(filter.afdSections ?? []);
    if (afdSections.length) {
      must.push({
        should: [
          {
            key: "afdSectionKey",
            match: {
              any: afdSections
                .map((value) => this.normalizeAfdSectionKey(value))
                .filter(Boolean),
            },
          },
          {
            key: "afdSectionName",
            match: { any: afdSections },
          },
          {
            key: "section",
            match: { any: afdSections },
          },
        ],
      });
    }

    if (!must.length && !mustNot.length) {
      return undefined;
    }

    return {
      ...(must.length ? { must } : {}),
      ...(mustNot.length ? { must_not: mustNot } : {}),
    };
  }

  private uniqueStrings(values: string[]): string[] {
    return [
      ...new Set(
        values
          .filter((value) => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
  }

  private normalizeCorpus(value: SearchCorpus | undefined): SearchCorpus {
    if (value == null) {
      return "alerts";
    }

    if (value !== "alerts" && value !== "afd") {
      throw new BadRequestException("corpus must be one of: alerts, afd");
    }

    return value;
  }

  private requireString(value: unknown, fieldName: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new BadRequestException(`${fieldName} must be a non-empty string`);
    }

    return value.trim();
  }

  private normalizeTopK(value: number | undefined, config: SearchEnv): number {
    if (value == null) {
      return config.searchTopKDefault;
    }

    if (!Number.isInteger(value) || value <= 0) {
      throw new BadRequestException("topK must be a positive integer");
    }

    return Math.min(value, config.searchTopKMax);
  }

  private normalizeRelativeScore(
    value: number | undefined,
    fallback: number,
  ): number {
    if (value == null) {
      return fallback;
    }

    if (!Number.isFinite(value) || value <= 0 || value > 1) {
      throw new BadRequestException(
        "minRelativeScore must be a number greater than 0 and less than or equal to 1",
      );
    }

    return value;
  }

  private normalizeOptionalNumber(
    value: number | undefined,
    fallback: number | undefined,
  ): number | undefined {
    if (value == null) {
      return fallback;
    }

    if (!Number.isFinite(value)) {
      throw new BadRequestException(
        "minAbsoluteScore must be a finite number when provided",
      );
    }

    return value;
  }

  private asString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
  }

  private asStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }

    const strings = value.filter(
      (item) => typeof item === "string",
    ) as string[];
    return strings.length ? strings : undefined;
  }

  private firstString(
    payload: Record<string, unknown>,
    keys: string[],
  ): string | undefined {
    for (const key of keys) {
      const value = this.asString(payload[key]);
      if (value) {
        return value;
      }
    }

    return undefined;
  }

  private normalizeAfdSectionKey(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  private readEnv(): SearchEnv {
    return {
      embeddingModel: getEmbeddingModel(),
      embeddingTimeoutMs: this.parsePositiveInt(
        process.env.NWS_EMBEDDING_TIMEOUT_MS ?? process.env.OLLAMA_TIMEOUT_MS,
        30000,
      ),
      qdrantUrl: process.env.QDRANT_URL ?? "http://localhost:6333",
      qdrantCollections: {
        alerts: readAlertCollectionsFromEnv(process.env),
        afd: process.env.QDRANT_COLLECTION_NWS_AFD ?? "nws_afd_embeddings_v1",
      },
      qdrantTimeoutMs: this.parsePositiveInt(
        process.env.QDRANT_TIMEOUT_MS,
        30000,
      ),
      searchTopKDefault: this.parsePositiveInt(
        process.env.NWS_SEARCH_TOPK_DEFAULT,
        12,
      ),
      searchTopKMax: this.parsePositiveInt(process.env.NWS_SEARCH_TOPK_MAX, 20),
      searchCandidateMultiplier: this.parsePositiveFloat(
        process.env.NWS_SEARCH_CANDIDATE_MULTIPLIER,
        3,
      ),
      searchCandidateTopKMax: this.parsePositiveInt(
        process.env.NWS_SEARCH_CANDIDATE_TOPK_MAX,
        60,
      ),
      searchMinRelativeScore: this.parseRelativeScore(
        process.env.NWS_SEARCH_MIN_RELATIVE_SCORE,
        0.9,
      ),
      searchMinAbsoluteScore: this.parseOptionalFiniteNumber(
        process.env.NWS_SEARCH_MIN_ABSOLUTE_SCORE,
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

  private parsePositiveFloat(
    rawValue: string | undefined,
    defaultValue: number,
  ): number {
    if (!rawValue) {
      return defaultValue;
    }

    const parsed = Number.parseFloat(rawValue);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return defaultValue;
    }

    return parsed;
  }

  private parseRelativeScore(
    rawValue: string | undefined,
    defaultValue: number,
  ): number {
    if (!rawValue) {
      return defaultValue;
    }

    const parsed = Number.parseFloat(rawValue);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
      return defaultValue;
    }

    return parsed;
  }

  private parseOptionalFiniteNumber(
    rawValue: string | undefined,
  ): number | undefined {
    if (!rawValue) {
      return undefined;
    }

    const parsed = Number.parseFloat(rawValue);
    if (!Number.isFinite(parsed)) {
      return undefined;
    }

    return parsed;
  }
}
