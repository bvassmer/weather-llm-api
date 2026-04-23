import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { AppController } from "./app.controller.js";
import { CorrelationIdMiddleware } from "./correlation-id.middleware.js";
import { NwsAdminModule } from "./api/nws-admin/nws-admin.module.js";
import { NwsAnswerModule } from "./api/nws-answer/nws-answer.module.js";
import { PrismaModule } from "./prisma/prisma.module.js";
import { NwsEmbeddingsModule } from "./api/nws-embeddings/nws-embeddings.module.js";
import { NwsSearchModule } from "./api/nws-search/nws-search.module.js";
import { NwsAlertsModule } from "./api/nws-alerts/nws-alerts.module.js";

const ttl = Number.parseInt(
  process.env.NWS_INGEST_RATE_LIMIT_TTL_MS ?? "60000",
  10,
);
const limit = Number.parseInt(
  process.env.NWS_INGEST_RATE_LIMIT_MAX ?? "30",
  10,
);

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl, limit }]),
    PrismaModule,
    NwsEmbeddingsModule,
    NwsSearchModule,
    NwsAnswerModule,
    NwsAdminModule,
    NwsAlertsModule,
  ],
  controllers: [AppController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes("*");
  }
}
