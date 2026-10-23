/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createHash } from 'crypto';
import { SHARED_MEMORY_OWNER } from '../../common/dreaming';

const MAX_SLUG_LENGTH = 96;
const HASH_LENGTH = 16;

export const shortHash = (...parts: string[]): string =>
  createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, HASH_LENGTH);

/**
 * Folds an entity name to the form that decides identity: case, accents, and punctuation are
 * ignored, so "Acme Corp." and "acme corp" are the same entity.
 */
export const slugify = (name: string): string => {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : shortHash(name);
};

/** Whose long-term memory a short-term memory feeds: its user, or the shared owner. */
export const ownerOf = (userId: string | undefined): string => userId ?? SHARED_MEMORY_OWNER;

export const ownerIdPrefix = (owner: string): string => `${owner}/`;

export const entityId = (owner: string, type: string, name: string): string =>
  `${ownerIdPrefix(owner)}entity-${slugify(type)}-${slugify(name)}`;

/** Fixed when the plan is saved, so a retried task writes the same id. */
export const factId = (owner: string, executionId: string, taskId: string, ref: string): string =>
  `${ownerIdPrefix(owner)}fact-${shortHash(executionId, taskId, ref)}`;

export const memoryUri = (memoryId: string): string => `memory://${memoryId}`;
export const sessionUri = (sessionId: string): string => `session://${sessionId}`;
export const kiUri = (kiId: string): string => `ki://${kiId}`;

const MEMORY_URI_PREFIX = 'memory://';
export const memoryIdFromUri = (uri: string): string | undefined =>
  uri.startsWith(MEMORY_URI_PREFIX) ? uri.slice(MEMORY_URI_PREFIX.length) : undefined;
