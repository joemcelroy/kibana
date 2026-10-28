/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { EuiProvider } from '@elastic/eui';
import { I18nProvider } from '@kbn/i18n-react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { useLearnFromConversations } from '../../hooks/memory/use_learn_from_conversations';
import { useOwnMemory } from '../../hooks/memory/use_own_memory';
import { UserMemory } from './user_memory';

jest.mock('../../hooks/memory/use_own_memory', () => ({
  useOwnMemory: jest.fn(),
}));
jest.mock('../../hooks/memory/use_learn_from_conversations', () => ({
  useLearnFromConversations: jest.fn(),
}));
const mockAddSuccessToast = jest.fn();
jest.mock('../../hooks/use_toasts', () => ({
  useToasts: () => ({ addSuccessToast: mockAddSuccessToast, addErrorToast: jest.fn() }),
}));

const mockUseOwnMemory = jest.mocked(useOwnMemory);
const mockUseLearnFromConversations = jest.mocked(useLearnFromConversations);
const setLearnFromConversations = jest.fn();
const forgetRounds = jest.fn();

const renderMemory = () =>
  render(
    <I18nProvider>
      <EuiProvider>
        <UserMemory />
      </EuiProvider>
    </I18nProvider>
  );

describe('UserMemory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setLearnFromConversations.mockResolvedValue(undefined);
    forgetRounds.mockResolvedValue({ forgotten: 3 });
    mockUseLearnFromConversations.mockReturnValue({
      learnFromConversations: true,
      setLearnFromConversations,
      isSaving: false,
      forgetRounds,
      isForgetting: false,
    });
  });

  it('asks for the memory in every AI index that keeps it per user, whatever the agent', () => {
    mockUseOwnMemory.mockReturnValue({ aiIndices: [], isLoading: false, error: undefined });

    renderMemory();

    expect(mockUseOwnMemory).toHaveBeenCalledWith();
    expect(screen.getByTestId('agentMemoryEmpty')).toBeInTheDocument();
  });

  it('shows the profile, then the other entries, for each AI index that takes memories', () => {
    mockUseOwnMemory.mockReturnValue({
      aiIndices: [
        {
          id: 'user-memories',
          memory_scope: 'user',
          kis: [
            {
              id: 'u1/entity-user-profile',
              type: 'entity.user',
              title: 'profile',
              content: '## Work context\nJoe leads the Context Engine.',
            },
            {
              id: 'u1/fact-1',
              type: 'fact.preference',
              title: 'Writing style',
              content: 'Direct, lowercase, no em dashes.',
              updated_at: '2026-10-26T08:00:00.000Z',
            },
            {
              id: 'u1/session-1',
              type: 'memory.session',
              title: 'Interview loops',
              content: '2026-10-26: Planned the PM interview loop.',
            },
          ],
        },
      ],
      isLoading: false,
      error: undefined,
    });

    renderMemory();

    const panel = screen.getByTestId('agentMemoryAiIndex-user-memories');
    expect(within(panel).getByText('Only you')).toBeInTheDocument();
    expect(within(panel).getByText('Work context')).toBeInTheDocument();
    const entries = within(panel).getByTestId('agentMemoryEntries');
    expect(within(entries).getByText('Writing style')).toBeInTheDocument();
    expect(within(entries).getByText('preference')).toBeInTheDocument();
    expect(within(entries).getByText('conversation')).toBeInTheDocument();
    expect(within(entries).queryByText('profile')).not.toBeInTheDocument();
  });

  it('says when nothing is remembered yet, and shows a read error per AI index', () => {
    mockUseOwnMemory.mockReturnValue({
      aiIndices: [
        { id: 'user-memories', memory_scope: 'user', kis: [] },
        { id: 'team-memories', memory_scope: 'user', kis: [], error: 'Forbidden' },
      ],
      isLoading: false,
      error: undefined,
    });

    renderMemory();

    expect(
      within(screen.getByTestId('agentMemoryAiIndex-user-memories')).getByTestId(
        'agentMemoryNothingYet'
      )
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('agentMemoryAiIndex-team-memories')).getByText('Forbidden')
    ).toBeInTheDocument();
  });

  it('leaves out shared AI indices: they hold team knowledge, not memory about the user', () => {
    mockUseOwnMemory.mockReturnValue({
      aiIndices: [
        { id: 'user-memories', memory_scope: 'user', kis: [] },
        {
          id: 'support-customers',
          memory_scope: 'shared',
          kis: [{ id: 'me/fact-1', type: 'fact.preference', title: 'Aisle seat' }],
        },
      ],
      isLoading: false,
      error: undefined,
    });

    renderMemory();

    expect(screen.getByTestId('agentMemoryAiIndex-user-memories')).toBeInTheDocument();
    expect(screen.queryByTestId('agentMemoryAiIndex-support-customers')).not.toBeInTheDocument();
  });

  it('says there is no memory when no AI index keeps it per user', () => {
    mockUseOwnMemory.mockReturnValue({
      aiIndices: [{ id: 'support-customers', memory_scope: 'shared', kis: [] }],
      isLoading: false,
      error: undefined,
    });

    renderMemory();

    expect(screen.getByTestId('agentMemoryEmpty')).toBeInTheDocument();
  });

  describe('learning from conversations', () => {
    beforeEach(() =>
      mockUseOwnMemory.mockReturnValue({
        aiIndices: [{ id: 'user-memories', memory_scope: 'user', kis: [] }],
        isLoading: false,
        error: undefined,
      })
    );

    it('shows the user’s switch when an AI index keeps memory per user', () => {
      renderMemory();
      expect(screen.getByTestId('agentMemoryLearnFromConversationsSwitch')).toBeChecked();
    });

    it('hides it when no AI index keeps memory per user', () => {
      mockUseOwnMemory.mockReturnValue({
        aiIndices: [{ id: 'support', memory_scope: 'shared', kis: [] }],
        isLoading: false,
        error: undefined,
      } as unknown as ReturnType<typeof useOwnMemory>);
      renderMemory();
      expect(screen.queryByTestId('agentMemoryLearnFromConversations')).not.toBeInTheDocument();
    });

    it('turns it off, then deletes what was recorded when asked', async () => {
      renderMemory();

      fireEvent.click(screen.getByTestId('agentMemoryLearnFromConversationsSwitch'));
      await waitFor(() => expect(setLearnFromConversations).toHaveBeenCalledWith(false));
      fireEvent.click(await screen.findByText('Delete recorded conversations'));

      await waitFor(() => expect(forgetRounds).toHaveBeenCalled());
      expect(mockAddSuccessToast).toHaveBeenCalledWith({
        title: 'Deleted 3 recorded conversation rounds',
      });
    });

    it('keeps what was recorded when the user says so', async () => {
      renderMemory();

      fireEvent.click(screen.getByTestId('agentMemoryLearnFromConversationsSwitch'));
      fireEvent.click(await screen.findByText('Keep them'));

      expect(forgetRounds).not.toHaveBeenCalled();
    });
  });
});
