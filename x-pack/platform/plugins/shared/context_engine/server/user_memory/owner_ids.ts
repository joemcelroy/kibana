/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * The ids a user's memory can be owned by. `remember` records the profile uid when the user has
 * one and the username otherwise, so one person can own KIs under both: a browser session has a
 * profile, a basic-auth API call may not. Reads match either, as Agent Builder matches
 * conversation owners.
 */
export const ownerIdsOf = (
  user: { profile_uid?: string; username?: string } | undefined
): string[] => [
  ...new Set([user?.profile_uid, user?.username].filter((id): id is string => Boolean(id))),
];
