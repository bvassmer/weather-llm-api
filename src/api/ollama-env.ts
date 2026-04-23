const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

const readTrimmedEnv = (...names: string[]): string | undefined => {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
};

const missingConfiguration = (message: string): never => {
  throw new Error(`Missing required configuration: ${message}.`);
};

export const getOllamaChatBaseUrl = (): string =>
  readTrimmedEnv("OLLAMA_CHAT_BASE_URL", "OLLAMA_BASE_URL") ??
  DEFAULT_OLLAMA_BASE_URL;

export const getOllamaChatModel = (): string =>
  readTrimmedEnv("OLLAMA_CHAT_MODEL") ??
  missingConfiguration("set OLLAMA_CHAT_MODEL");
