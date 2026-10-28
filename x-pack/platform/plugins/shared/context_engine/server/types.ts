/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { PluginStartContract as ActionsPluginStart } from '@kbn/actions-plugin/server';
import type { ElasticsearchClient, KibanaRequest } from '@kbn/core/server';
import type { FeaturesPluginSetup } from '@kbn/features-plugin/server';
import type { InferenceServerStart } from '@kbn/inference-plugin/server';
import type { SearchInferenceEndpointsPluginStart } from '@kbn/search-inference-endpoints/server';
import type { SecurityPluginStart } from '@kbn/security-plugin/server';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import type { UsageCollectionSetup } from '@kbn/usage-collection-plugin/server';
import type {
  TaskManagerSetupContract,
  TaskManagerStartContract,
} from '@kbn/task-manager-plugin/server';
import type {
  WorkflowsExtensionsServerPluginSetup,
  WorkflowsExtensionsServerPluginStart,
} from '@kbn/workflows-extensions/server';
import type { WorkflowEnablementApi } from './feedback_analysis/schedule';
import type { AiIndexProperties } from '../common/http_api/ai_indices';
import type { AiIndexDataReadServiceApi } from './ai_indices/data_read_service';
import type { AiIndexService } from './ai_indices/service';
import type { AiIndexRegistrationOptions } from './ai_indices/registry';
import type { ImprovementsServiceApi } from './improvements/service';
import type { SignalsServiceApi } from './signals/service';
import type { ShortTermMemoryServiceApi } from './short_term_memory/service';
import type { ForgetMemoryResult } from './dreaming/forget';
import type { DreamRequestResult, MemoryTarget } from './dreaming/request_dream';
import type { ShortTermMemory } from '../common/dreaming';
import type { MemoryApi } from './memory/api';

export interface ContextEnginePluginSetup {
  registerAiIndex: (
    id: string,
    properties: AiIndexProperties,
    options?: AiIndexRegistrationOptions
  ) => void;
}

export interface GetAiIndexDataReadServiceParams {
  /** Request-scoped client; Elasticsearch authorizes every read. */
  esClient: ElasticsearchClient;
  /** Space and audit scope are resolved from this request. */
  request: KibanaRequest;
}

export interface ContextEnginePluginStart {
  getAiIndexService: () => AiIndexService;
  /** Caller-scoped AI-index reads (query, and later describe/list). */
  getAiIndexDataReadService: (params: GetAiIndexDataReadServiceParams) => AiIndexDataReadServiceApi;
  /** The signals store. */
  getSignalsService: () => SignalsServiceApi;
  /**
   * The improvements store for one space, bound to the caller's Elasticsearch client.
   * Pass a request-scoped client: the store is a user-owned index, so Elasticsearch authorizes each read and write.
   */
  getImprovementsService: (
    esClient: ElasticsearchClient,
    spaceId: string
  ) => ImprovementsServiceApi;
  /** The shared short-term memory stream. Runs as the internal user; authorize callers first. */
  getShortTermMemoryService: () => ShortTermMemoryServiceApi;
  /** Appends a short-term memory as the request's user. See {@link MemoryApi.remember}. */
  remember: MemoryApi['remember'];
  /** Searches AI indices or short-term memory as the request's user. See {@link MemoryApi.recall}. */
  recall: MemoryApi['recall'];
  /**
   * Saves the transcript of the request's user's conversation round, apart from short-term memory.
   * See {@link MemoryApi.saveTranscript}. Throws `TranscriptExistsError` when its id is taken.
   */
  saveTranscript: MemoryApi['saveTranscript'];
  /**
   * Deletes a short-term memory or transcript and queues the long-term memory built from it for
   * re-dreaming.
   * Marks that long-term memory stale as the request's user.
   */
  forgetMemory: (
    spaceId: string,
    memoryId: string,
    request: KibanaRequest
  ) => Promise<ForgetMemoryResult>;
  /**
   * Forgets every recorded conversation round of a user in a space, one at a time, so what was
   * dreamed from each is marked stale and rewritten.
   */
  forgetRounds: (params: {
    spaceId: string;
    userId: string;
    request: KibanaRequest;
  }) => Promise<{ forgotten: number }>;
  /**
   * Whether the user, by any id their memory can be owned by, lets agents learn from their
   * conversations in a space. Unset means yes.
   */
  learnsFromConversations: (params: {
    spaceId: string;
    userIds: readonly string[];
  }) => Promise<boolean>;
  /**
   * The AI indices among `aiIndexIds` that take recorded conversation rounds: memory on, and
   * dreaming on without `rounds: false`. Unknown ids are left out.
   */
  resolveRoundTargets: (params: {
    spaceId: string;
    aiIndexIds: readonly string[];
  }) => Promise<string[]>;
  /**
   * The AI indices among `aiIndexIds` that take memories, with whose memory each holds. Unknown
   * ids and AI indices without memory are left out, so an agent's list can be passed as it is.
   */
  resolveMemoryTargets: (params: {
    spaceId: string;
    aiIndexIds: readonly string[];
  }) => Promise<MemoryTarget[]>;
  /**
   * Throws unless the request's user may target memories at each AI index: memory is on and they
   * can write its backing store. Call it before writing a memory with `ai_index_ids`.
   */
  authorizeMemoryTargets: (params: {
    spaceId: string;
    aiIndexIds: readonly string[];
    request: KibanaRequest;
  }) => Promise<void>;
  /**
   * Starts dreaming now, as the request's user, on each AI index for the group `memory` belongs
   * to. A run requested while another is in progress waits for it.
   */
  requestDream: (params: {
    spaceId: string;
    aiIndexIds: readonly string[];
    memory: Pick<ShortTermMemory, 'session_id' | 'user_id'>;
    request: KibanaRequest;
  }) => Promise<DreamRequestResult[]>;
}

/** Duck-typed so Context Engine does not depend on `@kbn/workflows-management-plugin` (Moon cycle). */
export interface DeleteWorkflowsApi {
  deleteWorkflows(
    workflowIds: string[],
    spaceId: string,
    request: KibanaRequest,
    options?: { force?: boolean }
  ): Promise<{
    failures: Array<{ id: string; error: string }>;
  }>;
}

export interface ContextEngineSetupDependencies {
  features: FeaturesPluginSetup;
  taskManager: TaskManagerSetupContract;
  workflowsExtensions: WorkflowsExtensionsServerPluginSetup;
  /** Optional in the manifest; without it a feedback analysis schedule cannot be enabled. */
  workflowsManagement?: { management: WorkflowEnablementApi };
  usageCollection?: UsageCollectionSetup;
}

export interface ContextEngineStartDependencies {
  actions: ActionsPluginStart;
  taskManager: TaskManagerStartContract;
  security: SecurityPluginStart;
  spaces?: SpacesPluginStart;
  workflowsExtensions: WorkflowsExtensionsServerPluginStart;
  inference: InferenceServerStart;
  /** Resolves the dreaming model; without it dreaming cannot run. */
  searchInferenceEndpoints?: SearchInferenceEndpointsPluginStart;
}
