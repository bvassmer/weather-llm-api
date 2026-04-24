import { Body, Controller, Inject, Post } from "@nestjs/common";
import { NwsOutlookSummaryService } from "./nws-outlook-summary.service.js";
import type { OutlookSummaryRequest, OutlookSummaryResponse } from "./types.js";

@Controller("nws-alerts")
export class NwsOutlookSummaryController {
  constructor(
    @Inject(NwsOutlookSummaryService)
    private readonly nwsOutlookSummaryService: NwsOutlookSummaryService,
  ) {}

  @Post("outlook-summary")
  async summarize(
    @Body() body: OutlookSummaryRequest,
  ): Promise<OutlookSummaryResponse> {
    return this.nwsOutlookSummaryService.summarize(body);
  }
}
