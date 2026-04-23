import { Injectable } from "@nestjs/common";
import type { QdrantUpsertPoint } from "./types.js";

interface QdrantErrorResponse {
  status?: string;
  result?: unknown;
  error?: string;
}

interface QdrantSearchResultItem {
  id: string | number;
  score: number;
  payload?: Record<string, unknown>;
}

interface QdrantScrollResultItem {
  id: string | number;
  payload?: Record<string, unknown>;
}

interface QdrantSearchResponse {
  result?: QdrantSearchResultItem[];
}

interface QdrantCountResponse {
  result?: {
    count?: number;
  };
}

interface QdrantCollectionResponse {
  result?: Record<string, unknown>;
}

interface QdrantFetchResponse {
  result?: Array<{ id: string | number }>;
}

interface QdrantScrollResponse {
  result?: {
    points?: QdrantScrollResultItem[];
    next_page_offset?: string | number;
  };
}

@Injectable()
export class QdrantClient {
  async ensureCollection(options: {
    baseUrl: string;
    collectionName: string;
    vectorSize: number;
    distance: string;
    timeoutMs: number;
  }): Promise<void> {
    const collectionExists = await this.collectionExists(options);
    if (collectionExists) {
      return;
    }

    await this.requestJson(
      `${options.baseUrl}/collections/${encodeURIComponent(options.collectionName)}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          vectors: {
            size: options.vectorSize,
            distance: options.distance,
          },
        }),
      },
      options.timeoutMs,
    );
  }

  async upsertPoints(options: {
    baseUrl: string;
    collectionName: string;
    points: QdrantUpsertPoint[];
    timeoutMs: number;
  }): Promise<void> {
    await this.requestJson(
      `${options.baseUrl}/collections/${encodeURIComponent(options.collectionName)}/points?wait=true`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ points: options.points }),
      },
      options.timeoutMs,
    );
  }

  async searchPoints(options: {
    baseUrl: string;
    collectionName: string;
    vector: number[];
    limit: number;
    timeoutMs: number;
    filter?: Record<string, unknown>;
  }): Promise<
    Array<{ id: string; score: number; payload: Record<string, unknown> }>
  > {
    const response = (await this.requestJson(
      `${options.baseUrl}/collections/${encodeURIComponent(options.collectionName)}/points/search`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          vector: options.vector,
          limit: options.limit,
          with_payload: true,
          filter: options.filter,
        }),
      },
      options.timeoutMs,
    )) as QdrantSearchResponse;

    const result = response.result ?? [];
    return result.map((item) => ({
      id: String(item.id),
      score: item.score,
      payload: item.payload ?? {},
    }));
  }

  async countPoints(options: {
    baseUrl: string;
    collectionName: string;
    timeoutMs: number;
    filter?: Record<string, unknown>;
  }): Promise<number> {
    const response = (await this.requestJson(
      `${options.baseUrl}/collections/${encodeURIComponent(options.collectionName)}/points/count`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          exact: true,
          filter: options.filter,
        }),
      },
      options.timeoutMs,
    )) as QdrantCountResponse;

    return response.result?.count ?? 0;
  }

  async deletePointsByFilter(options: {
    baseUrl: string;
    collectionName: string;
    timeoutMs: number;
    filter: Record<string, unknown>;
  }): Promise<void> {
    await this.requestJson(
      `${options.baseUrl}/collections/${encodeURIComponent(options.collectionName)}/points/delete?wait=true`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filter: options.filter,
        }),
      },
      options.timeoutMs,
    );
  }

  async deleteCollection(options: {
    baseUrl: string;
    collectionName: string;
    timeoutMs: number;
  }): Promise<void> {
    await this.requestJson(
      `${options.baseUrl}/collections/${encodeURIComponent(options.collectionName)}`,
      {
        method: "DELETE",
      },
      options.timeoutMs,
    );
  }

  async getCollectionInfo(options: {
    baseUrl: string;
    collectionName: string;
    timeoutMs: number;
  }): Promise<Record<string, unknown> | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await fetch(
        `${options.baseUrl}/collections/${encodeURIComponent(options.collectionName)}`,
        {
          method: "GET",
          signal: controller.signal,
        },
      );

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        const responseText = await response.text();
        throw new Error(
          `Qdrant collection info failed with status ${response.status}: ${responseText}`,
        );
      }

      const data = (await response.json()) as QdrantCollectionResponse;
      return data.result ?? {};
    } finally {
      clearTimeout(timeout);
    }
  }

  async scrollPoints(options: {
    baseUrl: string;
    collectionName: string;
    timeoutMs: number;
    limit: number;
    offset?: string | number;
    filter?: Record<string, unknown>;
  }): Promise<{
    points: Array<{ id: string; payload: Record<string, unknown> }>;
    nextOffset?: string | number;
  }> {
    const response = (await this.requestJson(
      `${options.baseUrl}/collections/${encodeURIComponent(options.collectionName)}/points/scroll`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          limit: options.limit,
          offset: options.offset,
          with_payload: true,
          with_vector: false,
          filter: options.filter,
        }),
      },
      options.timeoutMs,
    )) as QdrantScrollResponse;

    const points = (response.result?.points ?? []).map((point) => ({
      id: String(point.id),
      payload: point.payload ?? {},
    }));

    return {
      points,
      nextOffset: response.result?.next_page_offset,
    };
  }

  async fetchPoints(options: {
    baseUrl: string;
    collectionName: string;
    ids: string[];
    timeoutMs: number;
  }): Promise<Set<string>> {
    if (options.ids.length === 0) {
      return new Set();
    }
    const response = (await this.requestJson(
      `${options.baseUrl}/collections/${encodeURIComponent(options.collectionName)}/points`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: options.ids,
          with_payload: false,
          with_vector: false,
        }),
      },
      options.timeoutMs,
    )) as QdrantFetchResponse;
    return new Set((response.result ?? []).map((p) => String(p.id)));
  }

  private async collectionExists(options: {
    baseUrl: string;
    collectionName: string;
    timeoutMs: number;
  }): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await fetch(
        `${options.baseUrl}/collections/${encodeURIComponent(options.collectionName)}`,
        {
          method: "GET",
          signal: controller.signal,
        },
      );

      if (response.status === 404) {
        return false;
      }

      if (!response.ok) {
        const responseText = await response.text();
        throw new Error(
          `Qdrant collection lookup failed with status ${response.status}: ${responseText}`,
        );
      }

      return true;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestJson(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<QdrantErrorResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      if (!response.ok) {
        const responseText = await response.text();
        throw new Error(
          `Qdrant request failed with status ${response.status}: ${responseText}`,
        );
      }

      return (await response.json()) as QdrantErrorResponse;
    } finally {
      clearTimeout(timeout);
    }
  }
}
