/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import {
  MAX_AI_INDEX_QUERY_LIMIT,
  MAX_AI_INDEX_QUERY_PARAMS,
  MAX_AI_INDEX_QUERY_PARAM_KEY_LENGTH,
  MAX_AI_INDEX_QUERY_PARAM_VALUE_LENGTH,
} from '../../../common/constants';
import {
  MAX_SHORT_TERM_AI_INDEX_IDS,
  MAX_SHORT_TERM_CONTENT_LENGTH,
  MAX_SHORT_TERM_MEMORY_ID_LENGTH,
  MAX_SHORT_TERM_SESSION_ID_LENGTH,
  MAX_TRANSCRIPT_LENGTH,
} from '../../../common/dreaming';
import { MAX_RECALL_AI_INDICES, MAX_RECALL_QUERY_LENGTH } from '../../../common/http_api/memory';
import { MAX_TIMESTAMP_LENGTH, validateTimestamp } from './dreaming_schema';

const MAX_AI_INDEX_ID_LENGTH = 256;

const aiIndexIdSchema = schema.string({ minLength: 1, maxLength: MAX_AI_INDEX_ID_LENGTH });

const occurredAtSchema = schema.maybe(
  schema.string({
    maxLength: MAX_TIMESTAMP_LENGTH,
    validate: validateTimestamp,
    meta: { description: 'When it happened, if not now. ISO 8601.' },
  })
);

const attributesSchema = schema.maybe(
  schema.recordOf(schema.string(), schema.any(), {
    meta: { description: 'Extra fields to store with it.' },
  })
);

export const rememberBodySchema = schema.object({
  content: schema.string({
    minLength: 1,
    maxLength: MAX_SHORT_TERM_CONTENT_LENGTH,
    meta: {
      description: 'What to remember, with enough context to use it without re-deriving it.',
    },
  }),
  session_id: schema.maybe(
    schema.string({
      minLength: 1,
      maxLength: MAX_SHORT_TERM_SESSION_ID_LENGTH,
      meta: {
        description:
          'The session the memory belongs to. Generated when missing; pass the returned one to continue a session.',
      },
    })
  ),
  about_user: schema.maybe(
    schema.boolean({
      meta: { description: 'The memory is about the caller, so it records them as its user.' },
    })
  ),
  ai_index_ids: schema.maybe(
    schema.arrayOf(aiIndexIdSchema, {
      maxSize: MAX_SHORT_TERM_AI_INDEX_IDS,
      meta: {
        description:
          'The AI indices the memory is for; each must have memory on. Missing or empty: every AI index with dreaming on may use it.',
      },
    })
  ),
  occurred_at: occurredAtSchema,
  attributes: attributesSchema,
  dream_now: schema.maybe(
    schema.boolean({
      meta: {
        description:
          "Dream the memory's session now in each AI index it is for, instead of waiting for the schedule. Needs `ai_index_ids`.",
      },
    })
  ),
});

export const recallBodySchema = schema.object({
  query: schema.string({
    minLength: 1,
    maxLength: MAX_RECALL_QUERY_LENGTH,
    meta: {
      description:
        'What to look up: plain words, or an ES|QL query starting with `FROM`. ES|QL reads AI indices only; its `FROM` names them, and the server adds the space, lifecycle and per-user filters.',
    },
  }),
  scope: schema.maybe(
    schema.oneOf([schema.literal('ai-index'), schema.literal('short-term')], {
      meta: {
        description:
          '`ai-index` (default): the knowledge in AI indices, long-term memory included. `short-term`: memories remembered and not yet dreamed, shared or about the caller; plain words only.',
      },
    })
  ),
  ai_index_ids: schema.maybe(
    schema.arrayOf(aiIndexIdSchema, {
      maxSize: MAX_RECALL_AI_INDICES,
      meta: {
        description:
          'For plain words: the AI indices to search. Missing: every AI index the caller can read.',
      },
    })
  ),
  params: schema.maybe(
    schema.recordOf(
      schema.string({ minLength: 1, maxLength: MAX_AI_INDEX_QUERY_PARAM_KEY_LENGTH }),
      schema.oneOf([
        schema.string({ maxLength: MAX_AI_INDEX_QUERY_PARAM_VALUE_LENGTH }),
        schema.number(),
        schema.boolean(),
      ]),
      {
        validate: (params) =>
          Object.keys(params).length > MAX_AI_INDEX_QUERY_PARAMS
            ? `must not have more than ${MAX_AI_INDEX_QUERY_PARAMS} entries`
            : undefined,
        meta: { description: 'For ES|QL: values for `?name` placeholders in the query.' },
      }
    )
  ),
  limit: schema.maybe(
    schema.number({
      min: 1,
      max: MAX_AI_INDEX_QUERY_LIMIT,
      meta: {
        description:
          'Plain words: results, default 10, at most 50. ES|QL: rows, default 100, at most 1,000.',
      },
    })
  ),
});

export const saveTranscriptBodySchema = schema.object({
  id: schema.maybe(
    schema.string({
      minLength: 1,
      maxLength: MAX_SHORT_TERM_MEMORY_ID_LENGTH,
      meta: { description: 'Generated when missing. A transcript is saved once.' },
    })
  ),
  session_id: schema.string({
    minLength: 1,
    maxLength: MAX_SHORT_TERM_SESSION_ID_LENGTH,
    meta: { description: 'The conversation the round belongs to.' },
  }),
  raw: schema.string({
    minLength: 1,
    maxLength: MAX_TRANSCRIPT_LENGTH,
    meta: { description: 'The transcript, verbatim. Stored for dreaming, never searched.' },
  }),
  ai_index_ids: schema.arrayOf(aiIndexIdSchema, {
    minSize: 1,
    maxSize: MAX_SHORT_TERM_AI_INDEX_IDS,
    meta: {
      description:
        'The AI indices to dream it. Each must take conversation rounds: memory and dreaming on, with `rounds` not set to `false`.',
    },
  }),
  occurred_at: occurredAtSchema,
  attributes: attributesSchema,
});
