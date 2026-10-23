/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/** The model's answer did not match the change set schema. */
export class InvalidChangeSetError extends Error {
  constructor(message: string) {
    super(`The model returned an invalid change set: ${message}`);
    this.name = 'InvalidChangeSetError';
  }
}
