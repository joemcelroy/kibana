/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SmlTypeDefinition } from '@kbn/agent-builder-sml-plugin/server';
import { getSmlOriginId, kibanaPermissions } from '@kbn/agent-builder-sml-plugin/server';
import {
  DASHBOARD_ATTACHMENT_TYPE,
  dashboardStateToAttachmentData,
} from '@kbn/agent-builder-dashboards-common';
import type { DashboardPluginStart } from '@kbn/dashboard-plugin/server';
import { DASHBOARD_KI_TYPE } from '@kbn/agent-builder-elastic-ai-index-ki-types';
import { summarizeDashboardPanels } from './dashboard_esql';
import { dashboardAttributes, dashboardContent } from './dashboard_kis';

interface CreateDashboardSmlTypeOptions {
  getDashboardClient: () => Promise<DashboardPluginStart['client']>;
}

export const createDashboardSmlType = ({
  getDashboardClient,
}: CreateDashboardSmlTypeOptions): SmlTypeDefinition => ({
  id: DASHBOARD_KI_TYPE,
  fetchFrequency: () => '30m',

  async *list(context) {
    const finder = context.savedObjectsClient.createPointInTimeFinder({
      type: 'dashboard',
      perPage: 1000,
      namespaces: ['*'],
      fields: ['title'],
    });

    try {
      for await (const response of finder.find()) {
        yield response.saved_objects.map((savedObject) => ({
          id: savedObject.id,
          updatedAt: savedObject.updated_at ?? new Date().toISOString(),
          spaces: savedObject.namespaces ?? [],
        }));
      }
    } finally {
      await finder.close();
    }
  },

  getSmlEntry: async (originId, context) => {
    try {
      const dashboardClient = await getDashboardClient();
      const dashboard = await dashboardClient.read(context.savedObjectsClient, originId);
      const panels = await summarizeDashboardPanels(dashboard.data, context);

      return {
        type: DASHBOARD_KI_TYPE,
        title: dashboard.data.title ?? originId,
        content: dashboardContent(dashboard.data, panels),
        attributes: dashboardAttributes(panels),
      };
    } catch (error) {
      context.logger.warn(
        `SML dashboard: failed to get data for '${originId}': ${(error as Error).message}`
      );
      return undefined;
    }
  },

  getPermissions: () => kibanaPermissions({ kiType: DASHBOARD_KI_TYPE }),

  toAttachment: async (item, context) => {
    const originId = getSmlOriginId(item);
    try {
      const dashboardClient = await getDashboardClient();
      const dashboard = await dashboardClient.read(context.savedObjectsClient, originId);

      return {
        type: DASHBOARD_ATTACHMENT_TYPE,
        data: dashboardStateToAttachmentData(dashboard.data),
        origin: dashboard.id,
      };
    } catch (error) {
      throw new Error(
        `SML dashboard: failed to get data for '${originId}': ${(error as Error).message}`
      );
    }
  },
});
