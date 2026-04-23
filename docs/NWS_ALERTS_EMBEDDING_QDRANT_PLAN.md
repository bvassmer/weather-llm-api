## Plan: NWS Alerts Ingest -> In-Process Embeddings -> Qdrant

This plan adds ingestion endpoint(s) to accept NWS alert payloads from multiple sources, generate embeddings inside `weather-llm-api` using `Xenova/all-MiniLM-L6-v2` by default, and upsert vectors with metadata into Qdrant. It follows the current NestJS module/controller/service pattern and prioritizes idempotency, payload validation, deterministic collection setup, and resilient upstream dependency handling.

**Steps**

1. Add module wiring in [src/app.module.ts](../src/app.module.ts) with `NwsEmbeddingsModule`.
2. Create controller/service under [src/api/nws-embeddings](../src/api/nws-embeddings):
   - `POST /nws-alerts/embeddings:ingest`
3. Add ingestion input contracts in [src/api/nws-embeddings/types.ts](../src/api/nws-embeddings/types.ts).
4. Implement validation + normalization + idempotency in [src/api/nws-embeddings/nws-embeddings.service.ts](../src/api/nws-embeddings/nws-embeddings.service.ts).
5. Implement the in-process embedding client in [src/api/nws-embeddings/in-process-embedding.client.ts](../src/api/nws-embeddings/in-process-embedding.client.ts).
6. Implement Qdrant collection/upsert client in [src/api/nws-embeddings/qdrant.client.ts](../src/api/nws-embeddings/qdrant.client.ts).
7. Configure env vars in [.env.example](../.env.example) and deployment env in [../../weather-llm-iac/docker-compose.yml](../../weather-llm-iac/docker-compose.yml).
8. Add endpoint usage docs in [README.md](../README.md).

**Verification**

- Build API: `npm run build`
- Start stack and verify:
  - `GET /health`
  - `POST /nws-alerts/embeddings:ingest`
  - Qdrant collection exists and points upsert successfully.
- Re-submit same payload and confirm idempotent behavior (no duplicate point IDs).

**Decisions**

- Batch-first endpoint is the primary contract.
- Deterministic point IDs + Qdrant upsert enforce idempotency.
- Default collection: `nws_alerts_embeddings_v1`.
- Default embedding model: `Xenova/all-MiniLM-L6-v2`.
