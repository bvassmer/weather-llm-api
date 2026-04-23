# weather-llm-api

For the authoritative overall two-Raspberry Pi deployment overview, see [../weather-llm-iac/README.md](../weather-llm-iac/README.md). This README covers the API component only.

NestJS + Prisma (PostgreSQL) API scaffold using TypeScript and ESM.

## Requirements

- Node.js 24+
- PostgreSQL

## Setup

1. Copy `.env.example` to `.env`
2. Install deps:

```bash
npm install
```

3. Ensure PostgreSQL is reachable. If you are using the local Compose-backed database from [../weather-llm-iac/README.md](../weather-llm-iac/README.md), the verified start command was:

```bash
docker start weather-llm-postgres
```

4. Generate the Prisma client and apply the checked-in migrations:

```bash
npm run prisma:generate
npm run prisma:migrate:deploy
```

Use `npm run prisma:migrate:dev -- --name <migration-name>` only when you are authoring a new migration locally.

5. Start API in watch mode:

```bash
npm run dev
```

`npm run dev` and `npm run dev:worker` auto-load `.env`, so you do not need to manually export `DATABASE_URL` first.

Optional worker shell:

```bash
npm run dev:worker
```

6. Verify the local API and latest-conversation bootstrap endpoint:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/nws-alerts/conversation/latest
```

## Unit tests

Run unit tests:

```bash
npm test
```

Run coverage report:

```bash
npm run test:coverage
```

Coverage thresholds are enforced in `vitest.config.ts`:

- statements: `70%`
- lines: `70%`
- functions: `70%`
- branches: `50%`

CI runs `npm run test:coverage` in [unit-tests workflow](.github/workflows/unit-tests.yml), so coverage drops below thresholds fail the build.

Health endpoint:

`GET /health`

CORS diagnostics endpoint:

`GET /health/cors`

This returns request origin/preflight headers plus whether the origin is currently allowed by API CORS configuration.

## NWS Embedding Ingestion

Endpoint:

`POST /nws-alerts/embeddings:ingest`

This endpoint accepts NWS alert payloads from one or more sources, generates embeddings in-process (`Xenova/all-MiniLM-L6-v2` by default), and upserts vectors into Qdrant.

### Request body

```json
{
  "items": [
    {
      "source": "nws-active",
      "sourceDocumentId": "urn:oid:2.49.0.1.840.0.example",
      "sourceVersion": "2026-02-15T18:00:00Z",
      "embeddingText": "A concise text representation of the alert for semantic retrieval.",
      "metadata": {
        "eventType": "Winter Storm Warning",
        "severity": "Severe",
        "stateCodes": ["CO"]
      }
    }
  ]
}
```

### Environment variables

- `NWS_EMBEDDING_MODEL` (default `Xenova/all-MiniLM-L6-v2`)
- `NWS_EMBEDDING_TIMEOUT_MS` (default `30000`, falls back to `OLLAMA_TIMEOUT_MS`)
- `NWS_EMBEDDING_CACHE_DIR` (optional local model cache path)
- `QDRANT_URL` (default `http://localhost:6333`)
- `QDRANT_COLLECTION_NWS_ALERTS` (default `nws_alerts_embeddings_v1`)
- `QDRANT_DISTANCE` (default `Cosine`)
- `QDRANT_TIMEOUT_MS` (default `30000`)
- `QDRANT_VECTOR_SIZE` (default `384` for `Xenova/all-MiniLM-L6-v2`)
- `NWS_INGEST_MAX_BATCH_SIZE` (default `100`)
- `NWS_INGEST_MAX_TEXT_CHARS` (default `12000`)

## NWS Search API

Endpoint:

`POST /nws-alerts/search`

This endpoint embeds the query in-process and performs vector similarity search in Qdrant.

Retrieval is quality-based: the API fetches a candidate pool, then keeps only results that remain within a configurable relative score window from the best hit. The final number of hits can be lower or higher than historical fixed values, depending on quality.

### Request body

```json
{
  "query": "What severe weather alerts are active in Oklahoma?",
  "topK": 12,
  "minRelativeScore": 0.9,
  "groupByEvent": true,
  "filter": {
    "source": "nws-active",
    "eventType": "Severe Thunderstorm Warning",
    "stateCodes": ["OK"]
  }
}
```

Notes:

- `topK` is an optional maximum number of results to return after quality filtering.
- `minRelativeScore` is optional and must be between `0` and `1` (inclusive of `1`), where `1` means only the top-scoring hit survives.
- `minAbsoluteScore` is optional and can enforce an absolute floor in addition to relative filtering.
- `groupByEvent` is optional (default `true`) and collapses update chains for the same alert event to one representative hit before `topK` is applied.

## NWS Answer API

Endpoint:

`POST /nws-alerts/answer`

This endpoint retrieves top matches from Qdrant and generates a grounded answer from Ollama, returning citations.

### Request body

```json
{
  "question": "Summarize flood risk alerts for Oklahoma this evening",
  "topK": 12,
  "minRelativeScore": 0.9,
  "groupByEvent": true,
  "constraintSystem": {
    "enabled": true,
    "method": "heuristic-v1"
  },
  "filter": {
    "stateCodes": ["OK"]
  },
  "temperature": 0.2,
  "maxTokens": 4096
}
```

### Constraint extraction modes

- `bypass`: do not extract constraints from the question.
- `heuristic-v1`: regex/heuristic extraction for event types and recency windows.
- `heuristic-v2`: two-stage LLM-assisted extraction (type classification first, then exclusions/time), with heuristic fallback on failure.
- `rules-v2`: deterministic rule extraction with stricter warning-type exclusions and expanded time windows.
- `llm-v1`: Ollama-based extraction with strict JSON parsing and heuristic fallback.

The response includes `extraction` metadata with the applied method, fallback status, warnings, and merged filter used for retrieval.

## NWS Admin API

Endpoints:

- `GET /nws-alerts/admin/collections/stats`
- `POST /nws-alerts/admin/delete-by-filter`
- `POST /nws-alerts/admin/reindex`
- `POST /nws-alerts/admin/collections/reset`
- `POST /nws-alerts/admin/embeddings/backfill:enqueue`

Use these endpoints for operational tasks (filtered deletes, vector reindexing, and controlled collection reset).

### Additional environment variables

- `OLLAMA_CHAT_MODEL` (default `qwen3:1.7b`)
- `NWS_ANSWER_TIMEOUT_MS` (default `300000`, falls back to `OLLAMA_TIMEOUT_MS` when set)
- `QDRANT_VECTOR_SIZE` (default `384`)
- `NWS_SEARCH_TOPK_DEFAULT` (default `12`)
- `NWS_SEARCH_TOPK_MAX` (default `20`)
- `NWS_SEARCH_CANDIDATE_MULTIPLIER` (default `3`)
- `NWS_SEARCH_CANDIDATE_TOPK_MAX` (default `60`)
- `NWS_SEARCH_MIN_RELATIVE_SCORE` (default `0.9`)
- `NWS_SEARCH_MIN_ABSOLUTE_SCORE` (optional absolute score floor)
- `NWS_ANSWER_MAX_CONTEXT_CHARS` (default `6000`)
- `NWS_ANSWER_TEMPERATURE` (default `0.2`)
- `NWS_ANSWER_MAX_TOKENS` (default `4096`)
- `NWS_CONSTRAINT_EXTRACTOR_DEFAULT` (default `heuristic-v2`, allowed: `bypass|heuristic-v1|heuristic-v2|rules-v2|llm-v1`)
- `NWS_CONSTRAINT_EXTRACTOR_ENABLED` (default `false`)
- `NWS_CONSTRAINT_EXTRACTOR_TIMEOUT_MS` (default `15000`)
- `CORS_ORIGIN` (optional comma-separated allowlist of origins, e.g. `http://localhost:5173,http://192.168.1.50:5173`; use `*` to allow any origin)

### Alerts DB backfill

`POST /nws-alerts/admin/embeddings/backfill:enqueue` reads rows from the `Alerts` table in MariaDB and enqueues embedding jobs into the API embedding queue.

Request body:

```json
{
  "cursorId": 0,
  "limit": 500,
  "snapshotMaxId": 0,
  "dryRun": false
}
```

Environment variables for Alerts DB access and batching:

- `NWS_ALERTS_DB_HOST` (default `localhost`)
- `NWS_ALERTS_DB_PORT` (default `3307`)
- `NWS_ALERTS_DB_USER` (default `emwin_user`)
- `NWS_ALERTS_DB_PASSWORD` (default `emwin_pass`)
- `NWS_ALERTS_DB_NAME` (default `emwin`)
- `NWS_ALERTS_BACKFILL_BATCH_DEFAULT` (default `500`)
- `NWS_ALERTS_BACKFILL_BATCH_MAX` (default `5000`)
