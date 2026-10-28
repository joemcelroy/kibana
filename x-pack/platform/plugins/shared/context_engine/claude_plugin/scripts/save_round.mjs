#!/usr/bin/env node
/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Stop: saves the transcript of the round that just ended, for the AI indices that take rounds,
// the way Agent Builder's round capture does after each round
// (`context_engine_agent_builder/server/round_capture/capture_round.ts`).

import { setTimeout as sleep } from 'node:timers/promises';
import {
  SAVE_TRANSCRIPT_PATH,
  learnsFromConversations,
  listCatalog,
  roundTargetsOf,
} from './lib/ai_indices.mjs';
import { KibanaError, createKibanaClient, isConfigured, readConfig } from './lib/kibana.mjs';
import { renderRound } from './lib/render_round.mjs';
import { logRound, readSessionState, readStdinJson } from './lib/session_state.mjs';
import { lastRound, readTranscript } from './lib/transcript.mjs';

/** Claude Code may not have written the end of the round yet when Stop runs. */
const TRANSCRIPT_READ_RETRY_DELAYS_MS = [500, 1000, 2000];

const AGENT_ID = 'claude-code';

const readRound = async ({
  transcript_path: path,
  prompt_id: promptId,
  last_assistant_message: lastAssistantMessage,
}) => {
  for (let attempt = 0; attempt <= TRANSCRIPT_READ_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await sleep(TRANSCRIPT_READ_RETRY_DELAYS_MS[attempt - 1]);
    }
    try {
      const read = lastRound(await readTranscript(path), {
        lastAssistantMessage,
      });
      if (read && (!promptId || !read.promptId || read.promptId === promptId)) {
        return read;
      }
    } catch {
      // Not written yet: try again.
    }
  }
  return undefined;
};

const captureRound = async (input) => {
  const config = readConfig();
  if (!isConfigured(config)) {
    return { status: 'skipped', reason: 'not_configured' };
  }
  if (!input.session_id || !input.transcript_path) {
    return { status: 'skipped', reason: 'not_found' };
  }
  const client = createKibanaClient(config);
  // Asked every round, like Agent Builder: the user may turn it off mid-session.
  if (!(await learnsFromConversations(client))) {
    return { status: 'skipped', reason: 'opted_out' };
  }
  const targets =
    (await readSessionState(input.session_id))?.targets ??
    roundTargetsOf(await listCatalog(client, { aiIndexIds: config.aiIndexIds }));
  if (targets.length === 0) {
    return { status: 'skipped', reason: 'no_target' };
  }

  const read = await readRound(input);
  if (!read) {
    return { status: 'skipped', reason: 'not_found' };
  }
  const { id: roundId, startedAt, round } = read;
  const toolIds = [
    ...new Set(
      round.steps.filter(({ type }) => type === 'tool_call').map(({ tool_id: toolId }) => toolId)
    ),
  ];
  try {
    await client.post(SAVE_TRANSCRIPT_PATH, {
      id: `round-${roundId}`,
      session_id: input.session_id,
      raw: renderRound(round),
      attributes: {
        round_id: roundId,
        agent_id: AGENT_ID,
        ...(toolIds.length > 0 && { tool_ids: toolIds }),
      },
      ...(startedAt && { occurred_at: startedAt }),
      ai_index_ids: targets,
    });
  } catch (error) {
    if (error instanceof KibanaError && error.status === 409) {
      return { status: 'skipped', reason: 'already_captured' };
    }
    if (error instanceof KibanaError && error.status === 400 && /memory/i.test(error.message)) {
      return { status: 'skipped', reason: 'memory_off', message: error.message };
    }
    throw error;
  }
  return { status: 'captured', round_id: roundId, ai_index_ids: targets };
};

const input = await readStdinJson();
try {
  await logRound({ session_id: input.session_id, ...(await captureRound(input)) });
} catch (error) {
  await logRound({ session_id: input.session_id, status: 'failed', message: error.message });
}
