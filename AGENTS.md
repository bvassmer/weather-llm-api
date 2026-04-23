# weather-llm-api Agent Guide

## Purpose

- `weather-llm-api` is the NestJS API and worker that handle search, grounded answer generation, conversation persistence, embeddings, Postgres, and Qdrant integration.
- The main API is served from `nws` on port `3000`. The worker runs alongside it without a host port.

## Connection Rules

- `OLLAMA_BASE_URL` must point at a routable `ai-hub` address such as `http://192.168.7.176:11434`.
- After restarting the API on the Pi, generation health may be temporarily cold until the first real request warms the model path.

## Deployment Target

- Deploy API changes to `nws` at `pi@192.168.6.87`.
- Rebuild from `/home/pi/development/weather-stack/weather-llm-iac` with `sudo docker-compose up -d --build --no-deps --force-recreate api api-worker`.

## Validation

- `curl http://192.168.6.87:3000/health`
- `curl http://192.168.6.87:3000/health/cors`
- `curl http://192.168.6.87:3000/nws-alerts/conversation/latest`

## References

- See `../weather-llm-iac/AGENTS.md` for cross-host deployment rules.
- See `README.md` for API-specific commands and runtime details.
