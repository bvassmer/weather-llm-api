export interface OutlookSummaryCoverage {
  status: "inside" | "nearby" | "outside" | "unknown";
  location?: string;
  distanceMiles?: number;
}

export interface OutlookSummaryFacts {
  version: 1;
  coverage?: OutlookSummaryCoverage;
  validity?: { start?: string; end?: string };
  risks?: string[];
  values?: string[];
  evidence?: Array<{ heading?: string; text: string }>;
}

export interface OutlookSummaryRequest {
  sourceFamily: string;
  sourceProduct: string;
  event?: string;
  headline?: string;
  discussion?: string;
  summarySection?: string;
  supportingDiscussion?: string;
  timingFacts?: string[];
  riskFacts?: string[];
  locationFacts?: string[];
  oklahomaFacts?: string[];
  facts?: OutlookSummaryFacts;
  mode?: "compact";
}

export interface OutlookSummaryMetadata {
  mode: "compact" | "facts-only";
  promptVersion: "compact-v1";
  outcome: "selected" | "abstained" | "deterministic" | "fallback";
  inferenceAttempted: boolean;
  fallbackReason?: "busy" | "invalid-output" | "inference-error";
  latencyMs: number;
}

export interface OutlookSummaryResponse {
  summary: string;
  model: string;
  metadata?: OutlookSummaryMetadata;
}
