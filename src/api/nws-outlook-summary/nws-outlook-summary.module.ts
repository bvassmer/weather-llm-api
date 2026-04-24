import { Module } from "@nestjs/common";
import { NwsAnswerModule } from "../nws-answer/nws-answer.module.js";
import { NwsOutlookSummaryController } from "./nws-outlook-summary.controller.js";
import { NwsOutlookSummaryService } from "./nws-outlook-summary.service.js";

@Module({
  imports: [NwsAnswerModule],
  controllers: [NwsOutlookSummaryController],
  providers: [NwsOutlookSummaryService],
})
export class NwsOutlookSummaryModule {}
