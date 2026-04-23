import { BadRequestException } from "@nestjs/common";
import { NwsSearchService } from "../../../src/api/nws-search/nws-search.service.js";

describe("NwsSearchService", () => {
  beforeEach(() => {
    Object.assign(process.env, {
      NWS_EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
      OLLAMA_TIMEOUT_MS: "1000",
      QDRANT_URL: "http://qdrant.local",
      QDRANT_COLLECTION_NWS_ALERTS_NWS: "nws_alerts_embeddings_nws_v1",
      QDRANT_COLLECTION_NWS_ALERTS_SPC: "nws_alerts_embeddings_spc_v1",
      QDRANT_COLLECTION_NWS_ALERTS_WPC: "nws_alerts_embeddings_wpc_v1",
      QDRANT_COLLECTION_NWS_ALERTS_AIRNOW: "nws_alerts_embeddings_airnow_v1",
      QDRANT_COLLECTION_NWS_AFD: "nws_afd_embeddings_v1",
      QDRANT_TIMEOUT_MS: "1000",
      NWS_SEARCH_TOPK_DEFAULT: "5",
      NWS_SEARCH_TOPK_MAX: "10",
    });
  });

  it("returns mapped search hits", async () => {
    const ollama = {
      embedText: vi.fn(async () => [0.1, 0.2]),
    } as any;
    const qdrant = {
      searchPoints: vi.fn(async () => [
        {
          id: "p1",
          score: 0.9,
          payload: {
            source: "nws",
            sourceDocumentId: "urn:1",
            nwsId: "nws-alert-1",
            embeddingText: "Heavy rain expected",
            severity: "Severe",
            stateCodes: ["OK"],
          },
        },
      ]),
    } as any;

    const service = new NwsSearchService(ollama, qdrant);
    const result = await service.search({
      query: "rain",
      topK: 5,
      filter: { source: "nws", stateCodes: ["OK"] },
    });

    expect(result.query).toBe("rain");
    expect(result.corpus).toBe("alerts");
    expect(result.collection).toBe("nws_alerts_embeddings_nws_v1");
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].citationLabel).toBe("nws-alert-1");
    expect(result.hits[0].snippet).toContain("Heavy rain expected");
    expect(qdrant.searchPoints).toHaveBeenCalledTimes(1);
  });

  it("routes afd searches to the afd collection and applies issuance and section filters", async () => {
    const ollama = {
      embedText: vi.fn(async () => [0.1, 0.2]),
    } as any;
    const qdrant = {
      searchPoints: vi.fn(async () => [
        {
          id: "afd-1",
          score: 0.88,
          payload: {
            source: "nws-afd",
            sourceDocumentId: "afd-123",
            sourceVersion: "2026-02-16T12:00:00.000Z",
            afdIssuedAt: "2026-02-16T12:00:00.000Z",
            afdSectionName: "AVIATION",
            embeddingText: "AVIATION...MVFR cigs expected to improve.",
          },
        },
      ]),
    } as any;

    const service = new NwsSearchService(ollama, qdrant);

    const result = await service.search({
      query: "aviation discussion",
      corpus: "afd",
      filter: {
        afdIssuedFrom: "2026-02-16T00:00:00.000Z",
        afdIssuedTo: "2026-02-16T23:59:59.999Z",
        afdSections: ["AVIATION", "Long Term", "AVIATION"],
      },
    });

    expect(result.corpus).toBe("afd");
    expect(result.collection).toBe("nws_afd_embeddings_v1");
    expect(result.hits[0].afdIssuedAt).toBe("2026-02-16T12:00:00.000Z");
    expect(result.hits[0].afdSectionName).toBe("AVIATION");
    expect(qdrant.searchPoints).toHaveBeenCalledWith(
      expect.objectContaining({
        collectionName: "nws_afd_embeddings_v1",
        filter: expect.objectContaining({
          must: expect.arrayContaining([
            {
              should: [
                {
                  key: "afdIssuedAt",
                  range: {
                    gte: "2026-02-16T00:00:00.000Z",
                    lte: "2026-02-16T23:59:59.999Z",
                  },
                },
                {
                  key: "issuedAt",
                  range: {
                    gte: "2026-02-16T00:00:00.000Z",
                    lte: "2026-02-16T23:59:59.999Z",
                  },
                },
                {
                  key: "issuanceDate",
                  range: {
                    gte: "2026-02-16T00:00:00.000Z",
                    lte: "2026-02-16T23:59:59.999Z",
                  },
                },
              ],
            },
            {
              should: [
                {
                  key: "afdSectionKey",
                  match: { any: ["aviation", "long-term"] },
                },
                {
                  key: "afdSectionName",
                  match: { any: ["AVIATION", "Long Term"] },
                },
                {
                  key: "section",
                  match: { any: ["AVIATION", "Long Term"] },
                },
              ],
            },
          ]),
        }),
      }),
    );
  });

  it("fans out alert searches across source-family collections", async () => {
    const ollama = {
      embedText: vi.fn(async () => [0.1, 0.2]),
    } as any;
    const qdrant = {
      searchPoints: vi.fn(
        async ({ collectionName }: { collectionName: string }) => {
          if (collectionName === "nws_alerts_embeddings_spc_v1") {
            return [
              {
                id: "spc-1",
                score: 0.92,
                payload: {
                  source: "spc",
                  sourceDocumentId: "spc-1",
                  eventType: "SPC Convective Outlook Day 1",
                  embeddingText: "SPC severe storm risk.",
                },
              },
            ];
          }

          if (collectionName === "nws_alerts_embeddings_wpc_v1") {
            return [
              {
                id: "wpc-1",
                score: 0.95,
                payload: {
                  source: "wpc",
                  sourceDocumentId: "wpc-1",
                  eventType: "WPC Excessive Rainfall",
                  embeddingText: "WPC heavy rainfall risk.",
                },
              },
            ];
          }

          return [];
        },
      ),
    } as any;

    const service = new NwsSearchService(ollama, qdrant);
    const result = await service.search({
      query: "heavy rain risk today",
      topK: 5,
    });

    expect(result.collections).toEqual([
      "nws_alerts_embeddings_nws_v1",
      "nws_alerts_embeddings_spc_v1",
      "nws_alerts_embeddings_wpc_v1",
      "nws_alerts_embeddings_airnow_v1",
    ]);
    expect(result.hits.map((hit) => hit.id)).toEqual(["wpc-1", "spc-1"]);
    expect(result.hits[0].collection).toBe("nws_alerts_embeddings_wpc_v1");
    expect(qdrant.searchPoints).toHaveBeenCalledTimes(4);
  });

  it("rejects invalid topK", async () => {
    const service = new NwsSearchService(
      { embedText: vi.fn() } as any,
      { searchPoints: vi.fn() } as any,
    );
    await expect(
      service.search({ query: "storm", topK: 0 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("returns variable hit counts based on relative score quality", async () => {
    const ollama = {
      embedText: vi.fn(async () => [0.1, 0.2]),
    } as any;
    const qdrant = {
      searchPoints: vi.fn(async () => [
        {
          id: "p1",
          score: 0.95,
          payload: { embeddingText: "hit-1" },
        },
        {
          id: "p2",
          score: 0.9,
          payload: { embeddingText: "hit-2" },
        },
        {
          id: "p3",
          score: 0.7,
          payload: { embeddingText: "hit-3" },
        },
      ]),
    } as any;

    const service = new NwsSearchService(ollama, qdrant);

    const strict = await service.search({
      query: "rain",
      topK: 10,
      minRelativeScore: 0.95,
    });
    expect(strict.hits.map((hit) => hit.id)).toEqual(["p1"]);

    const relaxed = await service.search({
      query: "rain",
      topK: 10,
      minRelativeScore: 0.7,
    });
    expect(relaxed.hits.map((hit) => hit.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("rejects invalid minRelativeScore", async () => {
    const service = new NwsSearchService(
      { embedText: vi.fn() } as any,
      { searchPoints: vi.fn() } as any,
    );

    await expect(
      service.search({ query: "storm", minRelativeScore: 1.5 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("applies temporal filter across effectiveAt and fallback date fields", async () => {
    const ollama = {
      embedText: vi.fn(async () => [0.1, 0.2]),
    } as any;
    const qdrant = {
      searchPoints: vi.fn(async () => []),
    } as any;

    const service = new NwsSearchService(ollama, qdrant);

    await service.search({
      query: "spc outlook today",
      filter: {
        effectiveFrom: "2026-02-16T00:00:00.000Z",
        effectiveTo: "2026-02-16T23:59:59.999Z",
      },
    });

    expect(qdrant.searchPoints).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: {
          must: [
            {
              should: [
                {
                  key: "effectiveAt",
                  range: {
                    gte: "2026-02-16T00:00:00.000Z",
                    lte: "2026-02-16T23:59:59.999Z",
                  },
                },
                {
                  key: "onsetAt",
                  range: {
                    gte: "2026-02-16T00:00:00.000Z",
                    lte: "2026-02-16T23:59:59.999Z",
                  },
                },
                {
                  key: "sent",
                  range: {
                    gte: "2026-02-16T00:00:00.000Z",
                    lte: "2026-02-16T23:59:59.999Z",
                  },
                },
                {
                  key: "expiresAt",
                  range: {
                    gte: "2026-02-16T00:00:00.000Z",
                    lte: "2026-02-16T23:59:59.999Z",
                  },
                },
                {
                  key: "endsAt",
                  range: {
                    gte: "2026-02-16T00:00:00.000Z",
                    lte: "2026-02-16T23:59:59.999Z",
                  },
                },
                {
                  key: "effective",
                  range: {
                    gte: "2026-02-16T00:00:00.000Z",
                    lte: "2026-02-16T23:59:59.999Z",
                  },
                },
                {
                  key: "onset",
                  range: {
                    gte: "2026-02-16T00:00:00.000Z",
                    lte: "2026-02-16T23:59:59.999Z",
                  },
                },
                {
                  key: "expires",
                  range: {
                    gte: "2026-02-16T00:00:00.000Z",
                    lte: "2026-02-16T23:59:59.999Z",
                  },
                },
                {
                  key: "ends",
                  range: {
                    gte: "2026-02-16T00:00:00.000Z",
                    lte: "2026-02-16T23:59:59.999Z",
                  },
                },
              ],
            },
          ],
        },
      }),
    );
  });

  it("reranks current-alert queries toward recent and diverse alert types", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T15:00:00.000Z"));

    try {
      const ollama = {
        embedText: vi.fn(async () => [0.1, 0.2]),
      } as any;
      const qdrant = {
        searchPoints: vi.fn(async () => [
          {
            id: "watch-old-1",
            score: 0.91,
            payload: {
              source: "nws",
              sourceDocumentId: "watch-old-1",
              eventType: "Severe Thunderstorm Watch",
              headline: "Severe Thunderstorm Watch for northeast Oklahoma",
              effectiveAt: "2025-06-06T10:35:00.000Z",
              expiresAt: "2025-06-06T13:00:00.000Z",
              embeddingText:
                "Old severe thunderstorm watch covering Tulsa and Rogers counties.",
            },
          },
          {
            id: "watch-old-2",
            score: 0.905,
            payload: {
              source: "nws",
              sourceDocumentId: "watch-old-2",
              eventType: "Severe Thunderstorm Watch",
              headline: "Severe Thunderstorm Watch for eastern Oklahoma",
              effectiveAt: "2025-06-08T22:03:00.000Z",
              expiresAt: "2025-06-09T03:00:00.000Z",
              embeddingText:
                "Another old severe thunderstorm watch covering Tulsa and Mayes counties.",
            },
          },
          {
            id: "warning-current",
            score: 0.899,
            payload: {
              source: "nws",
              sourceDocumentId: "warning-current",
              eventType: "Tornado Warning",
              headline: "Tornado Warning for Tulsa County",
              effectiveAt: "2026-04-22T14:15:00.000Z",
              expiresAt: "2026-04-22T16:00:00.000Z",
              embeddingText: "Current tornado warning for Tulsa County.",
            },
          },
          {
            id: "flood-current",
            score: 0.897,
            payload: {
              source: "nws",
              sourceDocumentId: "flood-current",
              eventType: "Flood Warning",
              headline: "Flood Warning for Muskogee County",
              effectiveAt: "2026-04-22T11:00:00.000Z",
              expiresAt: "2026-04-22T20:00:00.000Z",
              embeddingText: "Current flood warning for Muskogee County.",
            },
          },
        ]),
      } as any;

      const service = new NwsSearchService(ollama, qdrant);
      const result = await service.search({
        query: "What current Oklahoma alerts are active right now?",
        topK: 4,
      });

      expect(result.hits.map((hit) => hit.id)).toEqual([
        "warning-current",
        "flood-current",
      ]);
      expect(result.hits.map((hit) => hit.eventType)).toEqual([
        "Tornado Warning",
        "Flood Warning",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters no-local-risk outlook guidance behind active products for current alert queries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T15:00:00.000Z"));

    try {
      const ollama = {
        embedText: vi.fn(async () => [0.1, 0.2]),
      } as any;
      const qdrant = {
        searchPoints: vi.fn(async () => [
          {
            id: "spc-no-risk",
            score: 0.94,
            payload: {
              source: "spc",
              sourceProduct: "convective-outlook",
              sourceDocumentId: "spc-no-risk",
              eventType: "SPC Convective Outlook Day 1",
              headline: "Day 1 Convective Outlook",
              effectiveAt: "2026-04-22T12:00:00.000Z",
              expiresAt: "2026-04-23T12:00:00.000Z",
              embeddingText:
                "SPC indicates there is NO LOCAL RISK OF SEVERE THUNDERSTORMS across Oklahoma today.",
            },
          },
          {
            id: "warning-current",
            score: 0.84,
            payload: {
              source: "nws",
              sourceProduct: "active-alert",
              sourceDocumentId: "warning-current",
              eventType: "Tornado Warning",
              headline: "Tornado Warning for Tulsa County",
              effectiveAt: "2026-04-22T14:15:00.000Z",
              expiresAt: "2026-04-22T16:00:00.000Z",
              embeddingText: "Current tornado warning for Tulsa County.",
            },
          },
          {
            id: "watch-current",
            score: 0.835,
            payload: {
              source: "nws",
              sourceProduct: "active-alert",
              sourceDocumentId: "watch-current",
              eventType: "Severe Thunderstorm Watch",
              headline: "Severe Thunderstorm Watch for northeast Oklahoma",
              effectiveAt: "2026-04-22T13:30:00.000Z",
              expiresAt: "2026-04-22T20:00:00.000Z",
              embeddingText:
                "Current severe thunderstorm watch covering northeast Oklahoma.",
            },
          },
        ]),
      } as any;

      const service = new NwsSearchService(ollama, qdrant);
      const result = await service.search({
        query: "What current Oklahoma alerts are active right now?",
        topK: 3,
      });

      expect(result.hits.map((hit) => hit.id)).toEqual([
        "warning-current",
        "watch-current",
      ]);
      expect(result.hits.map((hit) => hit.eventType)).toEqual([
        "Tornado Warning",
        "Severe Thunderstorm Watch",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps outlook guidance on top when the query explicitly asks for outlooks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T15:00:00.000Z"));

    try {
      const ollama = {
        embedText: vi.fn(async () => [0.1, 0.2]),
      } as any;
      const qdrant = {
        searchPoints: vi.fn(async () => [
          {
            id: "spc-outlook",
            score: 0.94,
            payload: {
              source: "spc",
              sourceProduct: "convective-outlook",
              sourceDocumentId: "spc-outlook",
              eventType: "SPC Convective Outlook Day 1",
              headline: "Day 1 Convective Outlook",
              effectiveAt: "2026-04-22T12:00:00.000Z",
              expiresAt: "2026-04-23T12:00:00.000Z",
              embeddingText:
                "SPC indicates there is no local risk of severe thunderstorms across Oklahoma today.",
            },
          },
          {
            id: "warning-current",
            score: 0.84,
            payload: {
              source: "nws",
              sourceProduct: "active-alert",
              sourceDocumentId: "warning-current",
              eventType: "Tornado Warning",
              headline: "Tornado Warning for Tulsa County",
              effectiveAt: "2026-04-22T14:15:00.000Z",
              expiresAt: "2026-04-22T16:00:00.000Z",
              embeddingText: "Current tornado warning for Tulsa County.",
            },
          },
        ]),
      } as any;

      const service = new NwsSearchService(ollama, qdrant);
      const result = await service.search({
        query: "What is the current SPC convective outlook for Oklahoma today?",
        topK: 2,
      });

      expect(result.hits[0]?.id).toBe("spc-outlook");
      expect(result.hits[0]?.eventType).toBe("SPC Convective Outlook Day 1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("boosts SPC outlook guidance for severe-weather-outlook queries even without extracted filters", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T15:00:00.000Z"));

    try {
      const ollama = {
        embedText: vi.fn(async () => [0.1, 0.2]),
      } as any;
      const qdrant = {
        searchPoints: vi.fn(async () => [
          {
            id: "winter-stale",
            score: 0.92,
            payload: {
              source: "nws",
              sourceProduct: "active-alert",
              sourceDocumentId: "winter-stale",
              eventType: "Winter Storm Warning",
              headline: "Winter Storm Warning for western Oklahoma",
              effectiveAt: "2026-01-23T11:24:00.000Z",
              expiresAt: "2026-01-25T15:00:00.000Z",
              embeddingText:
                "Winter storm warning affecting western Oklahoma from a prior event.",
            },
          },
          {
            id: "spc-day-1",
            score: 0.86,
            payload: {
              source: "spc",
              sourceProduct: "convective-outlook",
              sourceDocumentId: "spc-day-1",
              eventType: "SPC Convective Outlook Day 1",
              headline: "Day 1 Convective Outlook",
              effectiveAt: "2026-04-22T12:00:00.000Z",
              expiresAt: "2026-04-23T12:00:00.000Z",
              stateCodes: ["OK"],
              embeddingText:
                "SPC Day 1 convective outlook highlighting severe thunderstorm risk across Oklahoma.",
            },
          },
          {
            id: "spc-day-2",
            score: 0.85,
            payload: {
              source: "spc",
              sourceProduct: "convective-outlook",
              sourceDocumentId: "spc-day-2",
              eventType: "SPC Convective Outlook Day 2",
              headline: "Day 2 Convective Outlook",
              effectiveAt: "2026-04-23T12:00:00.000Z",
              expiresAt: "2026-04-24T12:00:00.000Z",
              stateCodes: ["OK"],
              embeddingText:
                "SPC Day 2 convective outlook for Oklahoma and the southern Plains.",
            },
          },
        ]),
      } as any;

      const service = new NwsSearchService(ollama, qdrant);
      const result = await service.search({
        query:
          "tell me what the severe weather outlook looks like for oklahoma in the next 5 days",
        topK: 3,
      });

      expect(result.hits.map((hit) => hit.id)).toEqual([
        "spc-day-1",
        "spc-day-2",
      ]);
      expect(result.hits.slice(0, 2).map((hit) => hit.source)).toEqual([
        "spc",
        "spc",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
