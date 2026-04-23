import { Module } from "@nestjs/common";
import { NwsAlertsController } from "./nws-alerts.controller.js";
import { NwsAlertsService } from "./nws-alerts.service.js";

@Module({
  controllers: [NwsAlertsController],
  providers: [NwsAlertsService],
  exports: [NwsAlertsService],
})
export class NwsAlertsModule {}
