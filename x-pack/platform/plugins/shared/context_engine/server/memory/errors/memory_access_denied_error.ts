/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/** The caller may not use memory: no Context Engine privilege, or no identity to record. */
export class MemoryAccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryAccessDeniedError';
  }
}
