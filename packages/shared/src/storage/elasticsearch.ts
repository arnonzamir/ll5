import { Client } from '@elastic/elasticsearch';

export interface ElasticsearchConfig {
  url: string;
  apiKey?: string;
}

export function createElasticsearchClient(config: ElasticsearchConfig): Client {
  const clientOptions: ConstructorParameters<typeof Client>[0] = {
    node: config.url,
  };

  if (config.apiKey) {
    clientOptions.auth = { apiKey: config.apiKey };
  }

  return new Client(clientOptions);
}

export async function ensureIndex(
  client: Client,
  index: string,
  mappings: Record<string, unknown>,
  settings?: Record<string, unknown>,
): Promise<void> {
  const exists = await client.indices.exists({ index });
  if (!exists) {
    await client.indices.create({
      index,
      body: {
        mappings,
        ...(settings ? { settings } : {}),
      },
    });
  }
}

export function withUserFilter(userId: string, query: Record<string, unknown>): Record<string, unknown> {
  return {
    bool: {
      filter: [
        { term: { user_id: userId } },
      ],
      ...(query.bool ? (query.bool as Record<string, unknown>) : { must: [query] }),
    },
  };
}
