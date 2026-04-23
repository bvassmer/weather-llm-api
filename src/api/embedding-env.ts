const DEFAULT_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const DEFAULT_EMBEDDING_VECTOR_SIZE = 384;

const readTrimmedEnv = (...names: string[]): string | undefined => {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
};

export const getEmbeddingModel = (): string =>
  readTrimmedEnv("NWS_EMBEDDING_MODEL") ?? DEFAULT_EMBEDDING_MODEL;

export const getEmbeddingCacheDir = (): string | undefined =>
  readTrimmedEnv("NWS_EMBEDDING_CACHE_DIR");
