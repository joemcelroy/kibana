/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreStart } from '@kbn/core/server';
import type { KibanaRequest } from '@kbn/core-http-server';
import { CONTEXT_ENGINE_MEMORY_ENABLED_SETTING_ID } from '@kbn/management-settings-ids';

/** Throws unless the global Context Engine memory setting is on. */
export const assertMemoryEnabled = async ({
  request,
  getCoreStart,
}: {
  request: KibanaRequest;
  getCoreStart: () => Promise<CoreStart>;
}): Promise<void> => {
  const coreStart = await getCoreStart();
  const savedObjectsClient = coreStart.savedObjects.getScopedClient(request);
  const memoryEnabled = await coreStart.uiSettings
    .globalAsScopedToClient(savedObjectsClient)
    .get<boolean>(CONTEXT_ENGINE_MEMORY_ENABLED_SETTING_ID);
  if (!memoryEnabled) {
    throw new Error('Context Engine memory is not enabled.');
  }
};

/** The id short-term memories record for the request's user: the profile uid, else the username. */
export const getCurrentUserId = async ({
  request,
  getCoreStart,
}: {
  request: KibanaRequest;
  getCoreStart: () => Promise<CoreStart>;
}): Promise<string> => {
  const user = (await getCoreStart()).security.authc.getCurrentUser(request);
  const userId = user?.profile_uid ?? user?.username;
  if (!userId) {
    throw new Error('Cannot identify the current user.');
  }
  return userId;
};
