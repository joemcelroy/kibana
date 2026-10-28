/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { DataStreamDefinition } from '@kbn/core-data-streams-server';
import type { MappingsDefinition } from '@kbn/es-mappings';
import { TRANSCRIPTS_DATA_STREAM } from '../../common/dreaming';

const transcriptMappings = {
  properties: {
    '@timestamp': { type: 'date' },
    id: { type: 'keyword' },
    session_id: { type: 'keyword' },
    user_id: { type: 'keyword' },
    // Kept in _source for dreaming only: no index or doc values, so it has no length limit.
    raw: { type: 'keyword', index: false, doc_values: false },
    attributes: { type: 'flattened' },
    occurred_at: { type: 'date' },
    ai_index_ids: { type: 'keyword' },
  },
} satisfies MappingsDefinition;

export type TranscriptMappings = typeof transcriptMappings;

/** Recorded conversation transcripts, which dreaming reads alongside short-term memory. */
export const transcriptsDataStreamDefinition: DataStreamDefinition<TranscriptMappings> = {
  name: TRANSCRIPTS_DATA_STREAM,
  version: 1,
  hidden: true,
  template: {
    settings: {
      refresh_interval: '1s',
    },
    mappings: transcriptMappings,
  },
};
