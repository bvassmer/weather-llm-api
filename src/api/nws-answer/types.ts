import type {
  SearchCorpus,
  SearchFilter,
  SearchHit,
} from "../nws-search/types.js";

export type ConstraintExtractionSystem =
  | "bypass"
  | "heuristic-v1"
  | "heuristic-v2"
  | "rules-v2"
  | "llm-v1";

export type ConversationHistoryMode = "none" | "last-turn" | "last-10-messages";

export type LiveContextMode = "auto" | "off" | "required";

export type CitationOrigin = "search" | "live-local" | "live-upstream";

export type LiveContextStatus = "ok" | "partial" | "unavailable";

export interface ConstraintSystemSelection {
  enabled?: boolean;
  method?: ConstraintExtractionSystem;
}

export interface ConstraintExtractionMetadata {
  enabled: boolean;
  requestedSystem: ConstraintExtractionSystem;
  appliedSystem: ConstraintExtractionSystem;
  fallbackApplied: boolean;
  warnings: string[];
  detectedEventTypes: string[];
  confidence?: number;
  signals?: string[];
  extractedFilter?: SearchFilter;
  mergedFilter?: SearchFilter;
}

export interface AnswerRequest {
  question: string;
  conversationId?: string;
  historyMode?: ConversationHistoryMode;
  liveMode?: LiveContextMode;
  corpus?: SearchCorpus;
  topK?: number;
  minRelativeScore?: number;
  minAbsoluteScore?: number;
  groupByEvent?: boolean;
  filter?: SearchFilter;
  constraintSystem?: ConstraintSystemSelection;
  maxContextChars?: number;
  temperature?: number;
  maxTokens?: number;
}

export interface Citation {
  id: string;
  score: number;
  source?: string;
  citationLabel?: string;
  sourceDocumentId?: string;
  origin?: CitationOrigin;
  fetchedAt?: string;
  freshnessMs?: number;
  snippet: string;
  metadata: Record<string, unknown>;
}

export interface LiveContextSource {
  dataset: string;
  origin: Exclude<CitationOrigin, "search">;
  source?: string;
  sourceFamily?: string;
  sourceProduct?: string;
  asOf?: string;
  itemCount?: number;
}

export interface LiveContextMetadata {
  mode: LiveContextMode;
  status: LiveContextStatus;
  fetchedAt?: string;
  warnings: string[];
  sources: LiveContextSource[];
}

export interface AnswerResponse {
  question: string;
  answer: string;
  model: string;
  citations: Citation[];
  conversationId?: string;
  extraction?: ConstraintExtractionMetadata;
  liveContext?: LiveContextMetadata;
}

export interface PromptSettingsMetadata {
  liveMode?: LiveContextMode;
  temperature?: number;
  maxTokens?: number;
  maxContextChars?: number;
  constraintSystem?: ConstraintSystemSelection;
}

export interface ConversationMessageMetadata {
  answerModel?: string;
  citations?: Citation[];
  search?: SearchContextResult;
  extraction?: ConstraintExtractionMetadata;
  liveContext?: LiveContextMetadata;
  filter?: SearchFilter;
  corpus?: SearchCorpus;
  groupByEvent?: boolean;
  promptSettings?: PromptSettingsMetadata;
  historyMode?: ConversationHistoryMode;
  stageEvents?: AnswerStageEvent[];
}

export interface ConversationMessageResponse {
  id: string;
  role: "user" | "assistant";
  content: string;
  metadata?: ConversationMessageMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationResponse {
  id: string;
  createdAt: string;
  updatedAt: string;
  messages: ConversationMessageResponse[];
}

export interface LatestConversationResponse {
  conversation: ConversationResponse | null;
}

export type AnswerStreamStage =
  | "constraints_started"
  | "constraints_complete"
  | "live_context_started"
  | "live_context_complete"
  | "search_started"
  | "search_complete"
  | "generation_started"
  | "generation_complete"
  | "cancelled";

export interface AnswerStageEvent {
  type: "stage";
  stage: AnswerStreamStage;
  extraction?: ConstraintExtractionMetadata;
  liveContext?: LiveContextMetadata;
  model?: string;
  citationsCount?: number;
  search?: SearchContextResult;
  message?: string;
}

export interface AnswerTokenEvent {
  type: "token";
  token: string;
}

export interface AnswerCompleteEvent {
  type: "complete";
  response: AnswerResponse;
}

export interface AnswerErrorEvent {
  type: "error";
  message: string;
}

export type AnswerStreamEvent =
  | AnswerStageEvent
  | AnswerTokenEvent
  | AnswerCompleteEvent
  | AnswerErrorEvent;

export interface SearchContextResult {
  corpus: SearchCorpus;
  hits: SearchHit[];
  topK: number;
  model: string;
  collection: string;
  collections?: string[];
}
