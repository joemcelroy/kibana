/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  applyBuiltinAiIndexSwitches,
  type BuiltinAiIndexSwitches,
} from '@kbn/agent-builder-server/agents';
import type { AgentAiIndexEntry } from '../../../common/http_api/agents';

/**
 * The agent's effective AI indices. Inherited ones, including `user-memories`, are marked default;
 * a built-in AI index switched off is left out even when the agent also assigned it.
 */
export const buildEffectiveAgentAiIndices = ({
  inherited,
  assigned,
  switches = {},
}: {
  inherited: string[];
  assigned: string[];
  switches?: BuiltinAiIndexSwitches;
}): AgentAiIndexEntry[] => {
  const defaults = applyBuiltinAiIndexSwitches(inherited, switches);
  const defaultSet = new Set(defaults);
  const allowed = new Set(applyBuiltinAiIndexSwitches(assigned, switches));

  return [
    ...defaults.map((id) => ({ id, is_default: true })),
    ...assigned
      .filter((id) => allowed.has(id) && !defaultSet.has(id))
      .map((id) => ({ id, is_default: false })),
  ];
};
