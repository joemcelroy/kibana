/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { setTimeout as sleep } from 'timers/promises';
import type { Conversation, ConversationRound } from '@kbn/agent-builder-common';
import { ConversationRoundStatus, isToolCallStep } from '@kbn/agent-builder-common';
import type { AgentBuilderPluginStart } from '@kbn/agent-builder-server';
import type { ContextEnginePluginStart } from '@kbn/context-engine-plugin/server';
import { TranscriptExistsError } from '@kbn/context-engine-plugin/server/transcripts/errors';
import type { CoreStart, KibanaRequest, Logger } from '@kbn/core/server';
import { CONTEXT_ENGINE_MEMORY_ENABLED_SETTING_ID } from '@kbn/management-settings-ids';
import type { CaptureRoundInput, CaptureRoundOutput } from '../../common/round_capture_step';
import { renderRound } from './render_round';

/**
 * The round may not be saved yet, or only saved as in progress (without its tool results), when
 * Agent Builder runs the workflow.
 */
export const ROUND_READ_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

export interface CaptureRoundDeps {
  agentBuilder: Pick<AgentBuilderPluginStart, 'agents' | 'conversations'>;
  contextEngine: Pick<
    ContextEnginePluginStart,
    'resolveRoundTargets' | 'saveTranscript' | 'learnsFromConversations'
  >;
  coreStart: Pick<CoreStart, 'security' | 'uiSettings' | 'savedObjects'>;
  logger: Logger;
  retryDelaysMs?: readonly number[];
}

const skipped = (reason: NonNullable<CaptureRoundOutput['reason']>): CaptureRoundOutput => ({
  status: 'skipped',
  reason,
});

const isMemoryEnabled = async (
  coreStart: CaptureRoundDeps['coreStart'],
  request: KibanaRequest
): Promise<boolean> =>
  (await coreStart.uiSettings
    .globalAsScopedToClient(coreStart.savedObjects.getScopedClient(request))
    .get<boolean>(CONTEXT_ENGINE_MEMORY_ENABLED_SETTING_ID)) === true;

const readRound = async (
  { agentBuilder, logger, retryDelaysMs = ROUND_READ_RETRY_DELAYS_MS }: CaptureRoundDeps,
  request: KibanaRequest,
  { conversation_id: conversationId, round_id: roundId }: CaptureRoundInput
): Promise<
  | { conversation: Pick<Conversation, 'id' | 'agent_id' | 'user'>; round: ConversationRound }
  | undefined
> => {
  const client = await agentBuilder.conversations.getScopedClient({ request });
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    if (attempt > 0) {
      await sleep(retryDelaysMs[attempt - 1]);
    }
    try {
      const { id, agent_id: agentId, user, rounds } = await client.get(conversationId);
      const round = rounds.find((candidate) => candidate.id === roundId);
      if (round?.status === ConversationRoundStatus.completed) {
        return { conversation: { id, agent_id: agentId, user }, round };
      }
    } catch (error) {
      logger.debug(`Round capture could not read conversation '${conversationId}': ${error}`);
    }
  }
  return undefined;
};

/**
 * The profile uid of a conversation's owner. Agent Builder records a synthetic `realm:` id for a
 * principal without a profile, such as one calling the API with basic auth.
 */
const profileUidOf = (owner: Conversation['user']): string | undefined =>
  owner.id && !owner.id.startsWith('realm:') ? owner.id : undefined;

/** Whether the request's user owns the conversation: by profile uid, else by username. */
const isOwner = (
  coreStart: CaptureRoundDeps['coreStart'],
  request: KibanaRequest,
  owner: Conversation['user']
): boolean => {
  const user = coreStart.security.authc.getCurrentUser(request);
  if (!user) {
    return false;
  }
  const ownerUid = profileUidOf(owner);
  return user.profile_uid && ownerUid
    ? user.profile_uid === ownerUid
    : user.username === owner.username;
};

/**
 * Saves the transcript of a completed Agent Builder round, apart from short-term memory, for the
 * agent's AI indices that take rounds, shared ones included. Runs as the user who had
 * the round. Returns only a status, never content.
 */
export const captureRound = async (
  deps: CaptureRoundDeps,
  { input, spaceId, request }: { input: CaptureRoundInput; spaceId: string; request: KibanaRequest }
): Promise<CaptureRoundOutput> => {
  const { agentBuilder, contextEngine, coreStart } = deps;
  if (!(await isMemoryEnabled(coreStart, request))) {
    return skipped('memory_off');
  }

  const read = await readRound(deps, request, input);
  if (!read) {
    return skipped('not_found');
  }
  const { conversation, round } = read;
  if (!isOwner(coreStart, request, conversation.user)) {
    return skipped('not_owner');
  }
  // What `remember` records: the profile uid, else the username.
  const userId = profileUidOf(conversation.user) ?? conversation.user.username;
  const ownerIds = [...new Set([userId, conversation.user.username])];
  if (!(await contextEngine.learnsFromConversations({ spaceId, userIds: ownerIds }))) {
    return skipped('opted_out');
  }

  const agentId = input.agent_id || conversation.agent_id;
  const registry = await agentBuilder.agents.getRegistry({ request });
  const agent = await registry.get(agentId);
  const configuration = await agentBuilder.agents.resolveConfiguration({ agent, request });
  const targets = await contextEngine.resolveRoundTargets({
    spaceId,
    aiIndexIds: configuration.ai_indices ?? [],
  });
  if (targets.length === 0) {
    return skipped('no_target');
  }
  const toolIds = [
    ...new Set(round.steps.filter(isToolCallStep).map(({ tool_id: toolId }) => toolId)),
  ];
  try {
    await contextEngine.saveTranscript({
      spaceId,
      request,
      // Saved as the owner, who is the request's user: see `isOwner` above.
      input: {
        id: `round-${round.id}`,
        session_id: conversation.id,
        raw: renderRound(round),
        attributes: {
          round_id: round.id,
          agent_id: agentId,
          ...(toolIds.length > 0 && { tool_ids: toolIds }),
        },
        occurred_at: round.started_at,
        ai_index_ids: targets,
      },
    });
  } catch (error) {
    if (error instanceof TranscriptExistsError) {
      return skipped('already_captured');
    }
    throw error;
  }
  return { status: 'captured', ai_index_ids: targets };
};
