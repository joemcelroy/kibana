/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { agentBuilderRoundCaptureWorkflowId } from '@kbn/agent-builder-common';
import { applyConversationLearning } from './conversation_learning';

describe('applyConversationLearning', () => {
  it('adds the round capture workflow after the agent’s own when it remembers users', () => {
    expect(
      applyConversationLearning({
        tools: [],
        ai_indices: ['elastic', 'user-memories'],
        post_execution_workflow_ids: ['mine'],
      })
    ).toEqual({ post_execution_workflow_ids: ['mine', agentBuilderRoundCaptureWorkflowId] });
  });

  it('adds it for an AI index of the agent’s own', () => {
    expect(applyConversationLearning({ tools: [], ai_indices: ['bookings'] })).toEqual({
      post_execution_workflow_ids: [agentBuilderRoundCaptureWorkflowId],
    });
  });

  it('adds it once', () => {
    expect(
      applyConversationLearning({
        tools: [],
        ai_indices: ['user-memories'],
        post_execution_workflow_ids: [agentBuilderRoundCaptureWorkflowId],
      })
    ).toEqual({ post_execution_workflow_ids: [agentBuilderRoundCaptureWorkflowId] });
  });

  it('leaves the workflows alone when the agent has only the elastic AI index or none', () => {
    expect(
      applyConversationLearning({
        tools: [],
        ai_indices: ['elastic'],
        post_execution_workflow_ids: ['mine'],
      })
    ).toEqual({ post_execution_workflow_ids: ['mine'] });
    expect(applyConversationLearning({ tools: [] })).toEqual({});
  });
});
