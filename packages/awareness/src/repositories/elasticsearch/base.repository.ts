import type { Client } from '@elastic/elasticsearch';
import crypto from 'node:crypto';

/**
 * Locally defined ES query/response types to avoid deep imports from
 * @elastic/elasticsearch which are not in its package exports map.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EsQueryContainer = Record<string, any>;

export interface EsSearchHit<T> {
  _index: string;
  _id?: string;
  _score?: number | null;
  _source?: T;
  highlight?: Record<string, string[]>;
}

export interface EsSearchTotal {
  value: number;
  relation: string;
}

export interface EsSearchResponse<T> {
  hits: {
    total: EsSearchTotal | number;
    max_score?: number | null;
    hits: Array<EsSearchHit<T>>;
  };
}

export class BaseElasticsearchRepository {
  constructor(
    protected readonly client: Client,
    protected readonly index: string,
  ) {}

  protected userFilter(userId: string): EsQueryContainer {
    return { term: { user_id: userId } };
  }

  protected buildBoolQuery(
    userId: string,
    filters: EsQueryContainer[],
    musts: EsQueryContainer[] = [],
  ): EsQueryContainer {
    return {
      bool: {
        filter: [this.userFilter(userId), ...filters],
        ...(musts.length > 0 ? { must: musts } : {}),
      },
    };
  }

  protected async searchDocs<T>(
    userId: string,
    body: {
      query?: EsQueryContainer;
      filters?: EsQueryContainer[];
      musts?: EsQueryContainer[];
      size?: number;
      from?: number;
      sort?: Array<Record<string, unknown>>;
      highlight?: Record<string, unknown>;
    },
  ): Promise<{ hits: Array<EsSearchHit<T>>; total: number }> {
    const query = body.query ?? this.buildBoolQuery(
      userId,
      body.filters ?? [],
      body.musts ?? [],
    );

    const response = await this.client.search<T>({
      index: this.index,
      query,
      size: body.size ?? 50,
      from: body.from ?? 0,
      sort: body.sort as never,
      highlight: body.highlight as never,
    });

    const rawTotal = response.hits.total;
    const total =
      typeof rawTotal === 'number'
        ? rawTotal
        : (rawTotal as EsSearchTotal | undefined)?.value ?? 0;

    const hits = response.hits.hits as unknown as Array<EsSearchHit<T>>;

    return { hits, total };
  }

  protected generateId(): string {
    return crypto.randomUUID();
  }

  protected nowISO(): string {
    return new Date().toISOString();
  }

  protected async getById<T>(userId: string, id: string): Promise<T | null> {
    try {
      const response = await this.client.get<T>({
        index: this.index,
        id,
      });

      const source = response._source;
      if (!source) return null;

      // Verify user_id ownership
      const doc = source as Record<string, unknown>;
      if (doc.user_id !== userId) return null;

      return { ...source, id: response._id } as T;
    } catch (err: unknown) {
      const error = err as { meta?: { statusCode?: number } };
      if (error.meta?.statusCode === 404) return null;
      throw err;
    }
  }

  protected async indexDoc(
    id: string,
    doc: Record<string, unknown>,
  ): Promise<void> {
    await this.client.index({
      index: this.index,
      id,
      document: doc,
      refresh: true,
    });
  }

  protected async updateDoc(
    id: string,
    doc: Record<string, unknown>,
  ): Promise<void> {
    await this.client.update({
      index: this.index,
      id,
      doc,
      refresh: true,
    });
  }

  protected async updateByQuery(
    query: EsQueryContainer,
    script: { source: string; params?: Record<string, unknown> },
  ): Promise<number> {
    const response = await this.client.updateByQuery({
      index: this.index,
      query,
      script: {
        source: script.source,
        lang: 'painless',
        params: script.params,
      },
      refresh: true,
    });
    return response.updated ?? 0;
  }
}
