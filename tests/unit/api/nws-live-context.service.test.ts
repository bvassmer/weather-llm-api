import { NwsLiveContextService } from "../../../src/api/nws-answer/nws-live-context.service.js";

describe("NwsLiveContextService guidance ranking", () => {
  const createEnv = () =>
    ({
      localGuidanceLookbackHours: 36,
      maxGuidanceRows: 4,
    }) as any;

  const createGuidanceRow = (overrides: Record<string, unknown> = {}) => ({
    id: 1,
    nwsId: "test-guidance-1",
    sourceFamily: "spc",
    sourceProduct: "convective-outlook",
    event: "SPC Convective Outlook Day 1",
    headline: "SPC Convective Outlook Day 1",
    shortDescription: "Severe thunderstorms possible.",
    description: "Severe thunderstorms possible.",
    sent: new Date("2026-04-22T18:00:00Z"),
    effective: new Date("2026-04-22T18:00:00Z"),
    expires: null,
    ends: null,
    ...overrides,
  });

  it("builds an SPC-heavy profile for severe weather outlook queries", () => {
    const service = new NwsLiveContextService();

    const profile = (service as any).buildGuidanceQueryProfile(
      createEnv(),
      "What is the tornado outlook today?",
      undefined,
    );

    expect(profile.sourceFamilies).toEqual(["spc"]);
    expect(profile.sourceProducts).toEqual(
      expect.arrayContaining(["convective-outlook", "mesoscale-discussion"]),
    );
    expect(profile.lookbackHours).toBe(18);
    expect(profile.candidateLimit).toBe(12);
  });

  it("builds an SPC fire-weather profile for fire weather queries", () => {
    const service = new NwsLiveContextService();

    const profile = (service as any).buildGuidanceQueryProfile(
      createEnv(),
      "Is there a critical fire weather outlook tomorrow?",
      undefined,
    );

    expect(profile.sourceFamilies).toEqual(["spc"]);
    expect(profile.sourceProducts).toEqual(
      expect.arrayContaining(["fire-weather-outlook"]),
    );
    expect(profile.sourceProducts).not.toContain("excessive-rainfall");
  });

  it("builds a WPC snow-focused profile for winter forecast queries", () => {
    const service = new NwsLiveContextService();

    const profile = (service as any).buildGuidanceQueryProfile(
      createEnv(),
      "What is the winter snow forecast and PWPF outlook?",
      undefined,
    );

    expect(profile.sourceFamilies).toEqual(["wpc"]);
    expect(profile.sourceProducts).toEqual(
      expect.arrayContaining(["snow-forecast"]),
    );
    expect(profile.sourceProducts).not.toContain("convective-outlook");
  });

  it("ranks SPC convective guidance ahead of WPC guidance for tornado queries", () => {
    const service = new NwsLiveContextService();
    const profile = (service as any).buildGuidanceQueryProfile(
      createEnv(),
      "What is the tornado outlook today?",
      undefined,
    );

    const ranked = (service as any).rankGuidanceRows(
      [
        createGuidanceRow({
          id: 1,
          sourceFamily: "wpc",
          sourceProduct: "snow-forecast",
          event: "WPC Snow Forecast",
          headline: "WPC Snow Forecast",
          shortDescription: "Heavy snow possible.",
        }),
        createGuidanceRow({
          id: 2,
          sourceFamily: "spc",
          sourceProduct: "convective-outlook",
          event: "SPC Convective Outlook Day 1",
          headline: "SPC Convective Outlook Day 1",
          shortDescription: "Tornado risk increasing this afternoon.",
        }),
      ],
      profile,
    );

    expect(ranked[0].row.sourceFamily).toBe("spc");
    expect(ranked[0].row.sourceProduct).toBe("convective-outlook");
    expect(ranked[0].relevanceScore).toBeGreaterThan(ranked[1].relevanceScore);
  });

  it("prefers the requested day number when ranking convective outlook rows", () => {
    const service = new NwsLiveContextService();
    const profile = (service as any).buildGuidanceQueryProfile(
      createEnv(),
      "What is the Day 1 severe weather outlook?",
      undefined,
    );

    const ranked = (service as any).rankGuidanceRows(
      [
        createGuidanceRow({
          id: 1,
          event: "SPC Convective Outlook Day 3",
          headline: "SPC Convective Outlook Day 3",
          sent: new Date("2026-04-22T19:00:00Z"),
          effective: new Date("2026-04-22T19:00:00Z"),
        }),
        createGuidanceRow({
          id: 2,
          event: "SPC Convective Outlook Day 1",
          headline: "SPC Convective Outlook Day 1",
          sent: new Date("2026-04-22T18:00:00Z"),
          effective: new Date("2026-04-22T18:00:00Z"),
        }),
      ],
      profile,
    );

    expect(ranked[0].row.event).toBe("SPC Convective Outlook Day 1");
  });

  it("ranks WPC excessive rainfall guidance ahead of SPC guidance for flood queries", () => {
    const service = new NwsLiveContextService();
    const profile = (service as any).buildGuidanceQueryProfile(
      createEnv(),
      "What is the excessive rainfall and flood outlook?",
      undefined,
    );

    const ranked = (service as any).rankGuidanceRows(
      [
        createGuidanceRow({
          id: 1,
          sourceFamily: "spc",
          sourceProduct: "convective-outlook",
          event: "SPC Convective Outlook Day 1",
          headline: "SPC Convective Outlook Day 1",
          shortDescription: "Thunderstorms possible.",
        }),
        createGuidanceRow({
          id: 2,
          sourceFamily: "wpc",
          sourceProduct: "excessive-rainfall",
          event: "WPC Excessive Rainfall",
          headline: "WPC Excessive Rainfall",
          shortDescription: "Flooding risk from excessive rainfall.",
        }),
      ],
      profile,
    );

    expect(ranked[0].row.sourceFamily).toBe("wpc");
    expect(ranked[0].row.sourceProduct).toBe("excessive-rainfall");
  });
});
