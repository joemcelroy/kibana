/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { elasticsearchServiceMock } from '@kbn/core/server/mocks';
import { findKiRevision, putKiRevision, type KiRevision } from '../ai_indices/ki_revision';
import { applyOperations, markStale, pruneSources, type ApplyContext } from './apply';
import type { DreamedKi } from './long_term';

jest.mock('../ai_indices/ki_revision', () => ({
  ...jest.requireActual('../ai_indices/ki_revision'),
  findKiRevision: jest.fn(),
  putKiRevision: jest.fn(),
}));

const findKiRevisionMock = findKiRevision as jest.MockedFunction<typeof findKiRevision>;
const putKiRevisionMock = putKiRevision as jest.MockedFunction<typeof putKiRevision>;

const context: ApplyContext = {
  esClient: elasticsearchServiceMock.createElasticsearchClient(),
  aiIndexId: 'memory',
  dest: { type: 'index', value: 'ai-index-idx-memory' },
  writer: { uri: 'task://dreaming/default', metadata: { run_id: 'exec-1' } },
  userId: 'alice',
};

const ki = (status: 'active' | 'stale', sources = ['m-1', 'm-2']): DreamedKi => ({
  id: 'alice/entity-person-bob',
  type: 'entity.person',
  title: 'Bob',
  references: sources.map((id) => ({ uri: `memory://${id}`, relation: 'derived_from' as const })),
  governance: { lifecycle: { status } },
});

const revisionOf = (source: DreamedKi): KiRevision => ({
  index: 'ai-index-idx-memory',
  documentId: source.id,
  seqNo: 1,
  primaryTerm: 1,
  source,
});

const written = () => putKiRevisionMock.mock.calls.map(([{ document }]) => document as DreamedKi);
const statusesWritten = () => written().map(({ governance }) => governance?.lifecycle?.status);

describe('dreaming apply', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    putKiRevisionMock.mockResolvedValue(undefined);
  });

  it('marks a KI stale only while its current revision cites the memory', async () => {
    findKiRevisionMock.mockResolvedValue(revisionOf(ki('active')));
    expect(await markStale(context, 'alice/entity-person-bob', 'm-1')).toBe(true);
    expect(await markStale(context, 'alice/entity-person-bob', 'm-9')).toBe(false);
    expect(statusesWritten()).toEqual(['stale']);
  });

  it('keeps a stale KI stale when pruning a forgotten source', async () => {
    findKiRevisionMock.mockResolvedValue(revisionOf(ki('stale')));

    await pruneSources(context, 'alice/entity-person-bob', new Set(['m-1']));

    expect(statusesWritten()).toEqual(['stale']);
    expect(written()[0].references).toEqual([{ uri: 'memory://m-2', relation: 'derived_from' }]);
  });

  it('makes a stale KI active again when the model rewrites it or leaves it out', async () => {
    findKiRevisionMock.mockResolvedValue(revisionOf(ki('stale')));

    await applyOperations(context, [
      {
        op: 'upsert_entity',
        id: 'alice/entity-person-bob',
        type: 'person',
        name: 'Bob',
        attributes: {},
        sourceMemoryIds: ['m-2'],
        sessionIds: ['s-1'],
      },
      { op: 'clear_stale', id: 'alice/entity-person-bob' },
    ]);

    expect(statusesWritten()).toEqual(['active', 'active']);
  });

  it('leaves a stale source entity stale when only a relationship changes', async () => {
    findKiRevisionMock.mockResolvedValue(revisionOf(ki('stale')));

    await applyOperations(context, [
      {
        op: 'relationship',
        sourceId: 'alice/entity-person-bob',
        targetId: 'alice/entity-team-platform',
        type: 'member_of',
        remove: false,
        sourceMemoryIds: ['m-2'],
      },
    ]);

    expect(statusesWritten()).toEqual(['stale']);
  });

  it('writes the entity content summary, and keeps it when an update leaves it out', async () => {
    const upsert = (content?: string) => ({
      op: 'upsert_entity' as const,
      id: 'alice/entity-person-bob',
      type: 'person',
      name: 'Bob',
      ...(content !== undefined && { content }),
      attributes: {},
      sourceMemoryIds: ['m-2'],
      sessionIds: ['s-1'],
    });
    findKiRevisionMock.mockResolvedValueOnce(revisionOf(ki('active')));
    await applyOperations(context, [upsert('Bob prefers tea.')]);
    findKiRevisionMock.mockResolvedValueOnce(revisionOf(written()[0]));
    await applyOperations(context, [upsert()]);

    expect(written().map(({ content }) => content)).toEqual([
      'Bob prefers tea.',
      'Bob prefers tea.',
    ]);
  });

  it('renders access patterns into the content, and keeps them when an update leaves them out', async () => {
    const accessPatterns = [
      {
        question_type: 'orders',
        esql_template: 'FROM orders | WHERE customer == ?customer',
        esql_example: 'FROM orders | WHERE customer == "Bob" | LIMIT 5',
        returns: "Bob's orders",
      },
    ];
    const upsert = (patterns?: typeof accessPatterns) => ({
      op: 'upsert_entity' as const,
      id: 'alice/entity-person-bob',
      type: 'person',
      name: 'Bob',
      content: 'Bob prefers tea.',
      attributes: {},
      ...(patterns && { accessPatterns: patterns }),
      sourceMemoryIds: ['m-2'],
      sessionIds: ['s-1'],
    });
    findKiRevisionMock.mockResolvedValueOnce(revisionOf(ki('active')));
    await applyOperations(context, [upsert(accessPatterns)]);
    findKiRevisionMock.mockResolvedValueOnce(revisionOf(written()[0]));
    await applyOperations(context, [upsert()]);
    findKiRevisionMock.mockResolvedValueOnce(revisionOf(written()[1]));
    await applyOperations(context, [upsert([])]);

    const [first, kept, cleared] = written();
    expect(first.content).toContain("## Access patterns\n- [orders] Bob's orders");
    expect(first.attributes?.esql).toEqual(['FROM orders | WHERE customer == "Bob" | LIMIT 5']);
    expect(kept.content).toBe(first.content);
    expect(kept.attributes).toEqual(first.attributes);
    expect(cleared.content).toBe('Bob prefers tea.');
    expect(cleared.attributes).not.toHaveProperty('esql');
    expect(cleared.attributes).not.toHaveProperty('access_patterns');
  });

  it('skips clearing a KI that is not stale', async () => {
    findKiRevisionMock.mockResolvedValue(revisionOf(ki('active')));

    await applyOperations(context, [{ op: 'clear_stale', id: 'alice/entity-person-bob' }]);

    expect(putKiRevisionMock).not.toHaveBeenCalled();
  });
});
