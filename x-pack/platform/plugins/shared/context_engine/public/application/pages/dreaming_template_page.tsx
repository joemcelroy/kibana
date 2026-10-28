/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  EuiButton,
  EuiButtonEmpty,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFormRow,
  EuiHorizontalRule,
  EuiIcon,
  EuiPanel,
  EuiSkeletonRectangle,
  EuiSkeletonText,
  EuiSpacer,
  EuiText,
  EuiTextArea,
  EuiTitle,
  useEuiTheme,
} from '@elastic/eui';
import { css } from '@emotion/react';
import { i18n } from '@kbn/i18n';
import { FormattedMessage } from '@kbn/i18n-react';
import { KbnDangerCallout } from '@kbn/ui-callout';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  buildDreamingTemplateConfig,
  type DreamingTemplate,
  type DreamingTemplateConfig,
  type DreamingTemplateSummary,
} from '../../../common/dreaming_templates';
import { AI_INDEX_CREATED_LOCATION_STATE } from '../ai_index_created_location_state';
import { DreamingTemplateOntology } from '../components/dreaming_template/dreaming_template_ontology';
import { Eyebrow } from '../components/dreaming_template/eyebrow';
import { OntologyGraph } from '../components/dreaming_template/ontology_graph';
import { useApplyDreamingTemplate } from '../hooks/use_apply_dreaming_template';
import { useContextEngineBreadcrumbs } from '../hooks/use_context_engine_breadcrumbs';
import { useDreamingTemplate, useDreamingTemplates } from '../hooks/use_dreaming_templates';
import { useNavigation } from '../hooks/use_navigation';
import {
  ContextEngineSubPageHeader,
  contextEngineBackDestinationLabel,
} from '../layout/context_engine_page_header';
import {
  ContextEnginePageSection,
  ContextEnginePageTemplate,
} from '../layout/context_engine_page_template';
import { getAiIndexDetailPath } from '../paths';

const pageTitle = i18n.translate('xpack.contextEngine.dreamingTemplate.title', {
  defaultMessage: 'Set up memory',
});

const loadErrorTitle = i18n.translate('xpack.contextEngine.dreamingTemplate.loadErrorTitle', {
  defaultMessage: 'Unable to load the examples',
});

const skipLabel = i18n.translate('xpack.contextEngine.dreamingTemplate.skipButton', {
  defaultMessage: 'Skip for now',
});

const STEP_COUNT = 2;

/** Scrolls whatever holds the element back to the top, so a new step starts at its heading. */
const scrollToTop = (element: HTMLElement | null) => {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    if (node.scrollTop > 0) {
      node.scrollTop = 0;
    }
  }
};

const StepEyebrow = ({ step }: { step: number }) => (
  <Eyebrow>
    {i18n.translate('xpack.contextEngine.dreamingTemplate.stepEyebrow', {
      defaultMessage: 'Step {step} of {count}',
      values: { step, count: STEP_COUNT },
    })}
  </Eyebrow>
);

const Highlight = ({ children }: { children: React.ReactNode }) => {
  const { euiTheme } = useEuiTheme();
  return <span css={{ color: euiTheme.colors.textPrimary }}>{children}</span>;
};

const StepHeading = ({
  step,
  title,
  lead,
}: {
  step: number;
  title: React.ReactNode;
  lead: string;
}) => (
  <>
    <StepEyebrow step={step} />
    <EuiSpacer size="m" />
    <EuiTitle size="l">
      <h2>{title}</h2>
    </EuiTitle>
    <EuiSpacer size="m" />
    <EuiText color="subdued">
      <p>{lead}</p>
    </EuiText>
  </>
);

const usePillStyles = () => {
  const { euiTheme } = useEuiTheme();
  return css`
    border-radius: ${euiTheme.size.xxl};
    padding-inline: ${euiTheme.size.l};
  `;
};

interface DescribeStepProps {
  templates: DreamingTemplateSummary[];
  isLoading: boolean;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  template: DreamingTemplate | undefined;
  templateError: Error | undefined;
  summary: string;
  onSummaryChange: (summary: string) => void;
  onSkip: () => void;
  onNext: () => void;
}

/** Step 1: pick the example closest to what's being built, and describe it. */
const DescribeStep = ({
  templates,
  isLoading,
  selectedId,
  onSelect,
  template,
  templateError,
  summary,
  onSummaryChange,
  onSkip,
  onNext,
}: DescribeStepProps) => {
  const pillStyles = usePillStyles();
  const selected = templates.find(({ id }) => id === selectedId);
  return (
    <>
      <StepHeading
        step={1}
        title={
          <FormattedMessage
            id="xpack.contextEngine.dreamingTemplate.describe.title"
            defaultMessage="What are you {building}?"
            values={{
              building: (
                <Highlight>
                  {i18n.translate('xpack.contextEngine.dreamingTemplate.describe.titleHighlight', {
                    defaultMessage: 'building',
                  })}
                </Highlight>
              ),
            }}
          />
        }
        lead={i18n.translate('xpack.contextEngine.dreamingTemplate.describe.lead', {
          defaultMessage:
            "Pick the example closest to your agent and describe it. We'll propose the facts, entities and relationships dreaming learns from this AI index's memories, for you to review next.",
        })}
      />
      <EuiSpacer size="xl" />
      {templateError ? (
        <KbnDangerCallout announceOnMount={false} title={loadErrorTitle} size="s">
          {templateError.message}
        </KbnDangerCallout>
      ) : template ? (
        <OntologyGraph
          entities={template.dreaming.entities ?? []}
          relationships={template.dreaming.relationships ?? []}
        />
      ) : (
        <EuiSkeletonRectangle width="100%" height={300} borderRadius="m" />
      )}
      <EuiSpacer size="xl" />
      <EuiFormRow
        fullWidth
        label={i18n.translate('xpack.contextEngine.dreamingTemplate.describe.examplesLabel', {
          defaultMessage: 'What are you building?',
        })}
        helpText={selected?.description}
      >
        {isLoading ? (
          <EuiSkeletonText lines={2} data-test-subj="contextDreamingTemplatesLoading" />
        ) : (
          <EuiFlexGroup gutterSize="s" wrap responsive={false} role="group">
            {templates.map(({ id, name }) => {
              const isSelected = id === selectedId;
              return (
                <EuiFlexItem grow={false} key={id}>
                  <EuiButton
                    css={pillStyles}
                    fill={isSelected}
                    color={isSelected ? 'primary' : 'text'}
                    isSelected={isSelected}
                    onClick={() => onSelect(id)}
                    data-test-subj={`contextDreamingTemplateOption-${id}`}
                  >
                    {name}
                  </EuiButton>
                </EuiFlexItem>
              );
            })}
          </EuiFlexGroup>
        )}
      </EuiFormRow>
      <EuiSpacer size="l" />
      <EuiFormRow
        fullWidth
        label={i18n.translate('xpack.contextEngine.dreamingTemplate.describe.summaryLabel', {
          defaultMessage: 'Describe your company, your agent and the knowledge it needs',
        })}
        helpText={i18n.translate('xpack.contextEngine.dreamingTemplate.describe.summaryHelpText', {
          defaultMessage:
            'Choose an example to start, then edit it to fit. Your description opens the instructions dreaming follows.',
        })}
      >
        <EuiTextArea
          fullWidth
          rows={4}
          value={summary}
          isLoading={!template && !templateError}
          onChange={(event) => onSummaryChange(event.target.value)}
          data-test-subj="contextDreamingTemplateSummary"
        />
      </EuiFormRow>
      <EuiHorizontalRule margin="xl" />
      <EuiFlexGroup justifyContent="spaceBetween" alignItems="center" responsive={false}>
        <EuiFlexItem grow={false}>
          <EuiButtonEmpty
            color="text"
            onClick={onSkip}
            data-test-subj="contextDreamingTemplateSkip"
          >
            {skipLabel}
          </EuiButtonEmpty>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiButton
            fill
            iconType="chevronSingleRight"
            iconSide="right"
            onClick={onNext}
            isDisabled={!template}
            data-test-subj="contextDreamingTemplateNext"
          >
            {i18n.translate('xpack.contextEngine.dreamingTemplate.describe.nextButton', {
              defaultMessage: 'Propose an ontology',
            })}
          </EuiButton>
        </EuiFlexItem>
      </EuiFlexGroup>
    </>
  );
};

interface ReviewStepProps {
  template: DreamingTemplate;
  config: DreamingTemplateConfig;
  isSaving: boolean;
  onBack: () => void;
  onSkip: () => void;
  onApply: () => void;
}

/** Step 2: the ontology the example proposes, to apply or skip. */
const ReviewStep = ({ template, config, isSaving, onBack, onSkip, onApply }: ReviewStepProps) => {
  const { euiTheme } = useEuiTheme();
  return (
    <>
      <StepHeading
        step={2}
        title={
          <FormattedMessage
            id="xpack.contextEngine.dreamingTemplate.review.title"
            defaultMessage="A proposed ontology for {yourDomain}"
            values={{
              yourDomain: (
                <Highlight>
                  {i18n.translate('xpack.contextEngine.dreamingTemplate.review.titleHighlight', {
                    defaultMessage: 'your domain',
                  })}
                </Highlight>
              ),
            }}
          />
        }
        lead={i18n.translate('xpack.contextEngine.dreamingTemplate.review.lead', {
          defaultMessage:
            'These types shape how dreaming turns this AI index’s memories into knowledge your agent can recall. Apply them and turn dreaming on, or skip and set it up later.',
        })}
      />
      <EuiSpacer size="l" />
      <EuiPanel
        color="primary"
        hasShadow={false}
        paddingSize="l"
        data-test-subj="contextDreamingTemplateRationale"
      >
        <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
          <EuiFlexItem grow={false}>
            <EuiIcon type="sparkles" color="primary" aria-hidden />
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <Eyebrow>
              {i18n.translate('xpack.contextEngine.dreamingTemplate.review.rationaleTitle', {
                defaultMessage: 'Why this shape',
              })}
            </Eyebrow>
          </EuiFlexItem>
        </EuiFlexGroup>
        <EuiSpacer size="s" />
        <EuiText css={{ color: euiTheme.colors.textParagraph }}>
          <p>{template.rationale}</p>
        </EuiText>
      </EuiPanel>
      <EuiSpacer size="m" />
      {config.group_by && (
        <>
          <EuiText size="s" color="subdued" data-test-subj="contextDreamingTemplateGroupBy">
            <EuiIcon type="user" aria-hidden />{' '}
            <FormattedMessage
              id="xpack.contextEngine.dreamingTemplate.review.groupBy"
              defaultMessage="Learned per {field}: memories are grouped by it, and each group is turned into knowledge on its own."
              values={{ field: <strong>{config.group_by}</strong> }}
            />
          </EuiText>
          <EuiSpacer size="s" />
        </>
      )}
      <EuiText size="xs" color="subdued">
        <EuiIcon type="info" size="s" aria-hidden />{' '}
        {i18n.translate('xpack.contextEngine.dreamingTemplate.review.guidance', {
          defaultMessage:
            'These types guide what dreaming looks for. You can change them, and the instructions, later.',
        })}
      </EuiText>
      <EuiSpacer size="xl" />
      <DreamingTemplateOntology config={config} />
      <EuiHorizontalRule margin="xl" />
      <EuiFlexGroup justifyContent="spaceBetween" alignItems="center" responsive={false}>
        <EuiFlexItem grow={false}>
          <EuiButtonEmpty
            iconType="chevronSingleLeft"
            onClick={onBack}
            data-test-subj="contextDreamingTemplateBack"
          >
            {i18n.translate('xpack.contextEngine.dreamingTemplate.review.backButton', {
              defaultMessage: 'Back',
            })}
          </EuiButtonEmpty>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
            <EuiFlexItem grow={false}>
              <EuiButtonEmpty
                color="text"
                onClick={onSkip}
                data-test-subj="contextDreamingTemplateSkip"
              >
                {skipLabel}
              </EuiButtonEmpty>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButton
                fill
                onClick={onApply}
                isLoading={isSaving}
                data-test-subj="contextDreamingTemplateSave"
              >
                {i18n.translate('xpack.contextEngine.dreamingTemplate.review.applyButton', {
                  defaultMessage: 'Apply and continue',
                })}
              </EuiButton>
            </EuiFlexItem>
          </EuiFlexGroup>
        </EuiFlexItem>
      </EuiFlexGroup>
    </>
  );
};

/**
 * The step after creating an AI index with memory: pick the example closest to what's being built
 * and describe it, then review the ontology it proposes and apply it, or skip. Either way it
 * continues to the AI index's own onboarding.
 */
export const DreamingTemplatePage = () => {
  const { id: aiIndexId } = useParams<{ id: string }>();
  const { createContextEngineUrl, navigateToContextEngine } = useNavigation();
  const { templates, isLoading, error } = useDreamingTemplates();
  const [pickedId, setPickedId] = useState<string>();
  // Until edited, the description is the example's.
  const [editedSummary, setEditedSummary] = useState<string>();
  const [step, setStep] = useState<'describe' | 'review'>('describe');
  const selectedId = pickedId ?? templates[0]?.id;
  const { template, error: templateError } = useDreamingTemplate(selectedId);
  const { applyTemplate, isSaving } = useApplyDreamingTemplate();
  const panelRef = useRef<HTMLDivElement>(null);
  const shownStep = useRef(step);
  const detailPath = getAiIndexDetailPath(aiIndexId);

  useContextEngineBreadcrumbs([{ text: aiIndexId, path: detailPath }, { text: pageTitle }]);

  useEffect(() => {
    if (shownStep.current !== step) {
      shownStep.current = step;
      scrollToTop(panelRef.current);
    }
  }, [step]);

  const summary = editedSummary ?? template?.summary ?? '';

  const config = useMemo(
    () => (template ? buildDreamingTemplateConfig(template, summary) : undefined),
    [template, summary]
  );

  const selectTemplate = (id: string) => {
    if (id !== selectedId) {
      setPickedId(id);
      setEditedSummary(undefined);
    }
  };

  const continueToAiIndex = () =>
    navigateToContextEngine(detailPath, undefined, AI_INDEX_CREATED_LOCATION_STATE);

  const applyAndContinue = async () => {
    if (config && (await applyTemplate({ aiIndexId, config }))) {
      continueToAiIndex();
    }
  };

  return (
    <ContextEnginePageTemplate data-test-subj="contextDreamingTemplatePage">
      <ContextEngineSubPageHeader
        backDestinationLabel={contextEngineBackDestinationLabel}
        backHref={createContextEngineUrl(detailPath)}
        onBackClick={(event) => {
          event.preventDefault();
          continueToAiIndex();
        }}
        pageTitle={pageTitle}
      />
      <ContextEnginePageSection>
        <div ref={panelRef}>
          <EuiPanel hasBorder paddingSize="xl">
            {error ? (
              <KbnDangerCallout
                announceOnMount={false}
                title={loadErrorTitle}
                data-test-subj="contextDreamingTemplatesError"
              >
                {error.message}
              </KbnDangerCallout>
            ) : step === 'review' && template && config ? (
              <ReviewStep
                template={template}
                config={config}
                isSaving={isSaving}
                onBack={() => setStep('describe')}
                onSkip={continueToAiIndex}
                onApply={applyAndContinue}
              />
            ) : (
              <DescribeStep
                templates={templates}
                isLoading={isLoading}
                selectedId={selectedId}
                onSelect={selectTemplate}
                template={template}
                templateError={templateError}
                summary={summary}
                onSummaryChange={setEditedSummary}
                onSkip={continueToAiIndex}
                onNext={() => setStep('review')}
              />
            )}
          </EuiPanel>
        </div>
      </ContextEnginePageSection>
    </ContextEnginePageTemplate>
  );
};
