/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ToolSchema } from '@kbn/inference-common';
import { z } from '@kbn/zod/v4';
import { MAX_DREAMING_CHANGE_SET_ITEMS } from '../../common/dreaming';
import {
  MAX_KI_ATTRIBUTE_KEY_LENGTH,
  MAX_KI_ATTRIBUTE_VALUE_LENGTH,
  MAX_KI_CONTENT_LENGTH,
  MAX_KI_DESCRIPTION_LENGTH,
  MAX_KI_ID_LENGTH,
  MAX_KI_TITLE_LENGTH,
} from '../../common/step_types/ki';

const MAX_REF_LENGTH = MAX_KI_ID_LENGTH;
const MAX_TYPE_LENGTH = 128;
const MAX_SOURCE_IDS = 100;

const sourceMemoryIdsSchema = z.array(z.string().min(1).max(MAX_REF_LENGTH)).max(MAX_SOURCE_IDS);

/**
 * What the model returns. Structured output has no null or free-form object keys, so a delete
 * is `delete: true` rather than `null`, and attributes are key/value pairs.
 */
export const changeSetSchema = z.object({
  entities: z
    .array(
      z.object({
        ref: z.string().min(1).max(MAX_REF_LENGTH),
        delete: z.boolean().optional(),
        type: z.string().max(MAX_TYPE_LENGTH).optional(),
        name: z.string().max(MAX_KI_TITLE_LENGTH).optional(),
        description: z.string().max(MAX_KI_DESCRIPTION_LENGTH).optional(),
        attributes: z
          .array(
            z.object({
              key: z.string().min(1).max(MAX_KI_ATTRIBUTE_KEY_LENGTH),
              value: z.string().max(MAX_KI_ATTRIBUTE_VALUE_LENGTH),
            })
          )
          .max(MAX_DREAMING_CHANGE_SET_ITEMS)
          .optional(),
        source_memory_ids: sourceMemoryIdsSchema.optional(),
      })
    )
    .max(MAX_DREAMING_CHANGE_SET_ITEMS)
    .default([]),
  facts: z
    .array(
      z.object({
        ref: z.string().min(1).max(MAX_REF_LENGTH),
        delete: z.boolean().optional(),
        type: z.string().max(MAX_TYPE_LENGTH).optional(),
        title: z.string().max(MAX_KI_TITLE_LENGTH).optional(),
        content: z.string().max(MAX_KI_CONTENT_LENGTH).optional(),
        about: z.array(z.string().min(1).max(MAX_REF_LENGTH)).max(MAX_SOURCE_IDS).optional(),
        source_memory_ids: sourceMemoryIdsSchema.optional(),
      })
    )
    .max(MAX_DREAMING_CHANGE_SET_ITEMS)
    .default([]),
  relationships: z
    .array(
      z.object({
        type: z.string().min(1).max(MAX_TYPE_LENGTH),
        source: z.string().min(1).max(MAX_REF_LENGTH),
        target: z.string().min(1).max(MAX_REF_LENGTH),
        remove: z.boolean().optional(),
        source_memory_ids: sourceMemoryIdsSchema.optional(),
      })
    )
    .max(MAX_DREAMING_CHANGE_SET_ITEMS)
    .default([]),
});

export type DreamingChangeSet = z.infer<typeof changeSetSchema>;

const refDescription =
  'An id from EXISTING, or a new key like "new:1" to create something. Reuse the same new key to refer to a new entity elsewhere in this change set.';
const sourceIdsDescription =
  'Ids of the MEMORIES this is based on. Required unless deleting; may also repeat sources the item already cites.';

/** The structured output schema the model answers with. */
export const changeSetToolSchema = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      description: 'Entities to create, update, or delete. Leave out entities that do not change.',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: refDescription },
          delete: { type: 'boolean', description: 'True deletes an existing entity.' },
          type: { type: 'string', description: 'One of the configured entity types.' },
          name: { type: 'string', description: 'The canonical name of the entity.' },
          description: { type: 'string', description: 'A one-line description.' },
          attributes: {
            type: 'array',
            description: 'Values for the attribute keys configured for this entity type.',
            items: {
              type: 'object',
              properties: { key: { type: 'string' }, value: { type: 'string' } },
              required: ['key', 'value'],
            },
          },
          source_memory_ids: {
            type: 'array',
            description: sourceIdsDescription,
            items: { type: 'string' },
          },
        },
        required: ['ref'],
      },
    },
    facts: {
      type: 'array',
      description: 'Facts to create, update, or delete. Leave out facts that do not change.',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: refDescription },
          delete: { type: 'boolean', description: 'True deletes an existing fact.' },
          type: { type: 'string', description: 'One of the configured fact types.' },
          title: {
            type: 'string',
            description: 'A short label for the fact that names the entities it is about.',
          },
          content: {
            type: 'string',
            description:
              'The fact, stated so it can be used on its own: name the entities it is about and keep exact values.',
          },
          about: {
            type: 'array',
            description: 'Refs of the entities the fact is about.',
            items: { type: 'string' },
          },
          source_memory_ids: {
            type: 'array',
            description: sourceIdsDescription,
            items: { type: 'string' },
          },
        },
        required: ['ref'],
      },
    },
    relationships: {
      type: 'array',
      description: 'Relationships between entities to add or remove.',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'One of the configured relationship types.' },
          source: { type: 'string', description: 'Ref of the source entity.' },
          target: { type: 'string', description: 'Ref of the target entity.' },
          remove: { type: 'boolean', description: 'True removes an existing relationship.' },
          source_memory_ids: {
            type: 'array',
            description: sourceIdsDescription,
            items: { type: 'string' },
          },
        },
        required: ['type', 'source', 'target'],
      },
    },
  },
  required: ['entities', 'facts', 'relationships'],
} as const satisfies ToolSchema;
