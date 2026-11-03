/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  DashboardPanel,
  DashboardSection,
  DashboardState,
} from '@kbn/as-code-dashboard-schema';
import { indexPatternsOf, queriesOf } from './dashboard_esql';
import { renderPanel, type PanelSummary } from './panel_esql';

/**
 * The text and attributes of dashboard and panel KIs, shared by the crawler that fills the
 * `elastic` AI index and the route that gives an AI index automation the same KIs.
 */

const toPanelSummary = (panel: DashboardPanel): string[] => {
  const title =
    (panel.config as { title?: string } | undefined)?.title ??
    (panel.config as { attributes?: { title?: string } } | undefined)?.attributes?.title;

  return [title, panel.type, panel.id ? `panel:${panel.id}` : undefined].filter(
    (value): value is string => Boolean(value)
  );
};

const toDashboardSearchContent = (state: DashboardState): string => {
  const topLevelPanels = state.panels.filter(
    (panel): panel is DashboardPanel => !('panels' in panel)
  );
  const sections = state.panels.filter((panel): panel is DashboardSection => 'panels' in panel);

  const contentParts = [state.title, state.description];

  for (const panel of topLevelPanels) {
    contentParts.push(...toPanelSummary(panel));
  }

  for (const section of sections) {
    contentParts.push(section.title, `section:${section.id}`);
    for (const panel of section.panels) {
      contentParts.push(...toPanelSummary(panel));
    }
  }

  contentParts.push(
    `${
      topLevelPanels.length + sections.reduce((count, section) => count + section.panels.length, 0)
    } panels`,
    `${sections.length} sections`
  );

  return contentParts.filter(Boolean).join('\n');
};

/** A dashboard KI's content: its panels in brief, then each with the ES|QL behind it. */
export const dashboardContent = (state: DashboardState, panels: PanelSummary[]): string => {
  const timeRange = (state as { time_range?: { from?: string; to?: string } }).time_range;
  const indexPatterns = indexPatternsOf(panels);
  return [
    toDashboardSearchContent(state),
    ...(timeRange?.from && timeRange.to
      ? [`Time range: ${timeRange.from} to ${timeRange.to}`]
      : []),
    ...(indexPatterns.length > 0 ? [`Data: ${indexPatterns.join(', ')}`] : []),
    ...(panels.length > 0 ? ['', '## Panels', '', panels.map(renderPanel).join('\n\n')] : []),
  ].join('\n');
};

export const dashboardAttributes = (panels: PanelSummary[]) => {
  const queries = queriesOf(panels);
  const indexPatterns = indexPatternsOf(panels);
  return {
    ...(queries.length > 0 && { esql: queries }),
    ...(indexPatterns.length > 0 && { index_patterns: indexPatterns }),
    panel_count: panels.length,
  };
};

/** A panel KI's content: the dashboard it is on, then the panel with its ES|QL. */
export const panelContent = (dashboardTitle: string, panel: PanelSummary): string =>
  [`Dashboard: ${dashboardTitle}`, renderPanel(panel)].join('\n');

export const panelAttributes = (dashboardId: string, panel: PanelSummary) => {
  const queries = queriesOf([panel]);
  const indexPatterns = indexPatternsOf([panel]);
  return {
    dashboard_id: dashboardId,
    ...(panel.id && { panel_id: panel.id }),
    ...(panel.chartType && { chart_type: panel.chartType }),
    ...(queries.length > 0 && { esql: queries }),
    ...(indexPatterns.length > 0 && { index_patterns: indexPatterns }),
  };
};

export const panelDescription = (dashboardTitle: string, panel: PanelSummary): string =>
  `A ${panel.chartType ?? panel.panelType} panel on the dashboard "${dashboardTitle}".`;
