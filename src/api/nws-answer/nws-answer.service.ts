import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { getOllamaChatBaseUrl, getOllamaChatModel } from "../ollama-env.js";
import { NwsSearchService } from "../nws-search/nws-search.service.js";
import type { SearchRequest } from "../nws-search/types.js";
import { NwsConstraintExtractionService } from "./nws-constraint-extraction.service.js";
import { NwsConversationService } from "./nws-conversation.service.js";
import {
  NwsLiveContextService,
  type LiveContextResult,
} from "./nws-live-context.service.js";
import { OllamaGenerationClient } from "./ollama-generation.client.js";
import type {
  AnswerCompleteEvent,
  AnswerRequest,
  AnswerResponse,
  AnswerStageEvent,
  AnswerTokenEvent,
  Citation,
  ConversationHistoryMode,
  ConversationMessageMetadata,
  ConstraintExtractionSystem,
  SearchContextResult,
} from "./types.js";

interface AnswerEnv {
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaAnswerTimeoutMs: number;
  maxContextChars: number;
  defaultTemperature: number;
  defaultMaxTokens: number;
  constraintExtractorDefault: ConstraintExtractionSystem;
  constraintExtractorEnabled: boolean;
  constraintExtractorTimeoutMs: number;
}

interface SearchExecutionResult {
  citations: Citation[];
  searchContext: SearchContextResult;
  fallbackMessages?: string[];
}

export interface AnswerStreamHandlers {
  onStage(event: AnswerStageEvent): void;
  onToken(event: AnswerTokenEvent): void;
  onComplete(event: AnswerCompleteEvent): void;
}

interface GenerationRequestOptions {
  prompt: string;
  temperature: number;
  maxTokens: number;
}

interface PromptConversationMessage {
  role: "user" | "assistant";
  content: string;
}

class AnswerQualityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswerQualityError";
  }
}

@Injectable()
export class NwsAnswerService {
  constructor(
    @Inject(NwsSearchService)
    private readonly nwsSearchService: NwsSearchService,
    @Inject(OllamaGenerationClient)
    private readonly ollamaGenerationClient: OllamaGenerationClient,
    @Inject(NwsConstraintExtractionService)
    private readonly nwsConstraintExtractionService: NwsConstraintExtractionService,
    @Optional()
    @Inject(NwsConversationService)
    private readonly nwsConversationService?: NwsConversationService,
    @Optional()
    @Inject(NwsLiveContextService)
    private readonly nwsLiveContextService?: NwsLiveContextService,
  ) {}

  async answer(body: AnswerRequest): Promise<AnswerResponse> {
    const config = this.readEnv();
    const question = this.requireString(body?.question, "question");
    const historyMode = this.normalizeHistoryMode(body?.historyMode);
    const conversationContext = await this.loadConversationContext(
      body?.conversationId,
      historyMode,
    );

    const requestedSystem =
      body?.constraintSystem?.method ?? config.constraintExtractorDefault;
    const extractionEnabled =
      body?.constraintSystem?.enabled ?? config.constraintExtractorEnabled;
    const extractionSystem: ConstraintExtractionSystem = extractionEnabled
      ? requestedSystem
      : "bypass";

    const extractionResult = await this.nwsConstraintExtractionService.extract({
      question,
      requestedSystem: extractionSystem,
      userFilter: body?.filter,
      enabled: extractionEnabled,
      timeoutMs: config.constraintExtractorTimeoutMs,
      llmBaseUrl: config.ollamaBaseUrl,
      llmModel: config.ollamaModel,
    });

    const liveContext = await this.resolveLiveContext({
      body,
      question,
      filter: extractionResult.mergedFilter,
    });
    this.enforceRequiredLiveContext(body, liveContext);

    const { citations: searchCitations, searchContext } =
      await this.executeSearchWithFallback(
        question,
        body,
        extractionResult.mergedFilter,
        extractionResult.extractedFilter,
        extractionResult.metadata.appliedSystem,
      );
    const citations = this.mergeCitations(
      liveContext?.citations ?? [],
      searchCitations,
    );

    if (!citations.length) {
      const answer = "No relevant NWS context was found for this question.";
      const conversationId = await this.persistCompletedTurn({
        body,
        conversationId: conversationContext.conversationId,
        question,
        answer,
        citations,
        searchContext,
        extraction: extractionResult.metadata,
        liveContext: liveContext?.metadata,
        historyMode,
        stageEvents: [],
        generationOptions: undefined,
        mergedFilter: extractionResult.mergedFilter,
      });

      return {
        question,
        answer,
        model: config.ollamaModel,
        citations,
        ...(conversationId ? { conversationId } : {}),
        extraction: extractionResult.metadata,
        ...(liveContext?.metadata ? { liveContext: liveContext.metadata } : {}),
      };
    }

    const context = this.buildContext(
      citations,
      body?.maxContextChars ?? config.maxContextChars,
    );
    const prompt = this.buildPrompt(
      question,
      context,
      conversationContext.messages,
    );
    const generationOptions = this.resolveGenerationRequestOptions(
      body,
      config,
      {
        prompt,
      },
    );

    const answer = await this.generateAnswerWithRetry(
      config,
      generationOptions,
    );

    const conversationId = await this.persistCompletedTurn({
      body,
      conversationId: conversationContext.conversationId,
      question,
      answer,
      citations,
      searchContext,
      extraction: extractionResult.metadata,
      liveContext: liveContext?.metadata,
      historyMode,
      stageEvents: [],
      generationOptions,
      mergedFilter: extractionResult.mergedFilter,
    });

    return {
      question,
      answer,
      model: config.ollamaModel,
      citations,
      ...(conversationId ? { conversationId } : {}),
      extraction: extractionResult.metadata,
      ...(liveContext?.metadata ? { liveContext: liveContext.metadata } : {}),
    };
  }

  async streamAnswer(
    body: AnswerRequest,
    handlers: AnswerStreamHandlers,
    signal?: AbortSignal,
  ): Promise<void> {
    const config = this.readEnv();
    const question = this.requireString(body?.question, "question");
    const historyMode = this.normalizeHistoryMode(body?.historyMode);
    const conversationContext = await this.loadConversationContext(
      body?.conversationId,
      historyMode,
    );
    const stageEvents: AnswerStageEvent[] = [];

    if (this.emitCancelledIfAborted(handlers, signal)) {
      return;
    }

    this.emitStage(handlers, stageEvents, {
      type: "stage",
      stage: "constraints_started",
    });

    const requestedSystem =
      body?.constraintSystem?.method ?? config.constraintExtractorDefault;
    const extractionEnabled =
      body?.constraintSystem?.enabled ?? config.constraintExtractorEnabled;
    const extractionSystem: ConstraintExtractionSystem = extractionEnabled
      ? requestedSystem
      : "bypass";

    const extractionResult = await this.nwsConstraintExtractionService.extract({
      question,
      requestedSystem: extractionSystem,
      userFilter: body?.filter,
      enabled: extractionEnabled,
      timeoutMs: config.constraintExtractorTimeoutMs,
      llmBaseUrl: config.ollamaBaseUrl,
      llmModel: config.ollamaModel,
    });

    if (this.emitCancelledIfAborted(handlers, signal)) {
      return;
    }

    this.emitStage(handlers, stageEvents, {
      type: "stage",
      stage: "constraints_complete",
      extraction: extractionResult.metadata,
    });

    const shouldAttemptLiveContext = this.shouldAttemptLiveContext({
      body,
      question,
      filter: extractionResult.mergedFilter,
    });
    let liveContext: LiveContextResult | null = null;

    if (shouldAttemptLiveContext) {
      this.emitStage(handlers, stageEvents, {
        type: "stage",
        stage: "live_context_started",
      });

      liveContext = await this.resolveLiveContext({
        body,
        question,
        filter: extractionResult.mergedFilter,
        signal,
      });

      if (this.emitCancelledIfAborted(handlers, signal)) {
        return;
      }

      this.emitStage(handlers, stageEvents, {
        type: "stage",
        stage: "live_context_complete",
        ...(liveContext?.metadata
          ? {
              liveContext: liveContext.metadata,
              message: liveContext.metadata.warnings.join(" "),
            }
          : {}),
      });

      this.enforceRequiredLiveContext(body, liveContext);
    }

    this.emitStage(handlers, stageEvents, {
      type: "stage",
      stage: "search_started",
    });

    const {
      citations: searchCitations,
      searchContext,
      fallbackMessages,
    } = await this.executeSearchWithFallback(
      question,
      body,
      extractionResult.mergedFilter,
      extractionResult.extractedFilter,
      extractionResult.metadata.appliedSystem,
    );
    const citations = this.mergeCitations(
      liveContext?.citations ?? [],
      searchCitations,
    );

    if (this.emitCancelledIfAborted(handlers, signal)) {
      return;
    }

    this.emitStage(handlers, stageEvents, {
      type: "stage",
      stage: "search_complete",
      citationsCount: citations.length,
      search: searchContext,
      ...(fallbackMessages?.length
        ? {
            message: fallbackMessages.join(" "),
          }
        : {}),
    });

    if (!citations.length) {
      const conversationId = await this.persistCompletedTurn({
        body,
        conversationId: conversationContext.conversationId,
        question,
        answer: "No relevant NWS context was found for this question.",
        citations,
        searchContext,
        extraction: extractionResult.metadata,
        liveContext: liveContext?.metadata,
        historyMode,
        stageEvents,
        generationOptions: undefined,
        mergedFilter: extractionResult.mergedFilter,
      });
      handlers.onComplete({
        type: "complete",
        response: {
          question,
          answer: "No relevant NWS context was found for this question.",
          model: config.ollamaModel,
          citations,
          ...(conversationId ? { conversationId } : {}),
          extraction: extractionResult.metadata,
          ...(liveContext?.metadata
            ? { liveContext: liveContext.metadata }
            : {}),
        },
      });
      return;
    }

    const context = this.buildContext(
      citations,
      body?.maxContextChars ?? config.maxContextChars,
    );
    const prompt = this.buildPrompt(
      question,
      context,
      conversationContext.messages,
    );
    const generationOptions = this.resolveGenerationRequestOptions(
      body,
      config,
      {
        prompt,
      },
    );

    this.emitStage(handlers, stageEvents, {
      type: "stage",
      stage: "generation_started",
      model: config.ollamaModel,
    });

    const attemptStream = async (maxTokens: number) => {
      let bufferedAnswerText = "";
      const bufferedTokens: string[] = [];

      await this.ollamaGenerationClient.generateStream({
        baseUrl: config.ollamaBaseUrl,
        model: config.ollamaModel,
        prompt: generationOptions.prompt,
        timeoutMs: config.ollamaAnswerTimeoutMs,
        temperature: generationOptions.temperature,
        maxTokens,
        signal,
        onToken: (token) => {
          bufferedAnswerText += token;
          bufferedTokens.push(token);
        },
      });

      return {
        answer: this.validateGeneratedAnswer(bufferedAnswerText),
        tokens: bufferedTokens,
      };
    };

    let finalAnswer = "";
    let outputTokens: string[] = [];

    try {
      const attempt = await attemptStream(generationOptions.maxTokens);
      finalAnswer = attempt.answer;
      outputTokens = attempt.tokens;
    } catch (error) {
      if (signal?.aborted) {
        handlers.onStage({
          type: "stage",
          stage: "cancelled",
          message: "Request cancelled",
        });
        return;
      }

      const retryMaxTokens = this.getReducedRetryMaxTokens(
        generationOptions.maxTokens,
      );
      if (this.shouldRetryGeneration(error, "", retryMaxTokens)) {
        this.emitStage(handlers, stageEvents, {
          type: "stage",
          stage: "generation_started",
          model: config.ollamaModel,
          message: `Retrying answer generation with reduced maxTokens (${retryMaxTokens}).`,
        });

        const retryAttempt = await attemptStream(retryMaxTokens);
        finalAnswer = retryAttempt.answer;
        outputTokens = retryAttempt.tokens;
      } else {
        throw error;
      }
    }

    if (this.emitCancelledIfAborted(handlers, signal)) {
      return;
    }

    for (const token of outputTokens) {
      handlers.onToken({ type: "token", token });
    }

    this.emitStage(handlers, stageEvents, {
      type: "stage",
      stage: "generation_complete",
    });
    const conversationId = await this.persistCompletedTurn({
      body,
      conversationId: conversationContext.conversationId,
      question,
      answer: finalAnswer,
      citations,
      searchContext,
      extraction: extractionResult.metadata,
      liveContext: liveContext?.metadata,
      historyMode,
      stageEvents,
      generationOptions,
      mergedFilter: extractionResult.mergedFilter,
    });
    handlers.onComplete({
      type: "complete",
      response: {
        question,
        answer: finalAnswer,
        model: config.ollamaModel,
        citations,
        ...(conversationId ? { conversationId } : {}),
        extraction: extractionResult.metadata,
        ...(liveContext?.metadata ? { liveContext: liveContext.metadata } : {}),
      },
    });
  }

  private async loadConversationContext(
    conversationId: string | undefined,
    historyMode: ConversationHistoryMode,
  ): Promise<{
    conversationId: string | null;
    messages: PromptConversationMessage[];
  }> {
    if (!this.nwsConversationService) {
      return {
        conversationId: conversationId ?? null,
        messages: [],
      };
    }

    return this.nwsConversationService.loadPromptContext({
      conversationId,
      historyMode,
    });
  }

  private async persistCompletedTurn(input: {
    body: AnswerRequest;
    conversationId: string | null;
    question: string;
    answer: string;
    citations: Citation[];
    searchContext: SearchContextResult;
    extraction: AnswerResponse["extraction"];
    liveContext: AnswerResponse["liveContext"];
    historyMode: ConversationHistoryMode;
    stageEvents: AnswerStageEvent[];
    generationOptions: GenerationRequestOptions | undefined;
    mergedFilter: SearchRequest["filter"];
  }): Promise<string | undefined> {
    if (!this.nwsConversationService) {
      return input.conversationId ?? undefined;
    }

    const promptSettings = {
      ...(input.body.liveMode != null
        ? {
            liveMode: input.body.liveMode,
          }
        : {}),
      ...(input.body.temperature != null
        ? {
            temperature: input.body.temperature,
          }
        : {}),
      ...(input.body.maxTokens != null
        ? {
            maxTokens: input.body.maxTokens,
          }
        : {}),
      ...(input.body.maxContextChars != null
        ? {
            maxContextChars: input.body.maxContextChars,
          }
        : {}),
      ...(input.body.constraintSystem != null
        ? {
            constraintSystem: input.body.constraintSystem,
          }
        : {}),
    };

    const baseMetadata: ConversationMessageMetadata = {
      ...(input.mergedFilter != null
        ? {
            filter: input.mergedFilter,
          }
        : {}),
      ...(input.body.corpus != null
        ? {
            corpus: input.body.corpus,
          }
        : {}),
      ...(input.body.groupByEvent != null
        ? {
            groupByEvent: input.body.groupByEvent,
          }
        : {}),
      ...(Object.keys(promptSettings).length > 0
        ? {
            promptSettings,
          }
        : {}),
      historyMode: input.historyMode,
    };

    return this.nwsConversationService.appendCompletedTurn({
      conversationId: input.conversationId,
      question: input.question,
      answer: input.answer,
      userMetadata: baseMetadata,
      assistantMetadata: {
        ...baseMetadata,
        answerModel: this.readEnv().ollamaModel,
        citations: input.citations,
        search: input.searchContext,
        ...(input.extraction != null
          ? {
              extraction: input.extraction,
            }
          : {}),
        ...(input.liveContext != null
          ? {
              liveContext: input.liveContext,
            }
          : {}),
        stageEvents: input.stageEvents,
      },
    });
  }

  private shouldAttemptLiveContext(input: {
    body: AnswerRequest;
    question: string;
    filter: SearchRequest["filter"];
  }): boolean {
    return (
      this.nwsLiveContextService?.shouldFetchLiveContext({
        question: input.question,
        filter: input.filter,
        liveMode: input.body.liveMode,
      }) ?? false
    );
  }

  private async resolveLiveContext(input: {
    body: AnswerRequest;
    question: string;
    filter: SearchRequest["filter"];
    signal?: AbortSignal;
  }): Promise<LiveContextResult | null> {
    if (!this.nwsLiveContextService) {
      return null;
    }

    return this.nwsLiveContextService.getLiveContext({
      question: input.question,
      filter: input.filter,
      liveMode: input.body.liveMode,
      signal: input.signal,
    });
  }

  private enforceRequiredLiveContext(
    body: AnswerRequest,
    liveContext: LiveContextResult | null,
  ): void {
    if (body.liveMode !== "required") {
      return;
    }

    if (liveContext?.citations.length) {
      return;
    }

    throw new ServiceUnavailableException(
      "Live context is required for this question, but no live data was available.",
    );
  }

  private mergeCitations(
    liveCitations: Citation[],
    searchCitations: Citation[],
  ): Citation[] {
    const merged: Citation[] = [];
    const seen = new Set<string>();

    for (const citation of [...liveCitations, ...searchCitations]) {
      const key = [
        citation.origin ?? "search",
        citation.sourceDocumentId ?? citation.id,
        citation.citationLabel ?? "",
        this.readCitationString(citation, ["sourceProduct", "eventType"]) ?? "",
      ].join("|");
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      merged.push(citation);
    }

    return merged;
  }

  private emitStage(
    handlers: AnswerStreamHandlers,
    stageEvents: AnswerStageEvent[],
    event: AnswerStageEvent,
  ): void {
    stageEvents.push(event);
    handlers.onStage(event);
  }

  private emitCancelledIfAborted(
    handlers: AnswerStreamHandlers,
    signal?: AbortSignal,
  ): boolean {
    if (!signal?.aborted) {
      return false;
    }

    handlers.onStage({
      type: "stage",
      stage: "cancelled",
      message: "Request cancelled",
    });
    return true;
  }

  private async generateAnswerWithRetry(
    config: AnswerEnv,
    options: GenerationRequestOptions,
  ): Promise<string> {
    let answerText = "";

    try {
      answerText = await this.ollamaGenerationClient.generate({
        baseUrl: config.ollamaBaseUrl,
        model: config.ollamaModel,
        prompt: options.prompt,
        timeoutMs: config.ollamaAnswerTimeoutMs,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
      });
      return this.validateGeneratedAnswer(answerText);
    } catch (error) {
      const retryMaxTokens = this.getReducedRetryMaxTokens(options.maxTokens);
      if (!this.shouldRetryGeneration(error, answerText, retryMaxTokens)) {
        throw error;
      }

      const retryAnswer = await this.ollamaGenerationClient.generate({
        baseUrl: config.ollamaBaseUrl,
        model: config.ollamaModel,
        prompt: options.prompt,
        timeoutMs: config.ollamaAnswerTimeoutMs,
        temperature: options.temperature,
        maxTokens: retryMaxTokens,
      });

      return this.validateGeneratedAnswer(retryAnswer);
    }
  }

  private resolveGenerationRequestOptions(
    body: AnswerRequest,
    config: AnswerEnv,
    input: { prompt: string },
  ): GenerationRequestOptions {
    return {
      prompt: input.prompt,
      temperature: this.normalizeTemperature(
        body?.temperature,
        config.defaultTemperature,
      ),
      maxTokens: this.normalizeMaxTokens(
        body?.maxTokens,
        config.defaultMaxTokens,
      ),
    };
  }

  private shouldRetryGeneration(
    error: unknown,
    answerText: string,
    retryMaxTokens: number | null,
  ): retryMaxTokens is number {
    if (retryMaxTokens == null) {
      return false;
    }

    if (error instanceof AnswerQualityError) {
      return true;
    }

    if (answerText.trim().length > 0) {
      return false;
    }

    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();
    return (
      message.includes("terminated before completion") ||
      message.includes("terminated") ||
      message.includes("timed out after")
    );
  }

  private getReducedRetryMaxTokens(maxTokens: number): number | null {
    if (maxTokens <= 256) {
      return null;
    }

    const reduced = Math.max(256, Math.floor(maxTokens / 2));
    return reduced < maxTokens ? reduced : null;
  }

  private validateGeneratedAnswer(answerText: string): string {
    const trimmed = answerText.trim();
    if (!trimmed) {
      throw new AnswerQualityError("Ollama generate response was empty");
    }

    if (this.isLikelyGarbageAnswer(trimmed)) {
      throw new AnswerQualityError(
        "Ollama generate response failed quality validation",
      );
    }

    return trimmed;
  }

  private isLikelyGarbageAnswer(answerText: string): boolean {
    const normalized = answerText.toLowerCase().replace(/\s+/g, " ").trim();
    if (!normalized) {
      return true;
    }

    const words = normalized.split(" ").filter(Boolean);
    if (words.length < 5) {
      return false;
    }

    const repeatedWordCount = new Map<string, number>();
    for (const word of words) {
      const count = (repeatedWordCount.get(word) ?? 0) + 1;
      repeatedWordCount.set(word, count);
      if (count >= 12) {
        return true;
      }
    }

    const repeatedPhraseCount = new Map<string, number>();
    for (let index = 0; index <= words.length - 2; index += 1) {
      const phrase = `${words[index]} ${words[index + 1]}`;
      const count = (repeatedPhraseCount.get(phrase) ?? 0) + 1;
      repeatedPhraseCount.set(phrase, count);
      if (count >= 6) {
        return true;
      }
    }

    return /(which way\b.*){4,}|\bthe\s+\d{4}\b|\bn--\b|snippet:\s*nwsid:/i.test(
      normalized,
    );
  }

  private async executeSearchWithFallback(
    question: string,
    body: AnswerRequest,
    mergedFilter: SearchRequest["filter"],
    extractedFilter: SearchRequest["filter"],
    appliedSystem: ConstraintExtractionSystem,
  ): Promise<SearchExecutionResult> {
    const initialRequest = this.buildSearchRequest(
      question,
      body,
      mergedFilter,
    );
    const initialSearchResult =
      await this.nwsSearchService.search(initialRequest);
    const initialCitations = this.toCitations(initialSearchResult.hits);
    const finalizedInitialCitations = this.finalizeSearchCitations(
      initialCitations,
      mergedFilter,
      extractedFilter,
    );

    if (finalizedInitialCitations.length > 0) {
      return {
        citations: finalizedInitialCitations,
        searchContext: {
          corpus: initialSearchResult.corpus,
          hits: initialSearchResult.hits,
          topK: initialSearchResult.topK,
          model: initialSearchResult.model,
          collection: initialSearchResult.collection,
          collections: initialSearchResult.collections,
        },
      };
    }

    const retryPlans = this.buildSearchFallbackPlans(
      body,
      mergedFilter,
      extractedFilter,
      appliedSystem,
    );

    if (!retryPlans.length) {
      return {
        citations: initialCitations,
        searchContext: {
          corpus: initialSearchResult.corpus,
          hits: initialSearchResult.hits,
          topK: initialSearchResult.topK,
          model: initialSearchResult.model,
          collection: initialSearchResult.collection,
          collections: initialSearchResult.collections,
        },
      };
    }

    let finalSearchResult = initialSearchResult;
    let finalCitations = initialCitations;
    const fallbackMessages: string[] = [];

    for (const retryPlan of retryPlans) {
      const retryRequest = this.buildSearchRequest(
        question,
        body,
        retryPlan.filter,
      );
      finalSearchResult = await this.nwsSearchService.search(retryRequest);
      finalCitations = this.toCitations(finalSearchResult.hits);
      fallbackMessages.push(retryPlan.message);

      if (finalCitations.length > 0) {
        break;
      }
    }

    const finalizedCitations = this.finalizeSearchCitations(
      finalCitations,
      mergedFilter,
      extractedFilter,
    );

    return {
      citations: finalizedCitations,
      searchContext: {
        corpus: finalSearchResult.corpus,
        hits: finalSearchResult.hits,
        topK: finalSearchResult.topK,
        model: finalSearchResult.model,
        collection: finalSearchResult.collection,
        collections: finalSearchResult.collections,
      },
      fallbackMessages,
    };
  }

  private finalizeSearchCitations(
    citations: Citation[],
    mergedFilter: SearchRequest["filter"],
    extractedFilter: SearchRequest["filter"],
  ): Citation[] {
    const reorderedCitations = this.reorderFallbackCitations(
      citations,
      mergedFilter,
      extractedFilter,
    );

    return this.focusAnswerCitations(
      reorderedCitations,
      mergedFilter,
      extractedFilter,
    );
  }

  private buildSearchFallbackPlans(
    body: AnswerRequest,
    mergedFilter: SearchRequest["filter"],
    extractedFilter: SearchRequest["filter"],
    appliedSystem: ConstraintExtractionSystem,
  ): Array<{ filter: SearchRequest["filter"]; message: string }> {
    const retryPlans: Array<{
      filter: SearchRequest["filter"];
      message: string;
    }> = [];
    let currentFilter = mergedFilter;

    if (
      this.shouldRetryWithoutExtractedTemporalBounds(
        body,
        mergedFilter,
        extractedFilter,
        appliedSystem,
      )
    ) {
      currentFilter = this.omitTemporalBounds(currentFilter);
      retryPlans.push({
        filter: currentFilter,
        message:
          "No hits matched extracted time constraints; retried without extracted temporal bounds.",
      });
    }

    if (
      this.shouldRetryWithoutExtractedSpcStateCodes(
        body,
        currentFilter,
        extractedFilter,
      )
    ) {
      currentFilter = this.omitStateCodes(currentFilter);
      retryPlans.push({
        filter: currentFilter,
        message:
          "No hits matched extracted SPC state constraints; retried without extracted SPC state filter.",
      });
    }

    return retryPlans;
  }

  private reorderFallbackCitations(
    citations: Citation[],
    mergedFilter: SearchRequest["filter"],
    extractedFilter: SearchRequest["filter"],
  ): Citation[] {
    if (!citations.length) {
      return citations;
    }

    const timeWindow = this.readFilterTimeWindow(
      extractedFilter ?? mergedFilter,
    );
    if (!timeWindow || !this.isSpcGuidanceFilter(mergedFilter)) {
      return citations;
    }

    return [...citations].sort((left, right) => {
      const leftDistance = this.computeCitationTemporalWindowDistance(
        left,
        timeWindow,
      );
      const rightDistance = this.computeCitationTemporalWindowDistance(
        right,
        timeWindow,
      );

      if (leftDistance !== rightDistance) {
        return leftDistance - rightDistance;
      }

      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.id.localeCompare(right.id);
    });
  }

  private focusAnswerCitations(
    citations: Citation[],
    mergedFilter: SearchRequest["filter"],
    extractedFilter: SearchRequest["filter"],
  ): Citation[] {
    if (!citations.length) {
      return citations;
    }

    const timeWindow = this.readFilterTimeWindow(
      extractedFilter ?? mergedFilter,
    );
    if (!timeWindow || !this.isSpcGuidanceFilter(mergedFilter)) {
      return citations;
    }

    const requestedEventTypes = this.collectRequestedEventTypes(mergedFilter);
    const targetCount = Math.max(
      1,
      Math.min(5, requestedEventTypes.length || 5),
    );
    const focusedCitations: Citation[] = [];
    const seenEventTypes = new Set<string>();

    for (const citation of citations) {
      const eventType = this.readCitationString(citation, ["eventType"]);
      if (eventType && seenEventTypes.has(eventType)) {
        continue;
      }

      if (eventType) {
        seenEventTypes.add(eventType);
      }

      focusedCitations.push(citation);
      if (focusedCitations.length >= targetCount) {
        break;
      }
    }

    return focusedCitations.length
      ? focusedCitations
      : citations.slice(0, targetCount);
  }

  private readFilterTimeWindow(
    filter: SearchRequest["filter"],
  ): { startMs: number; endMs: number } | null {
    const startMs = filter?.effectiveFrom
      ? Date.parse(filter.effectiveFrom)
      : NaN;
    const endMs = filter?.effectiveTo ? Date.parse(filter.effectiveTo) : NaN;

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return null;
    }

    return {
      startMs,
      endMs,
    };
  }

  private computeCitationTemporalWindowDistance(
    citation: Citation,
    timeWindow: { startMs: number; endMs: number },
  ): number {
    const timestamps = [
      this.readCitationString(citation, ["effectiveAt"]),
      this.readCitationString(citation, ["onsetAt"]),
      this.readCitationString(citation, ["sent"]),
      this.readCitationString(citation, ["expiresAt"]),
      this.readCitationString(citation, ["endsAt"]),
      this.readCitationString(citation, ["effective"]),
      this.readCitationString(citation, ["onset"]),
      this.readCitationString(citation, ["expires"]),
      this.readCitationString(citation, ["ends"]),
    ]
      .map((value) => (value ? Date.parse(value) : NaN))
      .filter((value) => Number.isFinite(value));

    if (!timestamps.length) {
      return Number.MAX_SAFE_INTEGER;
    }

    let closestDistance = Number.MAX_SAFE_INTEGER;
    for (const timestamp of timestamps) {
      if (timestamp >= timeWindow.startMs && timestamp <= timeWindow.endMs) {
        return 0;
      }

      const distance =
        timestamp < timeWindow.startMs
          ? timeWindow.startMs - timestamp
          : timestamp - timeWindow.endMs;
      if (distance < closestDistance) {
        closestDistance = distance;
      }
    }

    return closestDistance;
  }

  private buildSearchRequest(
    question: string,
    body: AnswerRequest,
    filter: SearchRequest["filter"],
  ): SearchRequest {
    return {
      query: question,
      ...(body?.corpus != null ? { corpus: body.corpus } : {}),
      ...(body?.topK != null ? { topK: body.topK } : {}),
      ...(body?.minRelativeScore != null
        ? { minRelativeScore: body.minRelativeScore }
        : {}),
      ...(body?.minAbsoluteScore != null
        ? { minAbsoluteScore: body.minAbsoluteScore }
        : {}),
      ...(body?.groupByEvent != null
        ? { groupByEvent: body.groupByEvent }
        : {}),
      filter,
    };
  }

  private toCitations(
    hits: Array<{
      id: string;
      score: number;
      source?: string;
      citationLabel?: string;
      sourceDocumentId?: string;
      snippet: string;
      metadata: Record<string, unknown>;
    }>,
  ): Citation[] {
    return hits.map((hit) => ({
      id: hit.id,
      score: hit.score,
      source: hit.source,
      citationLabel: hit.citationLabel,
      sourceDocumentId: hit.sourceDocumentId,
      snippet: hit.snippet,
      metadata: hit.metadata,
    }));
  }

  private shouldRetryWithoutExtractedTemporalBounds(
    body: AnswerRequest,
    mergedFilter: SearchRequest["filter"],
    extractedFilter: SearchRequest["filter"],
    appliedSystem: ConstraintExtractionSystem,
  ): boolean {
    if (appliedSystem === "heuristic-v2" || appliedSystem === "rules-v2") {
      return false;
    }

    const userProvidedTemporalBounds =
      body?.filter?.effectiveFrom != null || body?.filter?.effectiveTo != null;
    if (userProvidedTemporalBounds) {
      return false;
    }

    const mergedHasTemporalBounds =
      mergedFilter?.effectiveFrom != null || mergedFilter?.effectiveTo != null;
    if (!mergedHasTemporalBounds) {
      return false;
    }

    return (
      extractedFilter?.effectiveFrom != null ||
      extractedFilter?.effectiveTo != null
    );
  }

  private shouldRetryWithoutExtractedSpcStateCodes(
    body: AnswerRequest,
    mergedFilter: SearchRequest["filter"],
    extractedFilter: SearchRequest["filter"],
  ): boolean {
    if (body?.filter?.stateCodes?.length) {
      return false;
    }

    if (
      !mergedFilter?.stateCodes?.length ||
      !extractedFilter?.stateCodes?.length
    ) {
      return false;
    }

    return this.isSpcGuidanceFilter(mergedFilter);
  }

  private isSpcGuidanceFilter(filter: SearchRequest["filter"]): boolean {
    if (filter?.source !== "spc") {
      return false;
    }

    const requestedEventTypes = this.collectRequestedEventTypes(filter);
    return (
      requestedEventTypes.length > 0 &&
      requestedEventTypes.every((eventType) =>
        /^SPC (Convective Outlook Day \d+|Mesoscale Discussion|Fire Weather Outlook Day \d+)$/i.test(
          eventType,
        ),
      )
    );
  }

  private collectRequestedEventTypes(
    filter: SearchRequest["filter"],
  ): string[] {
    return [
      ...new Set(
        [
          ...(filter?.eventType ? [filter.eventType] : []),
          ...(filter?.includeEventTypes ?? []),
        ]
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
  }

  private omitTemporalBounds(
    filter: SearchRequest["filter"],
  ): SearchRequest["filter"] {
    if (!filter) {
      return filter;
    }

    const {
      effectiveFrom: _effectiveFrom,
      effectiveTo: _effectiveTo,
      ...rest
    } = filter;

    return Object.values(rest).some((value) => value != null)
      ? rest
      : undefined;
  }

  private omitStateCodes(
    filter: SearchRequest["filter"],
  ): SearchRequest["filter"] {
    if (!filter) {
      return filter;
    }

    const { stateCodes: _stateCodes, ...rest } = filter;

    return Object.values(rest).some((value) => value != null)
      ? rest
      : undefined;
  }

  private buildContext(citations: Citation[], maxContextChars: number): string {
    const contextSections: string[] = [];
    let consumed = 0;

    for (const [index, citation] of citations.entries()) {
      const section = this.buildCitationContextSection(citation, index + 1);

      if (consumed + section.length > maxContextChars) {
        break;
      }

      consumed += section.length;
      contextSections.push(section);
    }

    return contextSections.join("\n---\n");
  }

  private buildPrompt(
    question: string,
    context: string,
    conversationMessages: PromptConversationMessage[],
  ): string {
    const sections = [
      "You are a weather analyst assistant.",
      "Answer the user question using only the retrieved records below.",
      "Treat each record number like [1], [2], etc. as the source of truth for that record.",
      "When several retrieved records are relevant, synthesize them instead of answering from only the first record.",
      "Do not invent locations, hazards, timing, impacts, or alert semantics that are not explicitly stated in the records.",
      "If the records are stale, expired, duplicated, conflicting, or insufficient for the question, say that plainly.",
      "Prioritize records that appear current when the user asks about current or active conditions.",
      "For forecast or outlook questions about a future window such as the next few days, treat future-dated outlook records whose valid time falls within that requested window as relevant evidence even if they are not active right now.",
      "If retrieved outlook records cover the requested future period, summarize what they say instead of answering that no outlook exists.",
      "Include inline record citations like [1] or [2] next to material claims.",
    ];

    const historyContext =
      this.buildConversationHistoryContext(conversationMessages);
    if (historyContext) {
      sections.push(
        "Use the prior conversation only to resolve follow-up references and conversational intent. Retrieved records remain the only factual source of truth.",
        `Prior conversation: ${historyContext}`,
      );
    }

    sections.push(
      `Retrieved records: ${this.normalizeContextText(context)}`,
      `Question: ${this.normalizeContextText(question)}`,
      "Answer in Markdown.",
    );

    return sections.join(" ");
  }

  private buildConversationHistoryContext(
    messages: PromptConversationMessage[],
  ): string | null {
    if (!messages.length) {
      return null;
    }

    const historyLines: string[] = [];
    let totalChars = 0;

    for (const message of messages.slice(-10)) {
      const roleLabel = message.role === "assistant" ? "Assistant" : "User";
      const normalizedContent = this.sanitizeConversationMessageContent(
        message.content,
      );
      if (!normalizedContent) {
        continue;
      }

      const line = `${roleLabel}: ${normalizedContent}`;
      if (totalChars + line.length > 4000) {
        break;
      }

      historyLines.push(line);
      totalChars += line.length;
    }

    return historyLines.length ? historyLines.join(" \n ") : null;
  }

  private sanitizeConversationMessageContent(value: string): string {
    const normalized = this.normalizeContextText(value);
    if (normalized.length <= 600) {
      return normalized;
    }

    return `${normalized.slice(0, 597).trimEnd()}...`;
  }

  private buildCitationContextSection(
    citation: Citation,
    index: number,
  ): string {
    if (this.isSpcOutlookCitation(citation)) {
      return this.buildSpcCitationContextSection(citation, index);
    }

    const headline = this.selectCitationHeadline(citation);
    const sectionLines = [
      `Record [${index}]`,
      `Source: ${citation.source ?? "unknown"}`,
      `Citation Label: ${citation.citationLabel ?? "unknown"}`,
      `Event Type: ${this.readCitationString(citation, ["eventType"]) ?? "unknown"}`,
      `Headline: ${headline ?? "unknown"}`,
      `Effective At: ${
        this.readCitationString(citation, [
          "effectiveAt",
          "sent",
          "onsetAt",
          "afdIssuedAt",
        ]) ?? "unknown"
      }`,
      `Expires At: ${
        this.readCitationString(citation, [
          "expiresAt",
          "endsAt",
          "afdIssuedTo",
        ]) ?? "unknown"
      }`,
    ];

    const stateCodes = this.readCitationStringArray(citation, ["stateCodes"]);
    if (stateCodes.length > 0) {
      sectionLines.push(`States: ${stateCodes.join(", ")}`);
    }

    this.appendLiveCitationContext(sectionLines, citation);

    const afdSection = this.readCitationString(citation, ["afdSectionName"]);
    if (afdSection) {
      sectionLines.push(`AFD Section: ${afdSection}`);
    }

    const summary = this.selectCitationSummary(citation) ?? "unknown";
    sectionLines.push(`Summary: ${summary}`);

    const snippet = this.sanitizeCitationText(citation.snippet, 320);
    if (snippet && snippet !== summary) {
      sectionLines.push(`Snippet: ${snippet}`);
    }

    return `${sectionLines.join("\n")}\n`;
  }

  private buildSpcCitationContextSection(
    citation: Citation,
    index: number,
  ): string {
    const sectionLines = [
      `Record [${index}]`,
      `Source: ${citation.source ?? "unknown"}`,
      `Citation Label: ${citation.citationLabel ?? "unknown"}`,
      `Event Type: ${this.readCitationString(citation, ["eventType"]) ?? "unknown"}`,
    ];

    const riskSummary = this.selectCitationHeadline(citation, {
      skipSpcPlaceholders: true,
    });
    if (riskSummary) {
      sectionLines.push(`Risk Summary: ${riskSummary}`);
    }

    sectionLines.push(
      `Issued At: ${
        this.readCitationString(citation, [
          "sent",
          "effectiveAt",
          "onsetAt",
          "effective",
          "onset",
        ]) ?? "unknown"
      }`,
    );

    const validUntil = this.readCitationString(citation, [
      "expiresAt",
      "endsAt",
      "expires",
      "ends",
    ]);
    if (validUntil) {
      sectionLines.push(`Valid Until: ${validUntil}`);
    }

    const stateCodes = this.readCitationStringArray(citation, ["stateCodes"]);
    if (stateCodes.length > 0) {
      sectionLines.push(`States: ${stateCodes.join(", ")}`);
    }

    this.appendLiveCitationContext(sectionLines, citation);

    const summary =
      this.selectSpcCitationSummary(citation) ??
      this.buildSparseSpcSummary(citation) ??
      "unknown";
    sectionLines.push(`Summary: ${summary}`);

    const snippet = this.sanitizeCitationText(citation.snippet, 320);
    if (
      snippet &&
      snippet !== summary &&
      !this.isSpcPlaceholderText(snippet) &&
      !this.isStructuredCitationText(snippet)
    ) {
      sectionLines.push(`Snippet: ${snippet}`);
    }

    return `${sectionLines.join("\n")}\n`;
  }

  private appendLiveCitationContext(
    sectionLines: string[],
    citation: Citation,
  ): void {
    if (citation.origin == null || citation.origin === "search") {
      return;
    }

    sectionLines.push(`Origin: ${citation.origin}`);

    const asOf =
      citation.fetchedAt ??
      this.readCitationString(citation, ["sent", "effectiveAt", "observedAt"]);
    if (asOf) {
      sectionLines.push(`As Of: ${asOf}`);
    }

    if (typeof citation.freshnessMs === "number") {
      sectionLines.push(
        `Freshness Minutes: ${Math.max(0, Math.round(citation.freshnessMs / 60000))}`,
      );
    }
  }

  private isSpcOutlookCitation(citation: Citation): boolean {
    const sourceProduct = this.readCitationString(citation, ["sourceProduct"]);
    if (sourceProduct === "convective-outlook") {
      return true;
    }

    return /^SPC Convective Outlook Day \d+$/i.test(
      this.readCitationString(citation, ["eventType"]) ?? "",
    );
  }

  private selectCitationHeadline(
    citation: Citation,
    options?: { skipSpcPlaceholders?: boolean },
  ): string | undefined {
    const headline = this.sanitizeCitationText(
      this.readCitationString(citation, ["headline", "eventHeadline", "title"]),
      220,
    );

    if (!headline) {
      return undefined;
    }

    if (options?.skipSpcPlaceholders && this.isSpcPlaceholderText(headline)) {
      return undefined;
    }

    return headline;
  }

  private selectCitationSummary(
    citation: Citation,
    options?: { skipSpcPlaceholders?: boolean; maxChars?: number },
  ): string | undefined {
    const maxChars = options?.maxChars ?? 700;
    const candidates = [
      this.readCitationString(citation, ["shortDescription"]),
      this.readCitationString(citation, ["description"]),
      this.readCitationString(citation, ["summary"]),
      this.readCitationString(citation, ["message"]),
      citation.snippet,
    ];

    for (const candidate of candidates) {
      const normalized = this.sanitizeCitationText(candidate, maxChars);
      if (!normalized) {
        continue;
      }

      if (
        options?.skipSpcPlaceholders &&
        (this.isSpcPlaceholderText(normalized) ||
          this.isStructuredCitationText(normalized))
      ) {
        continue;
      }

      return normalized;
    }

    return undefined;
  }

  private selectSpcCitationSummary(citation: Citation): string | undefined {
    const candidates = [
      this.readCitationString(citation, ["shortDescription"]),
      this.readCitationString(citation, ["description"]),
      this.readCitationString(citation, ["summary"]),
      this.readCitationString(citation, ["message"]),
    ];

    for (const candidate of candidates) {
      const extractedSection = this.extractSpcSummarySection(
        candidate,
        citation,
      );
      const normalized = this.sanitizeCitationText(
        extractedSection ?? candidate,
        420,
      );
      if (!normalized) {
        continue;
      }

      if (
        this.isSpcPlaceholderText(normalized) ||
        this.isStructuredCitationText(normalized)
      ) {
        continue;
      }

      return normalized;
    }

    const snippet = this.sanitizeCitationText(citation.snippet, 220);
    if (
      !snippet ||
      this.isSpcPlaceholderText(snippet) ||
      this.isStructuredCitationText(snippet)
    ) {
      return undefined;
    }

    return snippet;
  }

  private extractSpcSummarySection(
    value: string | undefined,
    citation: Citation,
  ): string | undefined {
    if (!value) {
      return undefined;
    }

    const lines = this.toPlainTextPreservingNewlines(value)
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (!lines.length) {
      return undefined;
    }

    const dayNumber = this.extractSpcOutlookDayNumber(citation);
    if (dayNumber != null && dayNumber >= 4) {
      const dayHeaderPattern = new RegExp(
        `^\\.\\.\\.D${dayNumber}(?:\\/|\\b)`,
        "i",
      );
      const startIndex = lines.findIndex((line) => dayHeaderPattern.test(line));
      if (startIndex >= 0) {
        const collected = this.collectSpcSectionLines(lines, startIndex + 1);
        if (collected.length) {
          return collected.join(" ");
        }
      }
    }

    const summaryIndex = lines.findIndex((line) =>
      /^\.\.\.SUMMARY\.\.\./i.test(line),
    );
    if (summaryIndex >= 0) {
      const collected = this.collectSpcSectionLines(lines, summaryIndex + 1);
      if (collected.length) {
        return collected.join(" ");
      }
    }

    return undefined;
  }

  private collectSpcSectionLines(
    lines: string[],
    startIndex: number,
  ): string[] {
    const collected: string[] = [];

    for (let index = startIndex; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (
        /^\.\.\.D\d+(?:\/|\b)/i.test(line) ||
        /^\.\.\.[A-Za-z]/.test(line) ||
        /^\.\.[A-Za-z]/.test(line) ||
        /^CLICK TO GET/i.test(line)
      ) {
        break;
      }

      collected.push(line);
    }

    return collected;
  }

  private extractSpcOutlookDayNumber(citation: Citation): number | null {
    const eventType = this.readCitationString(citation, ["eventType"]);
    const match = eventType?.match(/Day\s+(\d+)/i);
    if (!match?.[1]) {
      return null;
    }

    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private readCitationString(
    citation: Citation,
    keys: string[],
  ): string | undefined {
    for (const key of keys) {
      const value = citation.metadata[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }

    return undefined;
  }

  private readCitationStringArray(
    citation: Citation,
    keys: string[],
  ): string[] {
    for (const key of keys) {
      const value = citation.metadata[key];
      if (Array.isArray(value)) {
        return value
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter(Boolean);
      }
    }

    return [];
  }

  private sanitizeCitationText(
    value: string | undefined,
    maxChars: number,
  ): string | undefined {
    if (!value) {
      return undefined;
    }

    const normalized = this.normalizeContextText(
      value
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&#39;/gi, "'")
        .replace(/&quot;/gi, '"'),
    );

    if (!normalized || normalized.toLowerCase() === "unknown") {
      return undefined;
    }

    if (normalized.length <= maxChars) {
      return normalized;
    }

    return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
  }

  private toPlainTextPreservingNewlines(value: string): string {
    return value
      .replace(/\r/g, "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&#39;/gi, "'")
      .replace(/&quot;/gi, '"');
  }

  private isStructuredCitationText(value: string | undefined): boolean {
    if (!value) {
      return false;
    }

    const normalized = value.toLowerCase();
    const structuredLabels = [
      "nwsid:",
      "sourcefamily:",
      "sourceproduct:",
      "event:",
      "headline:",
      "shortdescription:",
      "sent:",
    ];

    return (
      structuredLabels.filter((label) => normalized.includes(label)).length >= 3
    );
  }

  private buildSparseSpcSummary(citation: Citation): string | undefined {
    const eventType = this.readCitationString(citation, ["eventType"]);
    const issuedAt = this.readCitationString(citation, [
      "sent",
      "effectiveAt",
      "onsetAt",
      "effective",
      "onset",
    ]);
    const riskSummary = this.selectCitationHeadline(citation, {
      skipSpcPlaceholders: true,
    });

    if (riskSummary && issuedAt) {
      return `${eventType ?? "SPC outlook record"} issued ${issuedAt}. ${riskSummary}.`;
    }

    if (issuedAt) {
      return `${eventType ?? "SPC outlook record"} issued ${issuedAt}. Detailed SPC narrative is unavailable in this stored record.`;
    }

    if (eventType) {
      return `${eventType}. Detailed SPC narrative is unavailable in this stored record.`;
    }

    return undefined;
  }

  private isSpcPlaceholderText(value: string | undefined): boolean {
    if (!value) {
      return false;
    }

    const normalized = this.normalizeContextText(value).toUpperCase();
    if (!normalized) {
      return false;
    }

    return (
      normalized === "N/A" ||
      /^SPC CONV DAY \d+\s*-\s*N\/A(?:\s+[A-Z]+N\/A\*?)*$/.test(normalized) ||
      /^SPC CONV DAY \d+\s*-\s*P?N\/A$/.test(normalized)
    );
  }

  private normalizeContextText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }

  private requireString(value: unknown, fieldName: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new BadRequestException(`${fieldName} must be a non-empty string`);
    }

    return value.trim();
  }

  private normalizeHistoryMode(
    value: AnswerRequest["historyMode"],
  ): ConversationHistoryMode {
    if (value == null) {
      return "none";
    }

    if (
      value !== "none" &&
      value !== "last-turn" &&
      value !== "last-10-messages"
    ) {
      throw new BadRequestException(
        "historyMode must be one of none, last-turn, or last-10-messages",
      );
    }

    return value;
  }

  private normalizeTemperature(
    value: number | undefined,
    fallback: number,
  ): number {
    if (value == null) {
      return fallback;
    }

    if (!Number.isFinite(value) || value < 0 || value > 2) {
      throw new BadRequestException("temperature must be between 0 and 2");
    }

    return value;
  }

  private normalizeMaxTokens(
    value: number | undefined,
    fallback: number,
  ): number {
    if (value == null) {
      return fallback;
    }

    if (!Number.isInteger(value) || value <= 0) {
      throw new BadRequestException("maxTokens must be a positive integer");
    }

    return value;
  }

  private readEnv(): AnswerEnv {
    return {
      ollamaBaseUrl: getOllamaChatBaseUrl(),
      ollamaModel: getOllamaChatModel(),
      ollamaAnswerTimeoutMs: this.parsePositiveInt(
        process.env.NWS_ANSWER_TIMEOUT_MS,
        this.parsePositiveInt(process.env.OLLAMA_TIMEOUT_MS, 300000),
      ),
      maxContextChars: this.parsePositiveInt(
        process.env.NWS_ANSWER_MAX_CONTEXT_CHARS,
        6000,
      ),
      defaultTemperature: this.parseFloatWithFallback(
        process.env.NWS_ANSWER_TEMPERATURE,
        0.2,
      ),
      defaultMaxTokens: this.parsePositiveInt(
        process.env.NWS_ANSWER_MAX_TOKENS,
        4096,
      ),
      constraintExtractorDefault: this.parseConstraintExtractorDefault(
        process.env.NWS_CONSTRAINT_EXTRACTOR_DEFAULT,
      ),
      constraintExtractorEnabled: this.parseBoolean(
        process.env.NWS_CONSTRAINT_EXTRACTOR_ENABLED,
        false,
      ),
      constraintExtractorTimeoutMs: this.parsePositiveInt(
        process.env.NWS_CONSTRAINT_EXTRACTOR_TIMEOUT_MS,
        15000,
      ),
    };
  }

  private parseConstraintExtractorDefault(
    rawValue: string | undefined,
  ): ConstraintExtractionSystem {
    if (
      rawValue === "bypass" ||
      rawValue === "heuristic-v1" ||
      rawValue === "heuristic-v2" ||
      rawValue === "rules-v2" ||
      rawValue === "llm-v1"
    ) {
      return rawValue;
    }

    return "heuristic-v2";
  }

  private parseBoolean(
    rawValue: string | undefined,
    defaultValue: boolean,
  ): boolean {
    if (!rawValue) {
      return defaultValue;
    }

    const normalized = rawValue.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }

    return defaultValue;
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

  private parseFloatWithFallback(
    rawValue: string | undefined,
    fallback: number,
  ): number {
    if (!rawValue) {
      return fallback;
    }

    const parsed = Number.parseFloat(rawValue);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }

    return parsed;
  }
}
