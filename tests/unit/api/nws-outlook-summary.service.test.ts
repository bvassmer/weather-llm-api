import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { NwsOutlookSummaryService } from "../../../src/api/nws-outlook-summary/nws-outlook-summary.service.js";

describe("NwsOutlookSummaryService", () => {
  beforeEach(() => {
    delete process.env.NWS_OUTLOOK_SUMMARY_PROMPT_LAYOUT;
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
