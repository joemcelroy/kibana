#!/usr/bin/env node
/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// A stdio MCP server over Context Engine's remember and recall APIs, with no dependencies.

import { createInterface } from 'node:readline';
import {
  MAX_TARGET_AI_INDICES,
  RECALL_PATH,
  REMEMBER_PATH,
  aiIndexPath,
  listCatalog,
} from './lib/ai_indices.mjs';
import { createKibanaClient, isConfigured, readConfig } from './lib/kibana.mjs';

const SERVER_INFO = { name: 'context-engine', version: '0.1.0' };
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

const aiIndexIdsSchema = (description) => ({
  type: 'array',
  items: { type: 'string', minLength: 1 },
  maxItems: MAX_TARGET_AI_INDICES,
  description,
});

const TOOLS = [
  {
    name: 'recall',
    description:
      'Look up what Context Engine knows about something. scope ai-index (the default): the knowledge in AI indices, including long-term memory that was remembered and dreamed. Plain words get a search by meaning and by words, best matches first, each with the AI index it came from. An ES|QL query (starting with FROM <ES|QL target>) returns its columns and rows: use it for counts, filters and exact lookups, after describe_ai_index for the fields and example queries. The server adds the space filter and a row limit. scope short-term: memories remembered recently that dreaming has not turned into long-term memory yet, shared ones and ones about the current user; plain words only.',
    annotations: { title: 'Recall', readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          maxLength: 10_000,
          description:
            'What to look up: plain words, such as a question or the names involved, or an ES|QL query starting with FROM. Do not add a space condition to ES|QL; the server adds it.',
        },
        scope: {
          type: 'string',
          enum: ['ai-index', 'short-term'],
          description: 'What to search. Defaults to ai-index.',
        },
        ai_index_ids: aiIndexIdsSchema(
          'For plain words: the AI indices to search, by id. Omit to search every AI index the user can read. An ES|QL query names its AI indices in FROM instead.'
        ),
        params: {
          type: 'object',
          additionalProperties: { type: ['string', 'number', 'boolean'] },
          description: 'For ES|QL: values for ?named parameters in the query.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          description:
            'Plain words: maximum results, default 10, at most 50. ES|QL: maximum rows, default 100, at most 1,000.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'remember',
    description:
      "Record something learned in this session in Context Engine short-term memory. AI indices with dreaming turned on later turn it into long-term facts, entities and relationships shared with users and agents that can read those AI indices. Record findings useful in later sessions, such as discovered patterns, effective approaches, domain knowledge, the user's preferences, or what was tried and what worked. Each call appends one memory; to correct one, remember the correction.",
    annotations: { title: 'Remember', readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          minLength: 1,
          maxLength: 65_536,
          description: 'What to remember, with enough context to use it without re-deriving it.',
        },
        session_id: {
          type: 'string',
          minLength: 1,
          description: 'The Claude Code session id the session context gives. Do not invent one.',
        },
        about_user: {
          type: 'boolean',
          description:
            'True when the memory is about the current user, such as their preferences or role, so it is kept in their own long-term memory. Omit for knowledge useful to anyone in this space.',
        },
        ai_index_ids: aiIndexIdsSchema(
          'The AI indices whose long-term memory this belongs in, by id; each must take memories. Omit to let every AI index with dreaming on use it.'
        ),
        dream_now: {
          type: 'boolean',
          description:
            "True to turn this session's memories into long-term memory now, in each AI index in ai_index_ids, instead of waiting for the schedule. Set it only on the last remember call of a session.",
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'describe_ai_index',
    description:
      'Describe an AI index for writing ES|QL against it: its ES|QL target, fields (which are semantic), KI types and tags with counts, and example queries.',
    annotations: { title: 'Describe AI index', readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        ai_index_id: { type: 'string', minLength: 1, description: 'The AI index id.' },
      },
      required: ['ai_index_id'],
    },
  },
  {
    name: 'list_ai_indices',
    description:
      'List the AI indices the user can read: id, ES|QL target, description, and whether each takes memories.',
    annotations: { title: 'List AI indices', readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {} },
  },
];

const config = readConfig();
const client = createKibanaClient(config);

const pick = (args, keys) =>
  Object.fromEntries(keys.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));

const handlers = {
  recall: (args) =>
    client.post(RECALL_PATH, pick(args, ['query', 'scope', 'ai_index_ids', 'params', 'limit'])),
  remember: (args) =>
    client.post(
      REMEMBER_PATH,
      pick(args, ['content', 'session_id', 'about_user', 'ai_index_ids', 'dream_now'])
    ),
  describe_ai_index: async ({ ai_index_id: aiIndexId }) =>
    (await client.get(aiIndexPath(aiIndexId, '/_describe'))).response,
  list_ai_indices: async () =>
    (await listCatalog(client, { aiIndexIds: config.aiIndexIds })).map(
      ({ id, esqlTarget, description, memoryEnabled, memoryScope }) => ({
        id,
        esqlTarget,
        description,
        memoryEnabled,
        memoryScope,
      })
    ),
};

const callTool = async ({ name, arguments: args = {} }) => {
  const handler = handlers[name];
  if (!handler) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
  if (!isConfigured(config)) {
    return {
      content: [
        {
          type: 'text',
          text: 'Context Engine is not configured: set the Kibana URL and API key in the plugin configuration.',
        },
      ],
      isError: true,
    };
  }
  try {
    const result = await handler(args);
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: error.message }], isError: true };
  }
};

const respond = (id, payload) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...payload })}\n`);

const handle = async ({ method, params }) => {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      return callTool(params ?? {});
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
};

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) {
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    respond(null, { error: { code: -32700, message: 'Parse error' } });
    return;
  }
  // Notifications, such as notifications/initialized, get no response.
  if (message.id === undefined) {
    return;
  }
  try {
    respond(message.id, { result: await handle(message) });
  } catch (error) {
    respond(message.id, { error: { code: error.code ?? -32603, message: error.message } });
  }
});
