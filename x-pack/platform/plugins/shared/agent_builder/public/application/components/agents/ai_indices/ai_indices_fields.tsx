/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React, { useCallback, useMemo } from 'react';
import type { EuiComboBoxOptionOption } from '@elastic/eui';
import {
  EuiBadge,
  EuiBadgeGroup,
  EuiCheckbox,
  EuiComboBox,
  EuiFormRow,
  EuiFlexGroup,
  EuiFlexItem,
  EuiHighlight,
  EuiText,
  EuiTextBlockTruncate,
} from '@elastic/eui';
import { KbnDangerCallout } from '@kbn/ui-callout';
import {
  agentBuilderDefaultAiIndexId,
  agentBuilderUserMemoriesAiIndexId,
} from '@kbn/agent-builder-common';
import type { AiIndexHttpItem } from '@kbn/context-engine-plugin/common/http_api/ai_indices';
import type { AgentAiIndicesWarning } from '../../../../../common/http_api/agents';
import { useAgentAiIndicesById } from '../../../hooks/ai_indices/use_agent_ai_indices_by_id';
import { useListAiIndices } from '../../../hooks/ai_indices/use_list_ai_indices';
import { labels } from '../../../utils/i18n';
import { AiIndicesWarningsPanel } from './ai_indices_warnings_panel';

export const useAiIndices = (agentId?: string) => {
  const {
    aiIndices: availableAiIndices,
    isLoading: isLoadingAiIndices,
    error: aiIndicesError,
  } = useListAiIndices();
  const {
    aiIndices: agentAiIndices,
    warnings,
    isLoading: isLoadingAgentAiIndices,
    error: agentAiIndicesError,
  } = useAgentAiIndicesById(agentId, { enabled: Boolean(agentId) });

  const inheritedIds = useMemo(
    () => agentAiIndices.filter(({ is_default: isDefault }) => isDefault).map(({ id }) => id),
    [agentAiIndices]
  );

  return {
    availableAiIndices,
    inheritedIds,
    warnings,
    isLoading: isLoadingAiIndices || isLoadingAgentAiIndices,
    error: aiIndicesError ?? agentAiIndicesError,
  };
};

/**
 * AI indices with their own switch on the agent: `elastic` as a checkbox here, `user-memories` in
 * the agent's Memory settings. Neither is listed as a fixed default or offered in the picker.
 */
const builtinIdSet = new Set([agentBuilderDefaultAiIndexId, agentBuilderUserMemoriesAiIndexId]);

export interface AiIndicesFieldsProps {
  aiIndices: Array<Pick<AiIndexHttpItem, 'id' | 'description'>>;
  /** AI Indices assigned to the agent itself: editable, and the only ones a change writes back. */
  assignedIds: string[];
  /** AI Indices contributed by the agent's type. They always apply and cannot be removed here. */
  inheritedIds: string[];
  warnings?: AgentAiIndicesWarning[];
  isLoading: boolean;
  error?: Error;
  isFormDisabled: boolean;
  onChange: (assignedIds: string[]) => void;
  /** The agent's `enable_elastic_ai_index`; unset means on. */
  elasticAiIndexEnabled?: boolean;
  /** Shows the `elastic` checkbox when the agent's type provides that AI index. */
  onElasticAiIndexChange?: (enabled: boolean) => void;
  /** Creating an agent: its type's default AI indices are not known yet. */
  isNewAgent?: boolean;
}

export const AiIndicesFields: React.FC<AiIndicesFieldsProps> = ({
  aiIndices,
  assignedIds,
  inheritedIds,
  warnings = [],
  isLoading,
  error,
  isFormDisabled,
  onChange,
  elasticAiIndexEnabled,
  onElasticAiIndexChange,
  isNewAgent = false,
}) => {
  const inheritedIdSet = useMemo(() => new Set([...inheritedIds, ...builtinIdSet]), [inheritedIds]);
  const inheritedBadgeIds = useMemo(
    () => inheritedIds.filter((id) => !builtinIdSet.has(id)),
    [inheritedIds]
  );

  // Only agents whose type provides the `elastic` AI index can switch it.
  const elasticAiIndex = useMemo(() => {
    const available = aiIndices.find(({ id }) => id === agentBuilderDefaultAiIndexId);
    const applies =
      isNewAgent ||
      inheritedIds.includes(agentBuilderDefaultAiIndexId) ||
      elasticAiIndexEnabled === false;
    return onElasticAiIndexChange && available && applies ? available : undefined;
  }, [aiIndices, inheritedIds, isNewAgent, elasticAiIndexEnabled, onElasticAiIndexChange]);

  // Inherited ids are listed above as defaults, so they are not shown again here.
  const hiddenAssignedIds = useMemo(
    () => assignedIds.filter((id) => inheritedIdSet.has(id)),
    [assignedIds, inheritedIdSet]
  );

  // The API does not validate stored ids, so an agent can reference an index that was deleted.
  const selectedOptions = useMemo<Array<EuiComboBoxOptionOption<string>>>(
    () =>
      assignedIds
        .filter((id) => !inheritedIdSet.has(id))
        .map((id) => ({
          key: id,
          label: id,
          'data-test-subj': `agentBuilderSelectedAiIndex-${id}`,
        })),
    [assignedIds, inheritedIdSet]
  );

  const options = useMemo<Array<EuiComboBoxOptionOption<string>>>(
    () =>
      aiIndices
        .filter(({ id }) => !inheritedIdSet.has(id))
        .map(({ id, description }) => ({
          key: id,
          label: id,
          value: description,
          'data-test-subj': `agentBuilderAiIndexOption-${id}`,
        })),
    [aiIndices, inheritedIdSet]
  );

  const renderOption = useCallback(
    (
      { label, value: description }: EuiComboBoxOptionOption<string>,
      searchValue: string,
      contentClassName: string
    ) => (
      <EuiFlexGroup direction="column" gutterSize="xs" className={contentClassName}>
        <EuiText size="s">
          <strong>
            <EuiTextBlockTruncate
              lines={2}
              title={label}
              data-test-subj={`agentBuilderAiIndexOptionName-${label}`}
            >
              <EuiHighlight search={searchValue}>{label}</EuiHighlight>
            </EuiTextBlockTruncate>
          </strong>
        </EuiText>
        {description && (
          <EuiText size="xs" color="subdued">
            <EuiTextBlockTruncate
              lines={2}
              title={description}
              data-test-subj={`agentBuilderAiIndexOptionDescription-${label}`}
            >
              <EuiHighlight search={searchValue}>{description}</EuiHighlight>
            </EuiTextBlockTruncate>
          </EuiText>
        )}
      </EuiFlexGroup>
    ),
    []
  );

  // Configured but not listed for this user: deleted, unreadable, or not registered in this space.
  const unavailable = useMemo(() => {
    if (isLoading || error) {
      return { inherited: [], assigned: [] };
    }
    const availableIds = new Set(aiIndices.map(({ id }) => id));
    const isMissing = (id: string) => !availableIds.has(id);
    return {
      inherited: inheritedBadgeIds.filter(isMissing),
      assigned: selectedOptions.map(({ label }) => label).filter(isMissing),
    };
  }, [aiIndices, inheritedBadgeIds, selectedOptions, isLoading, error]);

  const handleChange = useCallback(
    (newSelectedOptions: Array<EuiComboBoxOptionOption<string>>) =>
      onChange([...hiddenAssignedIds, ...newSelectedOptions.map(({ label }) => label)]),
    [hiddenAssignedIds, onChange]
  );

  return (
    <EuiFlexGroup direction="column" gutterSize="m">
      {error && (
        <EuiFlexItem grow={false}>
          <KbnDangerCallout
            announceOnMount
            size="s"
            title={labels.aiIndices.loadErrorMessage}
            data-test-subj="agentBuilderAiIndicesLoadError"
          />
        </EuiFlexItem>
      )}

      {warnings.length > 0 && (
        <EuiFlexItem grow={false}>
          <AiIndicesWarningsPanel warnings={warnings} />
        </EuiFlexItem>
      )}

      {(inheritedBadgeIds.length > 0 || elasticAiIndex) && (
        <EuiFlexItem grow={false}>
          <EuiFormRow
            label={labels.aiIndices.defaultIndicesLabel}
            helpText={
              <>
                {labels.aiIndices.defaultIndicesHelpText}
                {unavailable.inherited.length > 0 && (
                  <span data-test-subj="agentBuilderUnavailableDefaultAiIndices">
                    {` ${labels.aiIndices.unavailableIndicesHelpText(
                      unavailable.inherited.join(', ')
                    )}`}
                  </span>
                )}
              </>
            }
            fullWidth
          >
            <EuiFlexGroup direction="column" gutterSize="s">
              {elasticAiIndex && (
                <EuiFlexItem grow={false}>
                  <EuiCheckbox
                    id="agentBuilderElasticAiIndex"
                    data-test-subj="agentBuilderElasticAiIndex"
                    checked={elasticAiIndexEnabled !== false}
                    onChange={(event) => onElasticAiIndexChange?.(event.target.checked)}
                    disabled={isFormDisabled}
                    label={
                      <>
                        <strong>{elasticAiIndex.id}</strong>
                        {elasticAiIndex.description && (
                          <EuiText size="xs" color="subdued">
                            <EuiTextBlockTruncate lines={2} title={elasticAiIndex.description}>
                              {elasticAiIndex.description}
                            </EuiTextBlockTruncate>
                          </EuiText>
                        )}
                      </>
                    }
                  />
                </EuiFlexItem>
              )}
              {inheritedBadgeIds.length > 0 && (
                <EuiFlexItem grow={false}>
                  <EuiBadgeGroup
                    gutterSize="s"
                    role="list"
                    data-test-subj="agentBuilderDefaultAiIndices"
                  >
                    {inheritedBadgeIds.map((id) => (
                      <EuiBadge
                        key={id}
                        color="hollow"
                        role="listitem"
                        data-test-subj={`agentBuilderDefaultAiIndex-${id}`}
                      >
                        {labels.aiIndices.defaultIndexBadge(id)}
                      </EuiBadge>
                    ))}
                  </EuiBadgeGroup>
                </EuiFlexItem>
              )}
            </EuiFlexGroup>
          </EuiFormRow>
        </EuiFlexItem>
      )}

      <EuiFlexItem grow={false}>
        <EuiFormRow
          label={labels.aiIndices.additionalIndicesLabel}
          labelAppend={
            <EuiText size="xs" color="subdued">
              {labels.aiIndices.optionalLabel}
            </EuiText>
          }
          helpText={
            unavailable.assigned.length > 0 ? (
              <span data-test-subj="agentBuilderUnavailableAiIndices">
                {labels.aiIndices.unavailableIndicesHelpText(unavailable.assigned.join(', '))}
              </span>
            ) : undefined
          }
          fullWidth
        >
          <EuiComboBox
            fullWidth
            aria-label={labels.aiIndices.additionalIndicesLabel}
            placeholder={labels.aiIndices.additionalIndicesPlaceholder}
            options={options}
            selectedOptions={selectedOptions}
            onChange={handleChange}
            renderOption={renderOption}
            rowHeight="auto"
            isLoading={isLoading}
            isDisabled={isFormDisabled}
            data-test-subj="agentBuilderAdditionalAiIndices"
          />
        </EuiFormRow>
      </EuiFlexItem>
    </EuiFlexGroup>
  );
};
