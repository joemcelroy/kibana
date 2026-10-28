/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  EuiBadge,
  EuiCallOut,
  EuiConfirmModal,
  EuiEmptyPrompt,
  EuiFlexGroup,
  EuiFlexItem,
  EuiInMemoryTable,
  EuiLoadingSpinner,
  EuiPanel,
  EuiSpacer,
  EuiSwitch,
  EuiText,
  EuiTitle,
  useEuiTheme,
  useGeneratedHtmlId,
  type EuiBasicTableColumn,
} from '@elastic/eui';
import { css } from '@emotion/react';
import { i18n } from '@kbn/i18n';
import { FormattedDate } from '@kbn/i18n-react';
import type {
  OwnMemoryAiIndex,
  OwnMemoryKi,
} from '@kbn/context-engine-plugin/common/http_api/user_memory';
import React, { useMemo, useState } from 'react';
import { formatAgentBuilderErrorMessage } from '@kbn/agent-builder-browser';
import { useLearnFromConversations } from '../../hooks/memory/use_learn_from_conversations';
import { useOwnMemory } from '../../hooks/memory/use_own_memory';
import { useToasts } from '../../hooks/use_toasts';
import { PageWrapper } from '../agents/common/page_wrapper';
import { RenderMarkdownReadOnly } from '../agents/common/render_markdown_read_only';

/** The type of the one profile entity each user has in a user memories AI index. */
const PROFILE_TYPE = 'entity.user';
const SESSION_TYPE = 'memory.session';
const MAX_CONTENT_PREVIEW = 300;

const labels = {
  title: i18n.translate('xpack.agentBuilder.userMemory.title', {
    defaultMessage: 'Memory',
  }),
  description: i18n.translate('xpack.agentBuilder.userMemory.description', {
    defaultMessage:
      'What agents remember about you, whichever agent learned it. Agents with Remember users on record what they learn in your conversations, and Context Engine turns it into the long-term memory below. Only you can see it.',
  }),
  emptyTitle: i18n.translate('xpack.agentBuilder.userMemory.emptyTitle', {
    defaultMessage: 'No memory about you',
  }),
  emptyBody: i18n.translate('xpack.agentBuilder.userMemory.emptyBody', {
    defaultMessage:
      'Agents keep what they learn about you in an AI index that keeps each user’s memory apart, such as user-memories. Turn on Remember users in an agent’s Memory settings to start.',
  }),
  nothingYet: i18n.translate('xpack.agentBuilder.userMemory.nothingYet', {
    defaultMessage:
      'Nothing remembered about you yet. Memories appear here after an agent records them and they are turned into long-term memory.',
  }),
  loadError: i18n.translate('xpack.agentBuilder.userMemory.loadError', {
    defaultMessage: 'Unable to load your memory',
  }),
  indexError: i18n.translate('xpack.agentBuilder.userMemory.indexError', {
    defaultMessage: 'Unable to read this AI index',
  }),
  onlyYou: i18n.translate('xpack.agentBuilder.userMemory.onlyYou', {
    defaultMessage: 'Only you',
  }),
  profile: i18n.translate('xpack.agentBuilder.userMemory.profile', {
    defaultMessage: 'Profile',
  }),
  entries: i18n.translate('xpack.agentBuilder.userMemory.entries', {
    defaultMessage: 'Entries',
  }),
  typeColumn: i18n.translate('xpack.agentBuilder.userMemory.typeColumn', {
    defaultMessage: 'Type',
  }),
  titleColumn: i18n.translate('xpack.agentBuilder.userMemory.titleColumn', {
    defaultMessage: 'Title',
  }),
  contentColumn: i18n.translate('xpack.agentBuilder.userMemory.contentColumn', {
    defaultMessage: 'Content',
  }),
  updatedColumn: i18n.translate('xpack.agentBuilder.userMemory.updatedColumn', {
    defaultMessage: 'Updated',
  }),
  session: i18n.translate('xpack.agentBuilder.userMemory.session', {
    defaultMessage: 'conversation',
  }),
  searchPlaceholder: i18n.translate('xpack.agentBuilder.userMemory.searchPlaceholder', {
    defaultMessage: 'Search your memory',
  }),
  learnTitle: i18n.translate('xpack.agentBuilder.userMemory.learnTitle', {
    defaultMessage: 'Learn from my conversations',
  }),
  learnDescription: i18n.translate('xpack.agentBuilder.userMemory.learnDescription', {
    defaultMessage:
      'Agents with Remember users on also learn from what happens in your conversations, such as what their tools found, not only from what they choose to remember. Turning this off applies to every agent in this space.',
  }),
  stopTitle: i18n.translate('xpack.agentBuilder.userMemory.stopTitle', {
    defaultMessage: 'Delete what was recorded from your conversations?',
  }),
  stopBody: i18n.translate('xpack.agentBuilder.userMemory.stopBody', {
    defaultMessage:
      'Agents no longer record your conversations. You can also delete the conversations already recorded; what was learned from them is rewritten the next time memory is updated.',
  }),
  stopDelete: i18n.translate('xpack.agentBuilder.userMemory.stopDelete', {
    defaultMessage: 'Delete recorded conversations',
  }),
  stopKeep: i18n.translate('xpack.agentBuilder.userMemory.stopKeep', {
    defaultMessage: 'Keep them',
  }),
  saveError: i18n.translate('xpack.agentBuilder.userMemory.saveError', {
    defaultMessage: 'Unable to save your memory setting',
  }),
  forgetError: i18n.translate('xpack.agentBuilder.userMemory.forgetError', {
    defaultMessage: 'Unable to delete your recorded conversations',
  }),
  forgotten: (count: number) =>
    i18n.translate('xpack.agentBuilder.userMemory.forgotten', {
      defaultMessage:
        'Deleted {count, plural, one {# recorded conversation round} other {# recorded conversation rounds}}',
      values: { count },
    }),
};

/** `fact.preference` reads as `preference`, and a session document as `conversation`. */
const typeLabel = (type: string): string =>
  type === SESSION_TYPE ? labels.session : type.replace(/^(fact|entity)\./, '');

const preview = (content: string | undefined): string =>
  !content
    ? ''
    : content.length > MAX_CONTENT_PREVIEW
    ? `${content.slice(0, MAX_CONTENT_PREVIEW)}…`
    : content;

const columns: Array<EuiBasicTableColumn<OwnMemoryKi>> = [
  {
    field: 'type',
    name: labels.typeColumn,
    width: '140px',
    sortable: true,
    render: (type: string) => (
      <EuiBadge color={type.startsWith('fact.') ? 'hollow' : 'default'}>{typeLabel(type)}</EuiBadge>
    ),
  },
  { field: 'title', name: labels.titleColumn, width: '25%', sortable: true },
  {
    field: 'content',
    name: labels.contentColumn,
    render: (content: string | undefined) => (
      <EuiText size="xs">
        <p>{preview(content)}</p>
      </EuiText>
    ),
  },
  {
    field: 'updated_at',
    name: labels.updatedColumn,
    width: '120px',
    sortable: true,
    render: (updatedAt: string | undefined) =>
      updatedAt ? (
        <FormattedDate value={updatedAt} year="numeric" month="short" day="2-digit" />
      ) : (
        ''
      ),
  },
];

const AiIndexMemory = ({ aiIndex }: { aiIndex: OwnMemoryAiIndex }) => {
  const profile = aiIndex.kis.find(({ type }) => type === PROFILE_TYPE);
  const entries = useMemo(
    () => aiIndex.kis.filter(({ type }) => type !== PROFILE_TYPE),
    [aiIndex.kis]
  );

  return (
    <EuiPanel hasBorder paddingSize="l" data-test-subj={`agentMemoryAiIndex-${aiIndex.id}`}>
      <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
        <EuiFlexItem grow={false}>
          <EuiTitle size="s">
            <h2>{aiIndex.id}</h2>
          </EuiTitle>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiBadge color="primary">{labels.onlyYou}</EuiBadge>
        </EuiFlexItem>
      </EuiFlexGroup>
      {aiIndex.description && (
        <EuiText size="xs" color="subdued">
          <p>{aiIndex.description}</p>
        </EuiText>
      )}
      <EuiSpacer size="m" />
      {aiIndex.error ? (
        <EuiCallOut
          announceOnMount={false}
          title={labels.indexError}
          color="danger"
          iconType="error"
          size="s"
        >
          <p>{aiIndex.error}</p>
        </EuiCallOut>
      ) : aiIndex.kis.length === 0 ? (
        <EuiText size="s" color="subdued" data-test-subj="agentMemoryNothingYet">
          <p>{labels.nothingYet}</p>
        </EuiText>
      ) : (
        <>
          {profile?.content && (
            <>
              <RenderMarkdownReadOnly content={profile.content} label={labels.profile} />
              <EuiSpacer size="l" />
            </>
          )}
          {entries.length > 0 && (
            <EuiInMemoryTable<OwnMemoryKi>
              tableCaption={labels.entries}
              items={entries}
              itemId="id"
              columns={columns}
              search={{ box: { incremental: true, placeholder: labels.searchPlaceholder } }}
              sorting={{ sort: { field: 'updated_at', direction: 'desc' } }}
              pagination={{ initialPageSize: 10, pageSizeOptions: [10, 25, 50] }}
              data-test-subj="agentMemoryEntries"
            />
          )}
        </>
      )}
    </EuiPanel>
  );
};

/** The user's own switch for learning from their conversations, shown for agents that do. */
const LearnFromConversations = () => {
  const {
    learnFromConversations,
    setLearnFromConversations,
    isSaving,
    forgetRounds,
    isForgetting,
  } = useLearnFromConversations();
  const { addErrorToast, addSuccessToast } = useToasts();
  const [isAskingToForget, setIsAskingToForget] = useState(false);
  const titleId = useGeneratedHtmlId();
  const forgetTitleId = useGeneratedHtmlId();

  if (learnFromConversations === undefined) {
    return null;
  }

  const onChange = async (learn: boolean) => {
    try {
      await setLearnFromConversations(learn);
      if (!learn) {
        setIsAskingToForget(true);
      }
    } catch (error) {
      addErrorToast({ title: labels.saveError, text: formatAgentBuilderErrorMessage(error) });
    }
  };

  const onForget = async () => {
    try {
      const { forgotten } = await forgetRounds();
      addSuccessToast({ title: labels.forgotten(forgotten) });
    } catch (error) {
      addErrorToast({ title: labels.forgetError, text: formatAgentBuilderErrorMessage(error) });
    } finally {
      setIsAskingToForget(false);
    }
  };

  return (
    <>
      <EuiPanel hasBorder paddingSize="l" data-test-subj="agentMemoryLearnFromConversations">
        <EuiFlexGroup alignItems="center" justifyContent="spaceBetween" responsive={false}>
          <EuiFlexItem>
            <EuiTitle size="xs">
              <h2 id={titleId}>{labels.learnTitle}</h2>
            </EuiTitle>
            <EuiText size="s" color="subdued">
              <p>{labels.learnDescription}</p>
            </EuiText>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiSwitch
              label={labels.learnTitle}
              showLabel={false}
              aria-labelledby={titleId}
              checked={learnFromConversations}
              disabled={isSaving}
              onChange={(e) => onChange(e.target.checked)}
              data-test-subj="agentMemoryLearnFromConversationsSwitch"
            />
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiPanel>
      <EuiSpacer size="l" />
      {isAskingToForget && (
        <EuiConfirmModal
          title={labels.stopTitle}
          aria-labelledby={forgetTitleId}
          titleProps={{ id: forgetTitleId }}
          onCancel={() => setIsAskingToForget(false)}
          onConfirm={onForget}
          confirmButtonText={labels.stopDelete}
          cancelButtonText={labels.stopKeep}
          buttonColor="danger"
          isLoading={isForgetting}
          data-test-subj="agentMemoryForgetRoundsModal"
        >
          <p>{labels.stopBody}</p>
        </EuiConfirmModal>
      )}
    </>
  );
};

/** The current user's memory across every agent: each AI index that keeps it per user. */
export const UserMemory = () => {
  const { euiTheme } = useEuiTheme();
  const { aiIndices: memoryAiIndices, isLoading, error } = useOwnMemory();
  // Only memory kept per user, such as user-memories. Shared AI indices hold the team's knowledge,
  // not memory about the user, even when the user's conversations contributed to it.
  const aiIndices = useMemo(
    () => memoryAiIndices.filter(({ memory_scope: scope }) => scope === 'user'),
    [memoryAiIndices]
  );

  const body = (() => {
    if (isLoading) {
      return (
        <EuiFlexGroup justifyContent="center">
          <EuiLoadingSpinner size="xl" data-test-subj="agentMemoryLoading" />
        </EuiFlexGroup>
      );
    }
    if (error) {
      return (
        <EuiCallOut
          announceOnMount={false}
          title={labels.loadError}
          color="danger"
          iconType="error"
          data-test-subj="agentMemoryError"
        >
          <p>{error.message}</p>
        </EuiCallOut>
      );
    }
    if (aiIndices.length === 0) {
      return (
        <EuiEmptyPrompt
          iconType="memory"
          title={<h2>{labels.emptyTitle}</h2>}
          body={<p>{labels.emptyBody}</p>}
          data-test-subj="agentMemoryEmpty"
        />
      );
    }
    return aiIndices.map((aiIndex) => (
      <React.Fragment key={aiIndex.id}>
        <AiIndexMemory aiIndex={aiIndex} />
        <EuiSpacer size="l" />
      </React.Fragment>
    ));
  })();

  return (
    <PageWrapper>
      <div
        css={css`
          padding: ${euiTheme.size.l} ${euiTheme.size.xl};
          overflow-y: auto;
          height: 100%;
        `}
        data-test-subj="agentMemoryPage"
      >
        <EuiTitle size="l">
          <h1>{labels.title}</h1>
        </EuiTitle>
        <EuiSpacer size="s" />
        <EuiText size="s" color="subdued">
          <p>{labels.description}</p>
        </EuiText>
        <EuiSpacer size="l" />
        {aiIndices.length > 0 && <LearnFromConversations />}
        {body}
      </div>
    </PageWrapper>
  );
};
