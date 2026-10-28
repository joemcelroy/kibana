/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/** A transcript with this id is already stored. Transcripts are append-only. */
export class TranscriptExistsError extends Error {
  constructor(public readonly transcriptId: string) {
    super(`Transcript '${transcriptId}' already exists.`);
    this.name = 'TranscriptExistsError';
  }
}
