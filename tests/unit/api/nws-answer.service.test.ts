import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { NwsAnswerService } from "../../../src/api/nws-answer/nws-answer.service.js";
import { NwsConversationService } from "../../../src/api/nws-answer/nws-conversation.service.js";
import { NwsConstraintExtractionService } from "../../../src/api/nws-answer/nws-constraint-extraction.service.js";

describe("NwsAnswerService", () => {
  const createExtractionService = () =>
    ({
      extract: vi.fn(async ({ requestedSystem, userFilter, enabled }) => ({
        mergedFilter: userFilter,
        metadata: {
          enabled: enabled ?? false,
          requestedSystem,
          appliedSystem: "bypass",
          fallbackApplied: false,
          warnings: [],
          detectedEventTypes: [],
          extractedFilter: undefined,
          mergedFilter: userFilter,
        },
      })),
    }) as any;

  const createConversationService = (
    overrides: Partial<NwsConversationService> = {},
  ) =>
    ({
      loadPromptContext: vi.fn(async () => ({
        conversationId: null,
        messages: [],
      })),
      appendCompletedTurn: vi.fn(async () => "conversation-1"),
      ...overrides,
    }) as any;

  const createLiveContextService = (
    overrides: {
      shouldFetchLiveContext?: (input: unknown) => boolean;
      getLiveContext?: (input: unknown) => Promise<unknown>;
    } = {},
  ) =>
    ({
      shouldFetchLiveContext: vi.fn(() => false),
      getLiveContext: vi.fn(async () => null),
      ...overrides,
    }) as any;

  beforeEach(() => {
    Object.assign(process.env, {
      OLLAMA_BASE_URL: "http://ollama.local",
      OLLAMA_CHAT_MODEL: "qwen2.5:14b",
      OLLAMA_TIMEOUT_MS: "1000",
      NWS_ANSWER_TOPK_DEFAULT: "5",
      NWS_ANSWER_MAX_CONTEXT_CHARS: "1000",
      NWS_ANSWER_TEMPERATURE: "0.2",
      NWS_ANSWER_MAX_TOKENS: "200",
    });
  });

  it("returns fallback when no citations exist", async () => {
    const searchService = {
      search: vi.fn(async () => ({
        hits: [],
        model: "qwen2.5:14b",
        collection: "nws",
      })),
    } as any;
    const generationClient = {
      generate: vi.fn(),
    } as any;
    const constraintExtractionService = createExtractionService();

    const service = new NwsAnswerService(
      searchService,
      generationClient,
      constraintExtractionService,
    );
    const result = await service.answer({ question: "Any alerts?" });

    expect(result.answer).toContain("No relevant NWS context");
    expect(generationClient.generate).not.toHaveBeenCalled();
  });

  it("generates grounded answer with citations", async () => {
    const searchService = {
      search: vi.fn(async () => ({
        hits: [
          {
            id: "p1",
            score: 0.8,
            source: "nws-active",
            sourceDocumentId: "123",
            citationLabel: "urn:oid:2.49.0.1.840.0.example",
            snippet: "Tornado warning in county",
            metadata: { eventType: "Tornado Warning" },
          },
        ],
      })),
    } as any;

    const generationClient = {
      generate: vi.fn(async () => "There is an active tornado warning."),
    } as any;
    const constraintExtractionService = createExtractionService();

    const service = new NwsAnswerService(
      searchService,
      generationClient,
      constraintExtractionService,
    );
    const result = await service.answer({ question: "What is active?" });

    expect(result.answer).toContain("tornado warning");
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].citationLabel).toBe(
      "urn:oid:2.49.0.1.840.0.example",
    );
    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          "Citation Label: urn:oid:2.49.0.1.840.0.example",
        ),
      }),
    );
    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Record [1]"),
      }),
    );
    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Event Type: Tornado Warning"),
      }),
    );
    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.not.stringContaining("SourceDocumentId:"),
      }),
    );
    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.not.stringContaining("Metadata:"),
      }),
    );
    expect(generationClient.generate).toHaveBeenCalledTimes(1);
  });

  it("merges live citations ahead of search citations and returns live metadata", async () => {
    const searchService = {
      search: vi.fn(async () => ({
        hits: [
          {
            id: "search-1",
            score: 0.8,
            source: "nws-active",
            sourceDocumentId: "123",
            citationLabel: "urn:oid:2.49.0.1.840.0.search",
            snippet: "Tornado warning in county",
            metadata: {
              eventType: "Tornado Warning",
              sourceProduct: "active-alert",
            },
          },
        ],
        corpus: "alerts",
        topK: 5,
        model: "qwen2.5:14b",
        collection: "nws",
      })),
    } as any;

    const generationClient = {
      generate: vi.fn(
        async () => "Current conditions are calm with one warning. [1] [2]",
      ),
    } as any;
    const liveContextService = createLiveContextService({
      shouldFetchLiveContext: () => true,
      getLiveContext: async () => ({
        citations: [
          {
            id: "live-1",
            score: 1,
            source: "weather.gov",
            citationLabel: "KOWP",
            sourceDocumentId: "KOWP",
            origin: "live-upstream",
            fetchedAt: "2026-04-22T21:00:00Z",
            freshnessMs: 600000,
            snippet:
              "Current conditions from KOWP: clear, 72 F, wind SW 10 mph.",
            metadata: {
              eventType: "Current Conditions",
              sourceProduct: "latest-observation",
              sent: "2026-04-22T21:00:00Z",
            },
          },
        ],
        metadata: {
          mode: "auto",
          status: "ok",
          fetchedAt: "2026-04-22T21:05:00Z",
          warnings: [],
          sources: [
            {
              dataset: "current-conditions",
              origin: "live-upstream",
              source: "weather.gov",
              sourceFamily: "nws",
              sourceProduct: "latest-observation",
              asOf: "2026-04-22T21:00:00Z",
              itemCount: 1,
            },
          ],
        },
      }),
    });

    const service = new NwsAnswerService(
      searchService,
      generationClient,
      createExtractionService(),
      undefined,
      liveContextService,
    );
    const result = await service.answer({
      question: "What is happening right now?",
    });

    expect(result.liveContext?.status).toBe("ok");
    expect(result.citations).toHaveLength(2);
    expect(result.citations[0].origin).toBe("live-upstream");
    expect(result.citations[0].citationLabel).toBe("KOWP");
    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Origin: live-upstream"),
      }),
    );
  });

  it("fails when live mode is required and no live data is available", async () => {
    const searchService = {
      search: vi.fn(async () => ({
        hits: [],
        corpus: "alerts",
        topK: 5,
        model: "qwen2.5:14b",
        collection: "nws",
      })),
    } as any;
    const liveContextService = createLiveContextService({
      shouldFetchLiveContext: () => true,
      getLiveContext: async () => ({
        citations: [],
        metadata: {
          mode: "required",
          status: "unavailable",
          fetchedAt: "2026-04-22T21:05:00Z",
          warnings: ["Current conditions unavailable"],
          sources: [],
        },
      }),
    });

    const service = new NwsAnswerService(
      searchService,
      { generate: vi.fn() } as any,
      createExtractionService(),
      undefined,
      liveContextService,
    );

    await expect(
      service.answer({
        question: "What is happening right now?",
        liveMode: "required",
      }),
    ).rejects.toThrow(
      "Live context is required for this question, but no live data was available.",
    );
  });

  it("includes prior conversation context in the prompt and persists the completed turn", async () => {
    const searchService = {
      search: vi.fn(async () => ({
        hits: [
          {
            id: "p1",
            score: 0.8,
            source: "nws-active",
            citationLabel: "urn:oid:1",
            snippet: "Snow continues overnight in Denver.",
            metadata: { eventType: "Winter Storm Warning" },
          },
        ],
        corpus: "alerts",
        topK: 5,
        model: "qwen2.5:14b",
        collection: "nws",
      })),
    } as any;

    const generationClient = {
      generate: vi.fn(async () => "Snow continues overnight. [1]"),
    } as any;

    const conversationService = createConversationService({
      loadPromptContext: vi.fn(async () => ({
        conversationId: "conversation-7",
        messages: [
          {
            role: "user",
            content: "What is happening in Denver?",
          },
          {
            role: "assistant",
            content: "Denver is under a winter storm warning.",
          },
        ],
      })),
      appendCompletedTurn: vi.fn(async () => "conversation-7"),
    });

    const service = new NwsAnswerService(
      searchService,
      generationClient,
      createExtractionService(),
      conversationService,
    );

    const result = await service.answer({
      question: "What about overnight?",
      historyMode: "last-turn",
    });

    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          "Prior conversation: User: What is happening in Denver?",
        ),
      }),
    );
    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          "Assistant: Denver is under a winter storm warning.",
        ),
      }),
    );
    expect(conversationService.appendCompletedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation-7",
        question: "What about overnight?",
        answer: "Snow continues overnight. [1]",
      }),
    );
    expect(result.conversationId).toBe("conversation-7");
  });

  it("persists the no-context fallback response during streaming", async () => {
    const searchService = {
      search: vi.fn(async () => ({
        hits: [],
        corpus: "alerts",
        topK: 5,
        model: "qwen2.5:14b",
        collection: "nws",
      })),
    } as any;

    const conversationService = createConversationService({
      appendCompletedTurn: vi.fn(async () => "conversation-empty"),
    });

    const service = new NwsAnswerService(
      searchService,
      { generate: vi.fn(), generateStream: vi.fn() } as any,
      createExtractionService(),
      conversationService,
    );

    let completedResponse: any;

    await service.streamAnswer(
      {
        question: "Any alerts?",
      },
      {
        onStage: () => undefined,
        onToken: () => undefined,
        onComplete: (event) => {
          completedResponse = event.response;
        },
      },
    );

    expect(conversationService.appendCompletedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        answer: "No relevant NWS context was found for this question.",
      }),
    );
    expect(completedResponse?.conversationId).toBe("conversation-empty");
  });

  it("emits live context stage events before search during streaming", async () => {
    const searchService = {
      search: vi.fn(async () => ({
        hits: [],
        corpus: "alerts",
        topK: 5,
        model: "qwen2.5:14b",
        collection: "nws",
      })),
    } as any;
    const liveContextService = createLiveContextService({
      shouldFetchLiveContext: () => true,
      getLiveContext: async () => ({
        citations: [
          {
            id: "live-1",
            score: 1,
            source: "weather.gov",
            citationLabel: "KOWP",
            sourceDocumentId: "KOWP",
            origin: "live-upstream",
            fetchedAt: "2026-04-22T21:00:00Z",
            freshnessMs: 600000,
            snippet:
              "Current conditions from KOWP: clear, 72 F, wind SW 10 mph.",
            metadata: {
              eventType: "Current Conditions",
              sourceProduct: "latest-observation",
              sent: "2026-04-22T21:00:00Z",
            },
          },
        ],
        metadata: {
          mode: "auto",
          status: "ok",
          fetchedAt: "2026-04-22T21:05:00Z",
          warnings: [],
          sources: [],
        },
      }),
    });
    const generationClient = {
      generateStream: vi.fn(async ({ onToken }) => {
        onToken(
          "Current conditions are calm with no active severe weather. [1]",
        );
      }),
    } as any;

    const service = new NwsAnswerService(
      searchService,
      generationClient,
      createExtractionService(),
      undefined,
      liveContextService,
    );
    const stages: string[] = [];

    await service.streamAnswer(
      {
        question: "What is happening right now?",
      },
      {
        onStage: (event) => {
          stages.push(event.stage);
        },
        onToken: () => undefined,
        onComplete: () => undefined,
      },
    );

    expect(stages).toContain("live_context_started");
    expect(stages).toContain("live_context_complete");
    expect(stages.indexOf("live_context_started")).toBeGreaterThan(
      stages.indexOf("constraints_complete"),
    );
    expect(stages.indexOf("search_started")).toBeGreaterThan(
      stages.indexOf("live_context_complete"),
    );
  });

  it("builds a prompt that requires synthesis across multiple retrieved records", async () => {
    const searchService = {
      search: vi.fn(async () => ({
        hits: [
          {
            id: "p1",
            score: 0.8,
            source: "nws-active",
            citationLabel: "urn:oid:warning",
            snippet: "Tornado warning in Tulsa County",
            metadata: {
              eventType: "Tornado Warning",
              headline: "Tornado Warning for Tulsa County",
            },
          },
          {
            id: "p2",
            score: 0.78,
            source: "nws-active",
            citationLabel: "urn:oid:watch",
            snippet: "Severe thunderstorm watch in Rogers County",
            metadata: {
              eventType: "Severe Thunderstorm Watch",
              headline: "Severe Thunderstorm Watch for Rogers County",
            },
          },
        ],
      })),
    } as any;

    const generationClient = {
      generate: vi.fn(async () => "Grounded summary."),
    } as any;

    const service = new NwsAnswerService(
      searchService,
      generationClient,
      createExtractionService(),
    );

    await service.answer({ question: "What is active?" });

    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          "When several retrieved records are relevant, synthesize them instead of answering from only the first record.",
        ),
      }),
    );
    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          "For forecast or outlook questions about a future window such as the next few days, treat future-dated outlook records whose valid time falls within that requested window as relevant evidence even if they are not active right now.",
        ),
      }),
    );
    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Record [1]"),
      }),
    );
    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Record [2]"),
      }),
    );
  });

  it("builds SPC outlook context from issued time and cleaned description when summary fields are placeholders", async () => {
    const searchService = {
      search: vi.fn(async () => ({
        hits: [
          {
            id: "spc-day-1",
            score: 0.8,
            source: "spc",
            sourceDocumentId: "spc-day-1",
            citationLabel: "urn:oid:spc-day-1",
            snippet:
              "<div><p>Severe storms possible across central Oklahoma this afternoon.</p></div>",
            metadata: {
              eventType: "SPC Convective Outlook Day 1",
              sourceProduct: "convective-outlook",
              headline: "SPC Conv Day 1 - N/A TN/A HN/A WN/A",
              shortDescription: "SPC Conv Day 1 - N/A",
              description:
                "<html><body><p>Severe storms possible across central Oklahoma this afternoon.</p></body></html>",
              sent: "2026-04-22T12:00:00.000Z",
            },
          },
        ],
      })),
    } as any;

    const generationClient = {
      generate: vi.fn(async () => "Grounded SPC summary."),
    } as any;

    const service = new NwsAnswerService(
      searchService,
      generationClient,
      createExtractionService(),
    );

    await service.answer({
      question: "What is the SPC outlook for Oklahoma today?",
    });

    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Issued At: 2026-04-22T12:00:00.000Z"),
      }),
    );
    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          "Summary: Severe storms possible across central Oklahoma this afternoon.",
        ),
      }),
    );
    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.not.stringContaining(
          "Risk Summary: SPC Conv Day 1 - N/A",
        ),
      }),
    );
    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.not.stringContaining("<html>"),
      }),
    );
  });

  it("compresses long SPC product text to the summary section", async () => {
    const searchService = {
      search: vi.fn(async () => ({
        hits: [
          {
            id: "spc-day-2",
            score: 0.8,
            source: "spc",
            sourceDocumentId: "spc-day-2",
            citationLabel: "urn:oid:spc-day-2",
            snippet: "SPC Day 2 outlook product text.",
            metadata: {
              eventType: "SPC Convective Outlook Day 2",
              sourceProduct: "convective-outlook",
              shortDescription: `SPC AC 290552

Day 2 Convective Outlook

...SUMMARY...
Scattered severe thunderstorms are possible on Wednesday, centered on central Texas to eastern Oklahoma and western Arkansas. Large hail, damaging wind, and a few tornadoes will be possible with thunderstorm activity.

...Synopsis...
A shortwave trough is expected to move eastward across the Southern Plains on Wednesday, with multiple rounds of thunderstorm activity possible across portions of Texas and Oklahoma.

CLICK TO GET PRODUCT`,
              sent: "2025-04-29T06:08:56.000Z",
            },
          },
        ],
      })),
    } as any;

    const generationClient = {
      generate: vi.fn(async () => "Compressed SPC summary."),
    } as any;

    const service = new NwsAnswerService(
      searchService,
      generationClient,
      createExtractionService(),
    );

    await service.answer({
      question: "What does the SPC outlook say?",
    });

    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          "Summary: Scattered severe thunderstorms are possible on Wednesday, centered on central Texas to eastern Oklahoma and western Arkansas. Large hail, damaging wind, and a few tornadoes will be possible with thunderstorm activity.",
        ),
      }),
    );
    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.not.stringContaining("...Synopsis..."),
      }),
    );
    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.not.stringContaining("CLICK TO GET PRODUCT"),
      }),
    );
  });

  it("builds sparse SPC summary instead of raw embedding text fields when no narrative is stored", async () => {
    const searchService = {
      search: vi.fn(async () => ({
        hits: [
          {
            id: "spc-day-1-sparse",
            score: 0.8,
            source: "spc",
            sourceDocumentId: "spc-day-1-sparse",
            citationLabel: "urn:oid:spc-day-1-sparse",
            snippet:
              "nwsId: https://www.spc.noaa.gov/products/outlook/archive/2026/day1otlk_20260422_1200.html sourceFamily: spc sourceProduct: convective-outlook event: SPC Convective Outlook Day 1 headline: SPC Conv Day 1 - N/A TN/A HN/A WN/A shortDescription: SPC Conv Day 1 - N/A sent: 2026-04-22T11:00:32.000Z",
            metadata: {
              eventType: "SPC Convective Outlook Day 1",
              sourceProduct: "convective-outlook",
              headline: "SPC Conv Day 1 - N/A TN/A HN/A WN/A",
              shortDescription: "SPC Conv Day 1 - N/A",
              sent: "2026-04-22T11:00:32.000Z",
            },
          },
        ],
      })),
    } as any;

    const generationClient = {
      generate: vi.fn(async () => "Sparse SPC summary."),
    } as any;

    const service = new NwsAnswerService(
      searchService,
      generationClient,
      createExtractionService(),
    );

    await service.answer({
      question: "What does the current SPC outlook show?",
    });

    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          "Summary: SPC Convective Outlook Day 1 issued 2026-04-22T11:00:32.000Z. Detailed SPC narrative is unavailable in this stored record.",
        ),
      }),
    );
    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.not.stringContaining("nwsId:"),
      }),
    );
  });

  it("validates request fields", async () => {
    const service = new NwsAnswerService(
      { search: vi.fn() } as any,
      { generate: vi.fn() } as any,
      createExtractionService(),
    );
    await expect(
      service.answer({ question: "", temperature: 3 } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("passes retrieval quality options to search", async () => {
    const searchService = {
      search: vi.fn(async () => ({
        hits: [],
        model: "qwen2.5:14b",
        collection: "nws",
      })),
    } as any;

    const service = new NwsAnswerService(
      searchService,
      { generate: vi.fn() } as any,
      createExtractionService(),
    );

    await service.answer({
      question: "Any alerts?",
      minRelativeScore: 0.92,
      minAbsoluteScore: 0.7,
    });

    expect(searchService.search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "Any alerts?",
        minRelativeScore: 0.92,
        minAbsoluteScore: 0.7,
      }),
    );
  });

  it("routes severe weather outlook questions to SPC search filters before generation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T15:30:00.000Z"));

    try {
      const searchService = {
        search: vi.fn(async () => ({
          hits: [],
          corpus: "alerts",
          topK: 5,
          model: "qwen2.5:14b",
          collection: "nws_alerts_embeddings_spc_v1",
          collections: ["nws_alerts_embeddings_spc_v1"],
        })),
      } as any;

      const service = new NwsAnswerService(
        searchService,
        { generate: vi.fn() } as any,
        new NwsConstraintExtractionService({ generate: vi.fn() } as any),
      );

      const result = await service.answer({
        question:
          "tell me what the severe weather outlook looks like for oklahoma in the next 5 days",
        constraintSystem: {
          enabled: true,
          method: "heuristic-v1",
        },
      });

      expect(searchService.search).toHaveBeenCalledTimes(3);
      expect(searchService.search.mock.calls[0][0].filter).toEqual({
        source: "spc",
        stateCodes: ["OK"],
        includeEventTypes: [
          "SPC Convective Outlook Day 1",
          "SPC Convective Outlook Day 2",
          "SPC Convective Outlook Day 3",
          "SPC Convective Outlook Day 4",
          "SPC Convective Outlook Day 5",
        ],
        effectiveFrom: "2026-04-22T15:30:00.000Z",
        effectiveTo: "2026-04-27T15:30:00.000Z",
      });
      expect(searchService.search.mock.calls[1][0].filter).toEqual({
        source: "spc",
        stateCodes: ["OK"],
        includeEventTypes: [
          "SPC Convective Outlook Day 1",
          "SPC Convective Outlook Day 2",
          "SPC Convective Outlook Day 3",
          "SPC Convective Outlook Day 4",
          "SPC Convective Outlook Day 5",
        ],
      });
      expect(searchService.search.mock.calls[2][0].filter).toEqual({
        source: "spc",
        includeEventTypes: [
          "SPC Convective Outlook Day 1",
          "SPC Convective Outlook Day 2",
          "SPC Convective Outlook Day 3",
          "SPC Convective Outlook Day 4",
          "SPC Convective Outlook Day 5",
        ],
      });
      expect(result.answer).toContain("No relevant NWS context");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries without extracted SPC state codes when SPC guidance records lack state metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T15:30:00.000Z"));

    try {
      const searchService = {
        search: vi
          .fn()
          .mockResolvedValueOnce({
            hits: [],
            corpus: "alerts",
            topK: 5,
            model: "qwen2.5:14b",
            collection: "nws_alerts_embeddings_spc_v1",
            collections: ["nws_alerts_embeddings_spc_v1"],
          })
          .mockResolvedValueOnce({
            hits: [],
            corpus: "alerts",
            topK: 5,
            model: "qwen2.5:14b",
            collection: "nws_alerts_embeddings_spc_v1",
            collections: ["nws_alerts_embeddings_spc_v1"],
          })
          .mockResolvedValueOnce({
            hits: [
              {
                id: "spc-day-1",
                score: 0.79,
                source: "spc",
                citationLabel: "urn:oid:spc-day-1",
                snippet: "Severe storms are possible across parts of Oklahoma.",
                metadata: {
                  eventType: "SPC Convective Outlook Day 1",
                  sourceProduct: "convective-outlook",
                  sent: "2026-04-22T12:00:00.000Z",
                },
              },
            ],
            corpus: "alerts",
            topK: 5,
            model: "qwen2.5:14b",
            collection: "nws_alerts_embeddings_spc_v1",
            collections: ["nws_alerts_embeddings_spc_v1"],
          }),
      } as any;

      const generationClient = {
        generate: vi.fn(async () => "A grounded SPC outlook summary."),
      } as any;

      const service = new NwsAnswerService(
        searchService,
        generationClient,
        new NwsConstraintExtractionService({ generate: vi.fn() } as any),
      );

      const result = await service.answer({
        question:
          "tell me what the severe weather outlook looks like for oklahoma in the next 5 days",
        constraintSystem: {
          enabled: true,
          method: "heuristic-v1",
        },
      });

      expect(searchService.search).toHaveBeenCalledTimes(3);
      expect(searchService.search.mock.calls[2][0].filter).toEqual({
        source: "spc",
        includeEventTypes: [
          "SPC Convective Outlook Day 1",
          "SPC Convective Outlook Day 2",
          "SPC Convective Outlook Day 3",
          "SPC Convective Outlook Day 4",
          "SPC Convective Outlook Day 5",
        ],
      });
      expect(result.citations).toHaveLength(1);
      expect(result.answer).toBe("A grounded SPC outlook summary.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers fallback SPC citations closest to the extracted time window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T15:30:00.000Z"));

    try {
      const searchService = {
        search: vi
          .fn()
          .mockResolvedValueOnce({
            hits: [],
            corpus: "alerts",
            topK: 5,
            model: "qwen2.5:14b",
            collection: "nws_alerts_embeddings_spc_v1",
            collections: ["nws_alerts_embeddings_spc_v1"],
          })
          .mockResolvedValueOnce({
            hits: [],
            corpus: "alerts",
            topK: 5,
            model: "qwen2.5:14b",
            collection: "nws_alerts_embeddings_spc_v1",
            collections: ["nws_alerts_embeddings_spc_v1"],
          })
          .mockResolvedValueOnce({
            hits: [
              {
                id: "older-day-1",
                score: 0.95,
                source: "spc",
                citationLabel: "urn:oid:older-day-1",
                snippet: "Older archived day 1 outlook for Oklahoma.",
                metadata: {
                  eventType: "SPC Convective Outlook Day 1",
                  sourceProduct: "convective-outlook",
                  sent: "2025-04-28T07:37:28.000Z",
                },
              },
              {
                id: "current-day-1",
                score: 0.8,
                source: "spc",
                citationLabel: "urn:oid:current-day-1",
                snippet: "Current day 1 outlook for Oklahoma.",
                metadata: {
                  eventType: "SPC Convective Outlook Day 1",
                  sourceProduct: "convective-outlook",
                  sent: "2026-04-23T01:00:58.000Z",
                },
              },
              {
                id: "current-day-2",
                score: 0.79,
                source: "spc",
                citationLabel: "urn:oid:current-day-2",
                snippet: "Current day 2 outlook for Oklahoma.",
                metadata: {
                  eventType: "SPC Convective Outlook Day 2",
                  sourceProduct: "convective-outlook",
                  sent: "2026-04-24T06:00:00.000Z",
                },
              },
            ],
            corpus: "alerts",
            topK: 5,
            model: "qwen2.5:14b",
            collection: "nws_alerts_embeddings_spc_v1",
            collections: ["nws_alerts_embeddings_spc_v1"],
          }),
      } as any;

      const generationClient = {
        generate: vi.fn(async () => "A grounded SPC outlook summary."),
      } as any;

      const service = new NwsAnswerService(
        searchService,
        generationClient,
        new NwsConstraintExtractionService({ generate: vi.fn() } as any),
      );

      const result = await service.answer({
        question:
          "tell me what the severe weather outlook looks like for oklahoma in the next 5 days",
        constraintSystem: {
          enabled: true,
          method: "heuristic-v1",
        },
      });

      expect(
        result.citations.map((citation) => citation.citationLabel),
      ).toEqual(["urn:oid:current-day-1", "urn:oid:current-day-2"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers current SPC citations even when the initial constrained search already returns hits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T15:30:00.000Z"));

    try {
      const searchService = {
        search: vi.fn(async () => ({
          hits: [
            {
              id: "older-day-1",
              score: 0.95,
              source: "spc",
              citationLabel: "urn:oid:older-day-1",
              snippet: "Older archived day 1 outlook for Oklahoma.",
              metadata: {
                eventType: "SPC Convective Outlook Day 1",
                sourceProduct: "convective-outlook",
                sent: "2025-04-28T07:37:28.000Z",
              },
            },
            {
              id: "current-day-1",
              score: 0.8,
              source: "spc",
              citationLabel: "urn:oid:current-day-1",
              snippet: "Current day 1 outlook for Oklahoma.",
              metadata: {
                eventType: "SPC Convective Outlook Day 1",
                sourceProduct: "convective-outlook",
                sent: "2026-04-23T01:00:58.000Z",
              },
            },
            {
              id: "current-day-2",
              score: 0.79,
              source: "spc",
              citationLabel: "urn:oid:current-day-2",
              snippet: "Current day 2 outlook for Oklahoma.",
              metadata: {
                eventType: "SPC Convective Outlook Day 2",
                sourceProduct: "convective-outlook",
                sent: "2026-04-24T06:00:00.000Z",
              },
            },
          ],
          corpus: "alerts",
          topK: 5,
          model: "qwen2.5:14b",
          collection: "nws_alerts_embeddings_spc_v1",
          collections: ["nws_alerts_embeddings_spc_v1"],
        })),
      } as any;

      const generationClient = {
        generate: vi.fn(async () => "A grounded SPC outlook summary."),
      } as any;

      const service = new NwsAnswerService(
        searchService,
        generationClient,
        new NwsConstraintExtractionService({ generate: vi.fn() } as any),
      );

      const result = await service.answer({
        question:
          "tell me what the severe weather outlook looks like for oklahoma in the next 5 days",
        constraintSystem: {
          enabled: true,
          method: "heuristic-v1",
        },
      });

      expect(searchService.search).toHaveBeenCalledTimes(1);
      expect(
        result.citations.map((citation) => citation.citationLabel),
      ).toEqual(["urn:oid:current-day-1", "urn:oid:current-day-2"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries without extracted temporal bounds when initial constrained search is empty", async () => {
    const searchService = {
      search: vi
        .fn()
        .mockResolvedValueOnce({
          hits: [],
          model: "qwen2.5:14b",
          collection: "nws",
        })
        .mockResolvedValueOnce({
          hits: [
            {
              id: "p-temporal",
              score: 0.51,
              source: "nws-active",
              citationLabel: "urn:oid:temporal-retry",
              snippet: "Tornado warning bulletin",
              metadata: { eventType: "Tornado Warning" },
            },
          ],
          model: "qwen2.5:14b",
          collection: "nws",
        }),
    } as any;

    const generationClient = {
      generate: vi.fn(async () => "Found tornado warning context."),
    } as any;

    const constraintExtractionService = {
      extract: vi.fn(async () => ({
        extractedFilter: {
          includeEventTypes: ["Tornado Warning"],
          effectiveFrom: "2026-02-15T00:00:00.000Z",
          effectiveTo: "2026-02-16T00:00:00.000Z",
        },
        mergedFilter: {
          includeEventTypes: ["Tornado Warning"],
          effectiveFrom: "2026-02-15T00:00:00.000Z",
          effectiveTo: "2026-02-16T00:00:00.000Z",
        },
        metadata: {
          enabled: true,
          requestedSystem: "heuristic-v1",
          appliedSystem: "heuristic-v1",
          fallbackApplied: false,
          warnings: [],
          detectedEventTypes: ["Tornado Warning"],
          extractedFilter: {
            includeEventTypes: ["Tornado Warning"],
            effectiveFrom: "2026-02-15T00:00:00.000Z",
            effectiveTo: "2026-02-16T00:00:00.000Z",
          },
          mergedFilter: {
            includeEventTypes: ["Tornado Warning"],
            effectiveFrom: "2026-02-15T00:00:00.000Z",
            effectiveTo: "2026-02-16T00:00:00.000Z",
          },
        },
      })),
    } as any;

    const service = new NwsAnswerService(
      searchService,
      generationClient,
      constraintExtractionService,
    );

    const result = await service.answer({
      question: "Show me the most recent tornado warnings",
      constraintSystem: {
        enabled: true,
        method: "heuristic-v1",
      },
    });

    expect(searchService.search).toHaveBeenCalledTimes(2);
    expect(searchService.search.mock.calls[0][0].filter).toEqual({
      includeEventTypes: ["Tornado Warning"],
      effectiveFrom: "2026-02-15T00:00:00.000Z",
      effectiveTo: "2026-02-16T00:00:00.000Z",
    });
    expect(searchService.search.mock.calls[1][0].filter).toEqual({
      includeEventTypes: ["Tornado Warning"],
    });
    expect(result.citations).toHaveLength(1);
    expect(result.answer).toContain("tornado warning");
  });

  it("does not retry when temporal bounds are explicitly provided by user filter", async () => {
    const searchService = {
      search: vi.fn(async () => ({
        hits: [],
        model: "qwen2.5:14b",
        collection: "nws",
      })),
    } as any;

    const constraintExtractionService = {
      extract: vi.fn(async ({ userFilter }) => ({
        extractedFilter: {
          includeEventTypes: ["Tornado Warning"],
          effectiveFrom: "2026-02-15T00:00:00.000Z",
          effectiveTo: "2026-02-16T00:00:00.000Z",
        },
        mergedFilter: userFilter,
        metadata: {
          enabled: true,
          requestedSystem: "heuristic-v1",
          appliedSystem: "heuristic-v1",
          fallbackApplied: false,
          warnings: [],
          detectedEventTypes: ["Tornado Warning"],
          extractedFilter: {
            includeEventTypes: ["Tornado Warning"],
            effectiveFrom: "2026-02-15T00:00:00.000Z",
            effectiveTo: "2026-02-16T00:00:00.000Z",
          },
          mergedFilter: userFilter,
        },
      })),
    } as any;

    const service = new NwsAnswerService(
      searchService,
      { generate: vi.fn() } as any,
      constraintExtractionService,
    );

    await service.answer({
      question: "Show me the most recent tornado warnings",
      filter: {
        effectiveFrom: "2026-02-15T00:00:00.000Z",
        effectiveTo: "2026-02-16T00:00:00.000Z",
      },
      constraintSystem: {
        enabled: true,
        method: "heuristic-v1",
      },
    });

    expect(searchService.search).toHaveBeenCalledTimes(1);
  });

  it("does not retry without temporal bounds for heuristic-v2", async () => {
    const searchService = {
      search: vi.fn(async () => ({
        hits: [],
        model: "qwen2.5:14b",
        collection: "nws",
      })),
    } as any;

    const constraintExtractionService = {
      extract: vi.fn(async () => ({
        extractedFilter: {
          includeEventTypes: ["SPC Convective Outlook Day 1"],
          effectiveFrom: "2026-02-16T00:00:00.000Z",
          effectiveTo: "2026-02-16T23:59:59.000Z",
        },
        mergedFilter: {
          includeEventTypes: ["SPC Convective Outlook Day 1"],
          effectiveFrom: "2026-02-16T00:00:00.000Z",
          effectiveTo: "2026-02-16T23:59:59.000Z",
        },
        metadata: {
          enabled: true,
          requestedSystem: "heuristic-v2",
          appliedSystem: "heuristic-v2",
          fallbackApplied: false,
          warnings: [],
          detectedEventTypes: ["SPC Convective Outlook Day 1"],
          extractedFilter: {
            includeEventTypes: ["SPC Convective Outlook Day 1"],
            effectiveFrom: "2026-02-16T00:00:00.000Z",
            effectiveTo: "2026-02-16T23:59:59.000Z",
          },
          mergedFilter: {
            includeEventTypes: ["SPC Convective Outlook Day 1"],
            effectiveFrom: "2026-02-16T00:00:00.000Z",
            effectiveTo: "2026-02-16T23:59:59.000Z",
          },
        },
      })),
    } as any;

    const service = new NwsAnswerService(
      searchService,
      { generate: vi.fn() } as any,
      constraintExtractionService,
    );

    const result = await service.answer({
      question:
        "What areas of the country may have severe weather today according to the SPC Convective Outlooks?",
      constraintSystem: {
        enabled: true,
        method: "heuristic-v2",
      },
    });

    expect(searchService.search).toHaveBeenCalledTimes(1);
    expect(result.answer).toContain("No relevant NWS context");
  });

  it("preserves afd corpus filters when retrying without extracted temporal bounds", async () => {
    const searchService = {
      search: vi
        .fn()
        .mockResolvedValueOnce({
          hits: [],
          model: "qwen2.5:14b",
          collection: "nws_afd_embeddings_v1",
          corpus: "afd",
        })
        .mockResolvedValueOnce({
          hits: [
            {
              id: "afd-aviation",
              score: 0.7,
              source: "nws-afd",
              citationLabel: "afd-aviation-1",
              snippet: "AVIATION...MVFR cigs improve tonight.",
              metadata: {
                afdSectionName: "AVIATION",
                afdIssuedAt: "2026-02-16T12:00:00.000Z",
              },
            },
          ],
          model: "qwen2.5:14b",
          collection: "nws_afd_embeddings_v1",
          corpus: "afd",
        }),
    } as any;

    const generationClient = {
      generate: vi.fn(
        async () => "The aviation section mentions improving ceilings.",
      ),
    } as any;

    const constraintExtractionService = {
      extract: vi.fn(async () => ({
        extractedFilter: {
          effectiveFrom: "2026-02-16T00:00:00.000Z",
          effectiveTo: "2026-02-16T23:59:59.000Z",
        },
        mergedFilter: {
          afdIssuedFrom: "2026-02-16T00:00:00.000Z",
          afdIssuedTo: "2026-02-16T23:59:59.999Z",
          afdSections: ["AVIATION"],
          effectiveFrom: "2026-02-16T00:00:00.000Z",
          effectiveTo: "2026-02-16T23:59:59.000Z",
        },
        metadata: {
          enabled: true,
          requestedSystem: "heuristic-v1",
          appliedSystem: "heuristic-v1",
          fallbackApplied: false,
          warnings: [],
          detectedEventTypes: [],
          extractedFilter: {
            effectiveFrom: "2026-02-16T00:00:00.000Z",
            effectiveTo: "2026-02-16T23:59:59.000Z",
          },
          mergedFilter: {
            afdIssuedFrom: "2026-02-16T00:00:00.000Z",
            afdIssuedTo: "2026-02-16T23:59:59.999Z",
            afdSections: ["AVIATION"],
            effectiveFrom: "2026-02-16T00:00:00.000Z",
            effectiveTo: "2026-02-16T23:59:59.000Z",
          },
        },
      })),
    } as any;

    const service = new NwsAnswerService(
      searchService,
      generationClient,
      constraintExtractionService,
    );

    const result = await service.answer({
      question: "What does the aviation discussion say today?",
      corpus: "afd",
      constraintSystem: {
        enabled: true,
        method: "heuristic-v1",
      },
      filter: {
        afdIssuedFrom: "2026-02-16T00:00:00.000Z",
        afdIssuedTo: "2026-02-16T23:59:59.999Z",
        afdSections: ["AVIATION"],
      },
    });

    expect(searchService.search).toHaveBeenCalledTimes(2);
    expect(searchService.search.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        corpus: "afd",
        filter: {
          afdIssuedFrom: "2026-02-16T00:00:00.000Z",
          afdIssuedTo: "2026-02-16T23:59:59.999Z",
          afdSections: ["AVIATION"],
          effectiveFrom: "2026-02-16T00:00:00.000Z",
          effectiveTo: "2026-02-16T23:59:59.000Z",
        },
      }),
    );
    expect(searchService.search.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        corpus: "afd",
        filter: {
          afdIssuedFrom: "2026-02-16T00:00:00.000Z",
          afdIssuedTo: "2026-02-16T23:59:59.999Z",
          afdSections: ["AVIATION"],
        },
      }),
    );
    expect(result.citations).toHaveLength(1);
    expect(result.answer).toContain("aviation section");
  });

  it("retries streaming generation with reduced max tokens after upstream termination", async () => {
    const searchService = {
      search: vi.fn(async () => ({
        hits: [
          {
            id: "p1",
            score: 0.8,
            source: "nws-active",
            citationLabel: "urn:oid:2.49.0.1.840.0.example",
            snippet: "Tornado warning in county",
            metadata: { eventType: "Tornado Warning" },
          },
        ],
        model: "qwen2.5:14b",
        collection: "nws",
      })),
    } as any;

    const generationClient = {
      generate: vi.fn(),
      generateStream: vi
        .fn()
        .mockRejectedValueOnce(
          new ServiceUnavailableException(
            "Ollama generation terminated before completion (terminated).",
          ),
        )
        .mockImplementationOnce(async ({ onToken }) => {
          onToken("Recovered answer.");
        }),
    } as any;

    const service = new NwsAnswerService(
      searchService,
      generationClient,
      createExtractionService(),
    );

    const stageEvents: Array<{ stage: string; message?: string }> = [];
    const tokenEvents: string[] = [];
    let completedAnswer = "";

    await service.streamAnswer(
      {
        question: "What is active?",
        maxTokens: 800,
      },
      {
        onStage: (event) => {
          stageEvents.push({ stage: event.stage, message: event.message });
        },
        onToken: (event) => {
          tokenEvents.push(event.token);
        },
        onComplete: (event) => {
          completedAnswer = event.response.answer;
        },
      },
    );

    expect(generationClient.generateStream).toHaveBeenCalledTimes(2);
    expect(generationClient.generateStream.mock.calls[0][0]).toEqual(
      expect.objectContaining({ maxTokens: 800 }),
    );
    expect(generationClient.generateStream.mock.calls[1][0]).toEqual(
      expect.objectContaining({ maxTokens: 400 }),
    );
    expect(tokenEvents).toEqual(["Recovered answer."]);
    expect(completedAnswer).toBe("Recovered answer.");
    expect(stageEvents).toContainEqual(
      expect.objectContaining({
        stage: "generation_started",
        message: "Retrying answer generation with reduced maxTokens (400).",
      }),
    );
  });

  it("retries streaming generation when upstream returns a bare terminated error", async () => {
    const searchService = {
      search: vi.fn(async () => ({
        hits: [
          {
            id: "p1",
            score: 0.8,
            source: "nws-active",
            citationLabel: "urn:oid:2.49.0.1.840.0.example",
            snippet: "Tornado warning in county",
            metadata: { eventType: "Tornado Warning" },
          },
        ],
        model: "qwen2.5:14b",
        collection: "nws",
      })),
    } as any;

    const generationClient = {
      generate: vi.fn(),
      generateStream: vi
        .fn()
        .mockRejectedValueOnce(new Error("terminated"))
        .mockImplementationOnce(async ({ onToken }) => {
          onToken("Recovered after bare terminated error.");
        }),
    } as any;

    const service = new NwsAnswerService(
      searchService,
      generationClient,
      createExtractionService(),
    );

    const tokenEvents: string[] = [];
    let completedAnswer = "";

    await service.streamAnswer(
      {
        question: "What is active?",
        maxTokens: 800,
      },
      {
        onStage: () => undefined,
        onToken: (event) => {
          tokenEvents.push(event.token);
        },
        onComplete: (event) => {
          completedAnswer = event.response.answer;
        },
      },
    );

    expect(generationClient.generateStream).toHaveBeenCalledTimes(2);
    expect(tokenEvents).toEqual(["Recovered after bare terminated error."]);
    expect(completedAnswer).toBe("Recovered after bare terminated error.");
  });

  it("retries sync generation when the first completed answer is repetitive garbage", async () => {
    const searchService = {
      search: vi.fn(async () => ({
        hits: [
          {
            id: "p1",
            score: 0.8,
            source: "spc",
            citationLabel: "urn:oid:spc-day1",
            snippet: "SPC Day 1 convective outlook for Oklahoma.",
            metadata: { eventType: "SPC Convective Outlook Day 1" },
          },
        ],
        model: "qwen2.5:14b",
        collection: "spc",
      })),
    } as any;

    const generationClient = {
      generate: vi
        .fn()
        .mockResolvedValueOnce(
          "which way which way which way which way which way which way which way which way which way which way which way which way",
        )
        .mockResolvedValueOnce("A grounded SPC outlook summary."),
    } as any;

    const service = new NwsAnswerService(
      searchService,
      generationClient,
      createExtractionService(),
    );

    const result = await service.answer({
      question: "What is the severe weather outlook?",
      maxTokens: 800,
    });

    expect(generationClient.generate).toHaveBeenCalledTimes(2);
    expect(generationClient.generate.mock.calls[0][0]).toEqual(
      expect.objectContaining({ maxTokens: 800 }),
    );
    expect(generationClient.generate.mock.calls[1][0]).toEqual(
      expect.objectContaining({ maxTokens: 400 }),
    );
    expect(result.answer).toBe("A grounded SPC outlook summary.");
  });

  it("retries streaming generation when the first completed answer is repetitive garbage", async () => {
    const searchService = {
      search: vi.fn(async () => ({
        hits: [
          {
            id: "p1",
            score: 0.8,
            source: "spc",
            citationLabel: "urn:oid:spc-day1",
            snippet: "SPC Day 1 convective outlook for Oklahoma.",
            metadata: { eventType: "SPC Convective Outlook Day 1" },
          },
        ],
        model: "qwen2.5:14b",
        collection: "spc",
      })),
    } as any;

    const generationClient = {
      generate: vi.fn(),
      generateStream: vi
        .fn()
        .mockImplementationOnce(async ({ onToken }) => {
          onToken("which way ");
          onToken("which way ");
          onToken("which way ");
          onToken("which way ");
          onToken("which way ");
          onToken("which way ");
        })
        .mockImplementationOnce(async ({ onToken }) => {
          onToken("Recovered outlook summary.");
        }),
    } as any;

    const service = new NwsAnswerService(
      searchService,
      generationClient,
      createExtractionService(),
    );

    const tokenEvents: string[] = [];
    let completedAnswer = "";
    const stageEvents: Array<{ stage: string; message?: string }> = [];

    await service.streamAnswer(
      {
        question: "What is the severe weather outlook?",
        maxTokens: 800,
      },
      {
        onStage: (event) => {
          stageEvents.push({ stage: event.stage, message: event.message });
        },
        onToken: (event) => {
          tokenEvents.push(event.token);
        },
        onComplete: (event) => {
          completedAnswer = event.response.answer;
        },
      },
    );

    expect(generationClient.generateStream).toHaveBeenCalledTimes(2);
    expect(generationClient.generateStream.mock.calls[0][0]).toEqual(
      expect.objectContaining({ maxTokens: 800 }),
    );
    expect(generationClient.generateStream.mock.calls[1][0]).toEqual(
      expect.objectContaining({ maxTokens: 400 }),
    );
    expect(tokenEvents).toEqual(["Recovered outlook summary."]);
    expect(completedAnswer).toBe("Recovered outlook summary.");
    expect(stageEvents).toContainEqual(
      expect.objectContaining({
        stage: "generation_started",
        message: "Retrying answer generation with reduced maxTokens (400).",
      }),
    );
  });
});
