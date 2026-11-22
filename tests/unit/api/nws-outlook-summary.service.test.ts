import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { NwsOutlookSummaryService } from "../../../src/api/nws-outlook-summary/nws-outlook-summary.service.js";
import type { OutlookSummaryRequest } from "../../../src/api/nws-outlook-summary/types.js";

const compactRequest: OutlookSummaryRequest = {
  mode: "compact",
  sourceFamily: "spc",
  sourceProduct: "convective-outlook",
  discussion: "Severe weather is expected in Florida.",
  facts: {
    version: 1,
    coverage: { status: "inside", location: "northeast Oklahoma" },
    validity: { start: "2026-11-20T12:00:00Z", end: "2026-11-21T12:00:00Z" },
    risks: ["General thunderstorms"],
    values: ["No local tornado probability delineated"],
    evidence: [{
      heading: "Northeast Oklahoma",
      text: "Thunderstorms may develop. Development could start at 5 p.m. CST. Coverage should remain isolated.",
    }],
  },
};

describe("NwsOutlookSummaryService", () => {
  beforeEach(() => {
    delete process.env.NWS_OUTLOOK_SUMMARY_PROMPT_LAYOUT;
    delete process.env.NWS_OUTLOOK_SUMMARY_MODE;
    delete process.env.NWS_OUTLOOK_SUMMARY_MODEL;
    Object.assign(process.env, {
      OLLAMA_BASE_URL: "http://ollama.local",
      OLLAMA_CHAT_MODEL: "qwen2.5:1.5b",
      NWS_OUTLOOK_SUMMARY_ENABLED: "true",
      NWS_OUTLOOK_SUMMARY_TIMEOUT_MS: "24000",
      NWS_OUTLOOK_SUMMARY_TEMPERATURE: "0.05",
      NWS_OUTLOOK_SUMMARY_MAX_TOKENS: "260",
    });
  });

  it("builds a sectioned Oklahoma-focused prompt and calls generation conservatively", async () => {
    const generationClient = {
      generate: vi.fn(
        async () =>
          "Severe thunderstorms may affect parts of Oklahoma Friday afternoon into Friday night.",
      ),
    } as any;

    const service = new NwsOutlookSummaryService(generationClient);
    const result = await service.summarize({
      sourceFamily: "spc",
      sourceProduct: "convective-outlook",
      event: "SPC Convective Outlook Day 2",
      headline: "SPC Conv Day 2 - ENH",
      discussion:
        "Thunderstorms are expected from north Texas into eastern Oklahoma Friday evening.",
      oklahomaFacts: ["Forecast day: 2", "Local relevance: true"],
      timingFacts: ["Valid Friday afternoon through Friday night"],
      riskFacts: ["Top local risk: ENH with 15% hail"],
      locationFacts: ["Configured point is in northeast Oklahoma"],
      summarySection:
        "Severe thunderstorms are possible across parts of Oklahoma Friday evening.",
      supportingDiscussion:
        "Storm mode may organize along the dryline before shifting east overnight.",
    });

    expect(result).toEqual({
      summary:
        "Severe thunderstorms may affect parts of Oklahoma Friday afternoon into Friday night.",
      model: "qwen2.5:1.5b",
    });
    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://ollama.local",
        model: "qwen2.5:1.5b",
        timeoutMs: 24000,
        temperature: 0.05,
        maxTokens: 260,
        prompt: expect.stringContaining(
          "Summarize this official NOAA outlook for Oklahoma in 3 to 5 plain sentences.",
        ),
      }),
    );
    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          "Oklahoma Facts:\nForecast day: 2 | Local relevance: true",
        ),
      }),
    );
    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          "Summary Section:\nSevere thunderstorms are possible across parts of Oklahoma Friday evening.",
        ),
      }),
    );
    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          "Supporting Discussion:\nStorm mode may organize along the dryline before shifting east overnight.",
        ),
      }),
    );
    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          "Lead with the highest Oklahoma severe-weather or fire-weather signal.",
        ),
      }),
    );
    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("\n\n"),
      }),
    );
  });

  it("can fall back to flat labeled prompts for ai-hub compatibility", async () => {
    process.env.NWS_OUTLOOK_SUMMARY_PROMPT_LAYOUT = "flat-labeled";

    const generationClient = {
      generate: vi.fn(async () => "Oklahoma may see heavy rain overnight."),
    } as any;

    const service = new NwsOutlookSummaryService(generationClient);
    await service.summarize({
      sourceFamily: "wpc",
      sourceProduct: "excessive-rainfall",
      discussion: "Heavy rain may affect central Oklahoma overnight.",
      summarySection: "Heavy rainfall may affect parts of Oklahoma.",
    });

    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.not.stringContaining("\n"),
      }),
    );
    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          "Summary Section: Heavy rainfall may affect parts of Oklahoma.",
        ),
      }),
    );
  });

  it("uses the higher default max token budget when env is unset", async () => {
    delete process.env.NWS_OUTLOOK_SUMMARY_MAX_TOKENS;

    const generationClient = {
      generate: vi.fn(async () => "Oklahoma may see strong winds late Friday."),
    } as any;

    const service = new NwsOutlookSummaryService(generationClient);
    await service.summarize({
      sourceFamily: "spc",
      sourceProduct: "convective-outlook",
      discussion: "Strong storms may reach eastern Oklahoma late Friday.",
    });

    expect(generationClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTokens: 280,
      }),
    );
  });

  it("uses the compact candidate only for an opted-in preview in legacy mode", async () => {
    process.env.NWS_OUTLOOK_SUMMARY_MODEL = " qwen3:4b ";
    process.env.NWS_OUTLOOK_SUMMARY_TIMEOUT_MS = "90000";
    const generationClient = { generate: vi.fn(async () => "2, 3") } as any;
    const service = new NwsOutlookSummaryService(generationClient);

    const result = await service.summarize(compactRequest);

    expect(result.model).toBe("qwen3:4b");
    expect(result.metadata).toMatchObject({
      mode: "compact",
      promptVersion: "compact-v1",
      outcome: "selected",
      inferenceAttempted: true,
      latencyMs: expect.any(Number),
    });
    expect(result.summary).toContain("Where: northeast Oklahoma (inside the mapped area).");
    expect(result.summary).toMatch(/When: .*Nov 20.*6:00 AM CST to .*Nov 21.*6:00 AM CST/);
    expect(result.summary).toContain("Risk: General thunderstorms.");
    expect(result.summary).toContain("Details: No local tornado probability delineated.");
    expect(result.summary).toContain(
      "Official discussion (Northeast Oklahoma): Development could start at 5 p.m. CST. Coverage should remain isolated.",
    );
    expect(generationClient.generate).toHaveBeenCalledTimes(1);
    expect(generationClient.generate).toHaveBeenCalledWith(expect.objectContaining({
      model: "qwen3:4b",
      timeoutMs: 60000,
      maxTokens: 80,
      rejectTruncated: true,
      prompt: expect.not.stringContaining("Florida"),
    }));

    await expect(service.summarize({ ...compactRequest, mode: undefined })).resolves.toEqual({
      summary: "2, 3",
      model: "qwen2.5:1.5b",
    });
  });

  it.each(["A tornado warning is in effect.", "1, 3", "9"])(
    "falls back to official text when the selector returns %s",
    async (answer) => {
      process.env.NWS_OUTLOOK_SUMMARY_MODE = "compact";
      const generationClient = { generate: vi.fn(async () => answer) } as any;
      const service = new NwsOutlookSummaryService(generationClient);

      const result = await service.summarize({ ...compactRequest, mode: undefined });
      expect(result.metadata).toMatchObject({
        outcome: "fallback",
        fallbackReason: "invalid-output",
        inferenceAttempted: true,
      });
      expect(result.summary).toContain("Thunderstorms may develop. Development could start at 5 p.m. CST.");
      expect(result.summary).not.toContain(answer);
      expect(generationClient.generate).toHaveBeenCalledTimes(1);
    },
  );

  it("uses verified facts without inference for an outside location or facts-only mode", async () => {
    const generationClient = { generate: vi.fn() } as any;
    const service = new NwsOutlookSummaryService(generationClient);
    const outside = await service.summarize({
      ...compactRequest,
      facts: {
        ...compactRequest.facts!,
        coverage: { status: "outside" },
        validity: { start: "2026-11-31T12:00:00Z" },
      },
    });
    expect(outside.summary).toContain("Where: Report location (outside the mapped area).");
    expect(outside.summary).toContain("When: Official validity unavailable.");
    expect(outside.summary).not.toContain("Official discussion");
    expect(outside.metadata).toMatchObject({ outcome: "deterministic", inferenceAttempted: false });

    process.env.NWS_OUTLOOK_SUMMARY_MODE = "facts-only";
    const factsOnly = await service.summarize(compactRequest);
    expect(factsOnly.summary).toContain("Official discussion (Northeast Oklahoma)");
    expect(factsOnly.metadata).toMatchObject({
      mode: "facts-only",
      outcome: "deterministic",
      inferenceAttempted: false,
    });
    expect(generationClient.generate).not.toHaveBeenCalled();
  });

  it.each([
    "However, confidence remains low.",
    "This threat depends on storms developing.",
  ])("keeps a qualifying sentence in the same passage: %s", async (qualifier) => {
    const service = new NwsOutlookSummaryService({ generate: vi.fn(async () => "1") } as any);
    const impact = "Severe thunderstorms may develop tonight.";
    const unrelated = "Temperatures could fall into the 40s.";
    const result = await service.summarize({
      ...compactRequest,
      facts: {
        ...compactRequest.facts!,
        evidence: [{ text: `${impact} ${qualifier} ${unrelated}` }],
      },
    });

    expect(result.summary).toContain(`${impact} ${qualifier}`);
    expect(result.summary).not.toContain(unrelated);
  });

  it("does not join a qualifier from a different source passage", async () => {
    const service = new NwsOutlookSummaryService({ generate: vi.fn(async () => "1") } as any);
    const result = await service.summarize({
      ...compactRequest,
      facts: {
        ...compactRequest.facts!,
        evidence: [
          { heading: "Western Oklahoma", text: "Thunderstorms may develop by sunset." },
          { heading: "Eastern Oklahoma", text: "However, confidence remains low." },
        ],
      },
    });

    expect(result.summary).toContain("Thunderstorms may develop by sunset.");
    expect(result.summary).not.toContain("confidence remains low");
  });

  it("records explicit abstention without sending a source excerpt", async () => {
    const generationClient = { generate: vi.fn(async () => "NONE") } as any;
    const service = new NwsOutlookSummaryService(generationClient);
    const result = await service.summarize(compactRequest);

    expect(result.metadata).toMatchObject({ outcome: "abstained", inferenceAttempted: true });
    expect(result.summary).not.toContain("Official discussion");
  });

  it("falls back on concurrent demand and inference errors without queuing retries", async () => {
    const first = Promise.withResolvers<string>();
    const generationClient = { generate: vi.fn(() => first.promise) } as any;
    const service = new NwsOutlookSummaryService(generationClient);

    const inFlight = service.summarize(compactRequest);
    const busy = await service.summarize(compactRequest);
    expect(busy.metadata).toMatchObject({
      outcome: "fallback",
      fallbackReason: "busy",
      inferenceAttempted: false,
    });
    first.reject(new Error("timeout"));
    await expect(inFlight).resolves.toMatchObject({
      metadata: { outcome: "fallback", fallbackReason: "inference-error", inferenceAttempted: true },
    });
    expect(generationClient.generate).toHaveBeenCalledTimes(1);
  });

  it("rejects empty discussion text", async () => {
    const service = new NwsOutlookSummaryService({
      generate: vi.fn(),
    } as any);

    await expect(
      service.summarize({
        sourceFamily: "wpc",
        sourceProduct: "excessive-rainfall",
        discussion: "   ",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("sanitizes markdowny output into plain text", () => {
    const service = new NwsOutlookSummaryService({
      generate: vi.fn(),
    } as any);

    expect(
      service.sanitizeSummary(
        "Summary: - Oklahoma may see heavy rain late Saturday. - Flooding is possible.",
      ),
    ).toBe("Oklahoma may see heavy rain late Saturday. Flooding is possible.");
  });

  it("raises service unavailable when summary generation is disabled", async () => {
    process.env.NWS_OUTLOOK_SUMMARY_ENABLED = "false";

    const service = new NwsOutlookSummaryService({
      generate: vi.fn(),
    } as any);

    await expect(
      service.summarize({
        sourceFamily: "spc",
        sourceProduct: "fire-weather-outlook",
        discussion: "Dry and windy conditions may affect Oklahoma.",
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
