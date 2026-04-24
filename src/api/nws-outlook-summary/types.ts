export interface OutlookSummaryRequest {
  sourceFamily: string;
  sourceProduct: string;
  event?: string;
  headline?: string;
  discussion: string;
  summarySection?: string;
  supportingDiscussion?: string;
  timingFacts?: string[];
  riskFacts?: string[];
  locationFacts?: string[];
  oklahomaFacts?: string[];
}

export interface OutlookSummaryResponse {
  summary: string;
  model: string;
}
