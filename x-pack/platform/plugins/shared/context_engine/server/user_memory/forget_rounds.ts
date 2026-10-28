/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ForgetMemoryResult } from '../dreaming/forget';
import type { TranscriptServiceApi } from '../transcripts/service';

/** Transcripts read per page. */
const FORGET_ROUNDS_BATCH = 100;

/**
 * Forgets every recorded conversation round of a user in a space, one transcript at a time, so
 * what was dreamed from each is marked stale and rewritten, as `forget` does.
 */
export const forgetRounds = async ({
  transcripts,
  forget,
  spaceId,
  userId,
}: {
  transcripts: Pick<TranscriptServiceApi, 'listIds'>;
  forget: (spaceId: string, memoryId: string) => Promise<ForgetMemoryResult>;
  spaceId: string;
  userId: string;
}): Promise<{ forgotten: number }> => {
  let forgotten = 0;
  for (;;) {
    const ids = await transcripts.listIds(spaceId, userId, FORGET_ROUNDS_BATCH);
    let progressed = false;
    for (const id of ids) {
      if ((await forget(spaceId, id)).forgotten) {
        forgotten += 1;
        progressed = true;
      }
    }
    // A page that could not be forgotten would be read again forever.
    if (ids.length < FORGET_ROUNDS_BATCH || !progressed) {
      return { forgotten };
    }
  }
};
