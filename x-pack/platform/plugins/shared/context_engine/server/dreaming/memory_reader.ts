/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  compareDreamingCursors,
  cursorOfMemory,
  dreamingMemoryOfTranscript,
  type DreamingCursor,
  type DreamingMemory,
} from '../../common/dreaming';
import type {
  PullShortTermMemoriesParams,
  ShortTermMemoryServiceApi,
} from '../short_term_memory/service';
import type { TranscriptServiceApi } from '../transcripts/service';

export type PullDreamingMemoriesParams = PullShortTermMemoriesParams;

export interface PullDreamingMemoriesResult {
  memories: DreamingMemory[];
  /** Set when more memories or transcripts may follow the page. */
  next?: DreamingCursor;
}

/** What dreaming reads: short-term memories and transcripts, as one stream in cursor order. */
export interface DreamingMemoryReader {
  pull(spaceId: string, params: PullDreamingMemoriesParams): Promise<PullDreamingMemoriesResult>;
  /** The memories and transcripts among `ids` that still exist, in cursor order. */
  getByIds(spaceId: string, ids: readonly string[]): Promise<DreamingMemory[]>;
  /** Deletes a memory or transcript and returns it, or `undefined` when neither exists. */
  forget(spaceId: string, id: string): Promise<DreamingMemory | undefined>;
}

const byCursor = (a: DreamingMemory, b: DreamingMemory) =>
  compareDreamingCursors(cursorOfMemory(a), cursorOfMemory(b));

export const createDreamingMemoryReader = ({
  shortTermMemory,
  transcripts,
}: {
  shortTermMemory: Pick<ShortTermMemoryServiceApi, 'pull' | 'getByIds' | 'forget'>;
  transcripts: Pick<TranscriptServiceApi, 'pull' | 'getByIds' | 'delete'>;
}): DreamingMemoryReader => ({
  async pull(spaceId, params) {
    const [memoryPage, transcriptPage] = await Promise.all([
      shortTermMemory.pull(spaceId, params),
      transcripts.pull(spaceId, params),
    ]);
    const merged = [
      ...memoryPage.memories,
      ...transcriptPage.transcripts.map(dreamingMemoryOfTranscript),
    ].sort(byCursor);
    // Each source returns its first `size` after the cursor, so the first `size` of both together
    // come before anything either left unread.
    const memories = merged.slice(0, params.size);
    const last = memories[memories.length - 1];
    const more =
      merged.length > params.size ||
      memoryPage.next !== undefined ||
      transcriptPage.next !== undefined;
    return { memories, ...(more && last !== undefined && { next: cursorOfMemory(last) }) };
  },

  async getByIds(spaceId, ids) {
    const [memories, found] = await Promise.all([
      shortTermMemory.getByIds(spaceId, ids),
      transcripts.getByIds(spaceId, ids),
    ]);
    return [...memories, ...found.map(dreamingMemoryOfTranscript)].sort(byCursor);
  },

  async forget(spaceId, id) {
    const memory = await shortTermMemory.forget(spaceId, id);
    if (memory) {
      return memory;
    }
    const transcript = await transcripts.delete(spaceId, id);
    return transcript && dreamingMemoryOfTranscript(transcript);
  },
});
