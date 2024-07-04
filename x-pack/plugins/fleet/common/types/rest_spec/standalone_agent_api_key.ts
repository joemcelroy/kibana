/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SecurityCreateApiKeyResponse } from '@elastic/elasticsearch/lib/api/types';

export interface PostStandaloneAgentAPIKeyRequest {
  body: {
    name: string;
  };
}

export interface PostStandaloneAgentAPIKeyResponse {
  action: string;
  item: SecurityCreateApiKeyResponse;
}
