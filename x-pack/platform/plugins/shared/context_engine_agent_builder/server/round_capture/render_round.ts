/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { isReasoningStep, isToolCallStep, type ConversationRound } from '@kbn/agent-builder-common';
import {
  contextEngineAiIndexTools,
  contextEngineMemoryTools,
  contextEngineRecallTools,
} from '@kbn/agent-builder-common/tools';
import { ToolResultType, type ToolResult } from '@kbn/agent-builder-common/tools/tool_result';

/** Longest transcript; dreaming shows the model at most this much of one. */
export const MAX_ROUND_TRANSCRIPT_LENGTH = 16_000;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_NOTE_LENGTH = 400;
const MAX_PARAMS_LENGTH = 600;
const MAX_ERROR_LENGTH = 600;
// Tried in order until the steps fit; after that, the last steps are left out.
const RESULT_EXCERPT_LENGTHS = [1500, 800, 400, 0];

/**
 * Tools whose results are what Context Engine already knows. Their calls stay in the transcript,
 * so dreaming sees what was looked up, but recording their results would only feed it back.
 */
const KNOWLEDGE_TOOL_IDS: ReadonlySet<string> = new Set([
  ...Object.values(contextEngineAiIndexTools),
  ...Object.values(contextEngineMemoryTools),
  ...Object.values(contextEngineRecallTools),
]);

type RenderedStep =
  | { kind: 'note'; text: string }
  | {
      kind: 'tool';
      toolId: string;
      params: string;
      result?: string;
      error?: string;
    };

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}… (+${text.length - max} characters)`;

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

const textOf = (result: ToolResult): string => {
  const { data } = result as { data: unknown };
  if (typeof data === 'string') {
    return data;
  }
  if (data && typeof data === 'object') {
    const { message } = data as { message?: unknown };
    if (result.type === ToolResultType.error && typeof message === 'string') {
      return message;
    }
  }
  return JSON.stringify(data);
};

const toRenderedSteps = (round: Pick<ConversationRound, 'steps'>): RenderedStep[] =>
  round.steps.flatMap((step): RenderedStep[] => {
    if (isReasoningStep(step)) {
      const text = oneLine(step.reasoning);
      return step.transient || text.length === 0 ? [] : [{ kind: 'note', text }];
    }
    if (!isToolCallStep(step)) {
      return [];
    }
    const errors = step.results.filter(({ type }) => type === ToolResultType.error);
    const outputs = step.results.filter(({ type }) => type !== ToolResultType.error);
    const knowledge = KNOWLEDGE_TOOL_IDS.has(step.tool_id);
    return [
      {
        kind: 'tool',
        toolId: step.tool_id,
        params: clip(JSON.stringify(step.params ?? {}), MAX_PARAMS_LENGTH),
        ...(!knowledge && outputs.length > 0 && { result: outputs.map(textOf).join('\n') }),
        ...(errors.length > 0 && {
          error: clip(errors.map(textOf).join('\n'), MAX_ERROR_LENGTH),
        }),
      },
    ];
  });

const renderSteps = (steps: RenderedStep[], excerptLength: number): string[] =>
  steps.map((step, index) => {
    const n = index + 1;
    if (step.kind === 'note') {
      return `${n}. Note: ${clip(step.text, MAX_NOTE_LENGTH)}`;
    }
    const lines = [`${n}. ${step.toolId}: ${step.params}`];
    if (step.result !== undefined && excerptLength > 0) {
      lines.push(`   Result: ${clip(step.result.trim(), excerptLength).replace(/\n/g, '\n   ')}`);
    }
    if (step.error !== undefined) {
      lines.push(`   Error: ${step.error.replace(/\n/g, '\n   ')}`);
    }
    return lines.join('\n');
  });

/**
 * Renders a completed round as the transcript dreaming reads: the user's
 * message, the agent's notes and tool calls in order with excerpts of their results, and its
 * answer, in at most {@link MAX_ROUND_TRANSCRIPT_LENGTH} characters.
 */
export const renderRound = (
  round: Pick<ConversationRound, 'input' | 'steps' | 'response'>
): string => {
  const head = ['## User', clip(round.input.message ?? '', MAX_MESSAGE_LENGTH), '', '## Steps'];
  const tail = ['', '## Answer', clip(round.response.message ?? '', MAX_MESSAGE_LENGTH)];
  // The steps join the head and the tail with one newline each.
  const budget = MAX_ROUND_TRANSCRIPT_LENGTH - head.join('\n').length - tail.join('\n').length - 2;
  const steps = toRenderedSteps(round);

  let rendered: string[] = [];
  for (const excerptLength of RESULT_EXCERPT_LENGTHS) {
    rendered = renderSteps(steps, excerptLength);
    if (rendered.join('\n').length <= budget) {
      break;
    }
  }
  let kept = rendered.length;
  const omittedNote = (omitted: number) => `(${omitted} later steps left out)`;
  const fits = (count: number) =>
    [
      ...rendered.slice(0, count),
      ...(count < rendered.length ? [omittedNote(rendered.length - count)] : []),
    ].join('\n').length <= budget;
  while (kept > 0 && !fits(kept)) {
    kept -= 1;
  }
  const body =
    rendered.length === 0
      ? ['(none)']
      : kept < rendered.length
      ? [...rendered.slice(0, kept), omittedNote(rendered.length - kept)]
      : rendered;

  return [...head, ...body, ...tail].join('\n');
};
