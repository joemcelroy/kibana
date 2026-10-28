/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/** Name of the shared short-term memory data stream. Released names never change. */
export const SHORT_TERM_MEMORY_DATA_STREAM = '.contextengine-memory-short-term';
/** Name of the transcripts data stream. Released names never change. */
export const TRANSCRIPTS_DATA_STREAM = '.contextengine-memory-transcripts';

export const DREAMING_GROUP_BY = ['session_id', 'user_id'] as const;
export type DreamingGroupBy = (typeof DREAMING_GROUP_BY)[number];

export const DEFAULT_DREAMING_GROUP_BY: DreamingGroupBy = 'session_id';
export const DEFAULT_DREAMING_INTERVAL = '24h';
export const MIN_DREAMING_INTERVAL_MINUTES = 15;

/** Generic fact type used when the dreaming config declares none. */
export const DEFAULT_DREAMING_FACT_TYPE = 'fact';

/** Type prefixes of the KIs dreaming writes: `fact.<fact type>` and `entity.<entity type>`. */
export const FACT_TYPE_PREFIX = 'fact.';
export const ENTITY_TYPE_PREFIX = 'entity.';

export const isDreamedKiType = (type: string): boolean =>
  type.startsWith(FACT_TYPE_PREFIX) || type.startsWith(ENTITY_TYPE_PREFIX);
/** Stands in for the user in long-term ids when a memory has no `user_id`. */
export const SHARED_MEMORY_OWNER = '_shared';

export const MAX_DREAMING_INTERVAL_LENGTH = 16;
export const MAX_DREAMING_INSTRUCTIONS_LENGTH = 8192;
export const MAX_DREAMING_TYPE_LENGTH = 128;
export const MAX_DREAMING_TYPE_DESCRIPTION_LENGTH = 2048;
export const MAX_DREAMING_FACT_TYPES = 50;
export const MAX_DREAMING_ENTITY_TYPES = 50;
export const MAX_DREAMING_ENTITY_ATTRIBUTES = 50;
export const MAX_DREAMING_RELATIONSHIP_TYPES = 50;

export const MAX_SHORT_TERM_MEMORY_ID_LENGTH = 512;
export const MAX_SHORT_TERM_SESSION_ID_LENGTH = 512;
export const MAX_SHORT_TERM_USER_ID_LENGTH = 1024;
export const MAX_SHORT_TERM_CONTENT_LENGTH = 65536;
/** Longest transcript `saveTranscript` stores. */
export const MAX_TRANSCRIPT_LENGTH = 65536;
/** AI indices one short-term memory may be limited to. */
export const MAX_SHORT_TERM_AI_INDEX_IDS = 20;

/** Groups a dreaming state may hold for the next run before the cursor stops advancing. */
export const MAX_DREAMING_RETRY_ENTRIES = 100;
export const MAX_DREAMING_GROUP_KEY_LENGTH = 1024;

/** Short-term memories one run reads in total, and one task at most. */
export const MAX_DREAMING_MEMORIES_PER_RUN = 2000;
export const MAX_DREAMING_MEMORIES_PER_TASK = 200;
/** Characters of `content` and transcripts, as the model sees them, that one task holds at most. */
export const MAX_DREAMING_TASK_CHARACTERS = 100_000;
/** Longest `content` and transcript the dreaming model is shown; the rest is cut. */
export const MAX_DREAMING_PROMPT_CONTENT_LENGTH = 4000;
export const MAX_DREAMING_PROMPT_TRANSCRIPT_LENGTH = 16_000;

/** How long a recorded round's transcript is kept, whether or not every target has dreamed it. */
export const ROUND_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The characters of a memory one dreaming task spends on it. */
export const promptCharactersOf = (
  memory: Pick<DreamingMemory, 'content' | 'transcript'>
): number =>
  Math.min(memory.content?.length ?? 0, MAX_DREAMING_PROMPT_CONTENT_LENGTH) +
  Math.min(memory.transcript?.length ?? 0, MAX_DREAMING_PROMPT_TRANSCRIPT_LENGTH);
export const MAX_SHORT_TERM_PULL_SIZE = 500;
export const MAX_SHORT_TERM_PULL_GROUP_KEYS = MAX_DREAMING_RETRY_ENTRIES;

/** How far behind now a run reads, so memories still being refreshed are not skipped. */
export const DREAMING_SETTLE_LAG_MS = 30_000;

/** Cap on each list in a change set returned by the model. */
export const MAX_DREAMING_CHANGE_SET_ITEMS = 200;

/** Access patterns one entity or fact may carry, and the bounds on each of their fields. */
export const MAX_DREAMING_ACCESS_PATTERNS = 5;
export const MAX_ACCESS_PATTERN_LABEL_LENGTH = 256;
export const MAX_ACCESS_PATTERN_RETURNS_LENGTH = 1024;
export const MAX_ACCESS_PATTERN_ESQL_LENGTH = 4096;

/** Position in the short-term stream: everything at or before it has been dreamed. */
export interface DreamingCursor {
  timestamp: string;
  memory_id: string;
}

/** A group that still has memories from `from` (exclusive) to dream. */
export interface DreamingRetryEntry {
  group_key: string;
  from: DreamingCursor;
}

export type DreamingRunStatus = 'running' | 'succeeded' | 'partial' | 'failed';

export interface DreamingLastRun {
  execution_id: string;
  status: DreamingRunStatus;
  started_at: string;
  completed_at?: string;
}

export interface AiIndexDreamingState {
  cursor?: DreamingCursor;
  retry: DreamingRetryEntry[];
  last_run?: DreamingLastRun;
}

export interface DreamingFactType {
  type: string;
  description?: string;
}

export interface DreamingEntityType {
  type: string;
  description?: string;
  attributes?: string[];
}

export interface DreamingRelationshipType {
  type: string;
  source: string;
  target: string;
  description?: string;
}

/** What a user configures through `PUT .../_dreaming`. */
export interface AiIndexDreamingConfig {
  enabled: boolean;
  schedule?: { interval: string };
  group_by?: DreamingGroupBy;
  instructions?: string;
  facts?: DreamingFactType[];
  entities?: DreamingEntityType[];
  relationships?: DreamingRelationshipType[];
  /** Also keep one `memory.session` KI per session: a dated summary of what happened in it. */
  sessions?: boolean;
  /**
   * Dream recorded conversation rounds (transcripts) as well as short-term memories. On unless set
   * to `false`. A round shows what its user could read, and a shared AI index shows what it dreams
   * from it to everyone who reads that AI index.
   */
  rounds?: boolean;
}

/**
 * The part of a dreaming config a plugin can register with a managed AI index. It always wins
 * over what is saved; whoever turns dreaming on still chooses `enabled` and `schedule`.
 */
export type ManagedDreamingConfig = Omit<AiIndexDreamingConfig, 'enabled' | 'schedule'>;

/** Response of `GET /api/context_engine/ai_index/{aiIndexId}/_dreaming`. */
export interface GetAiIndexDreamingResponse {
  dreaming: AiIndexDreaming;
}

/** KI type of the session documents dreaming keeps when `sessions` is on. */
export const SESSION_KI_TYPE = 'memory.session';

/** Stored on the AI index: the config plus state only the dreaming APIs may write. */
export interface AiIndexDreaming extends AiIndexDreamingConfig {
  state?: AiIndexDreamingState;
}

/** A memory in the short-term stream, as an agent remembered it. */
export interface ShortTermMemory {
  '@timestamp': string;
  id: string;
  session_id: string;
  user_id?: string;
  /** What to remember, searchable. */
  content: string;
  attributes?: Record<string, unknown>;
  occurred_at?: string;
  /** The AI indices that may dream this memory. Missing or empty: every AI index in the space. */
  ai_index_ids?: string[];
}

/**
 * The transcript of a recorded conversation round, kept apart from short-term memory in its own
 * stream. Only dreaming reads it, and only for the AI indices it names.
 */
export interface Transcript {
  '@timestamp': string;
  id: string;
  /** The conversation the round belongs to. */
  session_id: string;
  user_id: string;
  /** The transcript, verbatim. Stored for dreaming, never searched. */
  raw: string;
  attributes?: Record<string, unknown>;
  occurred_at?: string;
  /** The AI indices that may dream it; never empty. */
  ai_index_ids: string[];
}

/**
 * What dreaming reads: a short-term memory, with `content`, or a transcript, with `transcript`.
 * Ids are unique across both, so a KI cites either by id.
 */
export interface DreamingMemory {
  '@timestamp': string;
  id: string;
  session_id: string;
  user_id?: string;
  content?: string;
  transcript?: string;
  attributes?: Record<string, unknown>;
  occurred_at?: string;
  ai_index_ids?: string[];
}

export const dreamingMemoryOfTranscript = ({ raw, ...rest }: Transcript): DreamingMemory => ({
  ...rest,
  transcript: raw,
});

/** Orders cursors by timestamp, then memory id. */
export const compareDreamingCursors = (a: DreamingCursor, b: DreamingCursor): number => {
  const byTime = Date.parse(a.timestamp) - Date.parse(b.timestamp);
  if (byTime !== 0) {
    return byTime;
  }
  if (a.memory_id === b.memory_id) {
    return 0;
  }
  return a.memory_id < b.memory_id ? -1 : 1;
};

export const cursorOfMemory = ({
  '@timestamp': timestamp,
  id,
}: Pick<DreamingMemory, '@timestamp' | 'id'>): DreamingCursor => ({
  timestamp,
  memory_id: id,
});

/** Just before `memory`, so a read from this cursor includes it. */
export const cursorBeforeMemory = (
  memory: Pick<DreamingMemory, '@timestamp' | 'id'>
): DreamingCursor => ({ timestamp: memory['@timestamp'], memory_id: '' });
