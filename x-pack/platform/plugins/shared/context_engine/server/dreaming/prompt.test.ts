/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { DreamingMemory } from '../../common/dreaming';
import { buildInput, buildSystemPrompt } from './prompt';

const memoriesIn = (input: string) =>
  JSON.parse(input.split('\n\nEXISTING:')[0].replace(/^MEMORIES:\n/, ''));

describe('buildInput', () => {
  const base = { '@timestamp': '2026-10-27T10:00:00.000Z', session_id: 's-1' };

  it('shows each memory’s content or transcript', () => {
    const memories: DreamingMemory[] = [
      { ...base, id: 'note', content: 'Prefers aisle seats.' },
      { ...base, id: 'round', transcript: '## User\nWhich seat?\n## Answer\nAisle.' },
    ];

    expect(memoriesIn(buildInput({ memories, staleSources: [], existing: [] }))).toEqual([
      {
        id: 'note',
        session_id: 's-1',
        recorded_at: base['@timestamp'],
        content: 'Prefers aisle seats.',
      },
      {
        id: 'round',
        session_id: 's-1',
        recorded_at: base['@timestamp'],
        transcript: '## User\nWhich seat?\n## Answer\nAisle.',
      },
    ]);
  });

  it('cuts a long transcript', () => {
    const memories: DreamingMemory[] = [{ ...base, id: 'round', transcript: 'x'.repeat(17_000) }];

    const [shown] = memoriesIn(buildInput({ memories, staleSources: [], existing: [] }));

    expect(shown.transcript).toHaveLength(16_001);
  });

  it('tells the model what to take from a transcript', () => {
    expect(buildSystemPrompt({ enabled: true })).toContain(
      'A transcript records one conversation round as it happened'
    );
  });
});

describe('buildSystemPrompt', () => {
  const config = {
    enabled: true,
    facts: [{ type: 'preference' }],
    entities: {
      nodes: [{ type: 'person' }],
      edges: [{ type: 'knows', source: 'person', target: 'person' }],
    },
  };

  it('asks for facts, entities and relationships when all are configured', () => {
    const prompt = buildSystemPrompt(config);

    expect(prompt).toContain('entities, facts about them, and relationships between entities');
    expect(prompt).toContain('FACT TYPES:\n- preference');
    expect(prompt).toContain('ENTITY TYPES:\n- person');
    expect(prompt).toContain('List every entity a fact is about');
  });

  it('asks for standalone facts only while entities are not configured', () => {
    const prompt = buildSystemPrompt({ ...config, entities: null });

    expect(prompt).toContain('long-term memory: standalone facts.');
    expect(prompt).toContain('ENTITY TYPES: none; return no entities.');
    expect(prompt).toContain('RELATIONSHIP TYPES: none; return no relationships.');
    expect(prompt).not.toContain('List every entity a fact is about');
  });

  it('asks for entities and relationships only while facts are empty', () => {
    const prompt = buildSystemPrompt({ ...config, facts: [] });

    expect(prompt).toContain('long-term memory: entities and relationships between them.');
    expect(prompt).toContain('FACT TYPES: none; return no facts.');
    expect(prompt).toContain('ENTITY TYPES:\n- person');
  });

  it('asks for no relationships while edges are empty', () => {
    const prompt = buildSystemPrompt({ ...config, entities: { nodes: config.entities.nodes } });

    expect(prompt).toContain('long-term memory: entities, facts about them.');
    expect(prompt).toContain('RELATIONSHIP TYPES: none; return no relationships.');
    expect(prompt).not.toContain('Add a relationship of a configured type');
  });

  it('asks the model to cite an item seen again', () => {
    expect(buildSystemPrompt(config)).toContain('that records that it was seen again');
  });
});

describe('existing items in the input', () => {
  it('show how often and when each was last seen', () => {
    const input = buildInput({
      memories: [],
      staleSources: [],
      existing: [
        {
          id: 'alice/fact-tea',
          type: 'fact.preference',
          title: 'Tea',
          content: 'Bob prefers tea',
          attributes: {
            'memory.number_of_occurrences': 3,
            'memory.last_seen_at': '2026-10-02T10:00:00.000Z',
          },
          references: [{ uri: 'memory://m-1', relation: 'derived_from' }],
        },
      ],
    });
    const [shown] = JSON.parse(input.split('EXISTING:\n')[1]);

    expect(shown).toEqual(
      expect.objectContaining({
        number_of_occurrences: 3,
        last_seen_at: '2026-10-02T10:00:00.000Z',
      })
    );
  });
});

describe('existing entities in the input', () => {
  it('show attributes by their own names, old entity.<key> ones included', () => {
    const input = buildInput({
      memories: [],
      staleSources: [],
      existing: [
        {
          id: 'alice/entity-problem-delay',
          type: 'entity.problem',
          title: 'Delay',
          attributes: {
            category: 'Flight Disruption',
            'entity.severity': 'high',
            'memory.user_id': 'alice',
            esql: ['FROM flights | LIMIT 1'],
          },
        },
      ],
    });
    const [shown] = JSON.parse(input.split('EXISTING:\n')[1]);

    expect(shown.attributes).toEqual({ category: 'Flight Disruption', severity: 'high' });
  });
});
