/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { randomUUID } from 'crypto';
import type { KibanaRequest } from '@kbn/core/server';
import { DEFAULT_AI_INDEX_QUERY_LIMIT, MAX_AI_INDEX_QUERY_LIMIT } from '../../common/constants';
import type { ShortTermMemory } from '../../common/dreaming';
import {
  DEFAULT_RECALL_LIMIT,
  DEFAULT_RECALL_SCOPE,
  MAX_RECALL_LIMIT,
  type RecallRequest,
  type RecallResponse,
  type RememberRequest,
  type RememberResponse,
  type SaveTranscriptRequest,
  type SaveTranscriptResponse,
} from '../../common/http_api/memory';
import type { OwnMemoryAiIndex } from '../../common/http_api/user_memory';
import type { AiIndexDataReadServiceApi } from '../ai_indices/data_read_service';
import type { DreamRequestResult, MemoryTarget } from '../dreaming/request_dream';
import type { ShortTermMemoryServiceApi } from '../short_term_memory/service';
import type { TranscriptServiceApi } from '../transcripts/service';
import { ownerIdsOf } from '../user_memory/owner_ids';
import { InvalidMemoryRequestError, MemoryAccessDeniedError, MemoryDisabledError } from './errors';
import { isEsqlQuery } from './esql';
import { searchAiIndices, searchShortTermMemory } from './recall';

interface CurrentUser {
  profile_uid?: string;
  username?: string;
}

export interface MemoryApiDeps {
  shortTermMemory: Pick<ShortTermMemoryServiceApi, 'remember' | 'search'>;
  transcripts: Pick<TranscriptServiceApi, 'save'>;
  /** Reads AI indices as the request's user, with the space, lifecycle and per-user filters. */
  getDataRead: (request: KibanaRequest) => AiIndexDataReadServiceApi;
  /** Whether a plugin registered the AI index as hidden; recall leaves those out. */
  isHiddenAiIndex: (aiIndexId: string) => boolean;
  /** The caller's KIs in the given AI indices, hidden ones included. */
  listOwnMemory: (params: {
    spaceId: string;
    request: KibanaRequest;
    userIds: readonly string[];
    aiIndexIds: readonly string[];
  }) => Promise<OwnMemoryAiIndex[]>;
  /** Whether none of `userIds` turned off learning from their conversations. */
  learnsFromConversations: (spaceId: string, userIds: readonly string[]) => Promise<boolean>;
  /** The AI indices among `aiIndexIds` that take memories; unknown ones are left out. */
  resolveMemoryTargets: (spaceId: string, aiIndexIds: readonly string[]) => Promise<MemoryTarget[]>;
  /** Throws unless the request's user may write each AI index's backing store. */
  authorizeMemoryTargets: (
    spaceId: string,
    aiIndexIds: readonly string[],
    request: KibanaRequest
  ) => Promise<void>;
  requestDream: (params: {
    spaceId: string;
    aiIndexIds: readonly string[];
    memory: Pick<ShortTermMemory, 'session_id' | 'user_id'>;
    request: KibanaRequest;
  }) => Promise<DreamRequestResult[]>;
  getCurrentUser: (request: KibanaRequest) => CurrentUser | undefined;
  isMemoryEnabled: (request: KibanaRequest) => Promise<boolean>;
  /** Whether the request's user has the Context Engine read or write API privilege in the space. */
  hasPrivilege: (
    request: KibanaRequest,
    spaceId: string,
    privilege: 'read' | 'write'
  ) => Promise<boolean>;
  generateId?: () => string;
  now?: () => Date;
}

interface MemoryCall<Input> {
  spaceId: string;
  request: KibanaRequest;
  input: Input;
  /**
   * Lets a hidden AI index, such as user-memories, be a target. Only Agent Builder sets it, for a
   * conversation with an agent that remembers users; the routes and other clients never do.
   */
  includeHidden?: boolean;
}

/**
 * Remember, recall and save transcript: the memory API behind the start contract and the public
 * HTTP routes. Each call runs for the request's user and checks their access itself.
 */
export interface MemoryApi {
  /**
   * Appends a short-term memory. Needs the Context Engine write privilege and memory on. Records
   * the caller as its user when it is about them, or when an AI index it is for keeps each user's
   * memory apart. A hidden AI index is a target only with `includeHidden`.
   */
  remember(call: MemoryCall<RememberRequest>): Promise<RememberResponse>;
  /**
   * Searches AI indices (`scope: 'ai-index'`), by plain words or with an ES|QL query, or
   * short-term memory (`scope: 'short-term'`), by plain words. Needs the Context Engine read
   * privilege, and memory on for short-term memory. Transcripts and hidden AI indices, such as
   * user-memories, are never searched.
   */
  recall(call: MemoryCall<RecallRequest>): Promise<RecallResponse>;
  /**
   * What the AI indices among `ai_index_ids` that keep each user's memory apart know about the
   * caller, such as user-memories, for an agent to have in its prompt. Empty without the read
   * privilege, with memory off, or when the caller turned off learning from their conversations.
   */
  getUserMemory(call: MemoryCall<{ ai_index_ids: readonly string[] }>): Promise<OwnMemoryAiIndex[]>;
  /**
   * Saves the transcript of one of the caller's conversation rounds, apart from short-term memory,
   * for the AI indices it names to dream. Each must have memory and dreaming on, without
   * `rounds: false`. A hidden AI index is a target only with `includeHidden`.
   */
  saveTranscript(call: MemoryCall<SaveTranscriptRequest>): Promise<SaveTranscriptResponse>;
}

/** The id memories record for a user: the profile uid, else the username. */
const recordedUserIdOf = (user: CurrentUser | undefined): string => {
  const userId = user?.profile_uid ?? user?.username;
  if (!userId) {
    throw new MemoryAccessDeniedError('Cannot identify the current user.');
  }
  return userId;
};

/** Refuses hidden AI indices as targets, unless the call comes from an Agent Builder agent. */
const assertVisibleTargets = (
  aiIndexIds: readonly string[],
  isHiddenAiIndex: (aiIndexId: string) => boolean,
  includeHidden: boolean | undefined
): void => {
  const hidden = includeHidden ? [] : aiIndexIds.filter(isHiddenAiIndex);
  if (hidden.length > 0) {
    throw new InvalidMemoryRequestError(
      `${hidden
        .map((id) => `'${id}'`)
        .join(', ')} only takes memories from Agent Builder agents that remember users.`
    );
  }
};

export const createMemoryApi = ({
  shortTermMemory,
  transcripts,
  getDataRead,
  isHiddenAiIndex,
  listOwnMemory,
  learnsFromConversations,
  resolveMemoryTargets,
  authorizeMemoryTargets,
  requestDream,
  getCurrentUser,
  isMemoryEnabled,
  hasPrivilege,
  generateId = randomUUID,
  now = () => new Date(),
}: MemoryApiDeps): MemoryApi => {
  const assertPrivilege = async (
    request: KibanaRequest,
    spaceId: string,
    privilege: 'read' | 'write'
  ) => {
    if (!(await hasPrivilege(request, spaceId, privilege))) {
      throw new MemoryAccessDeniedError(`Insufficient privileges to ${privilege} Context Engine.`);
    }
  };
  const assertMemoryEnabled = async (request: KibanaRequest) => {
    if (!(await isMemoryEnabled(request))) {
      throw new MemoryDisabledError();
    }
  };

  return {
    async remember({ spaceId, request, input, includeHidden }) {
      await assertPrivilege(request, spaceId, 'write');
      await assertMemoryEnabled(request);
      const aiIndexIds = [...new Set(input.ai_index_ids ?? [])];
      assertVisibleTargets(aiIndexIds, isHiddenAiIndex, includeHidden);
      if (input.dream_now && aiIndexIds.length === 0) {
        throw new InvalidMemoryRequestError(
          'dream_now needs an AI index to dream in: set ai_index_ids.'
        );
      }
      const targets = aiIndexIds.length > 0 ? await resolveMemoryTargets(spaceId, aiIndexIds) : [];
      const missing = aiIndexIds.filter((id) => !targets.some(({ aiIndexId }) => aiIndexId === id));
      if (missing.length > 0) {
        throw new InvalidMemoryRequestError(
          `AI indices not found or without memory: ${missing.map((id) => `'${id}'`).join(', ')}`
        );
      }
      if (aiIndexIds.length > 0) {
        await authorizeMemoryTargets(spaceId, aiIndexIds, request);
      }

      // An AI index that keeps each user's memory apart only takes memories about a user.
      const userId =
        input.about_user || targets.some(({ memoryScope }) => memoryScope === 'user')
          ? recordedUserIdOf(getCurrentUser(request))
          : undefined;
      const memory: ShortTermMemory = {
        '@timestamp': now().toISOString(),
        id: generateId(),
        session_id: input.session_id ?? generateId(),
        ...(userId !== undefined && { user_id: userId }),
        content: input.content,
        ...(input.attributes && { attributes: input.attributes }),
        ...(input.occurred_at && { occurred_at: input.occurred_at }),
        ...(aiIndexIds.length > 0 && { ai_index_ids: aiIndexIds }),
      };
      await shortTermMemory.remember(spaceId, memory);

      // The memory is stored whatever happens here: a dream that doesn't start leaves it for the
      // next scheduled run.
      const dreams = input.dream_now
        ? await requestDream({ spaceId, aiIndexIds, memory, request })
        : undefined;
      return {
        id: memory.id,
        session_id: memory.session_id,
        ...(aiIndexIds.length > 0 && { ai_index_ids: aiIndexIds }),
        ...(dreams && {
          dreams: dreams.map(({ aiIndexId, status, runId, reason }) => ({
            ai_index_id: aiIndexId,
            status,
            ...(runId && { run_id: runId }),
            ...(reason && { reason }),
          })),
        }),
      };
    },

    async recall({ spaceId, request, input }) {
      await assertPrivilege(request, spaceId, 'read');
      const scope = input.scope ?? DEFAULT_RECALL_SCOPE;
      const esql = isEsqlQuery(input.query);
      const dataRead = getDataRead(request);
      // An agent passes all of its AI indices, so a hidden one is dropped rather than refused.
      const aiIndexIds = input.ai_index_ids?.filter((id) => !isHiddenAiIndex(id));

      if (esql) {
        if (scope === 'short-term') {
          throw new InvalidMemoryRequestError(
            "An ES|QL query reads AI indices: use scope 'ai-index', or plain words for short-term memory."
          );
        }
        if (input.ai_index_ids && input.ai_index_ids.length > 0) {
          throw new InvalidMemoryRequestError(
            "ai_index_ids applies to a plain-language recall: an ES|QL query's FROM names the AI indices."
          );
        }
        const limit = input.limit ?? DEFAULT_AI_INDEX_QUERY_LIMIT;
        if (limit > MAX_AI_INDEX_QUERY_LIMIT) {
          throw new InvalidMemoryRequestError(
            `An ES|QL recall returns at most ${MAX_AI_INDEX_QUERY_LIMIT} rows.`
          );
        }
        const { columns, values } = await dataRead.query({
          query: input.query,
          params: input.params,
          limit,
        });
        return { scope, query_type: 'esql', columns, values };
      }

      if (input.params && Object.keys(input.params).length > 0) {
        throw new InvalidMemoryRequestError('params applies to an ES|QL recall only.');
      }
      const limit = input.limit ?? DEFAULT_RECALL_LIMIT;
      if (limit > MAX_RECALL_LIMIT) {
        throw new InvalidMemoryRequestError(
          `A plain-language recall returns at most ${MAX_RECALL_LIMIT} results.`
        );
      }
      if (scope === 'short-term') {
        await assertMemoryEnabled(request);
        const { results, errors } = await searchShortTermMemory({
          dataRead,
          shortTermMemory,
          spaceId,
          userIds: ownerIdsOf(getCurrentUser(request)),
          query: input.query,
          aiIndexIds,
          limit,
        });
        return { scope, query_type: 'text', results, ...(errors.length > 0 && { errors }) };
      }
      const { results, errors } = await searchAiIndices({
        dataRead,
        query: input.query,
        aiIndexIds,
        limit,
      });
      return { scope, query_type: 'text', results, ...(errors.length > 0 && { errors }) };
    },

    async getUserMemory({ spaceId, request, input }) {
      if (!(await hasPrivilege(request, spaceId, 'read')) || !(await isMemoryEnabled(request))) {
        return [];
      }
      const userIds = ownerIdsOf(getCurrentUser(request));
      if (userIds.length === 0 || !(await learnsFromConversations(spaceId, userIds))) {
        return [];
      }
      const targets = await resolveMemoryTargets(spaceId, [...new Set(input.ai_index_ids)]);
      const aiIndexIds = targets
        .filter(({ memoryScope }) => memoryScope === 'user')
        .map(({ aiIndexId }) => aiIndexId);
      return aiIndexIds.length > 0 ? listOwnMemory({ spaceId, request, userIds, aiIndexIds }) : [];
    },

    async saveTranscript({ spaceId, request, input, includeHidden }) {
      await assertPrivilege(request, spaceId, 'read');
      await assertMemoryEnabled(request);
      const aiIndexIds = [...new Set(input.ai_index_ids)];
      assertVisibleTargets(aiIndexIds, isHiddenAiIndex, includeHidden);
      await authorizeMemoryTargets(spaceId, aiIndexIds, request);
      const id = input.id ?? `transcript-${generateId()}`;
      await transcripts.save(spaceId, {
        '@timestamp': now().toISOString(),
        id,
        session_id: input.session_id,
        // A transcript is always about the caller: rounds are saved by the user who had them.
        user_id: recordedUserIdOf(getCurrentUser(request)),
        raw: input.raw,
        ai_index_ids: aiIndexIds,
        ...(input.occurred_at && { occurred_at: input.occurred_at }),
        ...(input.attributes && { attributes: input.attributes }),
      });
      return { id, ai_index_ids: aiIndexIds };
    },
  };
};
