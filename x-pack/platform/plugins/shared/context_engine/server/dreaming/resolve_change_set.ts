/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  DREAMING_TYPE_PATTERN,
  ENTITY_TYPE_PREFIX,
  FACT_TYPE_PREFIX,
  l1TypesOf,
  type AiIndexDreamingConfig,
  type DreamingRelationshipType,
} from '../../common/dreaming';
import { baseContent, type AccessPattern } from './access_patterns';
import type { DreamingChangeSet } from './change_set';
import { entityId, factId, sessionKiId } from './ids';
import { citedMemoryIds, isStale, type DreamedKi } from './long_term';

const NEW_REF_PREFIX = 'new:';

/** Which types the model may write. An empty kind is off. */
export interface DreamingVocabulary {
  factTypes: ReadonlySet<string>;
  /** Each entity type with its attribute keys. */
  entityTypes: ReadonlyMap<string, ReadonlySet<string>>;
  relationshipTypes: ReadonlyMap<string, DreamingRelationshipType>;
}

export const vocabularyOf = (config: AiIndexDreamingConfig): DreamingVocabulary => {
  const { facts, entities, relationships } = l1TypesOf(config);
  return {
    factTypes: new Set(facts.map(({ type }) => type)),
    entityTypes: new Map(entities.map(({ type, attributes }) => [type, new Set(attributes ?? [])])),
    relationshipTypes: new Map(relationships.map((rel) => [rel.type, rel])),
  };
};

export interface GraphifyTaskContext {
  executionId: string;
  taskId: string;
  owner: string;
  vocabulary: DreamingVocabulary;
  /** This task's new memory ids. */
  memoryIds: ReadonlySet<string>;
  /** The session each known memory was recorded in. */
  sessionByMemoryId: ReadonlyMap<string, string>;
  /** When each known memory was recorded: its `occurred_at`, else its `@timestamp`. */
  recordedAtByMemoryId: ReadonlyMap<string, string>;
  /** The owner's current entities and facts by id. */
  existing: ReadonlyMap<string, DreamedKi>;
  /**
   * When the config keeps session documents: the task's sessions, each with its current session
   * document if it has one. Absent rejects every session entry.
   */
  sessions?: ReadonlyMap<string, DreamedKi | undefined>;
}

export interface UpsertEntityOperation {
  op: 'upsert_entity';
  id: string;
  type: string;
  name: string;
  description?: string;
  content?: string;
  attributes: Record<string, string>;
  /** Replaces the entity's access patterns. `undefined` keeps them. */
  accessPatterns?: AccessPattern[];
  sourceMemoryIds: string[];
  sessionIds: string[];
  /** When the latest of its sources was recorded. */
  lastSeenAt?: string;
}

export interface UpsertFactOperation {
  op: 'upsert_fact';
  id: string;
  type: string;
  title: string;
  content: string;
  /** Replaces the fact's `about` references. `undefined` keeps them. */
  about?: string[];
  /** Replaces the fact's access patterns. `undefined` keeps them. */
  accessPatterns?: AccessPattern[];
  sourceMemoryIds: string[];
  sessionIds: string[];
  /** When the latest of its sources was recorded. */
  lastSeenAt?: string;
}

export interface UpsertSessionOperation {
  op: 'upsert_session';
  id: string;
  sessionId: string;
  title: string;
  content: string;
  sourceMemoryIds: string[];
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
  /** When the latest of its sources was recorded; it marks the source entity as seen. */
  lastSeenAt?: string;
}

export interface ClearStaleOperation {
  op: 'clear_stale';
  id: string;
}

export type DreamingOperation =
  | UpsertEntityOperation
  | UpsertFactOperation
  | UpsertSessionOperation
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
  if (ki.type.startsWith(FACT_TYPE_PREFIX)) {
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
  const {
    executionId,
    taskId,
    owner,
    vocabulary,
    memoryIds,
    sessionByMemoryId,
    recordedAtByMemoryId,
    existing,
    sessions,
  } = context;
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

  const lastSeenAtOf = (sourceIds: readonly string[]): { lastSeenAt?: string } => {
    const recordedAt = sourceIds
      .flatMap((id) => recordedAtByMemoryId.get(id) ?? [])
      .sort((a, b) => Date.parse(a) - Date.parse(b));
    const lastSeenAt = recordedAt[recordedAt.length - 1];
    return lastSeenAt !== undefined ? { lastSeenAt } : {};
  };

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
      if (vocabulary.entityTypes.size === 0) {
        reject('this AI index does not build entities');
      }
      const current = existingOfKind(entity.ref, 'entity');
      if (entity.delete) {
        if (!current) {
          reject('only an existing entity can be deleted');
        }
        operations.push({ op: 'delete', id: entity.ref });
        touched.add(entity.ref);
        return;
      }
      // Any other ref is a new key: models often label new entities in their own way, and an
      // entity's id comes from its type and name, so a new key can never duplicate one.
      const type = entity.type ?? current?.type.slice(ENTITY_TYPE_PREFIX.length);
      const name = entity.name ?? current?.title;
      if (!type || !name) {
        reject('a new entity needs a type and a name');
      }
      assertTypePattern(type);
      const allowedAttributes = vocabulary.entityTypes.get(type);
      if (!allowedAttributes) {
        reject(`entity type '${type}' is not configured`);
      }
      const attributes: Record<string, string> = {};
      for (const { key, value } of entity.attributes ?? []) {
        if (!allowedAttributes.has(key)) {
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
        ...(entity.content !== undefined && { content: entity.content }),
        attributes,
        ...(entity.access_patterns && { accessPatterns: entity.access_patterns }),
        sourceMemoryIds,
        sessionIds: sessionsOf(sourceMemoryIds),
        ...lastSeenAtOf(sourceMemoryIds),
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
      if (vocabulary.factTypes.size === 0) {
        reject('this AI index does not build facts');
      }
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
      const type = fact.type ?? current?.type.slice(FACT_TYPE_PREFIX.length);
      const title = fact.title ?? current?.title;
      const content = fact.content ?? baseContent(current?.content);
      if (!type || !title || !content) {
        reject('a fact needs a type, a title, and content');
      }
      if (!vocabulary.factTypes.has(type)) {
        reject(`fact type '${type}' is not configured`);
      }
      // Without entities a fact is about nothing; its current `about` references are kept.
      const about = vocabulary.entityTypes.size > 0 ? fact.about?.map(resolveEntityRef) : undefined;
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
        ...(fact.access_patterns && { accessPatterns: fact.access_patterns }),
        sourceMemoryIds,
        sessionIds: sessionsOf(sourceMemoryIds),
        ...lastSeenAtOf(sourceMemoryIds),
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
        if (vocabulary.relationshipTypes.size === 0) {
          reject('this AI index does not build relationships');
        }
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
        const sourceMemoryIds = remove
          ? []
          : resolveSources(relationship.source_memory_ids, existing.get(sourceId));
        operations.push({
          op: 'relationship',
          sourceId,
          targetId,
          type: relationship.type,
          remove,
          sourceMemoryIds,
          ...lastSeenAtOf(sourceMemoryIds),
        });
      }
    );
  }

  for (const session of changeSet.sessions) {
    attempt(`session ${session.session_id}`, () => {
      if (!sessions) {
        reject('this AI index does not keep session documents');
      }
      if (!sessions.has(session.session_id)) {
        reject(`'${session.session_id}' is not a session of this task`);
      }
      const current = sessions.get(session.session_id);
      const title = session.title ?? current?.title;
      const content = session.summary ?? current?.content;
      if (!title || !content) {
        reject('a session document needs a title and a summary');
      }
      // A session document stands for the whole session, so it cites every memory of it.
      const sourceMemoryIds = [
        ...new Set([
          ...(current ? citedMemoryIds(current) : []),
          ...[...memoryIds].filter((id) => sessionByMemoryId.get(id) === session.session_id),
        ]),
      ];
      if (sourceMemoryIds.length === 0) {
        reject('the session has no memories to cite');
      }
      const id = current?.id ?? sessionKiId(owner, session.session_id);
      touched.add(id);
      operations.push({
        op: 'upsert_session',
        id,
        sessionId: session.session_id,
        title,
        content,
        sourceMemoryIds,
      });
    });
  }

  const sessionDocuments = [...(sessions?.values() ?? [])].flatMap((ki) => (ki ? [ki] : []));
  for (const ki of [...existing.values(), ...sessionDocuments]) {
    if (isStale(ki) && !touched.has(ki.id)) {
      operations.push({ op: 'clear_stale', id: ki.id });
    }
  }

  return { operations, rejected };
};
