# weather-llm-api Agent Guide

## Purpose

- `weather-llm-api` is the NestJS API and worker that handle search, grounded answer generation, conversation persistence, embeddings, Postgres, and Qdrant integration.
- The main API is served from `nws` on port `3000`. The worker runs alongside it without a host port.

## Connection Rules

- `OLLAMA_BASE_URL` must point at a routable `ai-hub` address such as `http://192.168.7.176:11434`.
- After restarting the API on the Pi, generation health may be temporarily cold until the first real request warms the model path.

## Deployment Target

- Deploy API changes to `nws` at `pi@192.168.6.87`.
- The steady-state deploy path is GitHub-first from `/home/pi/development/weather-stack/weather-llm-iac` via `sh ./scripts/deploy_nws_from_git.sh api`; treat raw `sudo docker-compose ...` as break-glass fallback only.

## Deploy Flow

- Push `weather-llm-api` changes to GitHub before deploying.
- Keep `/home/pi/development/weather-stack/weather-llm-api` as a Git checkout on `main`.
- Do not sync API source files directly into the Pi checkout; update the live Git checkout from GitHub and let the deploy wrapper recreate the services.
- Deploy from `/home/pi/development/weather-stack/weather-llm-iac` with `sh ./scripts/deploy_nws_from_git.sh api` so the live Pi checkout is fast-forwarded from GitHub before `api` and `api-worker` are recreated.

## Image Rebuild (when fresh image is required)

When the running containers must be rebuilt from source, use the registry publish workflow:

1. Push changes to GitHub.
2. SSH to `nws` and rebuild the image with `sudo`:
   ```bash
   ssh -o IdentitiesOnly=yes -i ~/.ssh/id_weather_stack_pi pi@192.168.6.87 '
   set -e
   export GITHUB_SSH_KEY_PATH=$HOME/.ssh/id_github
   export GIT_SSH_COMMAND="ssh -i $GITHUB_SSH_KEY_PATH -o IdentitiesOnly=yes"
   git -C /home/pi/development/weather-stack/weather-llm-api pull --ff-only origin main
   sudo sh /home/pi/development/weather-stack/weather-llm-iac/scripts/publish_images_to_registry.sh
   '
   ```
   `publish_images_to_registry.sh` **must be run with `sudo`** on `nws` (Docker socket permission requirement).
3. Deploy via the wrapper:
   ```bash
   ssh -o IdentitiesOnly=yes -i ~/.ssh/id_weather_stack_pi pi@192.168.6.87 \
     'export GITHUB_SSH_KEY_PATH=$HOME/.ssh/id_github; cd /home/pi/development/weather-stack/weather-llm-iac && sh ./scripts/deploy_nws_from_git.sh api'
   ```
4. Verify: `sudo docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}" | grep weather-llm`

## Validation

- `curl http://192.168.6.87:3000/health`
- `curl http://192.168.6.87:3000/health/cors`
- `curl http://192.168.6.87:3000/nws-alerts/conversation/latest`

## References

- See `../weather-llm-iac/AGENTS.md` for cross-host deployment rules.
- See `README.md` for API-specific commands and runtime details.
