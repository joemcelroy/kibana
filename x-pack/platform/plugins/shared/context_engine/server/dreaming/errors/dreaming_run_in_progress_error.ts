/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/** An explicit run requested while another run of the same AI index is in progress. */
export class DreamingRunInProgressError extends Error {
  constructor(aiIndexId: string, executionId: string) {
    super(`AI index '${aiIndexId}' is already dreaming in run '${executionId}'`);
    this.name = 'DreamingRunInProgressError';
  }
}
