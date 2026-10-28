/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  ConversationRoundStepType,
  type ConversationRound,
  type ConversationRoundStep,
} from '@kbn/agent-builder-common';
import { contextEngineRecallTools } from '@kbn/agent-builder-common/tools';
import { ToolResultType } from '@kbn/agent-builder-common/tools/tool_result';
import { MAX_ROUND_TRANSCRIPT_LENGTH, renderRound } from './render_round';

const toolCall = (
  toolId: string,
  params: Record<string, unknown>,
  results: Array<{ type: ToolResultType; data: unknown }>
): ConversationRoundStep =>
  ({
    type: ConversationRoundStepType.toolCall,
    tool_call_id: `${toolId}-call`,
    tool_id: toolId,
    params,
    results: results.map((result, index) => ({ tool_result_id: `r-${index}`, ...result })),
  } as ConversationRoundStep);

const round = (
  steps: ConversationRoundStep[]
): Pick<ConversationRound, 'input' | 'steps' | 'response'> => ({
  input: { message: 'Which seat do I like?' },
  steps,
  response: { message: 'You like aisle seats.' },
});

describe('renderRound', () => {
  it('shows the message, the notes and tool calls in order with their results, and the answer', () => {
    const transcript = renderRound(
      round([
        { type: ConversationRoundStepType.reasoning, reasoning: 'Look up\n the bookings.' },
        toolCall('platform.core.search', { query: 'bookings' }, [
          { type: ToolResultType.other, data: { seat: '14C', class: 'economy' } },
        ]),
        toolCall('platform.core.execute_esql', { query: 'FROM x' }, [
          { type: ToolResultType.error, data: { message: 'Unknown index [x]' } },
        ]),
      ] as ConversationRoundStep[])
    );

    expect(transcript).toBe(
      [
        '## User',
        'Which seat do I like?',
        '',
        '## Steps',
        '1. Note: Look up the bookings.',
        '2. platform.core.search: {"query":"bookings"}',
        '   Result: {"seat":"14C","class":"economy"}',
        '3. platform.core.execute_esql: {"query":"FROM x"}',
        '   Error: Unknown index [x]',
        '',
        '## Answer',
        'You like aisle seats.',
      ].join('\n')
    );
  });

  it('keeps the call to a memory tool but leaves out its result', () => {
    const transcript = renderRound(
      round([
        toolCall(contextEngineRecallTools.recall, { query: 'seat' }, [
          { type: ToolResultType.other, data: { results: [{ title: 'Prefers aisle seats' }] } },
        ]),
      ])
    );

    expect(transcript).toContain(`1. ${contextEngineRecallTools.recall}: {"query":"seat"}`);
    expect(transcript).not.toContain('Prefers aisle seats');
  });

  it('leaves out transient notes and other steps', () => {
    const transcript = renderRound(
      round([
        { type: ConversationRoundStepType.reasoning, reasoning: 'thinking…', transient: true },
      ] as ConversationRoundStep[])
    );

    expect(transcript).toContain('## Steps\n(none)\n');
  });

  const searches = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      toolCall('platform.core.search', { page: index }, [
        { type: ToolResultType.other, data: 'x'.repeat(5000) },
      ])
    );

  it('shortens results to keep every step within its length', () => {
    const transcript = renderRound(round(searches(12)));

    expect(transcript.length).toBeLessThanOrEqual(MAX_ROUND_TRANSCRIPT_LENGTH);
    expect(transcript).toContain('12. platform.core.search: {"page":11}');
    expect(transcript).toContain(`Result: ${'x'.repeat(800)}…`);
    expect(transcript).not.toContain('later steps left out');
  });

  it('leaves out the last steps when even the calls do not fit', () => {
    const transcript = renderRound(round(searches(1000)));

    expect(transcript.length).toBeLessThanOrEqual(MAX_ROUND_TRANSCRIPT_LENGTH);
    expect(transcript).not.toContain('Result:');
    expect(transcript).toMatch(/\(\d+ later steps left out\)/);
    expect(transcript.endsWith('## Answer\nYou like aisle seats.')).toBe(true);
  });
});
