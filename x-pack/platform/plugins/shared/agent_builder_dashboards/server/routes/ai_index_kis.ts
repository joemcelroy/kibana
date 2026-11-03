/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import type { IRouter, Logger } from '@kbn/core/server';
import type { DashboardPluginStart } from '@kbn/dashboard-plugin/server';
import {
  DASHBOARD_KI_TYPE,
  DASHBOARD_PANEL_KI_TYPE,
} from '@kbn/agent-builder-elastic-ai-index-ki-types';
import { summarizeDashboardPanels } from '../sml_types/dashboard_esql';
import {
  dashboardAttributes,
  dashboardContent,
  panelAttributes,
  panelContent,
  panelDescription,
} from '../sml_types/dashboard_kis';
import type { PanelSummary } from '../sml_types/panel_esql';

export const AI_INDEX_KIS_PATH = '/internal/agent_builder_dashboards/ai_index_kis';

const MAX_DASHBOARDS = 100;

/** Whether an index pattern a panel reads matches a wanted one: comma lists and `*` globs. */
export const matchesIndexPattern = (actual: string, wanted: string): boolean => {
  const globs = wanted
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const regexes = globs.map(
    (glob) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
  );
  return actual
    .split(',')
    .map((part) => part.trim())
    .some((part) => globs.includes(part) || regexes.some((regex) => regex.test(part)));
};

const readsIndex = (panel: PanelSummary, wanted: string): boolean =>
  panel.layers.some(
    ({ indexPattern }) => indexPattern && matchesIndexPattern(indexPattern, wanted)
  );

const hasQuery = (panel: PanelSummary): boolean => panel.layers.some(({ esql }) => esql);

interface AiIndexKi {
  ki_id: string;
  ki: {
    type: string;
    title: string;
    description?: string;
    content: string;
    attributes: Record<string, string | number | string[]>;
    references: Array<{ uri: string; relation: 'derived_from' }>;
  };
}

/**
 * The dashboard and panel KIs the `elastic` AI index crawler writes, for an AI index automation
 * to write into its own AI index: one KI per dashboard and per visualization panel, each with the
 * ES|QL behind it, already checked against the cluster. Optionally limited to given dashboards,
 * and to panels that read a given index pattern. Reads as the requesting user.
 */
export const registerAiIndexKisRoute = ({
  router,
  logger,
  getDashboardClient,
}: {
  router: IRouter;
  logger: Logger;
  getDashboardClient: () => Promise<DashboardPluginStart['client']>;
}) => {
  router.versioned
    .post({
      path: AI_INDEX_KIS_PATH,
      access: 'internal',
      security: {
        authz: {
          enabled: false,
          reason:
            'Dashboards and data views are read with the request-scoped saved objects client, and queries are checked as the current user.',
        },
      },
    })
    .addVersion(
      {
        version: '1',
        validate: {
          request: {
            body: schema.object({
              dashboard_ids: schema.maybe(
                schema.arrayOf(schema.string({ minLength: 1 }), { maxSize: MAX_DASHBOARDS })
              ),
              index_pattern: schema.maybe(schema.string({ minLength: 1, maxLength: 1024 })),
            }),
          },
        },
      },
      async (context, request, response) => {
        const core = await context.core;
        const savedObjectsClient = core.savedObjects.client;
        const smlContext = {
          esClient: core.elasticsearch.client.asCurrentUser,
          savedObjectsClient,
          logger,
        };
        const { dashboard_ids: dashboardIds, index_pattern: indexPattern } = request.body;
        const ids =
          dashboardIds && dashboardIds.length > 0
            ? dashboardIds
            : (
                await savedObjectsClient.find({
                  type: 'dashboard',
                  perPage: MAX_DASHBOARDS,
                  fields: ['title'],
                })
              ).saved_objects.map(({ id }) => id);

        const dashboardClient = await getDashboardClient();
        const kis: AiIndexKi[] = [];
        for (const id of ids) {
          try {
            const dashboard = await dashboardClient.read(savedObjectsClient, id);
            const panels = (await summarizeDashboardPanels(dashboard.data, smlContext)).filter(
              (panel) => hasQuery(panel) && (!indexPattern || readsIndex(panel, indexPattern))
            );
            if (panels.length === 0) {
              continue;
            }
            const title = dashboard.data.title ?? id;
            const references = [
              { uri: `${DASHBOARD_KI_TYPE}://${id}`, relation: 'derived_from' as const },
            ];
            kis.push({
              ki_id: `${DASHBOARD_KI_TYPE}-${id}`,
              ki: {
                type: DASHBOARD_KI_TYPE,
                title,
                ...(dashboard.data.description && { description: dashboard.data.description }),
                content: dashboardContent(dashboard.data, panels),
                attributes: { dashboard_id: id, ...dashboardAttributes(panels) },
                references,
              },
            });
            for (const panel of panels) {
              kis.push({
                ki_id: `${DASHBOARD_PANEL_KI_TYPE}-${id}-${panel.id}`,
                ki: {
                  type: DASHBOARD_PANEL_KI_TYPE,
                  title: panel.title ?? `Panel ${panel.id} of ${title}`,
                  description: panelDescription(title, panel),
                  content: panelContent(title, panel),
                  attributes: panelAttributes(id, panel),
                  references,
                },
              });
            }
          } catch (error) {
            logger.warn(
              `Dashboard KIs for an AI index: skipping '${id}': ${(error as Error).message}`
            );
          }
        }
        return response.ok({ body: { kis } });
      }
    );
};
