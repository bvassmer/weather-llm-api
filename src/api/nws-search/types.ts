export type SearchCorpus = "alerts" | "afd";

export interface SearchFilter {
  source?: string;
  eventType?: string;
  includeEventTypes?: string[];
  excludeEventTypes?: string[];
  severity?: string;
  stateCodes?: string[];
  effectiveFrom?: string;
  effectiveTo?: string;
  afdIssuedFrom?: string;
  afdIssuedTo?: string;
  afdSections?: string[];
}

export interface SearchRequest {
  query: string;
  corpus?: SearchCorpus;
  topK?: number;
  minRelativeScore?: number;
  minAbsoluteScore?: number;
  groupByEvent?: boolean;
  filter?: SearchFilter;
}

export interface SearchHit {
  id: string;
  score: number;
  collection?: string;
  source?: string;
  citationLabel?: string;
  sourceDocumentId?: string;
  sourceVersion?: string;
  eventType?: string;
  severity?: string;
  stateCodes?: string[];
  effectiveAt?: string;
  expiresAt?: string;
  afdIssuedAt?: string;
  afdSectionName?: string;
  snippet: string;
  metadata: Record<string, unknown>;
}

export interface SearchResponse {
  query: string;
  corpus: SearchCorpus;
  topK: number;
  model: string;
  collection: string;
  collections?: string[];
  hits: SearchHit[];
}
