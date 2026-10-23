/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core/server';
import type { InferenceServerStart } from '@kbn/inference-plugin/server';
import type { SearchInferenceEndpointsPluginStart } from '@kbn/search-inference-endpoints/server';
import { changeSetToolSchema } from './change_set';
import { DreamingModelUnavailableError } from './errors';
import type { DreamingModel } from './graphify';

/** The inference feature whose model dreaming uses; registered by Context Engine Agent Builder. */
export const DREAMING_INFERENCE_FEATURE_ID = 'context_engine';

/**
 * Resolves the model configured for the Context Engine inference feature, as the request's
 * user. Resolved per task, so a change in Model Management applies from the next task.
 */
export const resolveDreamingModel = async ({
  request,
  inference,
  searchInferenceEndpoints,
}: {
  request: KibanaRequest;
  inference: InferenceServerStart;
  searchInferenceEndpoints?: SearchInferenceEndpointsPluginStart;
}): Promise<DreamingModel> => {
  if (!searchInferenceEndpoints) {
    throw new DreamingModelUnavailableError(
      'Dreaming needs the search inference endpoints plugin to resolve its model.'
    );
  }
  const {
    endpoints: [endpoint],
  } = await searchInferenceEndpoints.endpoints.getForFeature(
    DREAMING_INFERENCE_FEATURE_ID,
    request
  );
  if (!endpoint?.connectorId) {
    throw new DreamingModelUnavailableError(
      `No model is configured for the '${DREAMING_INFERENCE_FEATURE_ID}' inference feature.`
    );
  }
  const { connectorId } = endpoint;
  const client = inference.getClient({ request });
  return async ({ system, input, abortSignal }) => {
    const { output } = await client.output({
      id: 'context_engine_dreaming',
      connectorId,
      system,
      input,
      schema: changeSetToolSchema,
      abortSignal,
      retry: { onValidationError: 1 },
    });
    return output;
  };
};
