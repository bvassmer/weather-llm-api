import { Body, Controller, Get, Inject, Post } from "@nestjs/common";
import { NwsAdminService } from "./nws-admin.service.js";
import type {
  DeleteByFilterRequest,
  EmailTemplatePreviewResponse,
  EnqueueAlertsBackfillRequest,
  RealEmailTestCandidatesResponse,
  QueueDeadJobsRequest,
  ReindexRequest,
  RetryDeadJobsRequest,
  ResetCollectionRequest,
  SendRealEmailTestRequest,
  SendRealEmailTestResponse,
} from "./types.js";

@Controller("nws-alerts/admin")
export class NwsAdminController {
  constructor(
    @Inject(NwsAdminService)
    private readonly nwsAdminService: NwsAdminService,
  ) {}

  @Get("collections/stats")
  async getCollectionStats() {
    return this.nwsAdminService.getCollectionStats();
  }

  @Post("delete-by-filter")
  async deleteByFilter(@Body() body: DeleteByFilterRequest) {
    return this.nwsAdminService.deleteByFilter(body);
  }

  @Post("reindex")
  async reindex(@Body() body: ReindexRequest) {
    return this.nwsAdminService.reindex(body);
  }

  @Post("collections/reset")
  async resetCollection(@Body() body: ResetCollectionRequest) {
    return this.nwsAdminService.resetCollection(body);
  }

  @Get("queue/stats")
  async getQueueStats() {
    return this.nwsAdminService.getQueueStats();
  }

  @Post("queue/dead")
  async getDeadQueueJobs(@Body() body: QueueDeadJobsRequest) {
    return this.nwsAdminService.getDeadQueueJobs(body?.limit);
  }

  @Post("queue/retry-dead")
  async retryDeadQueueJobs(@Body() body: RetryDeadJobsRequest) {
    return this.nwsAdminService.retryDeadQueueJobs(body);
  }

  @Post("embeddings/backfill:enqueue")
  async enqueueAlertsBackfill(@Body() body: EnqueueAlertsBackfillRequest) {
    return this.nwsAdminService.enqueueAlertsBackfill(body);
  }

  @Post("email-templates/preview")
  async getEmailTemplatePreview(): Promise<EmailTemplatePreviewResponse> {
    return this.nwsAdminService.getEmailTemplatePreview();
  }

  @Get("email-templates/candidates")
  async getRealEmailTestCandidates(): Promise<RealEmailTestCandidatesResponse> {
    return this.nwsAdminService.getRealEmailTestCandidates();
  }

  @Post("email-templates/send-test")
  async sendRealEmailTest(
    @Body() body: SendRealEmailTestRequest,
  ): Promise<SendRealEmailTestResponse> {
    return this.nwsAdminService.sendRealEmailTest(body);
  }
}
