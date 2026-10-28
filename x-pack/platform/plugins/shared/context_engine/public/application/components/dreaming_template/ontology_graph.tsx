/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { useEuiTheme } from '@elastic/eui';
import React, { useMemo } from 'react';
import type { DreamingEntityType, DreamingRelationshipType } from '../../../../common/dreaming';

const WIDTH = 720;
const HEIGHT = 300;
const CENTER = { x: WIDTH / 2, y: HEIGHT / 2 - 10 };
const RADIUS = { x: 260, y: 95 };
const NODE_RADIUS = 7;
const HUB_RADIUS = 11;
/** Relationship names shown on one edge before the rest are counted. */
const MAX_EDGE_LABELS = 2;

interface Point {
  x: number;
  y: number;
}

interface Edge {
  source: string;
  target: string;
  types: string[];
}

const humanize = (type: string) => type.replace(/_/g, ' ');

const edgeLabel = (types: string[]) => {
  const shown = types.slice(0, MAX_EDGE_LABELS).map(humanize).join(' · ');
  const hidden = types.length - MAX_EDGE_LABELS;
  return hidden > 0 ? `${shown} +${hidden}` : shown;
};

/**
 * Puts the most connected entity type in the middle and the rest around it, and merges the
 * relationship types between the same two entity types onto one edge.
 */
const layout = (entities: DreamingEntityType[], relationships: DreamingRelationshipType[]) => {
  const types = entities.map(({ type }) => type);
  const neighbors = new Map(types.map((type) => [type, new Set<string>()]));
  for (const { source, target } of relationships) {
    neighbors.get(source)?.add(target);
    neighbors.get(target)?.add(source);
  }
  const hub = [...types].sort(
    (a, b) => (neighbors.get(b)?.size ?? 0) - (neighbors.get(a)?.size ?? 0)
  )[0];
  const ring = types.filter((type) => type !== hub);
  const positions = new Map<string, Point>();
  if (hub !== undefined) {
    positions.set(hub, CENTER);
  }
  ring.forEach((type, i) => {
    const angle = Math.PI + (2 * Math.PI * i) / ring.length;
    positions.set(type, {
      x: CENTER.x + RADIUS.x * Math.cos(angle),
      y: CENTER.y + RADIUS.y * Math.sin(angle),
    });
  });

  const edges = new Map<string, Edge>();
  for (const { source, target, type } of relationships) {
    if (!positions.has(source) || !positions.has(target)) {
      continue;
    }
    const key = [source, target].sort().join('\u0000');
    const edge = edges.get(key) ?? { source, target, types: [] };
    edge.types.push(type);
    edges.set(key, edge);
  }
  return { hub, positions, edges: [...edges.values()] };
};

interface OntologyGraphProps {
  entities: DreamingEntityType[];
  relationships: DreamingRelationshipType[];
}

/** A sketch of a template's entity types and the relationship types between them. */
export const OntologyGraph = ({ entities, relationships }: OntologyGraphProps) => {
  const { euiTheme } = useEuiTheme();
  const { hub, positions, edges } = useMemo(
    () => layout(entities, relationships),
    [entities, relationships]
  );

  const labelHalo = {
    stroke: euiTheme.colors.backgroundBasePlain,
    strokeWidth: 4,
    paintOrder: 'stroke' as const,
    strokeLinejoin: 'round' as const,
  };

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width="100%"
      role="img"
      aria-hidden
      style={{ maxHeight: HEIGHT, display: 'block' }}
      data-test-subj="contextDreamingTemplateGraph"
    >
      <g stroke={euiTheme.colors.textSubdued} strokeOpacity={0.5} fill="none">
        {edges.map(({ source, target }) => {
          const from = positions.get(source)!;
          const to = positions.get(target)!;
          if (source === target) {
            return (
              <path
                key={`${source}-${target}`}
                d={`M ${from.x - 6} ${from.y - 6} C ${from.x - 34} ${from.y - 54}, ${from.x + 34} ${
                  from.y - 54
                }, ${from.x + 6} ${from.y - 6}`}
              />
            );
          }
          return <line key={`${source}-${target}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />;
        })}
      </g>
      <g
        fontSize={12}
        fill={euiTheme.colors.textSubdued}
        textAnchor="middle"
        fontFamily={euiTheme.font.family}
      >
        {edges.map(({ source, target, types }) => {
          const from = positions.get(source)!;
          const to = positions.get(target)!;
          const at =
            source === target
              ? { x: from.x, y: from.y - 46 }
              : { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 + 4 };
          return (
            <text key={`${source}-${target}`} x={at.x} y={at.y} {...labelHalo}>
              {edgeLabel(types)}
            </text>
          );
        })}
      </g>
      {entities.map(({ type }) => {
        const at = positions.get(type)!;
        const isHub = type === hub;
        return (
          <g key={type}>
            {isHub && (
              <circle
                cx={at.x}
                cy={at.y}
                r={HUB_RADIUS + 5}
                fill="none"
                stroke={euiTheme.colors.primary}
                strokeOpacity={0.4}
                strokeWidth={2}
              />
            )}
            <circle
              cx={at.x}
              cy={at.y}
              r={isHub ? HUB_RADIUS : NODE_RADIUS}
              fill={euiTheme.colors.primary}
            />
            <text
              x={at.x}
              y={at.y + (isHub ? HUB_RADIUS : NODE_RADIUS) + 18}
              textAnchor="middle"
              fontSize={11}
              fontWeight={600}
              letterSpacing="0.08em"
              fill={euiTheme.colors.textParagraph}
              fontFamily={euiTheme.font.familyCode}
              {...labelHalo}
            >
              {humanize(type).toUpperCase()}
            </text>
          </g>
        );
      })}
    </svg>
  );
};
