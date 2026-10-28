/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AiIndexMemoryScope } from './ai_indices';

/** AI indices one request may list the caller's memory from. */
export const MAX_OWN_MEMORY_AI_INDICES = 50;
/** KIs listed per AI index, newest first. */
export const MAX_OWN_MEMORY_KIS = 500;

export interface ListOwnMemoryRequest {
  /**
   * Context Engine ids; ones without memory are left out of the response. Missing: every AI index
   * that keeps each user's memory apart, such as user-memories.
   */
  ai_index_ids?: string[];
}

/** One long-term KI dreaming wrote for the caller. */
export interface OwnMemoryKi {
  id: string;
  type: string;
  title?: string;
  content?: string;
  updated_at?: string;
}

export interface OwnMemoryAiIndex {
  id: string;
  description?: string;
  memory_scope: AiIndexMemoryScope;
  kis: OwnMemoryKi[];
  /** Set when this AI index could not be read; the others still are. */
  error?: string;
}

export interface ListOwnMemoryResponse {
  ai_indices: OwnMemoryAiIndex[];
}

/** The caller's own memory settings in a space, read and written whole. */
export interface OwnMemorySettings {
  /** Whether agents that learn from conversations record the caller's. Defaults to true. */
  learn_from_conversations: boolean;
}

/** Response of forgetting the caller's recorded conversation rounds. */
export interface ForgetOwnRoundsResponse {
  /** Recorded rounds forgotten; what was dreamed from them is rewritten on the next run. */
  forgotten: number;
}
