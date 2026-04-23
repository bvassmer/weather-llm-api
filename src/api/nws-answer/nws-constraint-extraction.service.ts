import { Inject, Injectable, Logger } from "@nestjs/common";
import { getOllamaChatBaseUrl, getOllamaChatModel } from "../ollama-env.js";
import type { SearchFilter } from "../nws-search/types.js";
import { OllamaGenerationClient } from "./ollama-generation.client.js";
import type {
  ConstraintExtractionMetadata,
  ConstraintExtractionSystem,
} from "./types.js";

interface ExtractionRequest {
  question: string;
  requestedSystem: ConstraintExtractionSystem;
  userFilter?: SearchFilter;
  enabled?: boolean;
  timeoutMs?: number;
  llmBaseUrl?: string;
  llmModel?: string;
}

interface ExtractionResult {
  extractedFilter?: SearchFilter;
  mergedFilter?: SearchFilter;
  metadata: ConstraintExtractionMetadata;
}

interface LlmExtractionPayload {
  includeEventTypes?: unknown;
  excludeEventTypes?: unknown;
  effectiveFrom?: unknown;
  effectiveTo?: unknown;
}

interface HeuristicV2TypesPayload {
  includeEventTypes?: unknown;
}

interface HeuristicV2RefinementPayload {
  excludeEventTypes?: unknown;
  effectiveFrom?: unknown;
  effectiveTo?: unknown;
}

interface RulesExtractionResult {
  filter?: SearchFilter;
  confidence: number;
  signals: string[];
  warnings: string[];
  detectedEventTypes: string[];
}

const HOURS_IN_DAY = 24;
const MILLISECONDS_IN_HOUR = 60 * 60 * 1000;
const MILLISECONDS_IN_DAY = HOURS_IN_DAY * MILLISECONDS_IN_HOUR;

const CANONICAL_EVENT_TYPES = [
  // Warnings
  "Tornado Warning",
  "Severe Thunderstorm Warning",
  "Flash Flood Warning",
  "Flood Warning",
  "Blizzard Warning",
  "Winter Storm Warning",
  "Ice Storm Warning",
  "Snow Squall Warning",
  "Lake Effect Snow Warning",
  "Extreme Wind Warning",
  "High Wind Warning",
  "Hurricane Warning",
  "Tropical Storm Warning",
  "Storm Surge Warning",
  "Tsunami Warning",
  "Red Flag Warning",
  "Special Marine Warning",
  "Gale Warning",
  "Hurricane Force Wind Warning",
  "Avalanche Warning",
  "Dust Storm Warning",
  "Dense Fog Warning",
  "Excessive Heat Warning",
  "Wind Chill Warning",
  "Freeze Warning",
  "Hard Freeze Warning",
  "Coastal Flood Warning",
  "Lakeshore Flood Warning",
  // Watches
  "Tornado Watch",
  "Severe Thunderstorm Watch",
  "Flash Flood Watch",
  "Flood Watch",
  "Blizzard Watch",
  "Winter Storm Watch",
  "High Wind Watch",
  "Hurricane Watch",
  "Tropical Storm Watch",
  "Storm Surge Watch",
  "Fire Weather Watch",
  "Wind Chill Watch",
  "Freeze Watch",
  "Coastal Flood Watch",
  "Lakeshore Flood Watch",
  // Advisories
  "Wind Advisory",
  "Winter Weather Advisory",
  "Heat Advisory",
  "Dense Fog Advisory",
  "Flood Advisory",
  "Coastal Flood Advisory",
  "Lakeshore Flood Advisory",
  "High Surf Advisory",
  "Small Craft Advisory",
  "Freezing Fog Advisory",
  "Frost Advisory",
  "Air Stagnation Advisory",
  "Air Quality Alert",
  // Local SPC/WPC/snow event types
  "SPC Mesoscale Discussion",
  "SPC Convective Outlook Day 1",
  "SPC Convective Outlook Day 2",
  "SPC Convective Outlook Day 3",
  "SPC Convective Outlook Day 4",
  "SPC Convective Outlook Day 5",
  "SPC Convective Outlook Day 6",
  "SPC Convective Outlook Day 7",
  "SPC Convective Outlook Day 8",
  "WPC Excessive Rainfall",
  "WPC Snow Forecast",
  "WPC Snow Forecast Alert",
  "WPC Snow Probability Forecast",
  "WPC Probabilistic Winter Precipitation Forecast",
  "AirNow AQI Threshold Alert",
  "AirNow AQI Forecast Alert",
] as const;

const WARNING_EVENT_TYPES = CANONICAL_EVENT_TYPES.filter((eventType) =>
  eventType.endsWith(" Warning"),
);

const SPC_CONVECTIVE_OUTLOOK_EVENT_TYPES = CANONICAL_EVENT_TYPES.filter(
  (eventType) => eventType.startsWith("SPC Convective Outlook Day "),
);

const STATE_NAME_TO_CODE = new Map<string, string>([
  ["alabama", "AL"],
  ["alaska", "AK"],
  ["arizona", "AZ"],
  ["arkansas", "AR"],
  ["california", "CA"],
  ["colorado", "CO"],
  ["connecticut", "CT"],
  ["delaware", "DE"],
  ["district of columbia", "DC"],
  ["florida", "FL"],
  ["georgia", "GA"],
  ["hawaii", "HI"],
  ["idaho", "ID"],
  ["illinois", "IL"],
  ["indiana", "IN"],
  ["iowa", "IA"],
  ["kansas", "KS"],
  ["kentucky", "KY"],
  ["louisiana", "LA"],
  ["maine", "ME"],
  ["maryland", "MD"],
  ["massachusetts", "MA"],
  ["michigan", "MI"],
  ["minnesota", "MN"],
  ["mississippi", "MS"],
  ["missouri", "MO"],
  ["montana", "MT"],
  ["nebraska", "NE"],
  ["nevada", "NV"],
  ["new hampshire", "NH"],
  ["new jersey", "NJ"],
  ["new mexico", "NM"],
  ["new york", "NY"],
  ["north carolina", "NC"],
  ["north dakota", "ND"],
  ["ohio", "OH"],
  ["oklahoma", "OK"],
  ["oregon", "OR"],
  ["pennsylvania", "PA"],
  ["rhode island", "RI"],
  ["south carolina", "SC"],
  ["south dakota", "SD"],
  ["tennessee", "TN"],
  ["texas", "TX"],
  ["utah", "UT"],
  ["vermont", "VT"],
  ["virginia", "VA"],
  ["washington", "WA"],
  ["west virginia", "WV"],
  ["wisconsin", "WI"],
  ["wyoming", "WY"],
]);

const CANONICAL_MAP = new Map(
  CANONICAL_EVENT_TYPES.map((eventType) => [
    normalizeText(eventType),
    eventType,
  ]),
);

const ALIAS_MAP = new Map<string, string>([
  ["tornado warnings", "Tornado Warning"],
  ["tornado warning", "Tornado Warning"],
  ["severe thunderstorm warnings", "Severe Thunderstorm Warning"],
  ["severe thunderstorm warning", "Severe Thunderstorm Warning"],
  ["flash flood warnings", "Flash Flood Warning"],
  ["flash flood warning", "Flash Flood Warning"],
  ["flood warnings", "Flood Warning"],
  ["flood warning", "Flood Warning"],
  ["winter weather advisories", "Winter Weather Advisory"],
  ["winter weather advisory", "Winter Weather Advisory"],
  ["winter storm warnings", "Winter Storm Warning"],
  ["winter storm warning", "Winter Storm Warning"],
  ["winter storm watches", "Winter Storm Watch"],
  ["winter storm watch", "Winter Storm Watch"],
  ["blizzard warnings", "Blizzard Warning"],
  ["blizzard warning", "Blizzard Warning"],
  ["blizzard watches", "Blizzard Watch"],
  ["blizzard watch", "Blizzard Watch"],
  ["snow squall warning", "Snow Squall Warning"],
  ["snow squall warnings", "Snow Squall Warning"],
  ["spc mesoscale discussion", "SPC Mesoscale Discussion"],
  ["mesoscale discussion", "SPC Mesoscale Discussion"],
  ["severe weather outlook", "SPC Convective Outlook Day 1"],
  ["severe weather outlooks", "SPC Convective Outlook Day 1"],
  ["spc convective outlook", "SPC Convective Outlook Day 1"],
  ["convective outlook", "SPC Convective Outlook Day 1"],
  ["convective outlooks", "SPC Convective Outlook Day 1"],
  ["spc day 1 outlook", "SPC Convective Outlook Day 1"],
  ["spc day 2 outlook", "SPC Convective Outlook Day 2"],
  ["spc day 3 outlook", "SPC Convective Outlook Day 3"],
  ["spc day 4 outlook", "SPC Convective Outlook Day 4"],
  ["spc day 5 outlook", "SPC Convective Outlook Day 5"],
  ["spc day 6 outlook", "SPC Convective Outlook Day 6"],
  ["spc day 7 outlook", "SPC Convective Outlook Day 7"],
  ["spc day 8 outlook", "SPC Convective Outlook Day 8"],
  ["wpc excessive rainfall", "WPC Excessive Rainfall"],
  ["excessive rainfall", "WPC Excessive Rainfall"],
  ["wpc snow forecast", "WPC Snow Forecast"],
  ["wpc snow forecast alert", "WPC Snow Forecast Alert"],
  ["snow forecast alert", "WPC Snow Forecast Alert"],
  ["wpc snow probability forecast", "WPC Snow Probability Forecast"],
  [
    "wpc probabilistic winter precipitation forecast",
    "WPC Probabilistic Winter Precipitation Forecast",
  ],
  ["pwpf", "WPC Probabilistic Winter Precipitation Forecast"],
  ["air quality alert", "Air Quality Alert"],
  ["air quality alerts", "Air Quality Alert"],
  ["aqi alert", "AirNow AQI Threshold Alert"],
  ["aqi alerts", "AirNow AQI Threshold Alert"],
  ["aqi threshold alert", "AirNow AQI Threshold Alert"],
  ["aqi threshold alerts", "AirNow AQI Threshold Alert"],
  ["aqi forecast alert", "AirNow AQI Forecast Alert"],
  ["aqi forecast alerts", "AirNow AQI Forecast Alert"],
  ["air quality forecast", "AirNow AQI Forecast Alert"],
  ["air quality forecasts", "AirNow AQI Forecast Alert"],
]);

@Injectable()
export class NwsConstraintExtractionService {
  private readonly logger = new Logger(NwsConstraintExtractionService.name);

  constructor(
    @Inject(OllamaGenerationClient)
    private readonly ollamaGenerationClient: OllamaGenerationClient,
  ) {}

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const enabled = request.enabled ?? true;
    const requestedSystem = request.requestedSystem;

    if (!enabled || requestedSystem === "bypass") {
      return {
        extractedFilter: undefined,
        mergedFilter: sanitizeFilter(request.userFilter),
        metadata: {
          enabled,
          requestedSystem,
          appliedSystem: "bypass",
          fallbackApplied: false,
          warnings: [],
          detectedEventTypes: [],
          extractedFilter: undefined,
          mergedFilter: sanitizeFilter(request.userFilter),
        },
      };
    }

    if (requestedSystem === "heuristic-v1") {
      const extractedFilter = this.extractHeuristic(request.question);
      const mergedFilter = mergeFilters(request.userFilter, extractedFilter);

      return {
        extractedFilter,
        mergedFilter,
        metadata: {
          enabled,
          requestedSystem,
          appliedSystem: "heuristic-v1",
          fallbackApplied: false,
          warnings: [],
          detectedEventTypes: extractedFilter?.includeEventTypes ?? [],
          extractedFilter,
          mergedFilter,
        },
      };
    }

    if (requestedSystem === "heuristic-v2") {
      const heuristicV2Warnings: string[] = [];

      try {
        const extractedFilter = await this.extractHeuristicV2(request);
        const mergedFilter = mergeFilters(request.userFilter, extractedFilter);

        return {
          extractedFilter,
          mergedFilter,
          metadata: {
            enabled,
            requestedSystem,
            appliedSystem: "heuristic-v2",
            fallbackApplied: false,
            warnings: heuristicV2Warnings,
            detectedEventTypes: extractedFilter?.includeEventTypes ?? [],
            extractedFilter,
            mergedFilter,
          },
        };
      } catch (error) {
        const warning =
          error instanceof Error
            ? `heuristic-v2 extraction fallback to heuristic-v1: ${error.message}`
            : "heuristic-v2 extraction fallback to heuristic-v1";
        heuristicV2Warnings.push(warning);
        this.logger.warn(warning);

        const extractedFilter = this.extractHeuristic(request.question);
        const mergedFilter = mergeFilters(request.userFilter, extractedFilter);

        return {
          extractedFilter,
          mergedFilter,
          metadata: {
            enabled,
            requestedSystem,
            appliedSystem: "heuristic-v1",
            fallbackApplied: true,
            warnings: heuristicV2Warnings,
            detectedEventTypes: extractedFilter?.includeEventTypes ?? [],
            extractedFilter,
            mergedFilter,
          },
        };
      }
    }

    if (requestedSystem === "rules-v2") {
      const rulesResult = this.extractRulesV2(request.question);
      const mergedFilter = mergeFilters(request.userFilter, rulesResult.filter);

      return {
        extractedFilter: rulesResult.filter,
        mergedFilter,
        metadata: {
          enabled,
          requestedSystem,
          appliedSystem: "rules-v2",
          fallbackApplied: false,
          warnings: rulesResult.warnings,
          detectedEventTypes: rulesResult.detectedEventTypes,
          confidence: rulesResult.confidence,
          signals: rulesResult.signals,
          extractedFilter: rulesResult.filter,
          mergedFilter,
        },
      };
    }

    const llmWarnings: string[] = [];

    try {
      const extractedFilter = await this.extractLlm(request);
      const mergedFilter = mergeFilters(request.userFilter, extractedFilter);

      return {
        extractedFilter,
        mergedFilter,
        metadata: {
          enabled,
          requestedSystem,
          appliedSystem: "llm-v1",
          fallbackApplied: false,
          warnings: llmWarnings,
          detectedEventTypes: extractedFilter?.includeEventTypes ?? [],
          extractedFilter,
          mergedFilter,
        },
      };
    } catch (error) {
      const warning =
        error instanceof Error
          ? `llm-v1 extraction fallback to heuristic-v1: ${error.message}`
          : "llm-v1 extraction fallback to heuristic-v1";
      llmWarnings.push(warning);
      this.logger.warn(warning);

      const extractedFilter = this.extractHeuristic(request.question);
      const mergedFilter = mergeFilters(request.userFilter, extractedFilter);

      return {
        extractedFilter,
        mergedFilter,
        metadata: {
          enabled,
          requestedSystem,
          appliedSystem: "heuristic-v1",
          fallbackApplied: true,
          warnings: llmWarnings,
          detectedEventTypes: extractedFilter?.includeEventTypes ?? [],
          extractedFilter,
          mergedFilter,
        },
      };
    }
  }

  private extractHeuristic(question: string): SearchFilter | undefined {
    const normalizedQuestion = normalizeText(question);
    const timeWindow =
      this.detectTimeWindow(normalizedQuestion) ??
      this.detectTimeWindowRulesV2(normalizedQuestion);
    const includeEventTypes = this.detectEventTypes(
      normalizedQuestion,
      timeWindow,
    );
    const warnings: string[] = [];
    const stateCodes = this.detectStateCodes(normalizedQuestion);

    const excludeEventTypes: string[] = [];
    const shouldIgnoreOtherWarningTypes =
      /ignore\s+other\s+warning\s+types?/.test(normalizedQuestion) ||
      (/(^|\s)only(\s|$)/.test(normalizedQuestion) &&
        includeEventTypes.some((eventType) => eventType.endsWith(" Warning")));

    if (shouldIgnoreOtherWarningTypes) {
      const includedWarnings = includeEventTypes.filter((eventType) =>
        eventType.endsWith(" Warning"),
      );

      if (includedWarnings.length) {
        for (const warningType of WARNING_EVENT_TYPES) {
          if (!includedWarnings.includes(warningType)) {
            excludeEventTypes.push(warningType);
          }
        }
      }
    }

    const extractedFilter: SearchFilter = {
      source: this.detectSource(normalizedQuestion, includeEventTypes),
      includeEventTypes: includeEventTypes.length
        ? includeEventTypes
        : undefined,
      excludeEventTypes: excludeEventTypes.length
        ? excludeEventTypes
        : undefined,
      stateCodes: stateCodes.length ? stateCodes : undefined,
      effectiveFrom: timeWindow?.effectiveFrom,
      effectiveTo: timeWindow?.effectiveTo,
    };

    if (warnings.length) {
      this.logger.debug(warnings.join("; "));
    }

    return sanitizeFilter(extractedFilter);
  }

  private async extractLlm(
    request: ExtractionRequest,
  ): Promise<SearchFilter | undefined> {
    const baseUrl = request.llmBaseUrl ?? getOllamaChatBaseUrl();
    const model = request.llmModel ?? getOllamaChatModel();
    const timeoutMs = request.timeoutMs ?? 15000;

    const prompt = [
      "Extract weather retrieval constraints from user question.",
      "Return strict JSON only (no markdown, no prose).",
      "Schema:",
      '{"includeEventTypes": string[], "excludeEventTypes": string[], "effectiveFrom": string | null, "effectiveTo": string | null}',
      "Rules:",
      "- includeEventTypes and excludeEventTypes must contain only canonical event names from the list below.",
      "- Use ISO-8601 UTC timestamps for effectiveFrom/effectiveTo when inferred.",
      "- If not inferable, set fields to null or empty arrays.",
      "Canonical event names:",
      JSON.stringify(CANONICAL_EVENT_TYPES),
      "Question:",
      request.question,
    ].join("\n");

    const raw = await this.ollamaGenerationClient.generate({
      baseUrl,
      model,
      prompt,
      timeoutMs,
      temperature: 0,
      maxTokens: 300,
    });

    const parsed = parseJsonObject(raw) as LlmExtractionPayload;

    const includeEventTypes =
      normalizeEventTypes(toStringArray(parsed.includeEventTypes)) ?? [];
    const excludeEventTypes =
      normalizeEventTypes(toStringArray(parsed.excludeEventTypes)) ?? [];
    const stateCodes = this.detectStateCodes(normalizeText(request.question));

    const extractedFilter: SearchFilter = {
      source: this.detectSource(
        normalizeText(request.question),
        includeEventTypes,
      ),
      includeEventTypes: includeEventTypes.length
        ? includeEventTypes
        : undefined,
      excludeEventTypes: excludeEventTypes.length
        ? excludeEventTypes
        : undefined,
      stateCodes: stateCodes.length ? stateCodes : undefined,
      effectiveFrom: toIsoOrUndefined(parsed.effectiveFrom),
      effectiveTo: toIsoOrUndefined(parsed.effectiveTo),
    };

    return sanitizeFilter(extractedFilter);
  }

  private async extractHeuristicV2(
    request: ExtractionRequest,
  ): Promise<SearchFilter | undefined> {
    const includeEventTypes = await this.extractHeuristicV2TypesLlm(request);
    const refinement = await this.extractHeuristicV2RefinementLlm(
      request,
      includeEventTypes,
    );
    const normalizedQuestion = normalizeText(request.question);
    const fallbackTimeWindow =
      !refinement.effectiveFrom && !refinement.effectiveTo
        ? this.detectTimeWindowRulesV2(normalizedQuestion)
        : null;
    const stateCodes = this.detectStateCodes(normalizedQuestion);

    const extractedFilter: SearchFilter = {
      source: this.detectSource(normalizedQuestion, includeEventTypes),
      includeEventTypes: includeEventTypes.length
        ? includeEventTypes
        : undefined,
      excludeEventTypes: refinement.excludeEventTypes?.length
        ? refinement.excludeEventTypes
        : undefined,
      stateCodes: stateCodes.length ? stateCodes : undefined,
      effectiveFrom:
        refinement.effectiveFrom ?? fallbackTimeWindow?.effectiveFrom,
      effectiveTo: refinement.effectiveTo ?? fallbackTimeWindow?.effectiveTo,
    };

    return sanitizeFilter(extractedFilter);
  }

  private async extractHeuristicV2TypesLlm(
    request: ExtractionRequest,
  ): Promise<string[]> {
    const baseUrl = request.llmBaseUrl ?? getOllamaChatBaseUrl();
    const model = request.llmModel ?? getOllamaChatModel();
    const timeoutMs = request.timeoutMs ?? 15000;

    const prompt = [
      "Classify weather event types for retrieval from the user question.",
      "Return strict JSON only (no markdown, no prose).",
      "Schema:",
      '{"includeEventTypes": string[]}',
      "Rules:",
      "- includeEventTypes must contain zero or more canonical event names from the allowed list.",
      "- Do not invent event names.",
      "- If no type is inferable, return an empty array.",
      "Allowed canonical event names:",
      JSON.stringify(CANONICAL_EVENT_TYPES),
      "Question:",
      request.question,
    ].join("\n");

    const raw = await this.ollamaGenerationClient.generate({
      baseUrl,
      model,
      prompt,
      timeoutMs,
      temperature: 0,
      maxTokens: 220,
    });

    const parsed = parseJsonObject(raw) as HeuristicV2TypesPayload;
    return normalizeEventTypes(toStringArray(parsed.includeEventTypes)) ?? [];
  }

  private async extractHeuristicV2RefinementLlm(
    request: ExtractionRequest,
    includeEventTypes: string[],
  ): Promise<{
    excludeEventTypes?: string[];
    effectiveFrom?: string;
    effectiveTo?: string;
  }> {
    const baseUrl = request.llmBaseUrl ?? getOllamaChatBaseUrl();
    const model = request.llmModel ?? getOllamaChatModel();
    const timeoutMs = request.timeoutMs ?? 15000;

    const prompt = [
      "Refine retrieval constraints for weather question.",
      "Return strict JSON only (no markdown, no prose).",
      "Schema:",
      '{"excludeEventTypes": string[], "effectiveFrom": string | null, "effectiveTo": string | null}',
      "Rules:",
      "- excludeEventTypes must contain only canonical event names from the allowed list.",
      "- effectiveFrom/effectiveTo must be ISO-8601 UTC timestamps when inferable.",
      "- If not inferable, set fields to null or empty arrays.",
      "- Do not modify includeEventTypes; they are provided from stage 1.",
      "Allowed canonical event names:",
      JSON.stringify(CANONICAL_EVENT_TYPES),
      "Stage 1 includeEventTypes:",
      JSON.stringify(includeEventTypes),
      "Question:",
      request.question,
    ].join("\n");

    const raw = await this.ollamaGenerationClient.generate({
      baseUrl,
      model,
      prompt,
      timeoutMs,
      temperature: 0,
      maxTokens: 260,
    });

    const parsed = parseJsonObject(raw) as HeuristicV2RefinementPayload;
    const excludeEventTypes =
      normalizeEventTypes(toStringArray(parsed.excludeEventTypes)) ?? [];

    return {
      excludeEventTypes,
      effectiveFrom: toIsoOrUndefined(parsed.effectiveFrom),
      effectiveTo: toIsoOrUndefined(parsed.effectiveTo),
    };
  }

  private extractRulesV2(question: string): RulesExtractionResult {
    const normalizedQuestion = normalizeText(question);
    const timeWindow = this.detectTimeWindowRulesV2(normalizedQuestion);
    const detectedEventTypes = this.detectEventTypes(
      normalizedQuestion,
      timeWindow,
    );
    const includeEventTypes = [...detectedEventTypes];
    const warnings: string[] = [];
    const signals: string[] = [];

    if (includeEventTypes.length > 0) {
      signals.push("event-type-match");
    }

    const detectedWarningTypes = includeEventTypes.filter((eventType) =>
      eventType.endsWith(" Warning"),
    );

    const hasOnlyIntent =
      /(^|\s)only(\s|$)/.test(normalizedQuestion) &&
      detectedWarningTypes.length > 0;
    const hasIgnoreOtherWarningsIntent =
      /ignore\s+other\s+warning\s+types?/.test(normalizedQuestion) &&
      detectedWarningTypes.length > 0;
    const hasExcludeExceptIntent =
      /(exclude|except)\b/.test(normalizedQuestion) &&
      detectedWarningTypes.length > 0;

    const shouldExcludeOtherWarningTypes =
      hasOnlyIntent || hasIgnoreOtherWarningsIntent || hasExcludeExceptIntent;

    const excludeEventTypes: string[] = [];
    if (shouldExcludeOtherWarningTypes) {
      for (const warningType of WARNING_EVENT_TYPES) {
        if (!detectedWarningTypes.includes(warningType)) {
          excludeEventTypes.push(warningType);
        }
      }

      signals.push("explicit-exclusion-intent");
    }
    if (timeWindow) {
      signals.push("time-intent");
    }
    const stateCodes = this.detectStateCodes(normalizedQuestion);

    const filter = sanitizeFilter({
      source: this.detectSource(normalizedQuestion, includeEventTypes),
      includeEventTypes: includeEventTypes.length
        ? includeEventTypes
        : undefined,
      excludeEventTypes: excludeEventTypes.length
        ? excludeEventTypes
        : undefined,
      stateCodes: stateCodes.length ? stateCodes : undefined,
      effectiveFrom: timeWindow?.effectiveFrom,
      effectiveTo: timeWindow?.effectiveTo,
    });

    const confidence = Number.parseFloat((signals.length / 3).toFixed(2));

    if (!filter && !signals.length) {
      warnings.push("rules-v2 extracted no constraints from question");
    }

    return {
      filter,
      confidence,
      signals,
      warnings,
      detectedEventTypes,
    };
  }

  private detectEventTypes(
    normalizedQuestion: string,
    timeWindow?: {
      effectiveFrom: string;
      effectiveTo: string;
    } | null,
  ): string[] {
    const matches = new Set<string>();

    if (
      containsPhrase(normalizedQuestion, "aqi") ||
      containsPhrase(normalizedQuestion, "air quality")
    ) {
      if (
        containsPhrase(normalizedQuestion, "forecast") ||
        containsPhrase(normalizedQuestion, "tomorrow") ||
        containsPhrase(normalizedQuestion, "next day")
      ) {
        matches.add("AirNow AQI Forecast Alert");
      }

      if (
        containsPhrase(normalizedQuestion, "observed") ||
        containsPhrase(normalizedQuestion, "current") ||
        containsPhrase(normalizedQuestion, "now") ||
        containsPhrase(normalizedQuestion, "threshold") ||
        containsPhrase(normalizedQuestion, "alert") ||
        containsPhrase(normalizedQuestion, "alerts")
      ) {
        matches.add("AirNow AQI Threshold Alert");
      }

      if (!matches.size) {
        matches.add("AirNow AQI Threshold Alert");
        matches.add("AirNow AQI Forecast Alert");
      }
    }

    for (const [alias, canonical] of ALIAS_MAP) {
      if (containsPhrase(normalizedQuestion, alias)) {
        matches.add(canonical);
      }
    }

    for (const eventType of CANONICAL_EVENT_TYPES) {
      if (containsPhrase(normalizedQuestion, normalizeText(eventType))) {
        matches.add(eventType);
      }
    }

    for (const eventType of this.detectSpcConvectiveOutlookEventTypes(
      normalizedQuestion,
      timeWindow,
    )) {
      matches.add(eventType);
    }

    return [...matches];
  }

  private detectSource(
    normalizedQuestion: string,
    includeEventTypes: string[],
  ): SearchFilter["source"] | undefined {
    if (
      includeEventTypes.some((eventType) =>
        eventType.startsWith("SPC Convective Outlook Day "),
      ) ||
      includeEventTypes.includes("SPC Mesoscale Discussion") ||
      containsPhrase(normalizedQuestion, "spc") ||
      containsPhrase(normalizedQuestion, "severe weather outlook") ||
      containsPhrase(normalizedQuestion, "convective outlook")
    ) {
      return "spc";
    }

    if (includeEventTypes.some((eventType) => eventType.startsWith("WPC "))) {
      return "wpc";
    }

    return undefined;
  }

  private detectSpcConvectiveOutlookEventTypes(
    normalizedQuestion: string,
    timeWindow?: {
      effectiveFrom: string;
      effectiveTo: string;
    } | null,
  ): string[] {
    const hasSpcOutlookIntent =
      containsPhrase(normalizedQuestion, "severe weather outlook") ||
      containsPhrase(normalizedQuestion, "severe weather outlooks") ||
      containsPhrase(normalizedQuestion, "convective outlook") ||
      containsPhrase(normalizedQuestion, "convective outlooks") ||
      (containsPhrase(normalizedQuestion, "spc") &&
        containsPhrase(normalizedQuestion, "outlook"));

    if (!hasSpcOutlookIntent) {
      return [];
    }

    const explicitDayNumbers = [
      ...normalizedQuestion.matchAll(/\bday\s+(\d)\b/g),
    ]
      .map((match) => Number.parseInt(match[1] ?? "0", 10))
      .filter((value) => Number.isFinite(value) && value >= 1 && value <= 8);

    if (explicitDayNumbers.length > 0) {
      return [
        ...new Set(
          explicitDayNumbers
            .map((dayNumber) => `SPC Convective Outlook Day ${dayNumber}`)
            .filter((eventType) =>
              SPC_CONVECTIVE_OUTLOOK_EVENT_TYPES.includes(
                eventType as (typeof SPC_CONVECTIVE_OUTLOOK_EVENT_TYPES)[number],
              ),
            ),
        ),
      ];
    }

    const horizonDays = this.detectForwardLookDays(
      normalizedQuestion,
      timeWindow,
    );
    if (horizonDays != null) {
      return SPC_CONVECTIVE_OUTLOOK_EVENT_TYPES.slice(
        0,
        Math.min(horizonDays, SPC_CONVECTIVE_OUTLOOK_EVENT_TYPES.length),
      );
    }

    if (containsPhrase(normalizedQuestion, "today")) {
      return ["SPC Convective Outlook Day 1"];
    }

    return [
      "SPC Convective Outlook Day 1",
      "SPC Convective Outlook Day 2",
      "SPC Convective Outlook Day 3",
    ];
  }

  private detectForwardLookDays(
    normalizedQuestion: string,
    timeWindow?: {
      effectiveFrom: string;
      effectiveTo: string;
    } | null,
  ): number | null {
    const nextDaysMatch = normalizedQuestion.match(
      /\b(?:next|coming|upcoming)\s+(\d{1,2})\s*(day|days)\b/,
    );
    if (nextDaysMatch?.[1]) {
      const days = Number.parseInt(nextDaysMatch[1], 10);
      if (Number.isFinite(days) && days > 0) {
        return days;
      }
    }

    if (containsPhrase(normalizedQuestion, "today")) {
      return 1;
    }

    if (!timeWindow?.effectiveFrom || !timeWindow?.effectiveTo) {
      return null;
    }

    const effectiveFromMs = Date.parse(timeWindow.effectiveFrom);
    const effectiveToMs = Date.parse(timeWindow.effectiveTo);
    if (!Number.isFinite(effectiveFromMs) || !Number.isFinite(effectiveToMs)) {
      return null;
    }

    const durationDays = Math.ceil(
      Math.max(0, effectiveToMs - effectiveFromMs) / MILLISECONDS_IN_DAY,
    );
    return durationDays > 0 ? durationDays : null;
  }

  private detectStateCodes(normalizedQuestion: string): string[] {
    const matches = new Set<string>();

    for (const [stateName, stateCode] of STATE_NAME_TO_CODE.entries()) {
      if (containsPhrase(normalizedQuestion, stateName)) {
        matches.add(stateCode);
      }
    }

    return [...matches];
  }

  private detectTimeWindow(normalizedQuestion: string): {
    effectiveFrom: string;
    effectiveTo: string;
  } | null {
    const relativeMatch = normalizedQuestion.match(
      /(last|past)\s+(\d{1,3})\s*(hour|hours|hr|hrs|day|days)\b/,
    );

    const now = new Date();

    if (relativeMatch) {
      const quantity = Number.parseInt(relativeMatch[2] ?? "0", 10);
      const unit = relativeMatch[3] ?? "hours";

      if (Number.isFinite(quantity) && quantity > 0) {
        const durationHours = unit.startsWith("day")
          ? quantity * HOURS_IN_DAY
          : quantity;
        const effectiveFrom = new Date(
          now.getTime() - durationHours * 60 * 60 * 1000,
        );
        return {
          effectiveFrom: effectiveFrom.toISOString(),
          effectiveTo: now.toISOString(),
        };
      }
    }

    return null;
  }

  private detectTimeWindowRulesV2(normalizedQuestion: string): {
    effectiveFrom: string;
    effectiveTo: string;
  } | null {
    const now = new Date();

    const forwardMatch = normalizedQuestion.match(
      /\b(?:next|coming|upcoming)\s+(\d{1,2})\s*(hour|hours|hr|hrs|day|days)\b/,
    );
    if (forwardMatch) {
      const quantity = Number.parseInt(forwardMatch[1] ?? "0", 10);
      const unit = forwardMatch[2] ?? "days";

      if (Number.isFinite(quantity) && quantity > 0) {
        const durationHours = unit.startsWith("day")
          ? quantity * HOURS_IN_DAY
          : quantity;
        return {
          effectiveFrom: now.toISOString(),
          effectiveTo: new Date(
            now.getTime() + durationHours * MILLISECONDS_IN_HOUR,
          ).toISOString(),
        };
      }
    }

    const sinceMatch = normalizedQuestion.match(
      /\bsince\s+(\d{4}-\d{2}-\d{2})\b/,
    );
    if (sinceMatch?.[1]) {
      const sinceDate = new Date(`${sinceMatch[1]}T00:00:00.000Z`);
      if (!Number.isNaN(sinceDate.getTime())) {
        return {
          effectiveFrom: sinceDate.toISOString(),
          effectiveTo: now.toISOString(),
        };
      }
    }

    const relativeMatch = normalizedQuestion.match(
      /(last|past)\s+(\d{1,3})\s*(hour|hours|hr|hrs|day|days)\b/,
    );
    if (relativeMatch) {
      const quantity = Number.parseInt(relativeMatch[2] ?? "0", 10);
      const unit = relativeMatch[3] ?? "hours";

      if (Number.isFinite(quantity) && quantity > 0) {
        const durationHours = unit.startsWith("day")
          ? quantity * HOURS_IN_DAY
          : quantity;
        const effectiveFrom = new Date(
          now.getTime() - durationHours * 60 * 60 * 1000,
        );
        return {
          effectiveFrom: effectiveFrom.toISOString(),
          effectiveTo: now.toISOString(),
        };
      }
    }

    const startOfTodayUtc = this.startOfUtcDay(now);
    const startOfTomorrowUtc = new Date(
      startOfTodayUtc.getTime() + HOURS_IN_DAY * 60 * 60 * 1000,
    );

    if (/\btoday\b/.test(normalizedQuestion)) {
      return {
        effectiveFrom: startOfTodayUtc.toISOString(),
        effectiveTo: now.toISOString(),
      };
    }

    if (/\byesterday\b/.test(normalizedQuestion)) {
      const startOfYesterdayUtc = new Date(
        startOfTodayUtc.getTime() - HOURS_IN_DAY * 60 * 60 * 1000,
      );
      return {
        effectiveFrom: startOfYesterdayUtc.toISOString(),
        effectiveTo: startOfTodayUtc.toISOString(),
      };
    }

    if (
      containsPhrase(normalizedQuestion, "right now") ||
      containsPhrase(normalizedQuestion, "currently") ||
      containsPhrase(normalizedQuestion, "current") ||
      /\bactive\b/.test(normalizedQuestion)
    ) {
      const effectiveFrom = new Date(now.getTime() - 72 * 60 * 60 * 1000);
      return {
        effectiveFrom: effectiveFrom.toISOString(),
        effectiveTo: now.toISOString(),
      };
    }

    if (/\bthis\s+morning\b/.test(normalizedQuestion)) {
      return this.buildCurrentUtcWindow(now, 6, 12);
    }

    if (/\bthis\s+afternoon\b/.test(normalizedQuestion)) {
      return this.buildCurrentUtcWindow(now, 12, 18);
    }

    if (/\btonight\b/.test(normalizedQuestion)) {
      const effectiveFrom = new Date(
        startOfTodayUtc.getTime() + 18 * 60 * 60 * 1000,
      );
      const effectiveTo =
        now.getTime() < startOfTomorrowUtc.getTime() ? now : startOfTomorrowUtc;

      return {
        effectiveFrom:
          effectiveFrom.getTime() <= effectiveTo.getTime()
            ? effectiveFrom.toISOString()
            : effectiveTo.toISOString(),
        effectiveTo: effectiveTo.toISOString(),
      };
    }

    return null;
  }

  private startOfUtcDay(date: Date): Date {
    return new Date(
      Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        0,
        0,
        0,
        0,
      ),
    );
  }

  private buildCurrentUtcWindow(
    now: Date,
    startHourUtc: number,
    endHourUtc: number,
  ): {
    effectiveFrom: string;
    effectiveTo: string;
  } {
    const dayStart = this.startOfUtcDay(now);
    const effectiveFrom = new Date(
      dayStart.getTime() + startHourUtc * 60 * 60 * 1000,
    );
    const windowEnd = new Date(
      dayStart.getTime() + endHourUtc * 60 * 60 * 1000,
    );
    const effectiveTo = now.getTime() < windowEnd.getTime() ? now : windowEnd;

    return {
      effectiveFrom:
        effectiveFrom.getTime() <= effectiveTo.getTime()
          ? effectiveFrom.toISOString()
          : effectiveTo.toISOString(),
      effectiveTo: effectiveTo.toISOString(),
    };
  }
}

function mergeFilters(
  userFilter: SearchFilter | undefined,
  extractedFilter: SearchFilter | undefined,
): SearchFilter | undefined {
  const cleanedUserFilter = sanitizeFilter(userFilter);
  const cleanedExtractedFilter = sanitizeFilter(extractedFilter);

  if (!cleanedUserFilter && !cleanedExtractedFilter) {
    return undefined;
  }

  const merged: SearchFilter = {
    source: cleanedUserFilter?.source ?? cleanedExtractedFilter?.source,
    eventType:
      cleanedUserFilter?.eventType ?? cleanedExtractedFilter?.eventType,
    includeEventTypes:
      cleanedUserFilter?.includeEventTypes ??
      cleanedExtractedFilter?.includeEventTypes,
    excludeEventTypes: unique(
      cleanedUserFilter?.excludeEventTypes,
      cleanedExtractedFilter?.excludeEventTypes,
    ),
    severity: cleanedUserFilter?.severity ?? cleanedExtractedFilter?.severity,
    stateCodes:
      cleanedUserFilter?.stateCodes ?? cleanedExtractedFilter?.stateCodes,
    effectiveFrom:
      cleanedUserFilter?.effectiveFrom ?? cleanedExtractedFilter?.effectiveFrom,
    effectiveTo:
      cleanedUserFilter?.effectiveTo ?? cleanedExtractedFilter?.effectiveTo,
    afdIssuedFrom:
      cleanedUserFilter?.afdIssuedFrom ?? cleanedExtractedFilter?.afdIssuedFrom,
    afdIssuedTo:
      cleanedUserFilter?.afdIssuedTo ?? cleanedExtractedFilter?.afdIssuedTo,
    afdSections:
      cleanedUserFilter?.afdSections ?? cleanedExtractedFilter?.afdSections,
  };

  return sanitizeFilter(merged);
}

function sanitizeFilter(
  filter: SearchFilter | undefined,
): SearchFilter | undefined {
  if (!filter) {
    return undefined;
  }

  const sanitized: SearchFilter = {
    source: trimOrUndefined(filter.source),
    eventType: trimOrUndefined(filter.eventType),
    includeEventTypes: normalizeEventTypes(filter.includeEventTypes),
    excludeEventTypes: normalizeEventTypes(filter.excludeEventTypes),
    severity: trimOrUndefined(filter.severity),
    stateCodes: filter.stateCodes?.map((value) => value.trim()).filter(Boolean),
    effectiveFrom: toIsoOrUndefined(filter.effectiveFrom),
    effectiveTo: toIsoOrUndefined(filter.effectiveTo),
    afdIssuedFrom: toIsoOrUndefined(filter.afdIssuedFrom),
    afdIssuedTo: toIsoOrUndefined(filter.afdIssuedTo),
    afdSections: filter.afdSections
      ?.map((value) => value.trim())
      .filter(Boolean),
  };

  if (
    !sanitized.source &&
    !sanitized.eventType &&
    !sanitized.includeEventTypes?.length &&
    !sanitized.excludeEventTypes?.length &&
    !sanitized.severity &&
    !sanitized.stateCodes?.length &&
    !sanitized.effectiveFrom &&
    !sanitized.effectiveTo &&
    !sanitized.afdIssuedFrom &&
    !sanitized.afdIssuedTo &&
    !sanitized.afdSections?.length
  ) {
    return undefined;
  }

  return sanitized;
}

function normalizeEventTypes(
  eventTypes: string[] | undefined,
): string[] | undefined {
  if (!eventTypes?.length) {
    return undefined;
  }

  const normalized = new Set<string>();

  for (const eventType of eventTypes) {
    const canonical = canonicalizeEventType(eventType);
    if (canonical) {
      normalized.add(canonical);
    }
  }

  return normalized.size ? [...normalized] : undefined;
}

function canonicalizeEventType(value: string): string | undefined {
  const normalized = normalizeText(value);

  if (!normalized) {
    return undefined;
  }

  const fromCanonicalMap = CANONICAL_MAP.get(normalized);
  if (fromCanonicalMap) {
    return fromCanonicalMap;
  }

  const fromAliasMap = ALIAS_MAP.get(normalized);
  if (fromAliasMap) {
    return fromAliasMap;
  }

  return undefined;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsPhrase(text: string, phrase: string): boolean {
  if (!phrase.length) {
    return false;
  }

  return text.includes(phrase);
}

function trimOrUndefined(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function toIsoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString();
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function parseJsonObject(rawValue: string): Record<string, unknown> {
  const trimmed = rawValue.trim();
  const withoutFence = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  const parsed = JSON.parse(withoutFence) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LLM extraction response must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}

function unique(
  first: string[] | undefined,
  second: string[] | undefined,
): string[] | undefined {
  const merged = new Set<string>([...(first ?? []), ...(second ?? [])]);
  return merged.size ? [...merged] : undefined;
}
