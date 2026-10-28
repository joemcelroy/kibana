/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  agentBuilderDefaultAiIndexId,
  agentBuilderUserMemoriesAiIndexId,
  type AgentConfiguration,
} from '@kbn/agent-builder-common';

/** The agent flags that switch the built-in AI indices on and off. */
export type BuiltinAiIndexSwitches = Pick<
  AgentConfiguration,
  'enable_elastic_ai_index' | 'enable_user_memory'
>;

/** Each built-in AI index, keyed by the flag that switches it. */
export const builtinAiIndexIds = {
  enable_elastic_ai_index: agentBuilderDefaultAiIndexId,
  enable_user_memory: agentBuilderUserMemoriesAiIndexId,
} as const satisfies Record<keyof BuiltinAiIndexSwitches, string>;

/**
 * Applies an agent's built-in AI index switches to its AI indices. Every agent gets
 * `user-memories` unless `enable_user_memory` is false; the `elastic` AI index comes from the
 * agent's type and is dropped when `enable_elastic_ai_index` is false. Unset means on.
 */
export const applyBuiltinAiIndexSwitches = (
  aiIndices: readonly string[],
  switches: BuiltinAiIndexSwitches
): string[] => {
  const withUserMemory =
    switches.enable_user_memory === false
      ? aiIndices
      : [...aiIndices, builtinAiIndexIds.enable_user_memory];
  const switchedOff = new Set<string>(
    (Object.keys(builtinAiIndexIds) as Array<keyof BuiltinAiIndexSwitches>)
      .filter((flag) => switches[flag] === false)
      .map((flag) => builtinAiIndexIds[flag])
  );
  return [...new Set(withUserMemory)].filter((id) => !switchedOff.has(id));
};
