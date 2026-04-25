import { Injectable, ServiceUnavailableException } from "@nestjs/common";

interface OllamaGenerateResponse {
  response?: string;
  error?: string;
}

interface OllamaGenerateStreamResponse {
  response?: string;
  done?: boolean;
  error?: string;
}

const isUpstreamTerminationMessage = (message: string): boolean => {
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes("terminated") ||
    normalized.includes("signal: killed") ||
    normalized.includes("context canceled") ||
    normalized.includes("context cancelled")
  );
};

/**
 * hailo-ollama re-serializes the prompt into its internal JSON context without
 * properly escaping double-quote characters, causing parse_error.101.
 * Replace numeric-inch patterns (e.g. `1"`) with `in` and any remaining
 * bare double-quotes with single-quotes before sending upstream.
 */
const sanitizePromptForUpstream = (prompt: string): string =>
  prompt.replace(/(\d)"/g, "$1in").replace(/"/g, "'");

@Injectable()
export class OllamaGenerationClient {
  async generate(options: {
    baseUrl: string;
    model: string;
    prompt: string;
    timeoutMs: number;
    temperature: number;
    maxTokens: number;
  }): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await fetch(`${options.baseUrl}/api/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: options.model,
          prompt: sanitizePromptForUpstream(options.prompt),
          stream: false,
          options: {
            temperature: options.temperature,
            num_predict: options.maxTokens,
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const responseText = await response.text();
        throw this.buildUpstreamError(
          `Ollama generate failed with status ${response.status}: ${responseText}`,
        );
      }

      const payload = (await response.json()) as OllamaGenerateResponse;
      if (payload.error) {
        throw this.buildUpstreamError(payload.error);
      }

      if (!payload.response || !payload.response.trim()) {
        throw new Error("Ollama generate response was empty");
      }

      return payload.response.trim();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ServiceUnavailableException(
          `Ollama generate timed out after ${options.timeoutMs}ms. Increase NWS_ANSWER_TIMEOUT_MS or reduce maxTokens.`,
        );
      }

      if (
        error instanceof TypeError &&
        error.message.toLowerCase().includes("fetch failed")
      ) {
        throw new ServiceUnavailableException(
          `Unable to reach Ollama-compatible generation endpoint at ${options.baseUrl}. Verify the configured generation base URL and network connectivity.`,
        );
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async generateStream(options: {
    baseUrl: string;
    model: string;
    prompt: string;
    timeoutMs: number;
    temperature: number;
    maxTokens: number;
    signal?: AbortSignal;
    onToken(token: string): void;
  }): Promise<void> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);

    const onCallerAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        options.signal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }

    try {
      const response = await fetch(`${options.baseUrl}/api/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: options.model,
          prompt: sanitizePromptForUpstream(options.prompt),
          stream: true,
          options: {
            temperature: options.temperature,
            num_predict: options.maxTokens,
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const responseText = await response.text();
        throw this.buildUpstreamError(
          `Ollama generate failed with status ${response.status}: ${responseText}`,
        );
      }

      if (!response.body) {
        throw new Error("Ollama generate stream body was empty");
      }

      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }

          const payload = JSON.parse(trimmed) as OllamaGenerateStreamResponse;
          if (payload.error) {
            throw this.buildUpstreamError(payload.error);
          }

          if (payload.response) {
            options.onToken(payload.response);
          }
        }
      }

      const remaining = buffer.trim();
      if (remaining) {
        const payload = JSON.parse(remaining) as OllamaGenerateStreamResponse;
        if (payload.error) {
          throw this.buildUpstreamError(payload.error);
        }

        if (payload.response) {
          options.onToken(payload.response);
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        if (timedOut) {
          throw new ServiceUnavailableException(
            `Ollama generate timed out after ${options.timeoutMs}ms. Increase NWS_ANSWER_TIMEOUT_MS or reduce maxTokens.`,
          );
        }
      }

      if (
        error instanceof TypeError &&
        error.message.toLowerCase().includes("fetch failed")
      ) {
        throw new ServiceUnavailableException(
          `Unable to reach Ollama-compatible generation endpoint at ${options.baseUrl}. Verify the configured generation base URL and network connectivity.`,
        );
      }

      throw error;
    } finally {
      if (options.signal) {
        options.signal.removeEventListener("abort", onCallerAbort);
      }
      clearTimeout(timeout);
    }
  }

  private buildUpstreamError(rawMessage: string): Error {
    if (isUpstreamTerminationMessage(rawMessage)) {
      return new ServiceUnavailableException(
        `Ollama generation terminated before completion (${rawMessage.trim()}). The active chat model may be unstable or resource-constrained. Reduce maxTokens or use a smaller, more reliable model.`,
      );
    }

    return new Error(`Ollama generate error: ${rawMessage.trim()}`);
  }
}
