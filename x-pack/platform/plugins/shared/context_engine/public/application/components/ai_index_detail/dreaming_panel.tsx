/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  EuiButton,
  EuiButtonEmpty,
  EuiCodeBlock,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFormRow,
  EuiHorizontalRule,
  EuiModal,
  EuiModalBody,
  EuiModalFooter,
  EuiModalHeader,
  EuiModalHeaderTitle,
  EuiPanel,
  EuiSkeletonText,
  EuiSpacer,
  EuiText,
  EuiTextArea,
  EuiTitle,
  useGeneratedHtmlId,
} from '@elastic/eui';
import { i18n } from '@kbn/i18n';
import { FormattedMessage } from '@kbn/i18n-react';
import { KbnDangerCallout, KbnInfoCallout } from '@kbn/ui-callout';
import React, { useMemo, useState } from 'react';
import type { AiIndexDreaming, AiIndexDreamingConfig } from '../../../../common/dreaming';
import { matchingTemplateId } from '../../../../common/dreaming_templates';
import { useAiIndexDreaming } from '../../hooks/use_ai_index_dreaming';
import { useAllDreamingTemplates } from '../../hooks/use_dreaming_templates';
import { useNavigation } from '../../hooks/use_navigation';
import { useSaveDreamingConfig } from '../../hooks/use_save_dreaming_config';
import { getAiIndexDreamingTemplatePath } from '../../paths';
import {
  DreamingConfigEditor,
  draftBuildsAnything,
  draftOf,
  typesOfDraft,
  type DreamingConfigDraft,
} from '../dreaming_config/dreaming_config_editor';
import { AiIndexDetailPanelDescription } from './ai_index_detail_panel_description';

/** Tallest the JSON gets before it scrolls. */
export const DREAMING_JSON_MAX_HEIGHT = 480;

const errorTitle = i18n.translate('xpack.contextEngine.aiIndexDetail.dreaming.errorTitle', {
  defaultMessage: 'Unable to load the dreaming config',
});

const configOf = ({ state, ...config }: AiIndexDreaming): AiIndexDreamingConfig => config;

const sameTypes = (a: DreamingConfigDraft, b: DreamingConfigDraft): boolean =>
  JSON.stringify(typesOfDraft(a)) === JSON.stringify(typesOfDraft(b));

const DreamingJsonModal = ({
  dreaming,
  onClose,
}: {
  dreaming: AiIndexDreaming;
  onClose: () => void;
}) => {
  const titleId = useGeneratedHtmlId();
  return (
    <EuiModal
      aria-labelledby={titleId}
      onClose={onClose}
      style={{ width: 800 }}
      data-test-subj="contextAiIndexDreamingJsonModal"
    >
      <EuiModalHeader>
        <EuiModalHeaderTitle id={titleId}>
          {i18n.translate('xpack.contextEngine.aiIndexDetail.dreaming.jsonTitle', {
            defaultMessage: 'Dreaming config and state',
          })}
        </EuiModalHeaderTitle>
      </EuiModalHeader>
      <EuiModalBody>
        <EuiCodeBlock
          language="json"
          fontSize="s"
          paddingSize="m"
          overflowHeight={DREAMING_JSON_MAX_HEIGHT}
          isCopyable
          data-test-subj="contextAiIndexDreamingJson"
        >
          {JSON.stringify(dreaming, null, 2)}
        </EuiCodeBlock>
      </EuiModalBody>
      <EuiModalFooter>
        <EuiButton onClick={onClose} data-test-subj="contextAiIndexDreamingJsonClose">
          {i18n.translate('xpack.contextEngine.aiIndexDetail.dreaming.jsonClose', {
            defaultMessage: 'Close',
          })}
        </EuiButton>
      </EuiModalFooter>
    </EuiModal>
  );
};

interface DreamingEditorProps {
  aiIndexId: string;
  dreaming: AiIndexDreaming;
  managed: boolean;
}

/** The saved fact, entity and relationship types, edited as in onboarding, then saved. */
const DreamingEditor = ({ aiIndexId, dreaming, managed }: DreamingEditorProps) => {
  const saved = useMemo(() => draftOf(dreaming), [dreaming]);
  const [edited, setEdited] = useState<DreamingConfigDraft>();
  const [editedInstructions, setEditedInstructions] = useState<string>();
  const { saveConfig, isSaving } = useSaveDreamingConfig();
  const { templates } = useAllDreamingTemplates();
  const draft = edited ?? saved;
  const savedInstructions = dreaming.instructions ?? '';
  const instructions = editedInstructions ?? savedInstructions;
  const isDirty =
    (edited !== undefined && !sameTypes(edited, saved)) || instructions !== savedInstructions;
  const suggestedId = matchingTemplateId(dreaming, templates);
  const suggestedEntities = templates.find(({ id }) => id === suggestedId)?.dreaming.entities;

  const discard = () => {
    setEdited(undefined);
    setEditedInstructions(undefined);
  };

  const save = async () => {
    const { instructions: _, ...rest } = configOf(dreaming);
    const trimmed = instructions.trim();
    const config = { ...rest, ...(trimmed && { instructions: trimmed }), ...typesOfDraft(draft) };
    if (await saveConfig({ aiIndexId, config })) {
      discard();
    }
  };

  return (
    <>
      {managed && (
        <>
          <EuiText size="s" color="subdued" data-test-subj="contextAiIndexDreamingManaged">
            <p>
              {i18n.translate('xpack.contextEngine.aiIndexDetail.dreaming.managed', {
                defaultMessage: 'This AI index’s dreaming config is set by Elastic.',
              })}
            </p>
          </EuiText>
          <EuiSpacer size="m" />
        </>
      )}
      <EuiFormRow
        fullWidth
        label={i18n.translate('xpack.contextEngine.aiIndexDetail.dreaming.instructionsLabel', {
          defaultMessage: 'Instructions',
        })}
        helpText={i18n.translate('xpack.contextEngine.aiIndexDetail.dreaming.instructionsHelp', {
          defaultMessage:
            'What dreaming is told about this AI index: what it holds, who uses it, and what to record or skip.',
        })}
      >
        <EuiTextArea
          fullWidth
          rows={6}
          value={instructions}
          readOnly={managed}
          onChange={(event) => setEditedInstructions(event.target.value)}
          data-test-subj="contextAiIndexDreamingInstructions"
        />
      </EuiFormRow>
      <EuiHorizontalRule margin="xl" />
      <DreamingConfigEditor
        draft={draft}
        {...(!managed && { onChange: setEdited })}
        {...(suggestedEntities && { suggestedEntities })}
      />
      {isDirty && (
        <>
          <EuiHorizontalRule margin="l" />
          <EuiFlexGroup justifyContent="flexEnd" gutterSize="s" responsive={false}>
            <EuiFlexItem grow={false}>
              <EuiButtonEmpty onClick={discard} data-test-subj="contextAiIndexDreamingDiscard">
                {i18n.translate('xpack.contextEngine.aiIndexDetail.dreaming.discard', {
                  defaultMessage: 'Discard changes',
                })}
              </EuiButtonEmpty>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButton
                fill
                onClick={save}
                isLoading={isSaving}
                isDisabled={!draftBuildsAnything(draft)}
                data-test-subj="contextAiIndexDreamingSave"
              >
                {i18n.translate('xpack.contextEngine.aiIndexDetail.dreaming.save', {
                  defaultMessage: 'Save changes',
                })}
              </EuiButton>
            </EuiFlexItem>
          </EuiFlexGroup>
        </>
      )}
    </>
  );
};

interface DreamingPanelProps {
  aiIndexId: string;
  /** A managed AI index's config is registered in code, so it is shown read-only. */
  managed?: boolean;
}

/**
 * What the AI index's dreaming learns, editable as in onboarding, with its config and state as
 * JSON in a modal. An AI index that was never set up links to the setup.
 */
export const DreamingPanel = ({ aiIndexId, managed = false }: DreamingPanelProps) => {
  const { dreaming, isLoading, error } = useAiIndexDreaming(aiIndexId);
  const { navigateToContextEngine } = useNavigation();
  const [isJsonOpen, setIsJsonOpen] = useState(false);
  const shown = dreaming ?? { enabled: false };
  const isSetUp = shown.enabled || draftBuildsAnything(draftOf(shown));

  return (
    <EuiPanel hasBorder paddingSize="l" data-test-subj="contextAiIndexDreamingPanel">
      <EuiFlexGroup alignItems="center" responsive={false}>
        <EuiFlexItem>
          <EuiTitle size="s">
            <h2>
              <FormattedMessage
                id="xpack.contextEngine.aiIndexDetail.dreaming.title"
                defaultMessage="Dreaming"
              />
            </h2>
          </EuiTitle>
        </EuiFlexItem>
        {!isLoading && !error && (
          <EuiFlexItem grow={false}>
            <EuiButtonEmpty
              size="s"
              iconType="code"
              onClick={() => setIsJsonOpen(true)}
              data-test-subj="contextAiIndexDreamingViewJson"
            >
              {i18n.translate('xpack.contextEngine.aiIndexDetail.dreaming.viewJson', {
                defaultMessage: 'View JSON',
              })}
            </EuiButtonEmpty>
          </EuiFlexItem>
        )}
      </EuiFlexGroup>
      <AiIndexDetailPanelDescription>
        <FormattedMessage
          id="xpack.contextEngine.aiIndexDetail.dreaming.description"
          defaultMessage="What this AI index learns from its memories and conversations."
        />
      </AiIndexDetailPanelDescription>
      <EuiSpacer size="l" />
      {isLoading ? (
        <EuiSkeletonText lines={4} data-test-subj="contextAiIndexDreamingLoading" />
      ) : error ? (
        <KbnDangerCallout
          announceOnMount={false}
          title={errorTitle}
          size="s"
          data-test-subj="contextAiIndexDreamingError"
        >
          {error.message}
        </KbnDangerCallout>
      ) : isSetUp ? (
        <DreamingEditor aiIndexId={aiIndexId} dreaming={shown} managed={managed} />
      ) : (
        <>
          <KbnInfoCallout
            size="s"
            title={i18n.translate('xpack.contextEngine.aiIndexDetail.dreaming.notSetUpTitle', {
              defaultMessage:
                'Dreaming is not set up. Choose what this AI index learns from its memories and conversations.',
            })}
            data-test-subj="contextAiIndexDreamingNotSetUp"
          />
          <EuiSpacer size="m" />
          <EuiButton
            size="s"
            onClick={() => navigateToContextEngine(getAiIndexDreamingTemplatePath(aiIndexId))}
            data-test-subj="contextAiIndexDreamingSetUp"
          >
            {i18n.translate('xpack.contextEngine.aiIndexDetail.dreaming.setUp', {
              defaultMessage: 'Set up memory',
            })}
          </EuiButton>
        </>
      )}
      {isJsonOpen && <DreamingJsonModal dreaming={shown} onClose={() => setIsJsonOpen(false)} />}
    </EuiPanel>
  );
};
