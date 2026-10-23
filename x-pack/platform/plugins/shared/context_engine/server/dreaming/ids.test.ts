/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { entityId, factId, memoryIdFromUri, memoryUri, ownerOf, slugify } from './ids';

describe('dreaming ids', () => {
  it('folds case, accents, and punctuation so equivalent names share a slug', () => {
    expect(slugify('Acme Corp.')).toBe('acme-corp');
    expect(slugify('  acme   corp ')).toBe('acme-corp');
    expect(slugify('Café Déjà')).toBe('cafe-deja');
  });

  it('falls back to a hash for names with no slug characters', () => {
    expect(slugify('東京')).toMatch(/^[0-9a-f]{16}$/);
    expect(slugify('東京')).toBe(slugify('東京'));
  });

  it('builds entity ids from owner, type, and name', () => {
    expect(entityId('alice', 'person', 'Bob Smith')).toBe('alice/entity-person-bob-smith');
    expect(entityId(ownerOf(undefined), 'service', 'checkout')).toBe(
      '_shared/entity-service-checkout'
    );
  });

  it('builds the same fact id for the same run, task, and ref', () => {
    const id = factId('alice', 'exec-1', 'task-1', 'new:1');
    expect(id).toBe(factId('alice', 'exec-1', 'task-1', 'new:1'));
    expect(id).not.toBe(factId('alice', 'exec-2', 'task-1', 'new:1'));
    expect(id.startsWith('alice/fact-')).toBe(true);
  });

  it('round-trips memory uris', () => {
    expect(memoryIdFromUri(memoryUri('m-1'))).toBe('m-1');
    expect(memoryIdFromUri('ki://x')).toBeUndefined();
  });
});
