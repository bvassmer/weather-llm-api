import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NwsConstraintExtractionService } from "../../../src/api/nws-answer/nws-constraint-extraction.service.js";

describe("NwsConstraintExtractionService", () => {
  beforeEach(() => {
    process.env.OLLAMA_CHAT_MODEL = "qwen3:1.7b";
  });

  afterEach(() => {
    delete process.env.OLLAMA_CHAT_MODEL;
  });

  it("uses deterministic time window fallback for 'today' when heuristic-v2 refinement omits time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-16T15:30:00.000Z"));

    try {
      const generationClient = {
        generate: vi
          .fn()
          .mockResolvedValueOnce(
            '{"includeEventTypes":["spc convective outlook day 1"]}',
          )
          .mockResolvedValueOnce(
            '{"excludeEventTypes":[],"effectiveFrom":null,"effectiveTo":null}',
          ),
      } as any;

      const service = new NwsConstraintExtractionService(generationClient);

      const result = await service.extract({
        question:
          "What areas of the country may have severe weather today according to the SPC Convective Outlooks?",
        requestedSystem: "heuristic-v2",
        enabled: true,
      });

      expect(result.metadata.appliedSystem).toBe("heuristic-v2");
      expect(result.metadata.fallbackApplied).toBe(false);
      expect(result.extractedFilter?.effectiveFrom).toBe(
        "2026-02-16T00:00:00.000Z",
      );
      expect(result.extractedFilter?.effectiveTo).toBe(
        "2026-02-16T15:30:00.000Z",
      );
      expect(result.extractedFilter?.includeEventTypes).toEqual([
        "SPC Convective Outlook Day 1",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies heuristic-v2 two-stage extraction", async () => {
    const generationClient = {
      generate: vi
        .fn()
        .mockResolvedValueOnce(
          '{"includeEventTypes":["tornado warnings","flood warning"]}',
        )
        .mockResolvedValueOnce(
          '{"excludeEventTypes":["severe thunderstorm warning"],"effectiveFrom":"2026-02-15T00:00:00Z","effectiveTo":"2026-02-16T00:00:00Z"}',
        ),
    } as any;

    const service = new NwsConstraintExtractionService(generationClient);

    const result = await service.extract({
      question: "Only tornado and flood warnings in the last day",
      requestedSystem: "heuristic-v2",
      enabled: true,
    });

    expect(result.metadata.appliedSystem).toBe("heuristic-v2");
    expect(result.metadata.fallbackApplied).toBe(false);
    expect(result.extractedFilter).toEqual({
      includeEventTypes: ["Tornado Warning", "Flood Warning"],
      excludeEventTypes: ["Severe Thunderstorm Warning"],
      effectiveFrom: "2026-02-15T00:00:00.000Z",
      effectiveTo: "2026-02-16T00:00:00.000Z",
    });
    expect(result.metadata.detectedEventTypes).toEqual([
      "Tornado Warning",
      "Flood Warning",
    ]);
    expect(generationClient.generate).toHaveBeenCalledTimes(2);
    expect(generationClient.generate.mock.calls[1][0].prompt).toContain(
      '"Tornado Warning"',
    );
  });

  it("falls back to heuristic-v1 when heuristic-v2 stage 1 fails", async () => {
    const generationClient = {
      generate: vi.fn().mockResolvedValueOnce("not-json"),
    } as any;

    const service = new NwsConstraintExtractionService(generationClient);

    const result = await service.extract({
      question: "Show tornado warnings",
      requestedSystem: "heuristic-v2",
      enabled: true,
    });

    expect(result.metadata.appliedSystem).toBe("heuristic-v1");
    expect(result.metadata.fallbackApplied).toBe(true);
    expect(result.metadata.warnings[0]).toContain(
      "heuristic-v2 extraction fallback to heuristic-v1",
    );
    expect(result.extractedFilter?.includeEventTypes).toEqual([
      "Tornado Warning",
    ]);
    expect(generationClient.generate).toHaveBeenCalledTimes(1);
  });

  it("falls back to heuristic-v1 when heuristic-v2 stage 2 fails", async () => {
    const generationClient = {
      generate: vi
        .fn()
        .mockResolvedValueOnce('{"includeEventTypes":["tornado warning"]}')
        .mockResolvedValueOnce("not-json"),
    } as any;

    const service = new NwsConstraintExtractionService(generationClient);

    const result = await service.extract({
      question: "Only tornado warnings",
      requestedSystem: "heuristic-v2",
      enabled: true,
    });

    expect(result.metadata.appliedSystem).toBe("heuristic-v1");
    expect(result.metadata.fallbackApplied).toBe(true);
    expect(result.metadata.warnings[0]).toContain(
      "heuristic-v2 extraction fallback to heuristic-v1",
    );
    expect(result.extractedFilter?.includeEventTypes).toEqual([
      "Tornado Warning",
    ]);
    expect(generationClient.generate).toHaveBeenCalledTimes(2);
  });

  it("preserves afd user filters when sanitizing bypass extraction", async () => {
    const service = new NwsConstraintExtractionService({
      generate: vi.fn(),
    } as any);

    const result = await service.extract({
      question: "Show me the aviation discussion",
      requestedSystem: "bypass",
      enabled: true,
      userFilter: {
        afdIssuedFrom: "2026-02-16T00:00:00Z",
        afdIssuedTo: "2026-02-16T23:59:59Z",
        afdSections: [" AVIATION ", "LONG TERM"],
      },
    });

    expect(result.mergedFilter).toEqual({
      afdIssuedFrom: "2026-02-16T00:00:00.000Z",
      afdIssuedTo: "2026-02-16T23:59:59.000Z",
      afdSections: ["AVIATION", "LONG TERM"],
    });
  });

  it("maps AQI questions to threshold and forecast alert event types", async () => {
    const service = new NwsConstraintExtractionService({
      generate: vi.fn(),
    } as any);

    const result = await service.extract({
      question:
        "Show me AQI alerts and air quality forecast issues for tomorrow",
      requestedSystem: "heuristic-v1",
      enabled: true,
    });

    expect(result.metadata.appliedSystem).toBe("heuristic-v1");
    expect(result.extractedFilter?.includeEventTypes).toEqual([
      "AirNow AQI Forecast Alert",
      "AirNow AQI Threshold Alert",
    ]);
  });

  it("applies a recency window for heuristic-v1 current-alert questions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-16T15:30:00.000Z"));

    try {
      const service = new NwsConstraintExtractionService({
        generate: vi.fn(),
      } as any);

      const result = await service.extract({
        question: "What current alerts are active right now in Oklahoma?",
        requestedSystem: "heuristic-v1",
        enabled: true,
      });

      expect(result.metadata.appliedSystem).toBe("heuristic-v1");
      expect(result.extractedFilter?.effectiveFrom).toBe(
        "2026-02-13T15:30:00.000Z",
      );
      expect(result.extractedFilter?.effectiveTo).toBe(
        "2026-02-16T15:30:00.000Z",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes severe weather outlook questions to SPC convective outlooks over a forward window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T15:30:00.000Z"));

    try {
      const service = new NwsConstraintExtractionService({
        generate: vi.fn(),
      } as any);

      const result = await service.extract({
        question:
          "tell me what the severe weather outlook looks like for oklahoma in the next 5 days",
        requestedSystem: "heuristic-v1",
        enabled: true,
      });

      expect(result.metadata.appliedSystem).toBe("heuristic-v1");
      expect(result.extractedFilter?.source).toBe("spc");
      expect(result.extractedFilter?.stateCodes).toEqual(["OK"]);
      expect(result.extractedFilter?.effectiveFrom).toBe(
        "2026-04-22T15:30:00.000Z",
      );
      expect(result.extractedFilter?.effectiveTo).toBe(
        "2026-04-27T15:30:00.000Z",
      );
      expect(result.extractedFilter?.includeEventTypes).toEqual([
        "SPC Convective Outlook Day 1",
        "SPC Convective Outlook Day 2",
        "SPC Convective Outlook Day 3",
        "SPC Convective Outlook Day 4",
        "SPC Convective Outlook Day 5",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
