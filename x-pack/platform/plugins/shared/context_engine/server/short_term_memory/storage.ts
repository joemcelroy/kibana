/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { DataStreamDefinition } from '@kbn/core-data-streams-server';
import type { MappingsDefinition } from '@kbn/es-mappings';
import { SHORT_TERM_MEMORY_DATA_STREAM } from '../../common/dreaming';

const shortTermMemoryMappings = {
  properties: {
    '@timestamp': { type: 'date' },
    id: { type: 'keyword' },
    session_id: { type: 'keyword' },
    user_id: { type: 'keyword' },
    content: { type: 'semantic_text' },
    attributes: { type: 'flattened' },
    occurred_at: { type: 'date' },
    ai_index_ids: { type: 'keyword' },
  },
} satisfies MappingsDefinition;

export type ShortTermMemoryMappings = typeof shortTermMemoryMappings;

/** The shared stream `_remember` appends to and every AI index's dreaming reads from. */
export const shortTermMemoryDataStreamDefinition: DataStreamDefinition<ShortTermMemoryMappings> = {
  name: SHORT_TERM_MEMORY_DATA_STREAM,
  version: 4,
  hidden: true,
  template: {
    settings: {
      refresh_interval: '1s',
    },
    mappings: shortTermMemoryMappings,
  },
};
