/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { useMutation, useQuery, useQueryClient } from '@kbn/react-query';
import type {
  ForgetOwnRoundsResponse,
  OwnMemorySettings,
} from '@kbn/context-engine-plugin/common/http_api/user_memory';
import { queryKeys } from '../../query_keys';
import { useKibana } from '../use_kibana';

/** Kept in-plugin so Agent Builder does not take a bundle dependency on contextEngine. */
const FORGET_OWN_ROUNDS_PATH = '/internal/context_engine/memory/_mine/rounds/_forget';
const OWN_MEMORY_SETTINGS_PATH = '/internal/context_engine/memory/_mine/settings';
const OWN_MEMORY_API_VERSION = '1';

interface UseLearnFromConversationsResult {
  /** `undefined` while loading, or when it could not be read. */
  learnFromConversations: boolean | undefined;
  setLearnFromConversations: (learn: boolean) => Promise<void>;
  isSaving: boolean;
  /** Forgets the conversation rounds recorded about the user in this space. */
  forgetRounds: () => Promise<ForgetOwnRoundsResponse>;
  isForgetting: boolean;
}

/** The user's own "Learn from my conversations" switch, kept by Context Engine per space. */
export const useLearnFromConversations = (): UseLearnFromConversationsResult => {
  const {
    services: { http },
  } = useKibana();
  const queryClient = useQueryClient();

  const { data } = useQuery<boolean, Error>({
    queryKey: queryKeys.memory.learnFromConversations,
    queryFn: async ({ signal }) =>
      (
        await http.get<OwnMemorySettings>(OWN_MEMORY_SETTINGS_PATH, {
          version: OWN_MEMORY_API_VERSION,
          signal,
        })
      ).learn_from_conversations,
    retry: false,
  });

  const { mutateAsync: save, isLoading: isSaving } = useMutation<void, Error, boolean>({
    mutationFn: async (learn) => {
      await http.put<OwnMemorySettings>(OWN_MEMORY_SETTINGS_PATH, {
        version: OWN_MEMORY_API_VERSION,
        body: JSON.stringify({ learn_from_conversations: learn }),
      });
    },
    onSuccess: (_, learn) => {
      queryClient.setQueryData(queryKeys.memory.learnFromConversations, learn);
    },
  });

  const { mutateAsync: forget, isLoading: isForgetting } = useMutation<
    ForgetOwnRoundsResponse,
    Error
  >({
    mutationFn: () =>
      http.post<ForgetOwnRoundsResponse>(FORGET_OWN_ROUNDS_PATH, {
        version: OWN_MEMORY_API_VERSION,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['aiIndices', 'ownMemory'] }),
  });

  return {
    learnFromConversations: data,
    setLearnFromConversations: save,
    isSaving,
    forgetRounds: () => forget(),
    isForgetting,
  };
};
