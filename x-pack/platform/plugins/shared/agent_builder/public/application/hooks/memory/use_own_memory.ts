/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { useQuery } from '@kbn/react-query';
import type {
  ListOwnMemoryResponse,
  OwnMemoryAiIndex,
} from '@kbn/context-engine-plugin/common/http_api/user_memory';
import { queryKeys } from '../../query_keys';
import { useKibana } from '../use_kibana';

/** Kept in-plugin so Agent Builder does not take a bundle dependency on contextEngine. */
const OWN_MEMORY_PATH = '/internal/context_engine/memory/_mine';
const OWN_MEMORY_API_VERSION = '1';

interface UseOwnMemoryResult {
  aiIndices: OwnMemoryAiIndex[];
  isLoading: boolean;
  error: Error | undefined;
}

/**
 * The current user's long-term memory: what dreaming wrote about them, in each AI index that keeps
 * each user's memory apart, whichever agents wrote to it. Pass `aiIndexIds` to read only those;
 * ones without memory are left out of the result.
 */
export const useOwnMemory = (
  aiIndexIds?: readonly string[],
  { enabled = true }: { enabled?: boolean } = {}
): UseOwnMemoryResult => {
  const {
    services: { http },
  } = useKibana();
  const isEnabled = enabled && (aiIndexIds === undefined || aiIndexIds.length > 0);

  const { data, isLoading, error } = useQuery<ListOwnMemoryResponse, Error>({
    queryKey: queryKeys.aiIndices.ownMemory(aiIndexIds),
    queryFn: ({ signal }) =>
      http.post<ListOwnMemoryResponse>(OWN_MEMORY_PATH, {
        version: OWN_MEMORY_API_VERSION,
        body: JSON.stringify(aiIndexIds ? { ai_index_ids: aiIndexIds } : {}),
        signal,
      }),
    enabled: isEnabled,
  });

  return {
    aiIndices: data?.ai_indices ?? [],
    isLoading: isEnabled && isLoading,
    error: error ?? undefined,
  };
};
