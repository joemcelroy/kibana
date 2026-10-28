/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { useQuery } from '@kbn/react-query';
import type { AiIndexDreaming, GetAiIndexDreamingResponse } from '../../../common/dreaming';
import { getAiIndexDreaming } from '../api/ai_indices';
import { contextEngineQueryKeys } from './query_keys';
import { useKibana } from './use_kibana';

interface UseAiIndexDreamingResult {
  dreaming: AiIndexDreaming | undefined;
  isLoading: boolean;
  error: Error | undefined;
}

/** Fetches an AI index's dreaming config and state (`GET .../_dreaming`). */
export const useAiIndexDreaming = (id: string): UseAiIndexDreamingResult => {
  const {
    services: { http },
  } = useKibana();

  const { data, isLoading, error } = useQuery<GetAiIndexDreamingResponse, Error>({
    queryKey: contextEngineQueryKeys.aiIndex.dreaming(id),
    queryFn: ({ signal }) => getAiIndexDreaming(http, { aiIndexId: id, signal }),
  });

  return { dreaming: data?.dreaming, isLoading, error: error ?? undefined };
};
