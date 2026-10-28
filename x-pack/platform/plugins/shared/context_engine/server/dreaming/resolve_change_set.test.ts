/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { changeSetSchema, type DreamingChangeSet } from './change_set';
import type { DreamedKi } from './long_term';
import {
  resolveChangeSet,
  vocabularyOf,
  type GraphifyTaskContext,
  type UpsertEntityOperation,
  type UpsertFactOperation,
} from './resolve_change_set';
import { sessionKiId } from './ids';

const existingEntity: DreamedKi = {
  id: 'alice/entity-person-bob',
  type: 'entity.person',
  title: 'Bob',
  references: [{ uri: 'memory://m-old', relation: 'derived_from' }],
};

const existingFact: DreamedKi = {
  id: 'alice/fact-abc',
  type: 'fact.preference',
  title: 'Coffee',
  content: 'Alice drinks coffee',
  references: [{ uri: 'memory://m-old', relation: 'derived_from' }],
};

const context = (overrides: Partial<GraphifyTaskContext> = {}): GraphifyTaskContext => ({
  executionId: 'exec-1',
  taskId: 'task-1',
  owner: 'alice',
  vocabulary: vocabularyOf({
    enabled: true,
    facts: [{ type: 'preference' }],
    entities: [{ type: 'person', attributes: ['role'] }, { type: 'team' }],
    relationships: [{ type: 'member_of', source: 'person', target: 'team' }],
  }),
  memoryIds: new Set(['m-1', 'm-2']),
  sessionByMemoryId: new Map([
    ['m-1', 's-1'],
    ['m-2', 's-1'],
  ]),
  existing: new Map([
    [existingEntity.id, existingEntity],
    [existingFact.id, existingFact],
  ]),
  ...overrides,
});

const changeSet = (value: Partial<DreamingChangeSet>): DreamingChangeSet =>
  changeSetSchema.parse(value);

describe('resolveChangeSet', () => {
  it('creates entities with deterministic ids and resolves new refs in facts and relationships', () => {
    const { operations, rejected } = resolveChangeSet(
      changeSet({
        entities: [
          {
            ref: 'new:1',
            type: 'team',
            name: 'Platform Team',
            content: 'The team Bob is a member of.',
            source_memory_ids: ['m-1'],
          },
        ],
        facts: [
          {
            ref: 'new:2',
            type: 'preference',
            title: 'Tea',
            content: 'Bob prefers tea',
            about: [existingEntity.id],
            source_memory_ids: ['m-2'],
          },
        ],
        relationships: [
          {
            type: 'member_of',
            source: existingEntity.id,
            target: 'new:1',
            source_memory_ids: ['m-1'],
          },
        ],
      }),
      context()
    );

    expect(rejected).toEqual([]);
    const entity = operations[0] as UpsertEntityOperation;
    expect(entity).toMatchObject({
      op: 'upsert_entity',
      id: 'alice/entity-team-platform-team',
      content: 'The team Bob is a member of.',
      sessionIds: ['s-1'],
    });
    const fact = operations[1] as UpsertFactOperation;
    expect(fact.op).toBe('upsert_fact');
    expect(fact.id.startsWith('alice/fact-')).toBe(true);
    expect(fact.about).toEqual([existingEntity.id]);
    expect(operations[2]).toMatchObject({
      op: 'relationship',
      sourceId: existingEntity.id,
      targetId: 'alice/entity-team-platform-team',
      type: 'member_of',
    });
  });

  it('rejects unconfigured types and attributes item by item', () => {
    const { operations, rejected } = resolveChangeSet(
      changeSet({
        entities: [
          { ref: 'new:1', type: 'robot', name: 'R2', source_memory_ids: ['m-1'] },
          {
            ref: 'new:2',
            type: 'person',
            name: 'Carol',
            attributes: [{ key: 'age', value: '40' }],
            source_memory_ids: ['m-1'],
          },
          {
            ref: 'new:3',
            type: 'person',
            name: 'Dan',
            attributes: [{ key: 'role', value: 'SRE' }],
            source_memory_ids: ['m-1'],
          },
        ],
      }),
      context()
    );

    expect(rejected.map(({ item }) => item)).toEqual(['entity new:1', 'entity new:2']);
    expect(operations).toEqual([
      expect.objectContaining({ op: 'upsert_entity', name: 'Dan', attributes: { role: 'SRE' } }),
    ]);
  });

  it('rejects sources outside the task and upserts without sources', () => {
    const { rejected } = resolveChangeSet(
      changeSet({
        facts: [
          {
            ref: 'new:1',
            type: 'preference',
            title: 'x',
            content: 'y',
            source_memory_ids: ['m-elsewhere'],
          },
          { ref: 'new:2', type: 'preference', title: 'x', content: 'y' },
        ],
      }),
      context()
    );
    expect(rejected).toHaveLength(2);
  });

  it('accepts an existing source of the KI being updated', () => {
    const { operations, rejected } = resolveChangeSet(
      changeSet({
        facts: [
          { ref: existingFact.id, content: 'Alice drinks decaf', source_memory_ids: ['m-old'] },
        ],
      }),
      context()
    );
    expect(rejected).toEqual([]);
    expect(operations[0]).toMatchObject({
      op: 'upsert_fact',
      id: existingFact.id,
      title: 'Coffee',
      content: 'Alice drinks decaf',
    });
  });

  it('only deletes loaded KIs of the matching kind', () => {
    const { operations, rejected } = resolveChangeSet(
      changeSet({
        entities: [
          { ref: existingEntity.id, delete: true },
          { ref: existingFact.id, delete: true },
          { ref: 'alice/entity-person-ghost', delete: true },
        ],
      }),
      context()
    );
    expect(operations).toEqual([{ op: 'delete', id: existingEntity.id }]);
    expect(rejected).toHaveLength(2);
  });

  it('rejects relationships whose ends have the wrong entity types', () => {
    const { rejected } = resolveChangeSet(
      changeSet({
        relationships: [
          {
            type: 'member_of',
            source: existingEntity.id,
            target: existingEntity.id,
            source_memory_ids: ['m-1'],
          },
        ],
      }),
      context()
    );
    expect(rejected).toHaveLength(1);
  });

  it('allows any entity type and only the default fact type when nothing is configured', () => {
    const { operations, rejected } = resolveChangeSet(
      changeSet({
        entities: [{ ref: 'new:1', type: 'service', name: 'checkout', source_memory_ids: ['m-1'] }],
        facts: [
          { ref: 'new:2', type: 'fact', title: 't', content: 'c', source_memory_ids: ['m-1'] },
          {
            ref: 'new:3',
            type: 'preference',
            title: 't',
            content: 'c',
            source_memory_ids: ['m-1'],
          },
        ],
      }),
      context({ vocabulary: vocabularyOf({ enabled: true }) })
    );
    expect(operations.map(({ op }) => op)).toEqual(['upsert_entity', 'upsert_fact']);
    expect(rejected.map(({ item }) => item)).toEqual(['fact new:3']);
  });

  it('clears the stale flag on stale KIs the model left out', () => {
    const stale: DreamedKi = { ...existingFact, governance: { lifecycle: { status: 'stale' } } };
    const { operations } = resolveChangeSet(
      changeSet({}),
      context({ existing: new Map([[stale.id, stale]]) })
    );
    expect(operations).toEqual([{ op: 'clear_stale', id: stale.id }]);
  });

  it('treats an entity ref it does not know as a new key, so facts can refer to it', () => {
    const { operations, rejected } = resolveChangeSet(
      changeSet({
        entities: [
          { ref: 'person:carol', type: 'person', name: 'Carol', source_memory_ids: ['m-1'] },
        ],
        facts: [
          {
            ref: 'new:1',
            type: 'preference',
            title: 'Carol likes tea',
            content: 'Carol likes tea.',
            about: ['person:carol'],
            source_memory_ids: ['m-1'],
          },
        ],
      }),
      context()
    );
    expect(rejected).toEqual([]);
    expect(operations.map(({ op }) => op)).toEqual(['upsert_entity', 'upsert_fact']);
    expect((operations[1] as UpsertFactOperation).about).toEqual(['alice/entity-person-carol']);
  });

  describe('session documents', () => {
    const currentSession: DreamedKi = {
      id: 'alice/session-current',
      type: 'memory.session',
      title: 'Planning the offsite',
      content: '2026-10-20: Alice planned the offsite.',
      attributes: { 'memory.session_id': 's-1' },
      references: [{ uri: 'memory://m-old', relation: 'derived_from' }],
    };

    it('writes one document per session, citing every memory of it', () => {
      const { operations, rejected } = resolveChangeSet(
        changeSet({
          sessions: [{ session_id: 's-1', title: 'Offsite', summary: '2026-10-25: Booked it.' }],
        }),
        context({ sessions: new Map([['s-1', undefined]]) })
      );
      expect(rejected).toEqual([]);
      expect(operations).toEqual([
        {
          op: 'upsert_session',
          id: sessionKiId('alice', 's-1'),
          sessionId: 's-1',
          title: 'Offsite',
          content: '2026-10-25: Booked it.',
          sourceMemoryIds: ['m-1', 'm-2'],
        },
      ]);
    });

    it('updates the session’s current document and keeps what it left out', () => {
      const { operations } = resolveChangeSet(
        changeSet({ sessions: [{ session_id: 's-1', summary: 'Updated.' }] }),
        context({ sessions: new Map([['s-1', currentSession]]) })
      );
      expect(operations).toEqual([
        {
          op: 'upsert_session',
          id: currentSession.id,
          sessionId: 's-1',
          title: 'Planning the offsite',
          content: 'Updated.',
          sourceMemoryIds: ['m-old', 'm-1', 'm-2'],
        },
      ]);
    });

    it('rejects sessions outside the task, or when the config keeps none', () => {
      expect(
        resolveChangeSet(
          changeSet({ sessions: [{ session_id: 's-9', title: 'x', summary: 'y' }] }),
          context({ sessions: new Map([['s-1', undefined]]) })
        ).rejected
      ).toEqual([{ item: 'session s-9', reason: "'s-9' is not a session of this task" }]);
      expect(
        resolveChangeSet(
          changeSet({ sessions: [{ session_id: 's-1', title: 'x', summary: 'y' }] }),
          context()
        ).rejected
      ).toEqual([{ item: 'session s-1', reason: 'this AI index does not keep session documents' }]);
    });

    it('clears the stale flag on a session document the model left out', () => {
      const stale: DreamedKi = {
        ...currentSession,
        governance: { lifecycle: { status: 'stale' } },
      } as DreamedKi;
      const { operations } = resolveChangeSet(
        changeSet({}),
        context({ sessions: new Map([['s-1', stale]]) })
      );
      expect(operations).toEqual([{ op: 'clear_stale', id: stale.id }]);
    });
  });
});
