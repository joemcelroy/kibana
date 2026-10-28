/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { readFile } from 'node:fs/promises';

const contentBlocks = (entry) => {
  const content = entry.message?.content;
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return Array.isArray(content) ? content : [];
};

const isToolResultEntry = (entry) =>
  contentBlocks(entry).some(({ type }) => type === 'tool_result');

/** A message that starts a turn: typed by the user, or a notification Claude Code sent in. */
const isPrompt = (entry) =>
  entry.type === 'user' && !entry.isMeta && !entry.isSidechain && !isToolResultEntry(entry);

const textOfBlocks = (blocks) =>
  blocks
    .filter(({ type }) => type === 'text')
    .map(({ text }) => text)
    .join('\n');

const toolResultText = (content) => {
  if (typeof content === 'string') {
    return content;
  }
  return Array.isArray(content)
    ? content.map((block) => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n')
    : JSON.stringify(content ?? null);
};

export const readTranscript = async (path) =>
  (await readFile(path, 'utf8')).split('\n').flatMap((line) => {
    if (!line.trim()) {
      return [];
    }
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });

/**
 * The entries of the last turn, oldest first, following `parentUuid` back from the newest entry
 * so a rewound branch is left out. The first entry is the prompt that started the turn.
 */
const lastTurnEntries = (entries) => {
  const chain = entries.filter((entry) => entry.uuid && !entry.isSidechain);
  const byUuid = new Map(chain.map((entry) => [entry.uuid, entry]));
  const leaf = [...chain].reverse().find(({ type }) => type === 'user' || type === 'assistant');
  const turn = [];
  for (let entry = leaf; entry; entry = byUuid.get(entry.parentUuid)) {
    turn.unshift(entry);
    if (isPrompt(entry)) {
      return turn;
    }
  }
  return undefined;
};

/**
 * The last turn of a Claude Code transcript as an Agent Builder round, the shape `renderRound`
 * takes: the prompt, the thinking, notes and tool calls in order, and the final answer.
 */
export const lastRound = (entries, { lastAssistantMessage } = {}) => {
  const turn = lastTurnEntries(entries);
  if (!turn) {
    return undefined;
  }
  const [prompt, ...rest] = turn;
  const origin = prompt.origin?.kind;
  const message = textOfBlocks(contentBlocks(prompt));

  const steps = [];
  const toolSteps = new Map();
  // Text is the answer until a tool call follows it; then it was a note on the way.
  let pendingText = [];
  const flushNotes = () => {
    for (const text of pendingText) {
      steps.push({ type: 'reasoning', reasoning: text });
    }
    pendingText = [];
  };

  for (const entry of rest) {
    if (entry.type === 'assistant') {
      for (const block of contentBlocks(entry)) {
        if (block.type === 'thinking' && block.thinking) {
          steps.push({ type: 'reasoning', reasoning: block.thinking });
        } else if (block.type === 'text' && block.text?.trim()) {
          pendingText.push(block.text);
        } else if (block.type === 'tool_use') {
          flushNotes();
          const step = { type: 'tool_call', tool_id: block.name, params: block.input, results: [] };
          toolSteps.set(block.id, step);
          steps.push(step);
        }
      }
    } else if (entry.type === 'user') {
      for (const block of contentBlocks(entry)) {
        const step = block.type === 'tool_result' && toolSteps.get(block.tool_use_id);
        if (step) {
          step.results.push({
            type: block.is_error ? 'error' : 'other',
            data: toolResultText(block.content),
          });
        }
      }
    }
  }

  // Stop's `last_assistant_message` is the answer: the transcript may not have it yet, and then
  // the text left over was a note on the way to it.
  const answer = lastAssistantMessage?.trim() || pendingText.join('\n\n');
  if (lastAssistantMessage?.trim()) {
    pendingText = pendingText.filter((text) => !answer.includes(text.trim()));
    flushNotes();
  }
  return {
    id: prompt.uuid,
    promptId: prompt.promptId,
    startedAt: prompt.timestamp,
    origin,
    round: {
      input: { message: origin && origin !== 'human' ? `[${origin}] ${message}` : message },
      steps,
      response: { message: answer },
    },
  };
};
