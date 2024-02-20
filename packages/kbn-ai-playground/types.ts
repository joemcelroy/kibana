/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */

import { SecurityPluginStart } from '@kbn/security-plugin/public';
import { HttpStart } from '@kbn/core-http-browser';
import {
  IndexName,
  IndicesStatsIndexMetadataState,
  Uuid,
  HealthStatus,
} from '@elastic/elasticsearch/lib/api/typesWithBodyKey';

export enum MessageRole {
  'user' = 'user',
  'assistant' = 'assistant',
  'system' = 'system',
}

export interface Message {
  id: string;
  content: string | React.ReactNode;
  createdAt?: Date;
  role: MessageRole;
}

export interface Doc {
  id: string;
  content: string;
}

export interface AIMessage extends Message {
  role: MessageRole.assistant;
  citations: Doc[];
  retrievalDocs: Doc[];
}

export enum ChatFormFields {
  question = 'question',
  citations = 'citations',
  prompt = 'prompt',
  openAIKey = 'api_key',
}

export interface ChatForm {
  [ChatFormFields.question]: string;
  [ChatFormFields.prompt]: string;
  [ChatFormFields.citations]: boolean;
  [ChatFormFields.openAIKey]: string;
}

export interface AIPlaygroundPluginStartDeps {
  security: SecurityPluginStart;
  http: HttpStart;
}

export interface ElasticsearchIndex {
  count: number; // Elasticsearch _count
  has_in_progress_syncs?: boolean; // these default to false if not a connector or crawler
  has_pending_syncs?: boolean;
  health?: HealthStatus;
  hidden: boolean;
  name: IndexName;
  status?: IndicesStatsIndexMetadataState;
  total: {
    docs: {
      count: number; // Lucene count (includes nested documents)
      deleted: number;
    };
    store: {
      size_in_bytes: string;
    };
  };
  uuid?: Uuid;
}

export type IndicesQuerySourceFields = Record<string, QuerySourceFields>;

interface ModelFields {
  field: string;
  model_id: string;
  nested: boolean;
}

export interface QuerySourceFields {
  elser_query_fields: ModelFields[];
  dense_vector_query_fields: ModelFields[];
  bm25_query_fields: string[];
  source_fields: string[];
}
