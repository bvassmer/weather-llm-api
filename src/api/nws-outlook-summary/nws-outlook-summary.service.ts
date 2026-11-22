import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { getOllamaChatBaseUrl, getOllamaChatModel } from "../ollama-env.js";
import { OllamaGenerationClient } from "../nws-answer/ollama-generation.client.js";
import {
  buildEvidencePrompt,
  fallbackEvidence,
  getEvidenceSentences,
  parseSelectedEvidence,
  renderCompactBriefing,
} from "./compact-briefing.js";
import type {
  OutlookSummaryFacts,
  OutlookSummaryMetadata,
  OutlookSummaryRequest,
  OutlookSummaryResponse,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_MAX_TOKENS = 280;
const DEFAULT_TEMPERATURE = 0.1;
const COMPACT_TIMEOUT_MS = 60000;
const COMPACT_MAX_TOKENS = 80;

type SummaryMode = "legacy" | OutlookSummaryMetadata["mode"];

type PromptLayout = "multiline" | "flat-labeled";

type PromptSection = {
  label: string;
  value: string;
};

const normalizeWhitespace = (value: unknown): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

const parsePositiveInt = (
  value: string | undefined,
  fallback: number,
): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseTemperature = (
  value: string | undefined,
  fallback: number,
): number => {
  const parsed = Number.parseFloat(value ?? "");
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(1, Math.max(0, parsed));
};

const isEnabled = (): boolean =>
  (process.env.NWS_OUTLOOK_SUMMARY_ENABLED ?? "true").trim().toLowerCase() !==
  "false";

const getSummaryMode = (): SummaryMode => {
  const value = process.env.NWS_OUTLOOK_SUMMARY_MODE?.trim().toLowerCase();
  return value === "compact" || value === "facts-only" ? value : "legacy";
};

const getPromptLayout = (): PromptLayout => {
  const value = (process.env.NWS_OUTLOOK_SUMMARY_PROMPT_LAYOUT ?? "multiline")
    .trim()
    .toLowerCase();

  if (value === "flat-labeled") {
    return "flat-labeled";
  }

  return "multiline";
};

const renderPromptSections = (
  layout: PromptLayout,
  sections: PromptSection[],
): string => {
  if (layout === "flat-labeled") {
    return sections.map(({ label, value }) => `${label}: ${value}`).join(" ");
  }

  return sections.map(({ label, value }) => `${label}:\n${value}`).join("\n\n");
};

@Injectable()
export class NwsOutlookSummaryService {
  private readonly logger = new Logger(NwsOutlookSummaryService.name);
  private compactInferenceBusy = false;

  constructor(
    @Inject(OllamaGenerationClient)
    private readonly generationClient: OllamaGenerationClient,
  ) {}

  async summarize(
    request: OutlookSummaryRequest,
  ): Promise<OutlookSummaryResponse> {
    if (!isEnabled()) {
      throw new ServiceUnavailableException(
        "Outlook summary generation is disabled by env.",
      );
    }

    const sourceFamily = normalizeWhitespace(request?.sourceFamily);
    const sourceProduct = normalizeWhitespace(request?.sourceProduct);
    if (!sourceFamily || !sourceProduct) {
      throw new BadRequestException(
        "sourceFamily and sourceProduct are required",
      );
    }

    const mode = getSummaryMode();
    const validFacts = request.facts?.version === 1 ? request.facts : undefined;
    if (request.mode === "compact" && !validFacts) {
      throw new BadRequestException(
        "Compact preview requires outlook facts version 1",
      );
    }
    if (mode !== "legacy" || request.mode === "compact") {
      return this.summarizeCompact(
        validFacts ?? { version: 1 },
        mode === "facts-only" ? mode : "compact",
      );
    }

    const discussion = normalizeWhitespace(request.discussion);
    if (!discussion) {
      throw new BadRequestException("discussion is required");
    }

    const model = getOllamaChatModel();
    const prompt = this.buildPrompt({
      ...request,
      sourceFamily,
      sourceProduct,
      discussion,
      summarySection: request.summarySection
        ? normalizeWhitespace(request.summarySection)
        : undefined,
      supportingDiscussion: request.supportingDiscussion
        ? normalizeWhitespace(request.supportingDiscussion)
        : undefined,
      event: request.event ? normalizeWhitespace(request.event) : undefined,
      headline: request.headline
        ? normalizeWhitespace(request.headline)
        : undefined,
      timingFacts: (request.timingFacts ?? [])
        .map((fact) => normalizeWhitespace(String(fact)))
        .filter((fact) => fact.length > 0),
      riskFacts: (request.riskFacts ?? [])
        .map((fact) => normalizeWhitespace(String(fact)))
        .filter((fact) => fact.length > 0),
      locationFacts: (request.locationFacts ?? [])
        .map((fact) => normalizeWhitespace(String(fact)))
        .filter((fact) => fact.length > 0),
      oklahomaFacts: (request.oklahomaFacts ?? [])
        .map((fact) => normalizeWhitespace(String(fact)))
        .filter((fact) => fact.length > 0),
    });

    const summary = this.sanitizeSummary(
      await this.generationClient.generate({
        baseUrl: getOllamaChatBaseUrl(),
        model,
        prompt,
        timeoutMs: parsePositiveInt(
          process.env.NWS_OUTLOOK_SUMMARY_TIMEOUT_MS,
          DEFAULT_TIMEOUT_MS,
        ),
        temperature: parseTemperature(
          process.env.NWS_OUTLOOK_SUMMARY_TEMPERATURE,
          DEFAULT_TEMPERATURE,
        ),
        maxTokens: parsePositiveInt(
          process.env.NWS_OUTLOOK_SUMMARY_MAX_TOKENS,
          DEFAULT_MAX_TOKENS,
        ),
      }),
    );

    if (!summary) {
      throw new ServiceUnavailableException(
        "Outlook summary generation returned no usable text.",
      );
    }

    return {
      summary,
      model,
    };
  }

  private async summarizeCompact(
    facts: OutlookSummaryFacts,
    mode: OutlookSummaryMetadata["mode"],
  ): Promise<OutlookSummaryResponse> {
    const start = performance.now();
    // Preview can use the candidate while scheduled legacy requests keep their existing model.
    const model =
      process.env.NWS_OUTLOOK_SUMMARY_MODEL?.trim() ||
      process.env.OLLAMA_CHAT_MODEL?.trim() ||
      "";
    const evidence = getEvidenceSentences(facts);
    const respond = (
      outcome: OutlookSummaryMetadata["outcome"],
      excerpts: typeof evidence,
      inferenceAttempted = false,
      fallbackReason?: OutlookSummaryMetadata["fallbackReason"],
    ): OutlookSummaryResponse => {
      const summary = renderCompactBriefing(facts, excerpts);
      const metadata: OutlookSummaryMetadata = {
        mode,
        promptVersion: "compact-v1",
        outcome,
        inferenceAttempted,
        ...(fallbackReason ? { fallbackReason } : {}),
        latencyMs: Math.round(performance.now() - start),
      };
      const modelLabel = model || "unconfigured";
      this.logger.log({ event: "outlook_summary", model: modelLabel, ...metadata });
      return { summary, model: modelLabel, metadata };
    };

    if (mode === "facts-only" || evidence.length <= 1) {
      return respond("deterministic", fallbackEvidence(evidence));
    }
    if (!model) {
      return respond(
        "fallback",
        fallbackEvidence(evidence),
        false,
        "inference-error",
      );
    }
    if (this.compactInferenceBusy) {
      return respond("fallback", fallbackEvidence(evidence), false, "busy");
    }

    this.compactInferenceBusy = true;
    try {
      const answer = await this.generationClient.generate({
        baseUrl: getOllamaChatBaseUrl(),
        model,
        prompt: buildEvidencePrompt(evidence),
        timeoutMs: Math.min(
          COMPACT_TIMEOUT_MS,
          parsePositiveInt(
            process.env.NWS_OUTLOOK_SUMMARY_TIMEOUT_MS,
            COMPACT_TIMEOUT_MS,
          ),
        ),
        maxTokens: Math.min(
          COMPACT_MAX_TOKENS,
          parsePositiveInt(
            process.env.NWS_OUTLOOK_SUMMARY_MAX_TOKENS,
            COMPACT_MAX_TOKENS,
          ),
        ),
        temperature: parseTemperature(
          process.env.NWS_OUTLOOK_SUMMARY_TEMPERATURE,
          DEFAULT_TEMPERATURE,
        ),
        rejectTruncated: true,
      });
      const excerpts = parseSelectedEvidence(answer, evidence);
      if (!excerpts) {
        return respond("fallback", fallbackEvidence(evidence), true, "invalid-output");
      }
      return respond(excerpts.length ? "selected" : "abstained", excerpts, true);
    } catch {
      return respond("fallback", fallbackEvidence(evidence), true, "inference-error");
    } finally {
      this.compactInferenceBusy = false;
    }
  }

  buildPrompt(request: OutlookSummaryRequest): string {
    const facts = request.oklahomaFacts?.length
      ? request.oklahomaFacts.join(" | ")
      : "None provided.";
    const timingFacts = request.timingFacts?.length
      ? request.timingFacts.join(" | ")
      : "None provided.";
    const riskFacts = request.riskFacts?.length
      ? request.riskFacts.join(" | ")
      : "None provided.";
    const locationFacts = request.locationFacts?.length
      ? request.locationFacts.join(" | ")
      : "None provided.";

    const instructions = [
      "Summarize this official NOAA outlook for Oklahoma in 3 to 5 plain sentences.",
      ...this.getProductSpecificInstructions(request),
      "Use only the labeled sections and supplied Oklahoma facts.",
      "If Oklahoma is not directly affected or is only near the edge of the risk area, say that plainly.",
      "No bullets. No markdown. No preamble. No citations.",
    ].join(" ");

    const sections: PromptSection[] = [
      {
        label: "Task",
        value: instructions,
      },
      {
        label: "Product",
        value: `${request.sourceFamily} / ${request.sourceProduct}`,
      },
    ];

    if (request.event) {
      sections.push({
        label: "Event",
        value: request.event,
      });
    }

    if (request.headline) {
      sections.push({
        label: "Headline",
        value: request.headline,
      });
    }

    sections.push(
      {
        label: "Oklahoma Facts",
        value: facts,
      },
      {
        label: "Timing Facts",
        value: timingFacts,
      },
      {
        label: "Risk Facts",
        value: riskFacts,
      },
      {
        label: "Location Facts",
        value: locationFacts,
      },
    );

    if (request.summarySection) {
      sections.push({
        label: "Summary Section",
        value: request.summarySection,
      });
    }

    if (request.supportingDiscussion) {
      sections.push({
        label: "Supporting Discussion",
        value: request.supportingDiscussion,
      });
    }

    sections.push({
      label: "Discussion",
      value: request.discussion ?? "",
    });

    return renderPromptSections(getPromptLayout(), sections);
  }

  private getProductSpecificInstructions(
    request: Pick<OutlookSummaryRequest, "sourceFamily" | "sourceProduct">,
  ): string[] {
    if (request.sourceFamily === "spc") {
      return [
        "Lead with the highest Oklahoma severe-weather or fire-weather signal.",
        "Then state the most specific supported timing and expected Oklahoma effects.",
        "If Oklahoma is peripheral to the outlook, mention that uncertainty or fringe positioning clearly.",
      ];
    }

    if (request.sourceProduct === "excessive-rainfall") {
      return [
        "Lead with the highest Oklahoma rainfall or flooding risk signal.",
        "Then state the most specific supported timing and likely flood impacts.",
        "Clarify whether Oklahoma is inside the main threat area or only nearby.",
      ];
    }

    if (request.sourceProduct === "snow-forecast") {
      return [
        "Lead with the strongest supported Oklahoma snow or ice signal.",
        "Then state the most specific supported timing and expected travel or accumulation impacts.",
        "If uncertainty is high or the main axis stays outside Oklahoma, say that plainly.",
      ];
    }

    return [
      "State the strongest Oklahoma signal first, then timing, then likely local effects.",
    ];
  }

  sanitizeSummary(value: string): string {
    return normalizeWhitespace(
      value
        .replace(/^```[a-zA-Z]*\s*/g, "")
        .replace(/```$/g, "")
        .replace(/^summary\s*:\s*/i, "")
        .replace(/^[\-*•]\s+/gm, "")
        .replace(/\s[-•]\s+/g, " ")
        .replace(/^\d+\.\s+/gm, ""),
    );
  }
}
