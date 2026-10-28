/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  agentBuilderDefaultAiIndexId,
  agentBuilderRoundCaptureWorkflowId,
  type AgentConfiguration,
} from '@kbn/agent-builder-common';

/**
 * Adds the round capture workflow to an agent's post-execution workflows when the agent has an AI
 * index besides the built-in `elastic` one, which every agent has. Takes the configuration after
 * the built-in AI index switches, so an agent that remembers users has `user-memories` and counts.
 * The stored list never changes.
 */
export const applyConversationLearning = (
  configuration: AgentConfiguration
): Pick<AgentConfiguration, 'post_execution_workflow_ids'> => {
  const workflowIds = configuration.post_execution_workflow_ids;
  const learns = (configuration.ai_indices ?? []).some((id) => id !== agentBuilderDefaultAiIndexId);
  if (!learns) {
    return workflowIds ? { post_execution_workflow_ids: workflowIds } : {};
  }
  return {
    post_execution_workflow_ids: [
      ...new Set([...(workflowIds ?? []), agentBuilderRoundCaptureWorkflowId]),
    ],
  };
};
