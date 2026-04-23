import { Module } from "@nestjs/common";
import { InProcessEmbeddingClient } from "../nws-embeddings/in-process-embedding.client.js";
import { QdrantClient } from "../nws-embeddings/qdrant.client.js";
import { NwsSearchController } from "./nws-search.controller.js";
import { NwsSearchService } from "./nws-search.service.js";

@Module({
  controllers: [NwsSearchController],
  providers: [NwsSearchService, InProcessEmbeddingClient, QdrantClient],
  exports: [NwsSearchService],
})
export class NwsSearchModule {}
