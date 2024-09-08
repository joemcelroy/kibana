/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ElasticsearchClient } from '@kbn/core-elasticsearch-server';
import { Logger } from '@kbn/logging';
import { GetApiKeyResponse } from '../../common/types';

export async function getAPIKeyById(
  id: string,
  client: ElasticsearchClient,
  logger: Logger
): Promise<GetApiKeyResponse> {
  try {
    const apiKey = await client.security.getApiKey({
      id,
    });

    return apiKey.api_keys?.[0];
  } catch (e) {
    logger.error(`Error getting API Key for elasticsearch start`);
    logger.error(e);
    throw e;
  }
}
