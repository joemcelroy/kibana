/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { buildEffectiveAgentAiIndices } from './build_effective_agent_ai_indices';

describe('buildEffectiveAgentAiIndices', () => {
  it('flags inherited ids as defaults and lists them first', () => {
    expect(
      buildEffectiveAgentAiIndices({
        inherited: ['elastic'],
        assigned: ['sales'],
      })
    ).toEqual([
      { id: 'elastic', is_default: true },
      { id: 'user-memories', is_default: true },
      { id: 'sales', is_default: false },
    ]);
  });

  it('deduplicates ids present in both layers, keeping the default flag', () => {
    expect(
      buildEffectiveAgentAiIndices({
        inherited: ['elastic'],
        assigned: ['elastic', 'sales'],
      })
    ).toEqual([
      { id: 'elastic', is_default: true },
      { id: 'user-memories', is_default: true },
      { id: 'sales', is_default: false },
    ]);
  });

  it('leaves out built-in AI indices the agent switched off, even when assigned', () => {
    expect(
      buildEffectiveAgentAiIndices({
        inherited: ['elastic'],
        assigned: ['user-memories', 'sales'],
        switches: { enable_elastic_ai_index: false, enable_user_memory: false },
      })
    ).toEqual([{ id: 'sales', is_default: false }]);
  });
});
