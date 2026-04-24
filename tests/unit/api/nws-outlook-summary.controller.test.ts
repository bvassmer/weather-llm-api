import { NwsOutlookSummaryController } from "../../../src/api/nws-outlook-summary/nws-outlook-summary.controller.js";

describe("NwsOutlookSummaryController", () => {
  it("delegates summary requests to the service", async () => {
    const service = {
      summarize: vi.fn(async () => ({
        summary: "Oklahoma may see strong storms Friday.",
        model: "qwen2.5:1.5b",
      })),
    } as any;

    const controller = new NwsOutlookSummaryController(service);
    const body = {
      sourceFamily: "spc",
      sourceProduct: "convective-outlook",
      discussion: "Storms may reach eastern Oklahoma Friday.",
    };

    await expect(controller.summarize(body)).resolves.toEqual({
      summary: "Oklahoma may see strong storms Friday.",
      model: "qwen2.5:1.5b",
    });
    expect(service.summarize).toHaveBeenCalledWith(body);
  });
});
