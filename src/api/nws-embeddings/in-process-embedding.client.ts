import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { getEmbeddingCacheDir } from "../embedding-env.js";

type FeatureExtractionPipeline = (
  input: string,
  options?: Record<string, unknown>,
) => Promise<unknown>;

type InProcessEmbeddingPipelineFactory = (
  model: string,
) => Promise<FeatureExtractionPipeline>;

const defaultPipelineFactory: InProcessEmbeddingPipelineFactory = async (
  model,
) => {
  const transformers: any = await import("@xenova/transformers");
  const env = transformers?.env;

  if (env && typeof env === "object") {
    env.allowLocalModels = true;
    env.allowRemoteModels = true;
    env.useBrowserCache = false;

    const cacheDir = getEmbeddingCacheDir();
    if (cacheDir) {
      env.cacheDir = cacheDir;
    }
  }

  return transformers.pipeline("feature-extraction", model);
};

@Injectable()
export class InProcessEmbeddingClient {
  private static pipelineFactory: InProcessEmbeddingPipelineFactory =
    defaultPipelineFactory;

  private readonly logger = new Logger(InProcessEmbeddingClient.name);
  private readonly pipelines = new Map<string, Promise<FeatureExtractionPipeline>>();

  static setPipelineFactoryForTesting(
    factory: InProcessEmbeddingPipelineFactory | undefined,
  ) {
    this.pipelineFactory = factory ?? defaultPipelineFactory;
  }

  static resetPipelineFactoryForTesting() {
    this.pipelineFactory = defaultPipelineFactory;
  }

  async embedText(
    text: string,
    options: { model: string; timeoutMs: number },
  ): Promise<number[]> {
    let timeoutHandle: NodeJS.Timeout | undefined;

    const embedPromise = this.embedWithModel(text, options.model);
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new ServiceUnavailableException(
            `In-process embedding timed out after ${options.timeoutMs}ms while loading or executing model ${options.model}.`,
          ),
        );
      }, options.timeoutMs);
    });

    try {
      return await Promise.race([embedPromise, timeoutPromise]);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new ServiceUnavailableException(
        `In-process embedding failed for model ${options.model}: ${message}`,
      );
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async embedWithModel(text: string, model: string): Promise<number[]> {
    const pipeline = await this.getPipeline(model);
    const result = await pipeline(text, {
      pooling: "mean",
      normalize: true,
    });

    const vector = this.toVector(result);
    if (!vector.length) {
      throw new Error("Embedding model returned an empty vector");
    }

    return vector;
  }

  private getPipeline(model: string): Promise<FeatureExtractionPipeline> {
    let pipelinePromise = this.pipelines.get(model);
    if (!pipelinePromise) {
      this.logger.log(`Loading in-process embedding model \"${model}\"`);
      pipelinePromise = InProcessEmbeddingClient.pipelineFactory(model).catch(
        (error) => {
          this.pipelines.delete(model);
          throw error;
        },
      );
      this.pipelines.set(model, pipelinePromise);
    }

    return pipelinePromise;
  }

  private toVector(result: unknown): number[] {
    if (Array.isArray(result)) {
      if (Array.isArray(result[0])) {
        return (result[0] as unknown[]).map((value) => Number(value));
      }

      return result.map((value) => Number(value));
    }

    if (!result || typeof result !== "object") {
      throw new Error("Embedding pipeline returned an unsupported payload");
    }

    const tensorLike = result as {
      data?: ArrayLike<number> | number[];
      tolist?: () => unknown;
    };

    if (typeof tensorLike.tolist === "function") {
      const listValue = tensorLike.tolist();
      if (Array.isArray(listValue)) {
        if (Array.isArray(listValue[0])) {
          return (listValue[0] as unknown[]).map((value) => Number(value));
        }

        return listValue.map((value) => Number(value));
      }
    }

    if (tensorLike.data && typeof tensorLike.data.length === "number") {
      return Array.from(tensorLike.data, (value) => Number(value));
    }

    throw new Error("Embedding pipeline returned an unsupported payload");
  }
}
