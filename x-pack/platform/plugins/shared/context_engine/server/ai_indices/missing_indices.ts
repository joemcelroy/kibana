/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { errors } from '@elastic/elasticsearch';
import { BasicPrettyPrinter, Parser, mutate } from '@elastic/esql';
import type { AiIndexDest } from '../../common/http_api/ai_indices';

const UNKNOWN_INDEX = /Unknown index \[([^\]]+)\]/g;

/**
 * The indices an ES|QL error says don't exist. A query that names only missing indices fails
 * verification (`Unknown index [a]`); one that also names existing indices fails resolution
 * (`index_not_found_exception`).
 */
export const missingIndicesOf = (error: unknown): string[] => {
  if (!(error instanceof errors.ResponseError)) {
    return [];
  }
  const body = error.meta.body as
    | { error?: { type?: string; reason?: string; index?: string } }
    | undefined;
  const cause = body?.error;
  if (cause?.type === 'index_not_found_exception' && cause.index) {
    return [cause.index];
  }
  if (cause?.type === 'verification_exception' && cause.reason) {
    return [...cause.reason.matchAll(UNKNOWN_INDEX)].flatMap(([, names]) =>
      names.split(',').map((name) => name.trim())
    );
  }
  return [];
};

/** Whether `index` is the backing index of a registered AI index. */
export const isAiIndexDest = (index: string, dests: readonly AiIndexDest[]): boolean =>
  dests.some(({ value }) => value.split(',').some((dest) => dest.trim() === index));

/**
 * The query without the given `FROM` sources, or `undefined` when no source is left. Returns
 * the query unchanged when the parser rejects it or none of the sources are in it.
 */
export const withoutSources = (query: string, indices: readonly string[]): string | undefined => {
  const { root, errors: parseErrors } = Parser.parse(query);
  if (parseErrors.length > 0) {
    return query;
  }
  let removed = false;
  for (const index of indices) {
    removed = mutate.commands.from.sources.remove(root, index) !== undefined || removed;
  }
  if (!removed) {
    return query;
  }
  const remaining = [...mutate.commands.from.sources.list(root)];
  return remaining.length > 0 ? BasicPrettyPrinter.print(root) : undefined;
};
