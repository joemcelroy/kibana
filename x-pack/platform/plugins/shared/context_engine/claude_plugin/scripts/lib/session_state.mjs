/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = () =>
  process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'context-engine-claude-plugin');

const statePath = (sessionId) =>
  join(dataDir(), 'sessions', `${sessionId.replace(/[^\w.-]/g, '_')}.json`);

/** What SessionStart learned for a session, so each round does not ask again. */
export const writeSessionState = async (sessionId, state) => {
  await mkdir(join(dataDir(), 'sessions'), { recursive: true });
  await writeFile(statePath(sessionId), JSON.stringify(state));
};

export const readSessionState = async (sessionId) => {
  try {
    return JSON.parse(await readFile(statePath(sessionId), 'utf8'));
  } catch {
    return undefined;
  }
};

/** One line per round in `rounds.log`: status only, never content. */
export const logRound = async (entry) => {
  try {
    await mkdir(dataDir(), { recursive: true });
    await appendFile(
      join(dataDir(), 'rounds.log'),
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`
    );
  } catch {
    // Logging must never fail a hook.
  }
};

export const readStdinJson = async () => {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
};
