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
