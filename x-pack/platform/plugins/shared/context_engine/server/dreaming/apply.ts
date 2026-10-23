/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import pRetry from 'p-retry';
import type { ElasticsearchClient } from '@kbn/core/server';
import { ENTITY_TYPE_PREFIX, LONG_TERM_FACT_TYPE_PREFIX } from '../../common/dreaming';
import type { AiIndexDest } from '../../common/http_api/ai_indices';
import { MAX_KI_REFERENCES } from '../../common/step_types/ki';
import { KiConflictError, KiNotFoundError } from '../ai_indices/errors';
import {
  findKiRevision,
  isKiDeleted,
  putKiRevision,
  type KiWriter,
  type StoredKi,
} from '../ai_indices/ki_revision';
import { softDeleteKi } from '../ai_indices/ki_write';
import { kiUri, memoryUri, sessionUri } from './ids';
import {
  ENTITY_ATTRIBUTE_PREFIX,
  STALE_ATTRIBUTE,
  USER_ATTRIBUTE,
  citedMemoryIds,
  type DreamedKi,
  type DreamedKiAttributes,
  type DreamedKiReference,
} from './long_term';
import type {
  DreamingOperation,
  RelationshipOperation,
  UpsertEntityOperation,
  UpsertFactOperation,
} from './resolve_change_set';

const WRITE_CONFLICT_RETRIES = 3;

export const DREAMING_WRITER_URI = 'task://dreaming/default';

export const dreamingWriter = ({
  executionId,
  taskId,
  spaceId,
}: {
  executionId: string;
  taskId: string;
  spaceId: string;
}): KiWriter => ({
  uri: DREAMING_WRITER_URI,
  metadata: { run_id: executionId, task_id: taskId, space_id: spaceId },
});

export interface ApplyCounts {
  created: number;
  updated: number;
  deleted: number;
}

export const emptyCounts = (): ApplyCounts => ({ created: 0, updated: 0, deleted: 0 });

export interface ApplyContext {
  esClient: ElasticsearchClient;
  aiIndexId: string;
  dest: AiIndexDest;
  writer: KiWriter;
  userId?: string;
  abortSignal?: AbortSignal;
}

const referenceKey = ({ uri, relation, type }: DreamedKiReference): string =>
  `${relation ?? ''}\u0000${type ?? ''}\u0000${uri}`;

/**
 * Adds references without duplicates. Over the cap, the oldest `observed_in` references go
 * first, because `derived_from` is what forget relies on.
 */
export const addReferences = (
  current: readonly DreamedKiReference[] | undefined,
  additions: readonly DreamedKiReference[]
): DreamedKiReference[] => {
  const byKey = new Map<string, DreamedKiReference>();
  for (const reference of [...(current ?? []), ...additions]) {
    byKey.set(referenceKey(reference), byKey.get(referenceKey(reference)) ?? reference);
  }
  const references = [...byKey.values()];
  const dropOrder: Array<DreamedKiReference['relation']> = [
    'observed_in',
    'relates_to',
    'about',
    'derived_from',
  ];
  for (const relation of dropOrder) {
    while (references.length > MAX_KI_REFERENCES) {
      const index = references.findIndex((reference) => reference.relation === relation);
      if (index === -1) {
        break;
      }
      references.splice(index, 1);
    }
  }
  return references.slice(-MAX_KI_REFERENCES);
};

export const withoutStale = (attributes: DreamedKiAttributes | undefined): DreamedKiAttributes => {
  const { [STALE_ATTRIBUTE]: _stale, ...rest } = attributes ?? {};
  return rest;
};

const sourceReferences = (sourceMemoryIds: readonly string[]): DreamedKiReference[] =>
  sourceMemoryIds.map((id) => ({ uri: memoryUri(id), relation: 'derived_from' }));

const sessionReferences = (sessionIds: readonly string[]): DreamedKiReference[] =>
  sessionIds.map((id) => ({ uri: sessionUri(id), relation: 'observed_in' }));

type BuildDocument = (current: DreamedKi | undefined) => Omit<DreamedKi, 'governance'> | undefined;

/**
 * Writes a whole new revision of a KI built from its current one, retrying on a concurrent
 * write. `build` returning `undefined` skips the write.
 */
const writeDocument = async (
  { esClient, aiIndexId, dest, writer, abortSignal }: ApplyContext,
  kiId: string,
  build: BuildDocument
): Promise<'created' | 'updated' | 'skipped'> =>
  pRetry(
    async () => {
      const revision = await findKiRevision({
        esClient,
        aiIndexId,
        dest,
        kiId,
        includeSource: true,
        abortSignal,
      });
      const source = revision?.source as DreamedKi | undefined;
      const current = source && !isKiDeleted(source) ? source : undefined;
      const document = build(current);
      if (!document) {
        return 'skipped' as const;
      }
      const now = new Date().toISOString();
      await putKiRevision({
        esClient,
        aiIndexId,
        dest,
        kiId,
        document: {
          ...document,
          '@timestamp': now,
          id: kiId,
          updated_at: now,
          governance: {
            provenance: {
              created_by: current?.governance?.provenance?.created_by ?? writer,
              updated_by: writer,
            },
            lifecycle: { status: 'active' },
          },
        } satisfies StoredKi,
        existing: dest.type === 'data_stream' ? undefined : revision,
        failIfExists: revision === undefined,
        abortSignal,
      });
      return current ? ('updated' as const) : ('created' as const);
    },
    {
      retries: WRITE_CONFLICT_RETRIES,
      onFailedAttempt: (error) => {
        if (!(error instanceof KiConflictError)) {
          throw error;
        }
      },
    }
  );

const userAttributes = (userId: string | undefined): DreamedKiAttributes =>
  userId !== undefined ? { [USER_ATTRIBUTE]: userId } : {};

const upsertEntity = (context: ApplyContext, operation: UpsertEntityOperation) =>
  writeDocument(context, operation.id, (current) => ({
    ...current,
    id: operation.id,
    type: `${ENTITY_TYPE_PREFIX}${operation.type}`,
    title: operation.name,
    ...(operation.description !== undefined && { description: operation.description }),
    attributes: {
      ...withoutStale(current?.attributes),
      ...Object.fromEntries(
        Object.entries(operation.attributes).map(([key, value]) => [
          `${ENTITY_ATTRIBUTE_PREFIX}${key}`,
          value,
        ])
      ),
      ...userAttributes(context.userId),
    },
    references: addReferences(current?.references, [
      ...sourceReferences(operation.sourceMemoryIds),
      ...sessionReferences(operation.sessionIds),
    ]),
  }));

const upsertFact = (context: ApplyContext, operation: UpsertFactOperation) =>
  writeDocument(context, operation.id, (current) => {
    const { about } = operation;
    const kept =
      about === undefined
        ? current?.references
        : current?.references?.filter(({ relation }) => relation !== 'about');
    return {
      ...current,
      id: operation.id,
      type: `${LONG_TERM_FACT_TYPE_PREFIX}${operation.type}`,
      title: operation.title,
      content: operation.content,
      attributes: { ...withoutStale(current?.attributes), ...userAttributes(context.userId) },
      references: addReferences(kept, [
        ...(about ?? []).map((id) => ({ uri: kiUri(id), relation: 'about' as const })),
        ...sourceReferences(operation.sourceMemoryIds),
        ...sessionReferences(operation.sessionIds),
      ]),
    };
  });

const applyRelationship = (context: ApplyContext, operation: RelationshipOperation) =>
  writeDocument(context, operation.sourceId, (current) => {
    if (!current) {
      return undefined;
    }
    const relationship: DreamedKiReference = {
      uri: kiUri(operation.targetId),
      relation: 'relates_to',
      type: operation.type,
    };
    const references = operation.remove
      ? current.references?.filter(
          (reference) => referenceKey(reference) !== referenceKey(relationship)
        )
      : addReferences(current.references, [
          relationship,
          ...sourceReferences(operation.sourceMemoryIds),
        ]);
    return { ...current, references };
  });

const clearStale = (context: ApplyContext, kiId: string) =>
  writeDocument(context, kiId, (current) =>
    current?.attributes?.[STALE_ATTRIBUTE] === undefined
      ? undefined
      : { ...current, attributes: withoutStale(current.attributes) }
  );

/** Drops `derived_from` references to the given forgotten memories from a KI. */
export const pruneSources = (
  context: ApplyContext,
  kiId: string,
  forgottenMemoryIds: ReadonlySet<string>
) =>
  writeDocument(context, kiId, (current) =>
    current
      ? {
          ...current,
          references: current.references?.filter(
            ({ uri, relation }) =>
              relation !== 'derived_from' ||
              ![...forgottenMemoryIds].some((id) => uri === memoryUri(id))
          ),
        }
      : undefined
  );

/**
 * Flags a KI stale if its current revision still cites `memoryId`. Returns whether it did.
 * The check is on the current revision because a search on `references.uri` can match an older
 * one.
 */
export const markStale = async (
  context: ApplyContext,
  kiId: string,
  memoryId: string
): Promise<boolean> =>
  (await writeDocument(context, kiId, (current) =>
    current && citedMemoryIds(current).includes(memoryId)
      ? { ...current, attributes: { ...current.attributes, [STALE_ATTRIBUTE]: true } }
      : undefined
  )) !== 'skipped';

export const deleteKi = async (context: ApplyContext, kiId: string): Promise<void> => {
  const { esClient, aiIndexId, dest, writer, abortSignal } = context;
  await softDeleteKi(esClient, {
    aiIndexId,
    dest,
    kiId,
    writer,
    refresh: false,
    abortSignal,
  }).catch((error) => {
    if (!(error instanceof KiNotFoundError)) {
      throw error;
    }
  });
};

/** Applies operations in order. Writes are idempotent, so a retried task can re-apply a plan. */
export const applyOperations = async (
  context: ApplyContext,
  operations: readonly DreamingOperation[]
): Promise<ApplyCounts> => {
  const counts = emptyCounts();
  for (const operation of operations) {
    switch (operation.op) {
      case 'upsert_entity':
      case 'upsert_fact': {
        const result =
          operation.op === 'upsert_entity'
            ? await upsertEntity(context, operation)
            : await upsertFact(context, operation);
        if (result !== 'skipped') {
          counts[result] += 1;
        }
        break;
      }
      case 'relationship':
        if ((await applyRelationship(context, operation)) === 'updated') {
          counts.updated += 1;
        }
        break;
      case 'delete':
        await deleteKi(context, operation.id);
        counts.deleted += 1;
        break;
      case 'clear_stale':
        await clearStale(context, operation.id);
        break;
    }
  }
  return counts;
};
