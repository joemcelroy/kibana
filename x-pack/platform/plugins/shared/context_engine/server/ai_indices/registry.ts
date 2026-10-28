/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/logging';
import type { AiIndexProperties } from '../../common/http_api/ai_indices';
import type { ManagedDreamingConfig } from '../../common/dreaming';
import type { AiIndexService } from './service';
import { AiIndexConflictError } from './errors';

export interface AiIndexRegistrationOptions {
  /** Dreaming config owned by the plugin; users only turn it on and pick its schedule. */
  dreaming?: ManagedDreamingConfig;
}

export class AiIndexRegistry {
  private readonly entries = new Map<string, AiIndexProperties>();
  private readonly dreaming = new Map<string, ManagedDreamingConfig>();
  private frozen = false;

  register(id: string, properties: AiIndexProperties, options?: AiIndexRegistrationOptions): void {
    if (this.frozen) {
      throw new Error('registerAiIndex called after plugin setup');
    }
    if (this.entries.has(id)) {
      throw new Error(`AI index '${id}' is already registered`);
    }
    this.entries.set(id, properties);
    if (options?.dreaming) {
      this.dreaming.set(id, options.dreaming);
    }
  }

  /** Marks setup complete; further `register()` calls are rejected. */
  freeze(): void {
    this.frozen = true;
  }

  /** Ids of managed AI indices registered by plugins at setup. */
  getManagedIds(): string[] {
    return [...this.entries.keys()];
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): AiIndexProperties | undefined {
    return this.entries.get(id);
  }

  getDreamingConfig(id: string): ManagedDreamingConfig | undefined {
    return this.dreaming.get(id);
  }

  /**
   * Idempotent upsert of one managed entry into one space. Safe to call on
   * every access.
   */
  async ensure({
    id,
    spaceId,
    aiIndexService,
    logger,
  }: {
    id: string;
    spaceId: string;
    aiIndexService: AiIndexService;
    logger: Logger;
  }): Promise<void> {
    const properties = this.entries.get(id);
    if (!properties) {
      return;
    }
    try {
      const result = await aiIndexService.putManaged(id, spaceId, properties);
      logger.debug(`AI index '${id}' ${result} in space '${spaceId}'`);
    } catch (err) {
      if (err instanceof AiIndexConflictError) {
        logger.debug(
          `AI index '${id}' was registered concurrently in space '${spaceId}' — skipping.`
        );
        return;
      }
      throw err;
    }
  }
}
