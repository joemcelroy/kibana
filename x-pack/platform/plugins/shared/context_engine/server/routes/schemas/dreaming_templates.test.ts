/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  DREAMING_TEMPLATES_ASSET_DIR,
  type DreamingTemplate,
  type DreamingTemplateIndex,
} from '../../../common/dreaming_templates';
import { dreamingConfigSchema } from './dreaming_schema';

const dir = join(__dirname, '../../../public/assets', DREAMING_TEMPLATES_ASSET_DIR);
const read = <T>(file: string): T => JSON.parse(readFileSync(join(dir, file), 'utf8'));
const index = read<DreamingTemplateIndex>('index.json');

describe('dreaming templates', () => {
  it('lists every template file, once', () => {
    const files = readdirSync(dir).filter((file) => file !== 'index.json');
    const ids = index.templates.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.map((id) => `${id}.json`).sort()).toEqual(files.sort());
  });

  describe.each(index.templates.map(({ id }) => id))('%s', (id) => {
    const template = read<DreamingTemplate>(`${id}.json`);
    const { dreaming } = template;

    it('is a valid dreaming config', () => {
      expect(() => dreamingConfigSchema.validate({ enabled: true, ...dreaming })).not.toThrow();
    });

    it('has a summary and a rationale', () => {
      expect(template.summary.trim()).not.toBe('');
      expect(template.rationale.trim()).not.toBe('');
    });

    it('relates only entity types it defines', () => {
      const entityTypes = new Set((dreaming.entities ?? []).map(({ type }) => type));
      for (const { source, target } of dreaming.relationships ?? []) {
        expect(entityTypes).toContain(source);
        expect(entityTypes).toContain(target);
      }
    });

    it('has facts, entities and relationships, each type once', () => {
      for (const kinds of [dreaming.facts, dreaming.entities, dreaming.relationships]) {
        const types = (kinds ?? []).map(({ type }) => type);
        expect(types.length).toBeGreaterThan(0);
        expect(new Set(types).size).toBe(types.length);
      }
    });
  });
});
