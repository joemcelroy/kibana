/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ownerIdsOf } from './owner_ids';

describe('ownerIdsOf', () => {
  it('matches a user by profile uid and username, once each', () => {
    expect(ownerIdsOf({ profile_uid: 'u_1', username: 'jdoe' })).toEqual(['u_1', 'jdoe']);
    expect(ownerIdsOf({ profile_uid: 'jdoe', username: 'jdoe' })).toEqual(['jdoe']);
    expect(ownerIdsOf({ username: 'jdoe' })).toEqual(['jdoe']);
    expect(ownerIdsOf(undefined)).toEqual([]);
  });
});
