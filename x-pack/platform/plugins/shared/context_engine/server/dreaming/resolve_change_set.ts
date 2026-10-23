/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  DEFAULT_DREAMING_FACT_TYPE,
  ENTITY_TYPE_PREFIX,
  LONG_TERM_FACT_TYPE_PREFIX,
  type AiIndexDreamingConfig,
  type DreamingRelationshipType,
} from '../../common/dreaming';
import type { DreamingChangeSet } from './change_set';
import { entityId, factId } from './ids';
import { citedMemoryIds, isStale, type DreamedKi } from './long_term';

export const DREAMING_TYPE_PATTERN = /^[a-z0-9_]+$/;

const NEW_REF_PREFIX = 'new:';

/** The config with defaults applied: which types the model may write. */
export interface DreamingVocabulary {
  factTypes: ReadonlySet<string>;
  /** `undefined` allows any entity type, with any attribute keys. */
  entityTypes?: ReadonlyMap<string, ReadonlySet<string>>;
  relationshipTypes: ReadonlyMap<string, DreamingRelationshipType>;
}

export const vocabularyOf = (config: AiIndexDreamingConfig): DreamingVocabulary => ({
  factTypes: new Set(
    config.facts && config.facts.length > 0
      ? config.facts.map(({ type }) => type)
      : [DEFAULT_DREAMING_FACT_TYPE]
  ),
  ...(config.entities &&
    config.entities.length > 0 && {
      entityTypes: new Map(
        config.entities.map(({ type, attributes }) => [type, new Set(attributes ?? [])])
      ),
    }),
  relationshipTypes: new Map((config.relationships ?? []).map((rel) => [rel.type, rel])),
});

export interface GraphifyTaskContext {
  executionId: string;
  taskId: string;
  owner: string;
  vocabulary: DreamingVocabulary;
  /** This task's new memory ids. */
  memoryIds: ReadonlySet<string>;
  /** The session each known memory was recorded in. */
  sessionByMemoryId: ReadonlyMap<string, string>;
  /** The owner's current entities and facts by id. */
  existing: ReadonlyMap<string, DreamedKi>;
}

export interface UpsertEntityOperation {
  op: 'upsert_entity';
  id: string;
  type: string;
  name: string;
  description?: string;
  attributes: Record<string, string>;
  sourceMemoryIds: string[];
  sessionIds: string[];
}

export interface UpsertFactOperation {
  op: 'upsert_fact';
  id: string;
  type: string;
  title: string;
  content: string;
  /** Replaces the fact's `about` references. `undefined` keeps them. */
  about?: string[];
  sourceMemoryIds: string[];
  sessionIds: string[];
}

export interface DeleteOperation {
  op: 'delete';
  id: string;
}

export interface RelationshipOperation {
  op: 'relationship';
  sourceId: string;
  targetId: string;
  type: string;
  remove: boolean;
  sourceMemoryIds: string[];
}

export interface ClearStaleOperation {
  op: 'clear_stale';
  id: string;
}

export type DreamingOperation =
  | UpsertEntityOperation
  | UpsertFactOperation
  | DeleteOperation
  | RelationshipOperation
  | ClearStaleOperation;

export interface ResolvedChangeSet {
  operations: DreamingOperation[];
  rejected: Array<{ item: string; reason: string }>;
}

const kindOf = (ki: DreamedKi): 'entity' | 'fact' | undefined => {
  if (ki.type.startsWith(ENTITY_TYPE_PREFIX)) {
    return 'entity';
  }
  if (ki.type.startsWith(LONG_TERM_FACT_TYPE_PREFIX)) {
    return 'fact';
  }
  return undefined;
};

class RejectedItemError extends Error {}

// Annotated so control flow narrows after a call.
const reject: (reason: string) => never = (reason) => {
  throw new RejectedItemError(reason);
};

/**
 * Checks a model change set against the vocabulary and what the task loaded, and resolves every
 * ref to its final KI id. Invalid items are rejected one by one; the rest still apply.
 */
export const resolveChangeSet = (
  changeSet: DreamingChangeSet,
  context: GraphifyTaskContext
): ResolvedChangeSet => {
  const { executionId, taskId, owner, vocabulary, memoryIds, sessionByMemoryId, existing } =
    context;
  const operations: DreamingOperation[] = [];
  const rejected: ResolvedChangeSet['rejected'] = [];
  const touched = new Set<string>();
  /** New entity keys, and existing entity ids, to their final id. */
  const entityRefs = new Map<string, string>();
  for (const [id, ki] of existing) {
    if (kindOf(ki) === 'entity') {
      entityRefs.set(id, id);
    }
  }

  const attempt = (item: string, run: () => void) => {
    try {
      run();
    } catch (error) {
      if (!(error instanceof RejectedItemError)) {
        throw error;
      }
      rejected.push({ item, reason: error.message });
    }
  };

  const resolveSources = (ids: readonly string[] | undefined, current?: DreamedKi): string[] => {
    const allowed = new Set([...memoryIds, ...(current ? citedMemoryIds(current) : [])]);
    const sources = [...new Set(ids ?? [])];
    const unknown = sources.filter((id) => !allowed.has(id));
    if (unknown.length > 0) {
      reject(`cites memories that are not part of this task: ${unknown.join(', ')}`);
    }
    if (sources.length === 0) {
      reject('cites no source memories');
    }
    return sources;
  };

  const sessionsOf = (sourceIds: readonly string[]): string[] => [
    ...new Set(sourceIds.flatMap((id) => sessionByMemoryId.get(id) ?? [])),
  ];

  const existingOfKind = (ref: string, kind: 'entity' | 'fact'): DreamedKi | undefined => {
    const ki = existing.get(ref);
    if (ki && kindOf(ki) !== kind) {
      reject(`'${ref}' is not an existing ${kind}`);
    }
    return ki;
  };

  const assertTypePattern = (type: string) => {
    if (!DREAMING_TYPE_PATTERN.test(type)) {
      reject(`type '${type}' must be lowercase letters, digits, and underscores`);
    }
  };

  // Entities first, so facts and relationships can refer to new entity keys.
  for (const entity of changeSet.entities) {
    attempt(`entity ${entity.ref}`, () => {
      const current = existingOfKind(entity.ref, 'entity');
      if (entity.delete) {
        if (!current) {
          reject('only an existing entity can be deleted');
        }
        operations.push({ op: 'delete', id: entity.ref });
        touched.add(entity.ref);
        return;
      }
      if (!current && !entity.ref.startsWith(NEW_REF_PREFIX)) {
        reject(`'${entity.ref}' is neither an existing entity nor a new key`);
      }
      const type = entity.type ?? current?.type.slice(ENTITY_TYPE_PREFIX.length);
      const name = entity.name ?? current?.title;
      if (!type || !name) {
        reject('a new entity needs a type and a name');
      }
      assertTypePattern(type);
      const allowedAttributes = vocabulary.entityTypes?.get(type);
      if (vocabulary.entityTypes && !allowedAttributes) {
        reject(`entity type '${type}' is not configured`);
      }
      const attributes: Record<string, string> = {};
      for (const { key, value } of entity.attributes ?? []) {
        if (allowedAttributes && !allowedAttributes.has(key)) {
          reject(`attribute '${key}' is not configured for entity type '${type}'`);
        }
        attributes[key] = value;
      }
      const sourceMemoryIds = resolveSources(entity.source_memory_ids, current);
      const id = current?.id ?? entityId(owner, type, name);
      entityRefs.set(entity.ref, id);
      touched.add(id);
      operations.push({
        op: 'upsert_entity',
        id,
        type,
        name,
        ...(entity.description !== undefined && { description: entity.description }),
        attributes,
        sourceMemoryIds,
        sessionIds: sessionsOf(sourceMemoryIds),
      });
    });
  }

  const resolveEntityRef = (ref: string): string => {
    const id = entityRefs.get(ref);
    if (id === undefined) {
      reject(`'${ref}' does not refer to an entity`);
    }
    return id;
  };

  for (const fact of changeSet.facts) {
    attempt(`fact ${fact.ref}`, () => {
      const current = existingOfKind(fact.ref, 'fact');
      if (fact.delete) {
        if (!current) {
          reject('only an existing fact can be deleted');
        }
        operations.push({ op: 'delete', id: fact.ref });
        touched.add(fact.ref);
        return;
      }
      if (!current && !fact.ref.startsWith(NEW_REF_PREFIX)) {
        reject(`'${fact.ref}' is neither an existing fact nor a new key`);
      }
      const type = fact.type ?? current?.type.slice(LONG_TERM_FACT_TYPE_PREFIX.length);
      const title = fact.title ?? current?.title;
      const content = fact.content ?? current?.content;
      if (!type || !title || !content) {
        reject('a fact needs a type, a title, and content');
      }
      if (!vocabulary.factTypes.has(type)) {
        reject(`fact type '${type}' is not configured`);
      }
      const about = fact.about?.map(resolveEntityRef);
      const sourceMemoryIds = resolveSources(fact.source_memory_ids, current);
      const id = current?.id ?? factId(owner, executionId, taskId, fact.ref);
      touched.add(id);
      operations.push({
        op: 'upsert_fact',
        id,
        type,
        title,
        content,
        ...(about && { about }),
        sourceMemoryIds,
        sessionIds: sessionsOf(sourceMemoryIds),
      });
    });
  }

  const entityTypeOf = (id: string): string | undefined => {
    const upserted = operations.find(
      (operation): operation is UpsertEntityOperation =>
        operation.op === 'upsert_entity' && operation.id === id
    );
    return upserted?.type ?? existing.get(id)?.type.slice(ENTITY_TYPE_PREFIX.length);
  };

  for (const relationship of changeSet.relationships) {
    attempt(
      `relationship ${relationship.source} ${relationship.type} ${relationship.target}`,
      () => {
        const configured = vocabulary.relationshipTypes.get(relationship.type);
        if (!configured) {
          reject(`relationship type '${relationship.type}' is not configured`);
        }
        const sourceId = resolveEntityRef(relationship.source);
        const targetId = resolveEntityRef(relationship.target);
        if (
          entityTypeOf(sourceId) !== configured?.source ||
          entityTypeOf(targetId) !== configured?.target
        ) {
          reject(
            `'${relationship.type}' connects a '${configured?.source}' to a '${configured?.target}'`
          );
        }
        const remove = relationship.remove === true;
        operations.push({
          op: 'relationship',
          sourceId,
          targetId,
          type: relationship.type,
          remove,
          sourceMemoryIds: remove
            ? []
            : resolveSources(relationship.source_memory_ids, existing.get(sourceId)),
        });
      }
    );
  }

  for (const [id, ki] of existing) {
    if (isStale(ki) && !touched.has(id)) {
      operations.push({ op: 'clear_stale', id });
    }
  }

  return { operations, rejected };
};
