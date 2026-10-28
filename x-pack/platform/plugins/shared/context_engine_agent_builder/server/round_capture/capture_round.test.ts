/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ConversationRoundStepType } from '@kbn/agent-builder-common';
import { TranscriptExistsError } from '@kbn/context-engine-plugin/server/transcripts/errors';
import type { KibanaRequest } from '@kbn/core/server';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { captureRound, type CaptureRoundDeps } from './capture_round';

describe('captureRound', () => {
  const request = {} as KibanaRequest;
  const input = { conversation_id: 'conv-1', round_id: 'round-1', agent_id: 'assistant' };
  const round = {
    id: 'round-1',
    input: { message: 'Which seat do I like?' },
    steps: [
      {
        type: ConversationRoundStepType.toolCall,
        tool_call_id: 'c-1',
        tool_id: 'platform.core.search',
        params: { query: 'bookings' },
        results: [{ tool_result_id: 'r-1', type: 'other', data: { seat: '14C' } }],
      },
    ],
    response: { message: 'Aisle.' },
    started_at: '2026-10-27T10:00:00.000Z',
    status: 'completed',
  };

  const memoryEnabled = jest.fn();
  const get = jest.fn();
  const getCurrentUser = jest.fn();
  const learnsFromConversations = jest.fn();
  const getAgent = jest.fn();
  const resolveConfiguration = jest.fn();
  const resolveRoundTargets = jest.fn();
  const saveTranscript = jest.fn();

  const deps = (): CaptureRoundDeps =>
    ({
      coreStart: {
        uiSettings: { globalAsScopedToClient: () => ({ get: memoryEnabled }) },
        savedObjects: { getScopedClient: jest.fn() },
        security: { authc: { getCurrentUser } },
      },
      agentBuilder: {
        conversations: { getScopedClient: async () => ({ get }) },
        agents: { getRegistry: async () => ({ get: getAgent }), resolveConfiguration },
      },
      contextEngine: {
        resolveRoundTargets,
        saveTranscript,
        learnsFromConversations,
      },
      logger: loggingSystemMock.createLogger(),
      retryDelaysMs: [0, 0],
    } as unknown as CaptureRoundDeps);

  const capture = () => captureRound(deps(), { input, spaceId: 'default', request });

  beforeEach(() => {
    jest.clearAllMocks();
    memoryEnabled.mockResolvedValue(true);
    get.mockResolvedValue({
      id: 'conv-1',
      agent_id: 'assistant',
      user: { id: 'u_jdoe', username: 'jdoe' },
      rounds: [round],
    });
    getCurrentUser.mockReturnValue({ username: 'jdoe', profile_uid: 'u_jdoe' });
    learnsFromConversations.mockResolvedValue(true);
    getAgent.mockResolvedValue({ type: 'chat', configuration: { tools: [] } });
    resolveConfiguration.mockResolvedValue({ tools: [], ai_indices: ['elastic', 'user-memories'] });
    resolveRoundTargets.mockResolvedValue(['user-memories']);
    saveTranscript.mockResolvedValue(undefined);
  });

  it('checks the switch under every id the user’s memory can be owned by', async () => {
    await capture();

    expect(learnsFromConversations).toHaveBeenCalledWith({
      spaceId: 'default',
      userIds: ['u_jdoe', 'jdoe'],
    });
  });

  it('saves the round’s transcript for the agent’s AI indices that take rounds', async () => {
    await expect(capture()).resolves.toEqual({
      status: 'captured',
      ai_index_ids: ['user-memories'],
    });

    expect(resolveRoundTargets).toHaveBeenCalledWith({
      spaceId: 'default',
      aiIndexIds: ['elastic', 'user-memories'],
    });
    expect(saveTranscript).toHaveBeenCalledWith({
      spaceId: 'default',
      request,
      input: {
        id: 'round-round-1',
        session_id: 'conv-1',
        raw: expect.stringContaining('1. platform.core.search: {"query":"bookings"}'),
        attributes: {
          round_id: 'round-1',
          agent_id: 'assistant',
          tool_ids: ['platform.core.search'],
        },
        occurred_at: '2026-10-27T10:00:00.000Z',
        ai_index_ids: ['user-memories'],
      },
    });
  });

  it('waits for a round that is not saved yet', async () => {
    get.mockResolvedValueOnce({
      id: 'conv-1',
      agent_id: 'assistant',
      user: { id: 'u_jdoe', username: 'jdoe' },
      rounds: [],
    });

    await expect(capture()).resolves.toEqual(expect.objectContaining({ status: 'captured' }));
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('waits for the round to be saved as completed, with its tool results', async () => {
    get.mockResolvedValueOnce({
      id: 'conv-1',
      agent_id: 'assistant',
      user: { id: 'u_jdoe', username: 'jdoe' },
      rounds: [{ ...round, status: 'in_progress', steps: [] }],
    });

    await expect(capture()).resolves.toEqual(expect.objectContaining({ status: 'captured' }));
    expect(saveTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ raw: expect.stringContaining('"seat":"14C"') }),
      })
    );
  });

  it.each([
    ['memory_off', () => memoryEnabled.mockResolvedValue(false)],
    ['not_found', () => get.mockRejectedValue(new Error('Conversation not found'))],
    ['not_owner', () => getCurrentUser.mockReturnValue({ username: 'ana', profile_uid: 'u_ana' })],
    ['opted_out', () => learnsFromConversations.mockResolvedValue(false)],
    ['no_target', () => resolveRoundTargets.mockResolvedValue([])],
    ['already_captured', () => saveTranscript.mockRejectedValue(new TranscriptExistsError('x'))],
  ])('skips the round: %s', async (reason, arrange) => {
    arrange();

    await expect(capture()).resolves.toEqual({ status: 'skipped', reason });
    if (reason !== 'already_captured') {
      expect(saveTranscript).not.toHaveBeenCalled();
    }
  });

  it('matches the owner by username when the request has no profile', async () => {
    getCurrentUser.mockReturnValue({ username: 'jdoe' });
    get.mockResolvedValue({
      id: 'conv-1',
      agent_id: 'assistant',
      user: { username: 'jdoe' },
      rounds: [round],
    });

    await expect(capture()).resolves.toEqual(expect.objectContaining({ status: 'captured' }));
    expect(saveTranscript).toHaveBeenCalledWith(expect.objectContaining({ request }));
  });

  it('captures the round of an owner without a profile', async () => {
    getCurrentUser.mockReturnValue({ username: 'jdoe' });
    get.mockResolvedValue({
      id: 'conv-1',
      agent_id: 'assistant',
      user: { id: 'realm:["file","file1","jdoe"]', username: 'jdoe' },
      rounds: [round],
    });

    await expect(capture()).resolves.toEqual(expect.objectContaining({ status: 'captured' }));
    expect(saveTranscript).toHaveBeenCalledWith(expect.objectContaining({ request }));
  });

  it('fails when the user cannot write to the AI indices', async () => {
    saveTranscript.mockRejectedValue(new Error('Forbidden'));

    await expect(capture()).rejects.toThrow('Forbidden');
  });
});
