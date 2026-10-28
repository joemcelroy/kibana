/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { applyBuiltinAiIndexSwitches } from './builtin_ai_indices';

describe('applyBuiltinAiIndexSwitches', () => {
  it('gives every agent user-memories when the switches are unset', () => {
    expect(applyBuiltinAiIndexSwitches(['elastic', 'logs'], {})).toEqual([
      'elastic',
      'logs',
      'user-memories',
    ]);
    expect(applyBuiltinAiIndexSwitches([], {})).toEqual(['user-memories']);
  });

  it('does not list user-memories twice', () => {
    expect(applyBuiltinAiIndexSwitches(['user-memories', 'logs'], {})).toEqual([
      'user-memories',
      'logs',
    ]);
  });

  it('drops user-memories when user memory is off, even when assigned', () => {
    expect(
      applyBuiltinAiIndexSwitches(['elastic', 'user-memories'], { enable_user_memory: false })
    ).toEqual(['elastic']);
  });

  it('drops the elastic AI index when it is switched off', () => {
    expect(
      applyBuiltinAiIndexSwitches(['elastic', 'logs'], { enable_elastic_ai_index: false })
    ).toEqual(['logs', 'user-memories']);
  });

  it('does not add the elastic AI index to an agent whose type does not provide it', () => {
    expect(applyBuiltinAiIndexSwitches(['logs'], { enable_elastic_ai_index: true })).toEqual([
      'logs',
      'user-memories',
    ]);
  });
});
