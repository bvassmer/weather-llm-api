import { Body, Controller, Get, Inject, Post, Req, Res } from "@nestjs/common";
import { NwsAnswerService } from "./nws-answer.service.js";
import { NwsConversationService } from "./nws-conversation.service.js";
import type {
  AnswerErrorEvent,
  AnswerRequest,
  AnswerStreamEvent,
  LatestConversationResponse,
} from "./types.js";

@Controller("nws-alerts")
export class NwsAnswerController {
  constructor(
    @Inject(NwsAnswerService)
    private readonly nwsAnswerService: NwsAnswerService,
    @Inject(NwsConversationService)
    private readonly nwsConversationService: NwsConversationService,
  ) {}

  @Get("conversation/latest")
  async getLatestConversation(): Promise<LatestConversationResponse> {
    return this.nwsConversationService.getLatestConversationResponse();
  }

  @Post("answer")
  async answer(
    @Body() body: AnswerRequest,
    @Req() req: any,
    @Res() res: any,
  ): Promise<void> {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const abortController = new AbortController();
    const onClose = () => {
      abortController.abort();
    };
    req.on("close", onClose);

    const writeEvent = (event: AnswerStreamEvent): void => {
      if (res.writableEnded || abortController.signal.aborted) {
        return;
      }

      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      await this.nwsAnswerService.streamAnswer(
        body,
        {
          onStage: (event) => writeEvent(event),
          onToken: (event) => writeEvent(event),
          onComplete: (event) => writeEvent(event),
        },
        abortController.signal,
      );
    } catch (error) {
      if (!abortController.signal.aborted && !res.writableEnded) {
        const errorEvent: AnswerErrorEvent = {
          type: "error",
          message: error instanceof Error ? error.message : "Unknown error",
        };
        writeEvent(errorEvent);
      }
    } finally {
      req.removeListener("close", onClose);
      if (!res.writableEnded) {
        res.end();
      }
    }
  }
}
