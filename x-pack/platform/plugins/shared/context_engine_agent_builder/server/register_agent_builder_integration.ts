/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup } from '@kbn/core/server';
import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import { ENTITY_TYPE_PREFIX, FACT_TYPE_PREFIX } from '@kbn/context-engine-plugin/common/dreaming';
import { hasContextEngineReadPrivilege } from './agent_builder/has_context_engine_read_privilege';
import { registerAgentBuilderTools } from './agent_builder/tools';
import { registerAttachmentTypes } from './attachment_types';
import { registerContextEngineAgent } from './agent/context_engine_agent';
import type {
  ContextEngineAgentBuilderPluginStart,
  ContextEngineAgentBuilderStartDependencies,
} from './types';

type WorkflowsManagementApi = WorkflowsServerPluginSetup['management'];

export const registerContextEngineAgentBuilderIntegration = ({
  coreSetup,
  agentBuilder,
  workflowsManagement,
}: {
  coreSetup: CoreSetup<
    ContextEngineAgentBuilderStartDependencies,
    ContextEngineAgentBuilderPluginStart
  >;
  agentBuilder: AgentBuilderPluginSetup;
  workflowsManagement: WorkflowsManagementApi;
}): void => {
  registerAttachmentTypes(agentBuilder);
  registerContextEngineAgent(agentBuilder);

  agentBuilder.agents.registerAiIndexResolver(async ({ ids, request }) => {
    const [coreStart, startDeps] = await coreSetup.getStartServices();
    const { contextEngine, security } = startDeps;

    if (!(await hasContextEngineReadPrivilege({ security, request }))) {
      return [];
    }

    // Same rule as the list route; only requested ids are probed. Hidden ones, such as
    // user-memories, are kept so the agent can still remember into them, but marked so they stay
    // out of the catalog and recall.
    const aiIndices = await contextEngine
      .getAiIndexDataReadService({
        esClient: coreStart.elasticsearch.client.asScoped(request).asCurrentUser,
        request,
        includeHidden: true,
      })
      .list(ids);
    return aiIndices.map((aiIndex) => ({
      id: aiIndex.id,
      esqlTarget: aiIndex.dest.value,
      description: aiIndex.description,
      memoryEnabled: aiIndex.memory_enabled,
      ...(aiIndex.hidden && { hidden: true }),
    }));
  });

  // What an agent that remembers users knows about the user it talks to, in its prompt, so it
  // never has to recall it. Context Engine leaves it empty when the user turned learning off.
  agentBuilder.agents.registerUserMemoryProvider(async ({ aiIndexIds, request }) => {
    const [, { contextEngine, spaces }] = await coreSetup.getStartServices();
    const aiIndices = await contextEngine.getUserMemory({
      spaceId: spaces?.spacesService.getSpaceId(request) ?? 'default',
      request,
      input: { ai_index_ids: aiIndexIds },
    });
    return aiIndices
      .flatMap(({ kis }) => kis)
      .filter(
        ({ type }) => type.startsWith(FACT_TYPE_PREFIX) || type.startsWith(ENTITY_TYPE_PREFIX)
      )
      .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
      .map(({ type, title, content, updated_at: updatedAt }) => ({
        type,
        ...(title !== undefined && { title }),
        ...(content !== undefined && { content }),
        ...(updatedAt !== undefined && { updated_at: updatedAt }),
      }));
  });

  registerAgentBuilderTools({
    agentBuilder,
    getCoreStart: async () => {
      const [coreStart] = await coreSetup.getStartServices();
      return coreStart;
    },
    getSecurityStart: async () => {
      const [, startDeps] = await coreSetup.getStartServices();
      return startDeps.security;
    },
    getWorkflowsManagement: () => workflowsManagement,
    getContextEngineStart: async () => {
      const [, startDeps] = await coreSetup.getStartServices();
      return startDeps.contextEngine;
    },
  });
};
