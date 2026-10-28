/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

const PUBLIC_API_VERSION = '2023-10-31';
const INTERNAL_API_VERSION = '1';
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The plugin's settings. Hooks get them as `CLAUDE_PLUGIN_OPTION_*` from the plugin's user
 * config; the MCP server gets them as `KIBANA_*` from `.mcp.json`, which also lets them be set by
 * hand when the plugin is loaded with `--plugin-dir`.
 */
export const readConfig = (env = process.env) => {
  const option = (key, fallback) =>
    (env[`CLAUDE_PLUGIN_OPTION_${key}`] || env[fallback] || '').trim();
  const url = option('KIBANA_URL', 'KIBANA_URL').replace(/\/+$/, '');
  const apiKey = option('API_KEY', 'KIBANA_API_KEY');
  const spaceId = option('SPACE_ID', 'KIBANA_SPACE_ID');
  const aiIndexIds = option('AI_INDEX_IDS', 'CONTEXT_ENGINE_AI_INDEX_IDS')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  // The user config writes an unset option as its literal placeholder.
  const set = (value) => value && !value.startsWith('${');
  return {
    url: set(url) ? url : '',
    apiKey: set(apiKey) ? apiKey : '',
    spaceId: set(spaceId) && spaceId !== 'default' ? spaceId : '',
    aiIndexIds: aiIndexIds.filter(set),
  };
};

export const isConfigured = ({ url, apiKey }) => Boolean(url && apiKey);

export class KibanaError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Calls a Kibana API as the API key's user, in the configured space. */
export const createKibanaClient = ({ url, apiKey, spaceId }) => {
  const base = spaceId ? `${url}/s/${encodeURIComponent(spaceId)}` : url;
  const request = async (method, path, { body, internal = false } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `ApiKey ${apiKey}`,
        'kbn-xsrf': 'claude-code',
        'elastic-api-version': internal ? INTERNAL_API_VERSION : PUBLIC_API_VERSION,
        ...(internal && { 'x-elastic-internal-origin': 'claude-code' }),
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (!response.ok) {
      const message =
        parsed?.message ?? (typeof parsed === 'string' ? parsed : response.statusText);
      throw new KibanaError(response.status, `${method} ${path}: ${response.status} ${message}`);
    }
    return parsed;
  };
  return {
    get: (path, options) => request('GET', path, options),
    post: (path, body, options) => request('POST', path, { ...options, body }),
  };
};
