/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/** No model is configured for the Context Engine inference feature. */
export class DreamingModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DreamingModelUnavailableError';
  }
}
