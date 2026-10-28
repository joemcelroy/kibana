/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/** A memory with this id is already stored. Short-term memory is append-only. */
export class ShortTermMemoryExistsError extends Error {
  constructor(public readonly memoryId: string) {
    super(`Short-term memory '${memoryId}' already exists.`);
    this.name = 'ShortTermMemoryExistsError';
  }
}
