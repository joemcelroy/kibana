/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { i18n } from '@kbn/i18n';
import React, { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { UserMemory } from '../components/memory/user_memory';
import { useAgentBuilderAgentById } from '../hooks/agents/use_agent_by_id';
import { useBreadcrumb } from '../hooks/use_breadcrumbs';
import { appPaths } from '../utils/app_paths';

const breadcrumbs = [
  {
    text: i18n.translate('xpack.agentBuilder.memoryPage.breadcrumb', { defaultMessage: 'Memory' }),
    path: appPaths.manage.memory,
  },
];

/** The current user's memory, across every agent. */
export const AgentBuilderMemoryPage: React.FC = () => {
  useBreadcrumb(breadcrumbs);
  return <UserMemory />;
};

/**
 * The same memory, reached from an agent's Customize navigation. It is the user's, so it shows
 * what every agent learned, not only this one.
 */
export const AgentBuilderAgentMemoryPage: React.FC = () => {
  const { agentId } = useParams<{ agentId: string }>();
  const { agent } = useAgentBuilderAgentById(agentId);

  const agentBreadcrumbs = useMemo(
    () => [{ text: agent?.name ?? agentId, path: appPaths.agent.overview({ agentId }) }],
    [agent?.name, agentId]
  );

  useBreadcrumb(agentBreadcrumbs);

  return <UserMemory />;
};
