import { Module } from "@nestjs/common";
import { NwsSearchModule } from "../nws-search/nws-search.module.js";
import { NwsConstraintExtractionService } from "./nws-constraint-extraction.service.js";
import { OllamaGenerationClient } from "./ollama-generation.client.js";
import { NwsAnswerController } from "./nws-answer.controller.js";
import { NwsConversationService } from "./nws-conversation.service.js";
import { NwsAnswerService } from "./nws-answer.service.js";
import { NwsLiveContextService } from "./nws-live-context.service.js";

@Module({
  imports: [NwsSearchModule],
  controllers: [NwsAnswerController],
  providers: [
    NwsConversationService,
    NwsAnswerService,
    OllamaGenerationClient,
    NwsConstraintExtractionService,
    NwsLiveContextService,
  ],
  exports: [OllamaGenerationClient],
})
export class NwsAnswerModule {}
