import { Module } from "@nestjs/common";
import { NwsEmbeddingsModule } from "../nws-embeddings/nws-embeddings.module.js";
import { InProcessEmbeddingClient } from "../nws-embeddings/in-process-embedding.client.js";
import { QdrantClient } from "../nws-embeddings/qdrant.client.js";
import { NwsAdminController } from "./nws-admin.controller.js";
import { NwsAdminService } from "./nws-admin.service.js";
import { NwsAlertsBackfillService } from "./nws-alerts-backfill.service.js";

@Module({
  imports: [NwsEmbeddingsModule],
  controllers: [NwsAdminController],
  providers: [
    NwsAdminService,
    NwsAlertsBackfillService,
    InProcessEmbeddingClient,
    QdrantClient,
  ],
})
export class NwsAdminModule {}
