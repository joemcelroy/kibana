/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import {
  DREAMING_GROUP_BY,
  MAX_DREAMING_ENTITY_ATTRIBUTES,
  MAX_DREAMING_ENTITY_TYPES,
  MAX_DREAMING_FACT_TYPES,
  MAX_DREAMING_GROUP_KEY_LENGTH,
  MAX_DREAMING_INSTRUCTIONS_LENGTH,
  MAX_DREAMING_INTERVAL_LENGTH,
  MAX_DREAMING_RELATIONSHIP_TYPES,
  MAX_DREAMING_RETRY_ENTRIES,
  MAX_DREAMING_TYPE_DESCRIPTION_LENGTH,
  MAX_DREAMING_TYPE_LENGTH,
  MAX_SHORT_TERM_MEMORY_ID_LENGTH,
  MAX_SHORT_TERM_PULL_GROUP_KEYS,
  MAX_SHORT_TERM_PULL_SIZE,
  MAX_SHORT_TERM_SESSION_ID_LENGTH,
  MAX_SHORT_TERM_USER_ID_LENGTH,
  MIN_DREAMING_INTERVAL_MINUTES,
} from '../../../common/dreaming';
import { validateFeedbackAnalysisInterval } from '../../../common/validation';
import { DREAMING_TYPE_PATTERN } from '../../dreaming/resolve_change_set';

const MAX_EXECUTION_ID_LENGTH = 256;
export const MAX_TIMESTAMP_LENGTH = 64;

const validateType = (value: string): string | undefined =>
  DREAMING_TYPE_PATTERN.test(value)
    ? undefined
    : 'Must use lowercase letters, digits, and underscores only.';

export const validateTimestamp = (value: string): string | undefined =>
  Number.isNaN(Date.parse(value)) ? 'Must be an ISO 8601 date.' : undefined;

const typeSchema = schema.string({
  minLength: 1,
  maxLength: MAX_DREAMING_TYPE_LENGTH,
  validate: validateType,
});

const typeDescriptionSchema = schema.maybe(
  schema.string({ maxLength: MAX_DREAMING_TYPE_DESCRIPTION_LENGTH })
);

export const dreamingConfigSchema = schema.object({
  enabled: schema.boolean({
    meta: { description: 'Whether the AI index dreams on a schedule.' },
  }),
  schedule: schema.maybe(
    schema.object({
      interval: schema.string({
        maxLength: MAX_DREAMING_INTERVAL_LENGTH,
        validate: validateFeedbackAnalysisInterval,
        meta: {
          description: `How often to dream, for example \`1h\` or \`24h\`. At least ${MIN_DREAMING_INTERVAL_MINUTES} minutes.`,
        },
      }),
    })
  ),
  group_by: schema.maybe(
    schema.oneOf([schema.literal(DREAMING_GROUP_BY[0]), schema.literal(DREAMING_GROUP_BY[1])], {
      meta: { description: 'How memories are grouped into tasks. Defaults to `session_id`.' },
    })
  ),
  instructions: schema.maybe(
    schema.string({
      maxLength: MAX_DREAMING_INSTRUCTIONS_LENGTH,
      meta: { description: 'Extra guidance for what to remember and how.' },
    })
  ),
  facts: schema.maybe(
    schema.arrayOf(schema.object({ type: typeSchema, description: typeDescriptionSchema }), {
      maxSize: MAX_DREAMING_FACT_TYPES,
    })
  ),
  entities: schema.maybe(
    schema.arrayOf(
      schema.object({
        type: typeSchema,
        description: typeDescriptionSchema,
        attributes: schema.maybe(
          schema.arrayOf(typeSchema, { maxSize: MAX_DREAMING_ENTITY_ATTRIBUTES })
        ),
      }),
      { maxSize: MAX_DREAMING_ENTITY_TYPES }
    )
  ),
  relationships: schema.maybe(
    schema.arrayOf(
      schema.object({
        type: typeSchema,
        source: typeSchema,
        target: typeSchema,
        description: typeDescriptionSchema,
      }),
      { maxSize: MAX_DREAMING_RELATIONSHIP_TYPES }
    )
  ),
  sessions: schema.maybe(
    schema.boolean({
      meta: {
        description:
          'Also keep one `memory.session` KI per session: a dated summary of what happened in it.',
      },
    })
  ),
  rounds: schema.maybe(
    schema.boolean({
      meta: {
        description:
          "Dream recorded conversation rounds (transcripts) as well as short-term memories. Defaults to `true`. In a shared AI index, what is dreamed from a user's round is visible to everyone who reads the AI index.",
      },
    })
  ),
});

const cursorSchema = schema.object({
  timestamp: schema.string({ maxLength: MAX_TIMESTAMP_LENGTH, validate: validateTimestamp }),
  memory_id: schema.string({ maxLength: MAX_SHORT_TERM_MEMORY_ID_LENGTH }),
});

export const dreamingStateUpdateSchema = schema.object({
  execution_id: schema.maybe(
    schema.string({
      minLength: 1,
      maxLength: MAX_EXECUTION_ID_LENGTH,
      meta: { description: 'The run making the update. Required unless `reset` is set.' },
    })
  ),
  cursor: cursorSchema,
  retry: schema.arrayOf(
    schema.object({
      group_key: schema.string({ minLength: 1, maxLength: MAX_DREAMING_GROUP_KEY_LENGTH }),
      from: cursorSchema,
    }),
    { maxSize: MAX_DREAMING_RETRY_ENTRIES }
  ),
  reset: schema.maybe(
    schema.boolean({ meta: { description: 'Allow moving the cursor backwards.' } })
  ),
});

export const dreamRequestSchema = schema.object({
  session_id: schema.maybe(
    schema.string({ minLength: 1, maxLength: MAX_SHORT_TERM_SESSION_ID_LENGTH })
  ),
  user_id: schema.maybe(schema.string({ minLength: 1, maxLength: MAX_SHORT_TERM_USER_ID_LENGTH })),
  dry_run: schema.boolean({ defaultValue: false }),
});

export const shortTermMemoryPullSchema = schema.object({
  after: schema.maybe(cursorSchema),
  until: schema.string({ maxLength: MAX_TIMESTAMP_LENGTH, validate: validateTimestamp }),
  group_keys: schema.maybe(
    schema.arrayOf(schema.string({ minLength: 1, maxLength: MAX_DREAMING_GROUP_KEY_LENGTH }), {
      maxSize: MAX_SHORT_TERM_PULL_GROUP_KEYS,
    })
  ),
  size: schema.number({ min: 1, max: MAX_SHORT_TERM_PULL_SIZE }),
});
