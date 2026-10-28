/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// A port of `context_engine_agent_builder/server/round_capture/render_round.ts`, the transcript
// Agent Builder's round capture saves. Keep the two in step: dreaming reads both the same way.

/** Longest transcript; dreaming shows the model at most this much of one. */
export const MAX_ROUND_TRANSCRIPT_LENGTH = 16_000;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_NOTE_LENGTH = 400;
const MAX_PARAMS_LENGTH = 600;
const MAX_ERROR_LENGTH = 600;
// Tried in order until the steps fit; after that, the last steps are left out.
const RESULT_EXCERPT_LENGTHS = [1500, 800, 400, 0];

/**
 * Tools whose results are what Context Engine already knows: this plugin's own MCP tools. Their
 * calls stay in the transcript, so dreaming sees what was looked up, but recording their results
 * would only feed it back.
 */
const KNOWLEDGE_TOOL =
  /^mcp__.*context[-_]engine.*__(recall|remember|describe_ai_index|list_ai_indices)$/;

export const isKnowledgeTool = (toolId) => KNOWLEDGE_TOOL.test(toolId);

const clip = (text, max) =>
  text.length <= max ? text : `${text.slice(0, max)}… (+${text.length - max} characters)`;

const oneLine = (text) => text.replace(/\s+/g, ' ').trim();

const textOf = (result) => {
  const { data } = result;
  if (typeof data === 'string') {
    return data;
  }
  if (data && typeof data === 'object') {
    const { message } = data;
    if (result.type === 'error' && typeof message === 'string') {
      return message;
    }
  }
  return JSON.stringify(data);
};

const toRenderedSteps = (round) =>
  round.steps.flatMap((step) => {
    if (step.type === 'reasoning') {
      const text = oneLine(step.reasoning);
      return step.transient || text.length === 0 ? [] : [{ kind: 'note', text }];
    }
    if (step.type !== 'tool_call') {
      return [];
    }
    const errors = step.results.filter(({ type }) => type === 'error');
    const outputs = step.results.filter(({ type }) => type !== 'error');
    const knowledge = isKnowledgeTool(step.tool_id);
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

const renderSteps = (steps, excerptLength) =>
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
 * Renders a completed round as the transcript dreaming reads: the user's message, the agent's
 * notes and tool calls in order with excerpts of their results, and its answer, in at most
 * {@link MAX_ROUND_TRANSCRIPT_LENGTH} characters.
 *
 * `round` has Agent Builder's shape: `{ input: { message }, steps, response: { message } }`, where
 * a step is `{ type: 'reasoning', reasoning, transient? }` or
 * `{ type: 'tool_call', tool_id, params, results: [{ type: 'error' | 'other', data }] }`.
 */
export const renderRound = (round) => {
  const head = ['## User', clip(round.input.message ?? '', MAX_MESSAGE_LENGTH), '', '## Steps'];
  const tail = ['', '## Answer', clip(round.response.message ?? '', MAX_MESSAGE_LENGTH)];
  // The steps join the head and the tail with one newline each.
  const budget = MAX_ROUND_TRANSCRIPT_LENGTH - head.join('\n').length - tail.join('\n').length - 2;
  const steps = toRenderedSteps(round);

  let rendered = [];
  for (const excerptLength of RESULT_EXCERPT_LENGTHS) {
    rendered = renderSteps(steps, excerptLength);
    if (rendered.join('\n').length <= budget) {
      break;
    }
  }
  let kept = rendered.length;
  const omittedNote = (omitted) => `(${omitted} later steps left out)`;
  const fits = (count) =>
    [
      ...rendered.slice(0, count),
      ...(count < rendered.length ? [omittedNote(rendered.length - count)] : []),
    ].join('\n').length <= budget;
  while (kept > 0 && !fits(kept)) {
    kept -= 1;
  }
  let body = rendered;
  if (rendered.length === 0) {
    body = ['(none)'];
  } else if (kept < rendered.length) {
    body = [...rendered.slice(0, kept), omittedNote(rendered.length - kept)];
  }

  return [...head, ...body, ...tail].join('\n');
};
