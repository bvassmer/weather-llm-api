export interface IngestAlertItemInput {
  source: string;
  sourceDocumentId: string;
  sourceVersion?: string;
  embeddingText?: string;
  text?: string;
  content?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface IngestAlertsRequest {
  items: IngestAlertItemInput[];
}

export interface NormalizedIngestItem {
  source: string;
  sourceDocumentId: string;
  sourceVersion: string;
  embeddingText: string;
  metadata: Record<string, unknown>;
}

export interface IngestAlertsResponse {
  accepted: number;
  processed: number;
  upserted: number;
  skipped: number;
  failed: number;
  collection: string;
  collections?: string[];
  model: string;
  vectorDimension: number;
}

export interface QdrantUpsertPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}
