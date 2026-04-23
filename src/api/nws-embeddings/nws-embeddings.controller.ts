import { Body, Controller, Inject, Post, UseGuards } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { NwsEmbeddingsService } from "./nws-embeddings.service.js";
import type { IngestAlertsRequest } from "./types.js";

@Controller("nws-alerts")
export class NwsEmbeddingsController {
  constructor(
    @Inject(NwsEmbeddingsService)
    private readonly nwsEmbeddingsService: NwsEmbeddingsService,
  ) {}

  @Post("embeddings:ingest")
  @UseGuards(ThrottlerGuard)
  async ingest(@Body() body: IngestAlertsRequest) {
    return this.nwsEmbeddingsService.ingestAlerts(body);
  }
}
