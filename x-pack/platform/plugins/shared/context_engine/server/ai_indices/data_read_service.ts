/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, Logger } from '@kbn/core/server';
import type { AuditLogger } from '@kbn/core-security-server';
import type {
  AiIndexHttpItem,
  DescribeAiIndexResponse,
  QueryAiIndicesRequest,
  QueryAiIndicesResponse,
} from '../../common/http_api/ai_indices';
import { AiIndexAuditAction, aiIndexAuditEvent } from '../audit/audit_events';
import { describeAiIndex } from './describe';
import { AiIndexNotFoundError, AiIndexNotReadableError, InvalidAiIndexQueryError } from './errors';
import { filterReadableAiIndices, probeAiIndices } from './filter_readable_ai_indices';
import { isAiIndexDest, sourcesOf } from './missing_indices';
import { queryAiIndices } from './query';
import type { AiIndexService } from './service';

/** Caller-scoped AI-index reads. One instance per request; shared by HTTP routes and agent tools. */
export interface AiIndexDataReadServiceApi {
  query(request: QueryAiIndicesRequest): Promise<QueryAiIndicesResponse>;
  /** Throws `AiIndexNotFoundError` for an unknown id, `AiIndexNotReadableError` when the caller cannot read the backing index. */
  describe(id: string): Promise<DescribeAiIndexResponse>;
  /**
   * The AI Indices registered in this space whose backing index the caller can read. An empty
   * backing index still counts. Left out when the caller cannot read it, or when the check itself
   * failed. `ids` limits which entries are checked. Hidden AI indices are left out too, unless the
   * service was created to include them.
   */
  list(ids?: string[]): Promise<AiIndexHttpItem[]>;
}

export class AiIndexDataReadService implements AiIndexDataReadServiceApi {
  constructor(
    private readonly deps: {
      esClient: ElasticsearchClient;
      spaceId: string;
      auditLogger: AuditLogger;
      aiIndexService: Pick<AiIndexService, 'get' | 'list'>;
      logger: Logger;
      isMemoryEnabled: () => Promise<boolean>;
      /** The ids the caller's user-scoped KIs can be owned by: profile uid and username. */
      getCurrentUserIds?: () => string[];
      /**
       * Reads hidden AI indices too, such as user-memories. Only the memory APIs set it; reading
       * one needs the internal user's client, since its backing store is a system index.
       */
      includeHidden?: boolean;
    }
  ) {}

  private isVisible = ({ hidden }: AiIndexHttpItem): boolean =>
    this.deps.includeHidden === true || hidden !== true;

  /** Refuses a query that names a hidden AI index's backing index. */
  private assertNoHiddenSource(query: string, aiIndices: AiIndexHttpItem[]): void {
    const hidden = aiIndices.filter((aiIndex) => !this.isVisible(aiIndex));
    const named = hidden.find(({ dest }) =>
      sourcesOf(query).some((source) => isAiIndexDest(source, [dest]))
    );
    if (named) {
      throw new InvalidAiIndexQueryError(`AI index '${named.id}' cannot be queried.`);
    }
  }

  async query(request: QueryAiIndicesRequest): Promise<QueryAiIndicesResponse> {
    const { esClient, spaceId, auditLogger, aiIndexService } = this.deps;
    try {
      const aiIndices = await aiIndexService.list(spaceId);
      this.assertNoHiddenSource(request.query, aiIndices);
      const response = await queryAiIndices({
        esClient,
        spaceId,
        aiIndexDests: aiIndices.filter(this.isVisible).map(({ dest }) => dest),
        userScopedDests: aiIndices
          .filter(({ memory_scope: scope }) => scope === 'user')
          .map(({ dest }) => dest),
        userIds: this.deps.getCurrentUserIds?.() ?? [],
        ...request,
      });
      auditLogger.log(aiIndexAuditEvent({ action: AiIndexAuditAction.QUERY }));
      return response;
    } catch (error) {
      auditLogger.log(aiIndexAuditEvent({ action: AiIndexAuditAction.QUERY, error }));
      throw error;
    }
  }

  /** Throws unless the caller can read the backing index. */
  private async assertReadable(aiIndex: AiIndexHttpItem): Promise<void> {
    const { esClient, logger } = this.deps;
    const [{ failure }] = await probeAiIndices({ esClient, aiIndices: [aiIndex], logger });
    if (failure === undefined) {
      return;
    }
    if (failure.privilege) {
      throw new AiIndexNotReadableError(aiIndex.id);
    }
    throw new Error(`AI index '${aiIndex.id}' is not available: ${failure.reason}`);
  }

  async describe(id: string): Promise<DescribeAiIndexResponse> {
    const { esClient, spaceId, auditLogger, aiIndexService, isMemoryEnabled } = this.deps;
    try {
      const [aiIndex, includeMemory] = await Promise.all([
        aiIndexService.get(id, spaceId),
        isMemoryEnabled(),
      ]);
      if (!this.isVisible(aiIndex)) {
        throw new AiIndexNotFoundError(id);
      }
      await this.assertReadable(aiIndex);
      const response = await describeAiIndex({ esClient, aiIndex, spaceId, includeMemory });
      auditLogger.log(aiIndexAuditEvent({ action: AiIndexAuditAction.DESCRIBE, id }));
      return { response };
    } catch (error) {
      auditLogger.log(aiIndexAuditEvent({ action: AiIndexAuditAction.DESCRIBE, id, error }));
      throw error;
    }
  }

  async list(ids?: string[]): Promise<AiIndexHttpItem[]> {
    const { esClient, spaceId, auditLogger, aiIndexService, logger } = this.deps;
    try {
      const registry = await aiIndexService.list(spaceId);
      const requested = ids && new Set(ids);
      const aiIndices = registry.filter(
        (aiIndex) => this.isVisible(aiIndex) && (!requested || requested.has(aiIndex.id))
      );
      // A hidden AI index lives in a system index only Kibana reads, so the caller's privileges
      // on it say nothing: it is listed when asked for, and read through the memory APIs.
      const probed = await filterReadableAiIndices({
        esClient,
        aiIndices: aiIndices.filter(({ hidden }) => !hidden),
        logger,
      });
      const readable = aiIndices.filter(
        (aiIndex) => aiIndex.hidden || probed.some(({ id }) => id === aiIndex.id)
      );
      auditLogger.log(aiIndexAuditEvent({ action: AiIndexAuditAction.LIST }));
      return readable;
    } catch (error) {
      auditLogger.log(aiIndexAuditEvent({ action: AiIndexAuditAction.LIST, error }));
      throw error;
    }
  }
}
