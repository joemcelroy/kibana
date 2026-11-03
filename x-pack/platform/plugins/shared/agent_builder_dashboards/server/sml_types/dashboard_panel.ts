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
import {
  DASHBOARD_KI_TYPE,
  DASHBOARD_PANEL_KI_TYPE,
} from '@kbn/agent-builder-elastic-ai-index-ki-types';
import { summarizeDashboardPanels } from './dashboard_esql';
import { panelAttributes, panelContent, panelDescription } from './dashboard_kis';

interface CreateDashboardPanelSmlTypeOptions {
  getDashboardClient: () => Promise<DashboardPluginStart['client']>;
}

/** A panel's origin id: its dashboard and its id on that dashboard. */
const PANEL_ID_SEPARATOR = '/';

export const toPanelOriginId = (dashboardId: string, panelId: string): string =>
  `${dashboardId}${PANEL_ID_SEPARATOR}${panelId}`;

export const fromPanelOriginId = (
  originId: string
): { dashboardId: string; panelId: string } | undefined => {
  const separator = originId.lastIndexOf(PANEL_ID_SEPARATOR);
  return separator > 0
    ? { dashboardId: originId.slice(0, separator), panelId: originId.slice(separator + 1) }
    : undefined;
};

/** Visualization panels' ids, sections included. */
const visualizationPanelIds = (panels: unknown[]): string[] =>
  panels.flatMap((panel) => {
    const {
      id,
      type,
      panels: inner,
    } = (panel ?? {}) as {
      id?: string;
      type?: string;
      panels?: unknown[];
    };
    if (Array.isArray(inner)) {
      return visualizationPanelIds(inner);
    }
    return id && (type === 'vis' || type === 'lens') ? [id] : [];
  });

/**
 * One KI per visualization on a dashboard: what it shows, the data it reads, and the ES|QL that
 * returns its numbers. It links to its dashboard's KI, and is read with the dashboard privilege.
 */
export const createDashboardPanelSmlType = ({
  getDashboardClient,
}: CreateDashboardPanelSmlTypeOptions): SmlTypeDefinition => ({
  id: DASHBOARD_PANEL_KI_TYPE,
  fetchFrequency: () => '30m',

  async *list(context) {
    const dashboardClient = await getDashboardClient();
    const finder = context.savedObjectsClient.createPointInTimeFinder({
      type: 'dashboard',
      perPage: 100,
      namespaces: ['*'],
      fields: ['title'],
    });

    try {
      for await (const response of finder.find()) {
        const items = [];
        for (const savedObject of response.saved_objects) {
          try {
            const dashboard = await dashboardClient.read(
              context.savedObjectsClient,
              savedObject.id
            );
            for (const panelId of visualizationPanelIds(dashboard.data.panels ?? [])) {
              items.push({
                id: toPanelOriginId(savedObject.id, panelId),
                updatedAt: savedObject.updated_at ?? new Date().toISOString(),
                spaces: savedObject.namespaces ?? [],
              });
            }
          } catch (error) {
            context.logger.warn(
              `SML dashboard panel: failed to list panels of '${savedObject.id}': ${
                (error as Error).message
              }`
            );
          }
        }
        yield items;
      }
    } finally {
      await finder.close();
    }
  },

  getSmlEntry: async (originId, context) => {
    const ids = fromPanelOriginId(originId);
    if (!ids) {
      return undefined;
    }
    try {
      const dashboardClient = await getDashboardClient();
      const dashboard = await dashboardClient.read(context.savedObjectsClient, ids.dashboardId);
      const panels = await summarizeDashboardPanels(dashboard.data, context);
      const panel = panels.find(({ id }) => id === ids.panelId);
      if (!panel) {
        return undefined;
      }
      const dashboardTitle = dashboard.data.title ?? ids.dashboardId;
      return {
        type: DASHBOARD_PANEL_KI_TYPE,
        title: panel.title ?? `Panel ${ids.panelId} of ${dashboardTitle}`,
        description: panelDescription(dashboardTitle, panel),
        content: panelContent(dashboardTitle, panel),
        attributes: panelAttributes(ids.dashboardId, panel),
        references: [{ uri: `${DASHBOARD_KI_TYPE}://${ids.dashboardId}` }],
      };
    } catch (error) {
      context.logger.warn(
        `SML dashboard panel: failed to get data for '${originId}': ${(error as Error).message}`
      );
      return undefined;
    }
  },

  getPermissions: () => kibanaPermissions({ kiType: DASHBOARD_KI_TYPE }),

  // A panel is attached as the dashboard it belongs to.
  toAttachment: async (item, context) => {
    const ids = fromPanelOriginId(getSmlOriginId(item));
    if (!ids) {
      return undefined;
    }
    const dashboardClient = await getDashboardClient();
    const dashboard = await dashboardClient.read(context.savedObjectsClient, ids.dashboardId);
    return {
      type: DASHBOARD_ATTACHMENT_TYPE,
      data: dashboardStateToAttachmentData(dashboard.data),
      origin: dashboard.id,
    };
  },
});
