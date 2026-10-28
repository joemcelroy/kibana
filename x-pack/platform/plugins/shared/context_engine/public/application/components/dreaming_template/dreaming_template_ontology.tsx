/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  EuiAccordion,
  EuiBadge,
  EuiCode,
  EuiCodeBlock,
  EuiFlexGrid,
  EuiFlexGroup,
  EuiFlexItem,
  EuiHorizontalRule,
  EuiIcon,
  EuiNotificationBadge,
  EuiPanel,
  EuiSpacer,
  EuiText,
  useEuiTheme,
  type IconType,
} from '@elastic/eui';
import { css } from '@emotion/react';
import { i18n } from '@kbn/i18n';
import React from 'react';
import type { DreamingTemplateConfig } from '../../../../common/dreaming_templates';
import { Eyebrow } from './eyebrow';

/** Tallest the instructions get before they scroll. */
const INSTRUCTIONS_MAX_HEIGHT = 320;

const useTypeNameStyles = () => {
  const { euiTheme } = useEuiTheme();
  return css`
    font-family: ${euiTheme.font.familyCode};
    font-weight: ${euiTheme.font.weight.bold};
    font-size: ${euiTheme.size.l};
    color: ${euiTheme.colors.textHeading};
    overflow-wrap: anywhere;
  `;
};

interface TypeCardProps {
  type: string;
  description?: string;
  /** Shown under the name, such as `issue → product_area` for a relationship. */
  subtitle?: React.ReactNode;
  footer?: React.ReactNode;
  'data-test-subj': string;
}

const TypeCard = ({
  type,
  description,
  subtitle,
  footer,
  'data-test-subj': dataTestSubj,
}: TypeCardProps) => {
  const typeNameStyles = useTypeNameStyles();
  return (
    <EuiPanel hasBorder paddingSize="l" css={{ height: '100%' }} data-test-subj={dataTestSubj}>
      <div css={typeNameStyles}>{type}</div>
      {subtitle && (
        <>
          <EuiSpacer size="s" />
          {subtitle}
        </>
      )}
      {description && (
        <>
          <EuiSpacer size="m" />
          <EuiText size="s" color="subdued">
            <p>{description}</p>
          </EuiText>
        </>
      )}
      {footer && (
        <>
          <EuiSpacer size="m" />
          {footer}
        </>
      )}
    </EuiPanel>
  );
};

interface SectionProps {
  icon: IconType;
  title: string;
  count: number;
  description: string;
  children: React.ReactNode;
  'data-test-subj': string;
}

const Section = ({
  icon,
  title,
  count,
  description,
  children,
  'data-test-subj': dataTestSubj,
}: SectionProps) => (
  <section data-test-subj={dataTestSubj}>
    <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
      <EuiFlexItem grow={false}>
        <EuiIcon type={icon} color="subdued" aria-hidden />
      </EuiFlexItem>
      <EuiFlexItem grow={false}>
        <Eyebrow>{title}</Eyebrow>
      </EuiFlexItem>
      <EuiFlexItem grow={false}>
        <EuiNotificationBadge color="subdued">{count}</EuiNotificationBadge>
      </EuiFlexItem>
    </EuiFlexGroup>
    <EuiSpacer size="s" />
    <EuiText size="s" color="subdued">
      <p>{description}</p>
    </EuiText>
    <EuiSpacer size="m" />
    <EuiFlexGrid columns={3} gutterSize="m">
      {children}
    </EuiFlexGrid>
  </section>
);

interface DreamingTemplateOntologyProps {
  /** The config as it will be saved. */
  config: DreamingTemplateConfig;
}

/**
 * The fact, entity and relationship types a template proposes, as cards, and the instructions
 * dreaming follows.
 */
export const DreamingTemplateOntology = ({ config }: DreamingTemplateOntologyProps) => {
  const { instructions, facts = [], entities = [], relationships = [] } = config;
  return (
    <div data-test-subj="contextDreamingTemplateOntology">
      <Section
        icon="document"
        title={i18n.translate('xpack.contextEngine.dreamingTemplate.ontology.factsTitle', {
          defaultMessage: 'Fact types',
        })}
        count={facts.length}
        description={i18n.translate(
          'xpack.contextEngine.dreamingTemplate.ontology.factsDescription',
          {
            defaultMessage:
              'What dreaming writes down: the kinds of knowledge your agent can recall later.',
          }
        )}
        data-test-subj="contextDreamingTemplateFacts"
      >
        {facts.map(({ type, description }) => (
          <EuiFlexItem key={type}>
            <TypeCard
              type={type}
              description={description}
              data-test-subj={`contextDreamingTemplateFact-${type}`}
            />
          </EuiFlexItem>
        ))}
      </Section>
      <EuiHorizontalRule margin="xl" />
      <Section
        icon="cube"
        title={i18n.translate('xpack.contextEngine.dreamingTemplate.ontology.entitiesTitle', {
          defaultMessage: 'Entity types',
        })}
        count={entities.length}
        description={i18n.translate(
          'xpack.contextEngine.dreamingTemplate.ontology.entitiesDescription',
          {
            defaultMessage:
              'The things your agent remembers: the nouns of your domain. Facts and relationships attach to them.',
          }
        )}
        data-test-subj="contextDreamingTemplateEntities"
      >
        {entities.map(({ type, description, attributes = [] }) => (
          <EuiFlexItem key={type}>
            <TypeCard
              type={type}
              description={description}
              footer={
                attributes.length > 0 && (
                  <EuiFlexGroup gutterSize="xs" wrap responsive={false}>
                    {attributes.map((attribute) => (
                      <EuiFlexItem grow={false} key={attribute}>
                        <EuiCode>{attribute}</EuiCode>
                      </EuiFlexItem>
                    ))}
                  </EuiFlexGroup>
                )
              }
              data-test-subj={`contextDreamingTemplateEntity-${type}`}
            />
          </EuiFlexItem>
        ))}
      </Section>
      <EuiHorizontalRule margin="xl" />
      <Section
        icon="link"
        title={i18n.translate('xpack.contextEngine.dreamingTemplate.ontology.relationshipsTitle', {
          defaultMessage: 'Relationship types',
        })}
        count={relationships.length}
        description={i18n.translate(
          'xpack.contextEngine.dreamingTemplate.ontology.relationshipsDescription',
          {
            defaultMessage:
              'How entities connect: the verbs. Each links one entity to another, so your agent can follow from one to the next.',
          }
        )}
        data-test-subj="contextDreamingTemplateRelationships"
      >
        {relationships.map(({ type, source, target, description }) => (
          <EuiFlexItem key={type}>
            <TypeCard
              type={type}
              subtitle={<EuiBadge color="hollow">{`${source} → ${target}`}</EuiBadge>}
              description={description}
              data-test-subj={`contextDreamingTemplateRelationship-${type}`}
            />
          </EuiFlexItem>
        ))}
      </Section>
      {instructions && (
        <>
          <EuiHorizontalRule margin="xl" />
          <EuiAccordion
            id="contextDreamingTemplateInstructions"
            buttonContent={
              <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
                <EuiFlexItem grow={false}>
                  <EuiIcon type="comment" color="subdued" aria-hidden />
                </EuiFlexItem>
                <EuiFlexItem grow={false}>
                  <Eyebrow>
                    {i18n.translate(
                      'xpack.contextEngine.dreamingTemplate.ontology.instructionsTitle',
                      { defaultMessage: 'Instructions' }
                    )}
                  </Eyebrow>
                </EuiFlexItem>
              </EuiFlexGroup>
            }
            data-test-subj="contextDreamingTemplateInstructionsToggle"
          >
            <EuiSpacer size="s" />
            <EuiText size="s" color="subdued">
              <p>
                {i18n.translate(
                  'xpack.contextEngine.dreamingTemplate.ontology.instructionsDescription',
                  {
                    defaultMessage:
                      'What dreaming is told about this AI index, starting with your description.',
                  }
                )}
              </p>
            </EuiText>
            <EuiSpacer size="m" />
            <EuiCodeBlock
              language="text"
              fontSize="s"
              paddingSize="m"
              whiteSpace="pre-wrap"
              overflowHeight={INSTRUCTIONS_MAX_HEIGHT}
              data-test-subj="contextDreamingTemplateInstructions"
            >
              {instructions}
            </EuiCodeBlock>
          </EuiAccordion>
        </>
      )}
    </div>
  );
};
