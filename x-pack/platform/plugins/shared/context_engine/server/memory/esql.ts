/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { Parser } from '@elastic/esql';

const SOURCE_COMMANDS = new Set(['from', 'ts']);

/**
 * Whether a recall query is ES|QL rather than plain words: it parses without errors and starts
 * with a command that reads indices. "From what I remember, which seat?" is plain words.
 */
export const isEsqlQuery = (query: string): boolean => {
  try {
    const { root, errors } = Parser.parse(query);
    const [first] = root.commands;
    return errors.length === 0 && first !== undefined && SOURCE_COMMANDS.has(first.name);
  } catch {
    return false;
  }
};
