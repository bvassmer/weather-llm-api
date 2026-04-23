import { Body, Controller, Inject, Post } from "@nestjs/common";
import { NwsEmbeddingQueueService } from "./nws-embedding-queue.service.js";
import type { IngestAlertsRequest } from "./types.js";

@Controller("nws-alerts")
export class NwsEmbeddingQueueController {
  constructor(
    @Inject(NwsEmbeddingQueueService)
    private readonly nwsEmbeddingQueueService: NwsEmbeddingQueueService,
  ) {}

  @Post("embeddings:enqueue")
  async enqueue(@Body() body: IngestAlertsRequest) {
    return this.nwsEmbeddingQueueService.enqueue(body);
  }
}
