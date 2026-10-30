/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core-http-server';

/** One thing an agent knows about the user it is talking to, from Context Engine memory. */
export interface UserMemoryEntry {
  /** Such as `fact.preference` or `entity.project`. */
  type: string;
  title?: string;
  content?: string;
  updated_at?: string;
}

/**
 * Returns what the AI indices among `aiIndexIds` that keep each user's memory apart know about the
 * requesting user, newest first. Empty when memory is off for Context Engine or for the user.
 * Callers gate on whether AI indices are enabled.
 */
export type UserMemoryProvider = (params: {
  aiIndexIds: string[];
  request: KibanaRequest;
}) => Promise<UserMemoryEntry[]>;
