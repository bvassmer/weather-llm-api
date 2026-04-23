import { Module } from "@nestjs/common";
import { NwsEmbeddingsController } from "./nws-embeddings.controller.js";
import { NwsEmbeddingsService } from "./nws-embeddings.service.js";
import { InProcessEmbeddingClient } from "./in-process-embedding.client.js";
import { QdrantClient } from "./qdrant.client.js";
import { NwsEmbeddingQueueController } from "./nws-embedding-queue.controller.js";
import { NwsEmbeddingQueueService } from "./nws-embedding-queue.service.js";

@Module({
  controllers: [NwsEmbeddingsController, NwsEmbeddingQueueController],
  providers: [
    NwsEmbeddingsService,
    NwsEmbeddingQueueService,
    InProcessEmbeddingClient,
    QdrantClient,
  ],
  exports: [NwsEmbeddingQueueService, InProcessEmbeddingClient],
})
export class NwsEmbeddingsModule {}
