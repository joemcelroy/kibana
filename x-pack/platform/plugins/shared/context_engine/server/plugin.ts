/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  CoreSetup,
  CoreStart,
  ElasticsearchClient,
  KibanaRequest,
  Plugin,
  PluginInitializerContext,
} from '@kbn/core/server';
import type { AgentBuilderPluginStart } from '@kbn/agent-builder-server';
import type { Logger } from '@kbn/logging';
import { schema } from '@kbn/config-schema';
import { i18n } from '@kbn/i18n';
import { CONTEXT_ENGINE_MEMORY_ENABLED_SETTING_ID } from '@kbn/management-settings-ids';
import { WorkflowsManagementOperationPrivileges } from '@kbn/workflows';
import { CONTEXT_ENGINE_FEEDBACK_LOOP_ENABLED_SETTING_ID } from '../common/constants';
import { apiPrivileges } from '../common/features';
import type {
  ContextEnginePluginSetup,
  ContextEnginePluginStart,
  ContextEngineSetupDependencies,
  ContextEngineStartDependencies,
  DeleteWorkflowsApi,
  GetAiIndexDataReadServiceParams,
} from './types';
import type { KiVerifierWorkflowRunner } from './ki_verification';
import { registerFeatures } from './features';
import { registerAiIndexRoutes } from './routes/ai_indices';
import { registerSignalRoutes } from './routes/signals';
import type {
  FeedbackAnalysisScheduleService,
  WorkflowEnablementApi,
} from './feedback_analysis/schedule';
import { createFeedbackAnalysisScheduleService } from './feedback_analysis/schedule';
import { AiIndexDataReadService } from './ai_indices/data_read_service';
import { AiIndexService } from './ai_indices/service';
import { AiIndexRegistry } from './ai_indices/registry';
import { ImprovementsService } from './improvements/service';
import { installImprovementsIndexTemplate } from './improvements/storage';
import { SignalsService } from './signals/service';
import type { SignalsServiceApi } from './signals/service';
import { registerSignalGeneratorTaskDefinition, scheduleSignalGenerator } from './tasks';
import { createVerifyKiStepDefinition } from './step_types/verify_ki_step';
import { createVerifyKi } from './step_types/verify_ki';
import { registerStepDefinitions } from './step_types';
import { ContextEngineAnalyticsService, registerContextEngineUsageCollector } from './telemetry';
import { isContextEngineEnabledInSpace } from './utils/is_context_engine_enabled_in_space';
import { resolveSpaceId } from './utils/resolve_space_id';
import {
  SHORT_TERM_MEMORY_DATA_STREAM,
  TRANSCRIPTS_DATA_STREAM,
  type ShortTermMemory,
  type Transcript,
} from '../common/dreaming';
import {
  shortTermMemoryDataStreamDefinition,
  type ShortTermMemoryMappings,
} from './short_term_memory/storage';
import { ShortTermMemoryService } from './short_term_memory/service';
import { transcriptsDataStreamDefinition, type TranscriptMappings } from './transcripts/storage';
import { TranscriptService } from './transcripts/service';
import { createDreamingMemoryReader, type DreamingMemoryReader } from './dreaming/memory_reader';
import { registerMemoryRoutes } from './routes/memory';
import { createMemoryApi, type MemoryApi } from './memory/api';
import { DreamingRunProgress } from './dreaming/run_progress';
import { DreamingService } from './dreaming/service';
import { createDreamingScheduleService, type DreamingScheduleService } from './dreaming/schedule';
import { resolveDreamingModel } from './dreaming/model';
import { forgetMemory } from './dreaming/forget';
import { registerUserMemoriesAiIndex } from './user_memories';
import { ownerIdsOf } from './user_memory/owner_ids';
import {
  assertMemoryTargets,
  authorizeMemoryTargets,
  requestDream,
  resolveMemoryTargets,
  resolveRoundTargets,
} from './dreaming/request_dream';
import { registerDreamingRoutes } from './routes/dreaming';
import { registerUserMemoryRoutes } from './routes/user_memory';
import { forgetRounds } from './user_memory/forget_rounds';
import { MemorySettingsService } from './user_memory/settings';

/** Must match the `pluginId` on the managed workflow definition. */
const CONTEXT_ENGINE_WORKFLOW_OWNER = 'contextEngine';

export class ContextEnginePlugin
  implements
    Plugin<
      ContextEnginePluginSetup,
      ContextEnginePluginStart,
      ContextEngineSetupDependencies,
      ContextEngineStartDependencies
    >
{
  private logger: Logger;
  private aiIndexService?: AiIndexService;
  private signalsService?: SignalsService;
  private createImprovementsService?: (
    esClient: ElasticsearchClient,
    spaceId: string
  ) => ImprovementsService;
  private createAiIndexDataReadService?: (
    params: GetAiIndexDataReadServiceParams
  ) => AiIndexDataReadService;
  private esClient?: ElasticsearchClient;
  private scheduleService?: FeedbackAnalysisScheduleService;
  /** Captured at setup because the schedule service, built at start, enables workflows with it. */
  private workflowsManagement?: WorkflowEnablementApi;
  private isFeedbackLoopEnabled: () => Promise<boolean> = async () => false;
  private readonly aiIndexRegistry = new AiIndexRegistry();
  private analyticsService?: ContextEngineAnalyticsService;
  private memoryReader?: DreamingMemoryReader;
  private memoryApi?: MemoryApi;
  private forgetRounds?: ContextEnginePluginStart['forgetRounds'];
  private dreamingRunProgress?: DreamingRunProgress;
  private memorySettings?: MemorySettingsService;
  private dreamingService?: DreamingService;
  private dreamingSchedule?: DreamingScheduleService;
  private workflowsManagementApiPromise: Promise<
    (DeleteWorkflowsApi & KiVerifierWorkflowRunner & WorkflowEnablementApi) | undefined
  > = Promise.resolve(undefined);

  constructor(context: PluginInitializerContext) {
    this.logger = context.logger.get();
  }

  setup(
    coreSetup: CoreSetup<ContextEngineStartDependencies, ContextEnginePluginStart>,
    setupDeps: ContextEngineSetupDependencies
  ): ContextEnginePluginSetup {
    registerFeatures({ features: setupDeps.features });
    this.setupWorkflowsManagement(coreSetup);
    coreSetup.dataStreams.registerDataStream(shortTermMemoryDataStreamDefinition);
    coreSetup.dataStreams.registerDataStream(transcriptsDataStreamDefinition);

    this.workflowsManagement = setupDeps.workflowsManagement?.management;

    this.analyticsService = new ContextEngineAnalyticsService(
      coreSetup.analytics,
      this.logger.get('telemetry')
    );
    this.analyticsService.registerContextEngineEventTypes();
    const analyticsService = this.analyticsService;

    registerContextEngineUsageCollector({
      usageCollection: setupDeps.usageCollection,
      getEsClient: async () => {
        const [coreStart] = await coreSetup.getStartServices();
        return coreStart.elasticsearch.client.asInternalUser;
      },
      getManagedDest: (id) => this.aiIndexRegistry.get(id)?.dest,
      logger: this.logger.get('telemetry'),
    });

    const checkApiPrivileges = async (
      request: KibanaRequest,
      spaceId: string,
      actions: readonly string[]
    ): Promise<boolean> => {
      const [, startDeps] = await coreSetup.getStartServices();
      const { security } = startDeps;
      if (!security) {
        return true;
      }
      const { hasAllRequested } = await security.authz
        .checkPrivilegesWithRequest(request)
        .atSpace(spaceId, {
          kibana: actions.map((action) => security.authz.actions.api.get(action)),
        });
      return hasAllRequested;
    };

    const verifyKi = createVerifyKi({
      getAuditLogger: async (request) => {
        const [coreStart] = await coreSetup.getStartServices();
        return coreStart.security.audit.asScoped(request);
      },
      workflowVerifierDeps: {
        getWorkflowsManagement: () => this.workflowsManagementApiPromise,
        checkExecutePrivilege: (request, spaceId) =>
          checkApiPrivileges(request, spaceId, WorkflowsManagementOperationPrivileges.execute),
      },
      analyticsService,
      logger: this.logger.get('context_steps'),
    });
    setupDeps.workflowsExtensions.registerStepDefinition(
      createVerifyKiStepDefinition(coreSetup, verifyKi)
    );

    coreSetup.uiSettings.registerGlobal({
      [CONTEXT_ENGINE_FEEDBACK_LOOP_ENABLED_SETTING_ID]: {
        name: i18n.translate('xpack.contextEngine.uiSettings.feedbackLoop.name', {
          defaultMessage: 'Context Engine feedback loop',
        }),
        description: i18n.translate('xpack.contextEngine.uiSettings.feedbackLoop.description', {
          defaultMessage:
            'Generates classified signals from Agent Builder traces to power the Context Engine feedback loop.',
        }),
        schema: schema.boolean(),
        value: false,
        experimental: true,
        requiresPageReload: false,
        readonly: false,
      },
      [CONTEXT_ENGINE_MEMORY_ENABLED_SETTING_ID]: {
        name: i18n.translate('xpack.contextEngine.uiSettings.memory.name', {
          defaultMessage: 'Context Engine memory',
        }),
        description: i18n.translate('xpack.contextEngine.uiSettings.memory.description', {
          defaultMessage: 'Enables memory capabilities for Context Engine AI indices.',
        }),
        schema: schema.boolean(),
        value: false,
        experimental: true,
        requiresPageReload: false,
        readonly: false,
      },
    });

    registerSignalGeneratorTaskDefinition({
      taskManager: setupDeps.taskManager,
      getEsClient: () => {
        if (!this.esClient) {
          throw new Error('Elasticsearch client not available — plugin has not started');
        }
        return this.esClient;
      },
      getSignalsService: (): SignalsServiceApi => {
        if (!this.signalsService) {
          throw new Error('Signals service not available — plugin has not started');
        }
        return this.signalsService;
      },
      getFeedbackLoopEnabled: () => this.isFeedbackLoopEnabled(),
      logger: this.logger.get('signal_generator'),
    });

    setupDeps.workflowsExtensions.registerManagedWorkflowOwner(CONTEXT_ENGINE_WORKFLOW_OWNER);

    const getAiIndexService = () => {
      if (!this.aiIndexService) {
        throw new Error('AI index service not available — plugin has not started');
      }
      return this.aiIndexService;
    };

    const getImprovementsService = (esClient: ElasticsearchClient, spaceId: string) => {
      if (!this.createImprovementsService) {
        throw new Error('Improvements service not available — plugin has not started');
      }
      return this.createImprovementsService(esClient, spaceId);
    };

    const getScheduleService = () => {
      if (!this.scheduleService) {
        throw new Error('Schedule service not available — plugin has not started');
      }
      return this.scheduleService;
    };

    const isMemoryEnabled = async (request: KibanaRequest) => {
      const [coreStart] = await coreSetup.getStartServices();
      const savedObjectsClient = coreStart.savedObjects.getScopedClient(request);
      const globalUiSettings = coreStart.uiSettings.globalAsScopedToClient(savedObjectsClient);
      return (
        (await globalUiSettings.get<boolean>(CONTEXT_ENGINE_MEMORY_ENABLED_SETTING_ID)) ?? false
      );
    };

    const router = coreSetup.http.createRouter();
    registerAiIndexRoutes({
      router,
      logger: this.logger.get('routes'),
      getAiIndexService,
      getImprovementsService,
      getScheduleService,
      isMemoryEnabled,
      getAiIndexDataReadService: (params) => {
        if (!this.createAiIndexDataReadService) {
          throw new Error('AI index read service not available — plugin has not started');
        }
        return this.createAiIndexDataReadService(params);
      },
      getActions: async () => {
        const [, startDeps] = await coreSetup.getStartServices();
        return startDeps.actions;
      },
      // Resolved at runtime because a static dependency on agentBuilder would be a cycle:
      // agentBuilder -> agentBuilderSml -> contextEngine.
      getAgentBuilder: async () => {
        const { agentBuilder } = await coreSetup.plugins.onStart<{
          agentBuilder: AgentBuilderPluginStart;
        }>('agentBuilder');
        return agentBuilder.found ? agentBuilder.contract : undefined;
      },
      getWorkflowsManagementApi: () => this.workflowsManagementApiPromise,
      getSpaces: async () => {
        const [, startDeps] = await coreSetup.getStartServices();
        return startDeps.spaces;
      },
      analyticsService,
    });

    const isContextEngineEnabled = async (spaceId: string) => {
      const [coreStart] = await coreSetup.getStartServices();
      return isContextEngineEnabledInSpace({
        savedObjects: coreStart.savedObjects,
        uiSettings: coreStart.uiSettings,
        spaceId,
      });
    };

    const checkWritePrivilege = async (request: KibanaRequest, spaceId: string) => {
      const [, startDeps] = await coreSetup.getStartServices();
      const { security } = startDeps;
      if (!security) {
        return true;
      }
      const { hasAllRequested } = await security.authz
        .checkPrivilegesWithRequest(request)
        .atSpace(spaceId, {
          kibana: [security.authz.actions.api.get(apiPrivileges.writeContextEngine)],
        });
      return hasAllRequested;
    };

    const requireStarted = <T>(value: T | undefined, name: string): T => {
      if (!value) {
        throw new Error(`${name} not available — plugin has not started`);
      }
      return value;
    };
    const getMemoryReader = () => requireStarted(this.memoryReader, 'Dreaming memory reader');
    const getDreamingSchedule = () =>
      requireStarted(this.dreamingSchedule, 'Dreaming schedule service');

    registerUserMemoryRoutes({
      router,
      logger: this.logger.get('routes'),
      getAiIndexService,
      getAiIndexDataReadService: (params) => {
        if (!this.createAiIndexDataReadService) {
          throw new Error('AI index read service not available — plugin has not started');
        }
        return this.createAiIndexDataReadService(params);
      },
      getSpaces: async () => {
        const [, startDeps] = await coreSetup.getStartServices();
        return startDeps.spaces;
      },
      forgetRounds: (params) => {
        if (!this.forgetRounds) {
          throw new Error('Short-term memory not available — plugin has not started');
        }
        return this.forgetRounds(params);
      },
      getMemorySettings: () => {
        if (!this.memorySettings) {
          throw new Error('Memory settings not available — plugin has not started');
        }
        return this.memorySettings;
      },
    });

    registerDreamingRoutes({
      router,
      logger: this.logger.get('routes'),
      getAiIndexService,
      getMemoryReader,
      getDreamingSchedule,
      getSpaces: async () => {
        const [, startDeps] = await coreSetup.getStartServices();
        return startDeps.spaces;
      },
    });

    registerMemoryRoutes({
      router,
      logger: this.logger.get('routes'),
      getMemoryApi: () => requireStarted(this.memoryApi, 'Memory API'),
      getSpaces: async () => {
        const [, startDeps] = await coreSetup.getStartServices();
        return startDeps.spaces;
      },
    });

    registerStepDefinitions({
      workflowsExtensions: setupDeps.workflowsExtensions,
      analyticsService,
      logger: this.logger.get('context_steps'),
      getAiIndexService,
      isContextEngineEnabled,
      checkWritePrivilege,
      verifyKi,
      dreaming: {
        getAiIndexService,
        getMemoryReader,
        getDreamingService: () => requireStarted(this.dreamingService, 'Dreaming service'),
        getRunProgress: () => requireStarted(this.dreamingRunProgress, 'Dreaming run progress'),
        getDreamingModel: async (request) => {
          const [, { inference, searchInferenceEndpoints }] = await coreSetup.getStartServices();
          return resolveDreamingModel({ request, inference, searchInferenceEndpoints });
        },
        isContextEngineEnabled,
        logger: this.logger.get('dreaming'),
      },
      feedbackAnalysis: {
        getAiIndexService,
        getImprovementsService,
        getAuditLogger: async (request) => {
          const [coreStart] = await coreSetup.getStartServices();
          return coreStart.security.audit.asScoped(request);
        },
        isContextEngineEnabled,
        isFeedbackLoopEnabled: () => this.isFeedbackLoopEnabled(),
        checkWritePrivilege,
        logger: this.logger.get('feedback_analysis'),
      },
    });

    // Read-only Signals routes (reads run as the current user, scoped to the active space).
    registerSignalRoutes({
      router,
      getSpaces: async () => {
        const [, startDeps] = await coreSetup.getStartServices();
        return startDeps.spaces;
      },
      // Reads the current value at request time (assigned in start(), after this setup() runs).
      getFeedbackLoopEnabled: () => this.isFeedbackLoopEnabled(),
    });

    registerUserMemoriesAiIndex(this.aiIndexRegistry);

    return {
      registerAiIndex: (id, properties, options) =>
        this.aiIndexRegistry.register(id, properties, options),
    };
  }

  private setupWorkflowsManagement(
    coreSetup: CoreSetup<ContextEngineStartDependencies, ContextEnginePluginStart>
  ): void {
    try {
      this.workflowsManagementApiPromise = coreSetup.plugins
        .onSetup<{
          workflowsManagement: {
            management: DeleteWorkflowsApi & KiVerifierWorkflowRunner & WorkflowEnablementApi;
          };
        }>('workflowsManagement')
        .then(({ workflowsManagement }) =>
          workflowsManagement.found ? workflowsManagement.contract.management : undefined
        )
        .catch(() => undefined);
    } catch {
      this.workflowsManagementApiPromise = Promise.resolve(undefined);
    }
  }

  start(coreStart: CoreStart, startDeps: ContextEngineStartDependencies): ContextEnginePluginStart {
    this.aiIndexRegistry.freeze();
    const aiIndexLogger = this.logger.get('ai_indices');

    this.esClient = coreStart.elasticsearch.client.asInternalUser;

    const ensureAiIndex = async (id: string, spaceId: string): Promise<boolean> => {
      const enabled = await isContextEngineEnabledInSpace({
        savedObjects: coreStart.savedObjects,
        uiSettings: coreStart.uiSettings,
        spaceId,
      });
      if (!enabled) {
        return false;
      }
      if (!this.aiIndexService) {
        throw new Error('AI index service not available — plugin has not started');
      }
      await this.aiIndexRegistry.ensure({
        id,
        spaceId,
        aiIndexService: this.aiIndexService,
        logger: aiIndexLogger,
      });
      return true;
    };

    this.aiIndexService = new AiIndexService({
      esClient: this.esClient,
      logger: aiIndexLogger,
      managedBootstrap: {
        isManaged: (id) => this.aiIndexRegistry.has(id),
        getManagedIds: () => this.aiIndexRegistry.getManagedIds(),
        getRegistration: (id) => this.aiIndexRegistry.get(id),
        getDreamingConfig: (id) => this.aiIndexRegistry.getDreamingConfig(id),
        ensure: ensureAiIndex,
      },
    });
    const aiIndexService = this.aiIndexService;

    this.signalsService = new SignalsService({
      esClient: this.esClient,
      logger: this.logger.get('signals'),
    });
    const signalsService = this.signalsService;

    const improvementsLogger = this.logger.get('improvements');
    this.createImprovementsService = (esClient: ElasticsearchClient, spaceId: string) =>
      new ImprovementsService({ esClient, logger: improvementsLogger, space: spaceId });
    const createImprovementsService = this.createImprovementsService;

    this.createAiIndexDataReadService = ({ esClient, request }) =>
      new AiIndexDataReadService({
        esClient,
        spaceId: resolveSpaceId(startDeps.spaces, request),
        auditLogger: coreStart.security.audit.asScoped(request),
        aiIndexService,
        logger: this.logger,
        isMemoryEnabled: async () => {
          const savedObjectsClient = coreStart.savedObjects.getScopedClient(request);
          const globalUiSettings = coreStart.uiSettings.globalAsScopedToClient(savedObjectsClient);
          return (
            (await globalUiSettings.get<boolean>(CONTEXT_ENGINE_MEMORY_ENABLED_SETTING_ID)) ?? false
          );
        },
        getCurrentUserIds: () =>
          ownerIdsOf(coreStart.security.authc.getCurrentUser(request) ?? undefined),
      });
    const createAiIndexDataReadService = this.createAiIndexDataReadService;

    // Installed as Kibana, with the cluster privilege it already holds. The index is left for the
    // first user write to create from it, so the store needs no grant on the internal user.
    installImprovementsIndexTemplate({
      esClient: this.esClient,
      logger: improvementsLogger,
    }).catch((err) => {
      improvementsLogger.warn(
        `Failed to install the improvements index template: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    });

    const getManagedWorkflowsClient = () =>
      startDeps.workflowsExtensions.initManagedWorkflowsClient(CONTEXT_ENGINE_WORKFLOW_OWNER);
    const feedbackAnalysisSchedule = createFeedbackAnalysisScheduleService({
      logger: this.logger,
      getManagedWorkflowsClient,
      ...(this.workflowsManagement ? { workflowsManagement: this.workflowsManagement } : {}),
    });
    const dreamingSchedule = createDreamingScheduleService({
      logger: this.logger,
      getManagedWorkflowsClient,
      getWorkflowsManagement: () => this.workflowsManagementApiPromise,
    });
    this.dreamingSchedule = dreamingSchedule;
    this.scheduleService = {
      reconcile: (params) => feedbackAnalysisSchedule.reconcile(params),
      // Deleting an AI index tears down every schedule it owns.
      remove: async (params) => {
        await Promise.all([
          feedbackAnalysisSchedule.remove(params),
          dreamingSchedule.remove(params),
        ]);
      },
    };

    const dreamingLogger = this.logger.get('dreaming');
    const shortTermMemoryService = new ShortTermMemoryService({
      getClient: () =>
        coreStart.dataStreams.initializeClient<ShortTermMemoryMappings, ShortTermMemory>(
          SHORT_TERM_MEMORY_DATA_STREAM
        ),
      esClient: this.esClient,
      assertTargets: (spaceId, aiIndexIds, memory) =>
        assertMemoryTargets({
          aiIndexService,
          spaceId,
          aiIndexIds,
          userId: memory.user_id,
        }),
    });
    const transcriptService = new TranscriptService({
      getClient: () =>
        coreStart.dataStreams.initializeClient<TranscriptMappings, Transcript>(
          TRANSCRIPTS_DATA_STREAM
        ),
      esClient: this.esClient,
      assertTargets: (spaceId, aiIndexIds, transcript) =>
        assertMemoryTargets({
          aiIndexService,
          spaceId,
          aiIndexIds,
          userId: transcript.user_id,
          round: true,
        }),
    });
    const memoryReader = createDreamingMemoryReader({
      shortTermMemory: shortTermMemoryService,
      transcripts: transcriptService,
    });
    this.memoryReader = memoryReader;
    this.dreamingRunProgress = new DreamingRunProgress({
      esClient: this.esClient,
      logger: dreamingLogger,
    });
    const memorySettings = new MemorySettingsService({
      esClient: this.esClient,
      logger: dreamingLogger,
    });
    this.memorySettings = memorySettings;
    this.dreamingService = new DreamingService({
      aiIndexService,
      memoryReader,
      transcripts: transcriptService,
      runProgress: this.dreamingRunProgress,
      logger: dreamingLogger,
    });

    const soClient = coreStart.savedObjects.createInternalRepository();
    const globalUiSettings = coreStart.uiSettings.globalAsScopedToClient(soClient);

    this.isFeedbackLoopEnabled = async () =>
      (await globalUiSettings.get<boolean>(CONTEXT_ENGINE_FEEDBACK_LOOP_ENABLED_SETTING_ID)) ??
      false;

    scheduleSignalGenerator({ taskManager: startDeps.taskManager }).catch((err) => {
      this.logger.warn(
        `Failed to schedule signal generator: ${err instanceof Error ? err.message : String(err)}`
      );
    });

    const forget = (spaceId: string, memoryId: string, request: KibanaRequest) =>
      forgetMemory({
        spaceId,
        memoryId,
        memoryReader,
        aiIndexService,
        esClient: coreStart.elasticsearch.client.asScoped(request).asCurrentUser,
        logger: dreamingLogger,
      });
    const forgetUserRounds: ContextEnginePluginStart['forgetRounds'] = ({
      spaceId,
      userId,
      request,
    }) =>
      forgetRounds({
        transcripts: transcriptService,
        forget: (space, memoryId) => forget(space, memoryId, request),
        spaceId,
        userId,
      });
    this.forgetRounds = forgetUserRounds;

    const memoryApi = createMemoryApi({
      shortTermMemory: shortTermMemoryService,
      transcripts: transcriptService,
      getDataRead: (request) =>
        createAiIndexDataReadService({
          esClient: coreStart.elasticsearch.client.asScoped(request).asCurrentUser,
          request,
        }),
      resolveMemoryTargets: (spaceId, aiIndexIds) =>
        resolveMemoryTargets({ aiIndexService, spaceId, aiIndexIds }),
      authorizeMemoryTargets: (spaceId, aiIndexIds, request) =>
        authorizeMemoryTargets({
          aiIndexService,
          spaceId,
          aiIndexIds,
          currentUserClient: coreStart.elasticsearch.client.asScoped(request).asCurrentUser,
        }),
      requestDream: ({ spaceId, aiIndexIds, memory, request }) =>
        requestDream({
          aiIndexService,
          dreamingSchedule,
          spaceId,
          aiIndexIds,
          memory,
          request,
          currentUserClient: coreStart.elasticsearch.client.asScoped(request).asCurrentUser,
        }),
      getCurrentUser: (request) => coreStart.security.authc.getCurrentUser(request) ?? undefined,
      isMemoryEnabled: async (request) =>
        (await coreStart.uiSettings
          .globalAsScopedToClient(coreStart.savedObjects.getScopedClient(request))
          .get<boolean>(CONTEXT_ENGINE_MEMORY_ENABLED_SETTING_ID)) ?? false,
      hasPrivilege: async (request, spaceId, privilege) => {
        const { security } = startDeps;
        if (!security) {
          return true;
        }
        const action =
          privilege === 'write'
            ? apiPrivileges.writeContextEngine
            : apiPrivileges.readContextEngine;
        const { hasAllRequested } = await security.authz
          .checkPrivilegesWithRequest(request)
          .atSpace(spaceId, { kibana: [security.authz.actions.api.get(action)] });
        return hasAllRequested;
      },
    });
    this.memoryApi = memoryApi;

    return {
      getAiIndexService: () => {
        if (!this.aiIndexService) {
          throw new Error('AI index service not available — plugin has not started');
        }
        return this.aiIndexService;
      },
      getAiIndexDataReadService: (params) => createAiIndexDataReadService(params),
      getSignalsService: () => signalsService,
      getImprovementsService: (esClient, spaceId) => createImprovementsService(esClient, spaceId),
      getShortTermMemoryService: () => shortTermMemoryService,
      remember: (params) => memoryApi.remember(params),
      recall: (params) => memoryApi.recall(params),
      saveTranscript: (params) => memoryApi.saveTranscript(params),
      forgetMemory: (spaceId, memoryId, request) => forget(spaceId, memoryId, request),
      forgetRounds: forgetUserRounds,
      learnsFromConversations: ({ spaceId, userIds }) =>
        memorySettings.learnsFromConversations(spaceId, userIds),
      resolveRoundTargets: ({ spaceId, aiIndexIds }) =>
        resolveRoundTargets({ aiIndexService, spaceId, aiIndexIds }),
      resolveMemoryTargets: ({ spaceId, aiIndexIds }) =>
        resolveMemoryTargets({ aiIndexService, spaceId, aiIndexIds }),
      authorizeMemoryTargets: ({ spaceId, aiIndexIds, request }) =>
        authorizeMemoryTargets({
          aiIndexService,
          spaceId,
          aiIndexIds,
          currentUserClient: coreStart.elasticsearch.client.asScoped(request).asCurrentUser,
        }),
      requestDream: ({ spaceId, aiIndexIds, memory, request }) =>
        requestDream({
          aiIndexService,
          dreamingSchedule,
          spaceId,
          aiIndexIds,
          memory,
          request,
          currentUserClient: coreStart.elasticsearch.client.asScoped(request).asCurrentUser,
        }),
    };
  }

  stop() {}
}
