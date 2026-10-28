/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AiIndexQueryParamValue, QueryAiIndicesResponse } from './ai_indices';

/** What `recall` searches: the knowledge in AI indices, or short-term memory. */
export const RECALL_SCOPES = ['ai-index', 'short-term'] as const;
export type RecallScope = (typeof RECALL_SCOPES)[number];
export const DEFAULT_RECALL_SCOPE: RecallScope = 'ai-index';

export const MAX_RECALL_QUERY_LENGTH = 10_000;
export const MAX_RECALL_AI_INDICES = 20;
/** Results of a plain-language recall. An ES|QL recall returns rows, up to the query limits. */
export const DEFAULT_RECALL_LIMIT = 10;
export const MAX_RECALL_LIMIT = 50;
/** Longest `content` a result carries; KIs such as Kibana resources can be much longer. */
export const MAX_RECALL_CONTENT_LENGTH = 2000;

/** Body of `POST /api/context_engine/_remember`. */
export interface RememberRequest {
  /** What to remember, with enough context to use it without re-deriving it. */
  content: string;
  /** The session the memory belongs to. Generated when missing; pass it back to continue one. */
  session_id?: string;
  /** The memory is about the caller, so it records them as its user. */
  about_user?: boolean;
  /**
   * The AI indices the memory is for; each must have memory on. Missing or empty: every AI index
   * with dreaming on may use it.
   */
  ai_index_ids?: string[];
  occurred_at?: string;
  attributes?: Record<string, unknown>;
  /** Dream the memory's session now, in each AI index it is for. Needs `ai_index_ids`. */
  dream_now?: boolean;
}

/** A dream `remember` started, or why it did not. */
export interface RememberDream {
  ai_index_id: string;
  status: 'started' | 'skipped';
  run_id?: string;
  reason?: string;
}

/** Response of `POST /api/context_engine/_remember`. */
export interface RememberResponse {
  id: string;
  session_id: string;
  ai_index_ids?: string[];
  dreams?: RememberDream[];
}

/** Body of `POST /api/context_engine/_recall`. */
export interface RecallRequest {
  /**
   * What to look up: plain words, or an ES|QL query (`FROM ...`). ES|QL reads AI indices only, and
   * its `FROM` names them.
   */
  query: string;
  /** Defaults to `ai-index`. */
  scope?: RecallScope;
  /** For a plain-language recall: the AI indices to search. Missing: every one the caller can read. */
  ai_index_ids?: string[];
  /** For an ES|QL recall: values for `?named` parameters. */
  params?: Record<string, AiIndexQueryParamValue>;
  /** Plain language: results, default 10, at most 50. ES|QL: rows, default 100, at most 1,000. */
  limit?: number;
}

/** A KI found in an AI index. */
export interface RecalledKi {
  ai_index_id: string;
  id: string;
  type?: string;
  title?: string;
  description?: string;
  content?: string;
  updated_at?: string;
  score: number;
}

/** A short-term memory: remembered, not yet dreamed into long-term memory. */
export interface RecalledMemory {
  id: string;
  session_id: string;
  content: string;
  recorded_at: string;
  /** The memory is about the caller, not shared. */
  about_user: boolean;
  /** The AI indices it was remembered for; missing means every one. */
  ai_index_ids?: string[];
  score: number;
}

/** An AI index that could not be searched. */
export interface RecallError {
  ai_index_id: string;
  message: string;
}

/** Response of `POST /api/context_engine/_recall`. */
export type RecallResponse =
  | {
      scope: 'ai-index';
      query_type: 'text';
      results: RecalledKi[];
      errors?: RecallError[];
    }
  | {
      scope: 'short-term';
      query_type: 'text';
      results: RecalledMemory[];
      errors?: RecallError[];
    }
  | ({ scope: 'ai-index'; query_type: 'esql' } & QueryAiIndicesResponse);

/** Body of `POST /api/context_engine/_save_transcript`. */
export interface SaveTranscriptRequest {
  /** Generated when missing. A transcript is stored once: a taken id is a conflict. */
  id?: string;
  /** The conversation the round belongs to. */
  session_id: string;
  /** The transcript, verbatim. */
  raw: string;
  /** The AI indices to dream it. Each must have memory and dreaming on, without `rounds: false`. */
  ai_index_ids: string[];
  occurred_at?: string;
  attributes?: Record<string, unknown>;
}

/** Response of `POST /api/context_engine/_save_transcript`. */
export interface SaveTranscriptResponse {
  id: string;
  ai_index_ids: string[];
}
