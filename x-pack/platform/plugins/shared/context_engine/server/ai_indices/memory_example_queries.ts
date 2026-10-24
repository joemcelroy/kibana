/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ENTITY_TYPE_PREFIX } from '../../common/dreaming';
import { LONG_TERM_FACT_TYPE_PATTERN } from './example_queries';

export interface MemoryExampleQueries {
  crossSession: string;
  findEntity: string;
  factsAboutEntity: string;
}

const latestActiveRevision = [
  '| INLINE STATS latest_at = MAX(@timestamp) BY id',
  '| WHERE @timestamp == latest_at',
  '  AND (governance.lifecycle.status IS NULL OR governance.lifecycle.status == "active")',
  '  AND (expires_at IS NULL OR expires_at > NOW())',
];

/** ES|QL examples for recalling current memory revisions from an AI-index backing target. */
export const buildMemoryExampleQueries = (target: string): MemoryExampleQueries => ({
  crossSession: [
    `FROM ${target} METADATA _id, _index, _score`,
    `| WHERE type == "memory.session_fact" OR type LIKE "${LONG_TERM_FACT_TYPE_PATTERN}"`,
    ...latestActiveRevision,
    '| FORK',
    '    ( WHERE content:"<query>" OR title:"<query>" OR description:"<query>" | SORT _score DESC | LIMIT 20 )',
    '    ( WHERE content.semantic:"<query>" OR title.semantic:"<query>" OR description.semantic:"<query>" | SORT _score DESC | LIMIT 20 )',
    '| FUSE',
    '| SORT _score DESC, _id ASC',
    '| KEEP id, title, description, content, type, tags, updated_at, references.uri, references.relation, references.description',
    '| LIMIT 10',
  ].join('\n'),
  findEntity: [
    `FROM ${target} METADATA _id, _score`,
    `| WHERE type LIKE "${ENTITY_TYPE_PREFIX}*"`,
    ...latestActiveRevision,
    '| WHERE title:"<name>" OR description:"<name>"',
    '| SORT _score DESC, _id ASC',
    '| KEEP id, title, description, type, references.uri, references.relation, references.type',
    '| LIMIT 10',
  ].join('\n'),
  factsAboutEntity: [
    `FROM ${target} METADATA _id`,
    `| WHERE type LIKE "${LONG_TERM_FACT_TYPE_PATTERN}"`,
    ...latestActiveRevision,
    '| WHERE MV_CONTAINS(references.uri, "ki://<entity id>")',
    '| SORT updated_at DESC, _id ASC',
    '| KEEP id, title, content, type, updated_at',
    '| LIMIT 50',
  ].join('\n'),
});
