export interface AdminFilter {
  source?: string;
  eventType?: string;
  severity?: string;
  stateCodes?: string[];
}

export interface DeleteByFilterRequest {
  filter: AdminFilter;
  dryRun?: boolean;
}

export interface DeleteByFilterResponse {
  beforeCount: number;
  afterCount: number;
  deleted: number;
  dryRun: boolean;
}

export interface ReindexRequest {
  filter?: AdminFilter;
  dryRun?: boolean;
  limit?: number;
  batchSize?: number;
}

export interface ReindexCollectionResponse {
  collection: string;
  matched: number;
  processed: number;
  reindexed: number;
  skipped: number;
}

export interface ReindexResponse {
  matched: number;
  processed: number;
  reindexed: number;
  skipped: number;
  dryRun: boolean;
  collections: ReindexCollectionResponse[];
}

export interface ResetCollectionRequest {
  confirm: boolean;
  vectorSize?: number;
}

export interface ResetCollectionResponse {
  reset: boolean;
  collections: Array<{
    collection: string;
    existed: boolean;
    reset: boolean;
  }>;
}

export interface CollectionStatsItemResponse {
  collection: string;
  pointsCount: number;
  collectionInfo: Record<string, unknown> | null;
}

export interface CollectionStatsResponse {
  totalPointsCount: number;
  collections: CollectionStatsItemResponse[];
}

export interface QueueStatsResponse {
  totals: Record<string, number>;
  oldestPendingAt: string | null;
  oldestRetryingAt: string | null;
}

export interface QueueDeadJobsRequest {
  limit?: number;
}

export interface QueueDeadJob {
  id: number;
  dedupeKey: string;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  deadLetteredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RetryDeadJobsRequest {
  ids?: number[];
}

export interface RetryDeadJobsResponse {
  retried: number;
}

export interface EnqueueAlertsBackfillRequest {
  cursorId?: number;
  limit?: number;
  snapshotMaxId?: number;
  sentFrom?: string;
  sentTo?: string;
  dryRun?: boolean;
}

export interface EnqueueAlertsBackfillResponse {
  runId: string;
  cursorId: number;
  nextCursorId: number;
  snapshotMaxId: number;
  rowsRead: number;
  accepted: number;
  enqueued: number;
  duplicate: number;
  skippedInvalid: number;
  dryRun: boolean;
  hasMore: boolean;
  monitor: {
    queueStatsPath: string;
    deadQueuePath: string;
  };
}

export interface EmailTemplatePreviewRequest {
  includeContent?: boolean;
}

export interface EmailTemplatePreviewAttachment {
  filename?: string;
  cid?: string;
  sourcePath?: string;
  artifactPath?: string;
}

export interface EmailTemplatePreviewScenario {
  scenario: string;
  subject?: string;
  emailFormat: "html" | "text";
  status: "captured" | "failed";
  artifactDirectory: string;
  bodyPath?: string;
  mailOptionsPath?: string;
  attachments: EmailTemplatePreviewAttachment[];
  aiSummaryCheck?: {
    expected: "present" | "absent";
    expectedText?: string;
    passed: boolean;
    sectionCount: number;
    textCount: number;
  };
  preview?: {
    subject?: string;
    html?: string;
    htmlForBrowser?: string;
    text?: string;
  };
  error?: string;
}

export interface EmailTemplatePreviewResponse {
  runId: string;
  startedAt: string;
  completedAt: string;
  artifactRootDir: string;
  summaryPath: string;
  scenarios: EmailTemplatePreviewScenario[];
  hadErrors: boolean;
}
