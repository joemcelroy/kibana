/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { USER_MEMORIES_AI_INDEX_DEST, USER_MEMORIES_AI_INDEX_ID } from '../common/constants';
import type { ManagedDreamingConfig } from '../common/dreaming';
import type { AiIndexProperties } from '../common/http_api/ai_indices';
import type { AiIndexRegistry } from './ai_indices/registry';

export const USER_MEMORIES_AI_INDEX: AiIndexProperties = {
  description:
    'What agents have learned about each user across conversations: a profile of their work, ' +
    'personal context, what is top of mind and their recent history, plus a summary of every ' +
    'conversation. Each user only reads their own.',
  memory_enabled: true,
  memory_scope: 'user',
  dest: { type: 'index', value: USER_MEMORIES_AI_INDEX_DEST },
  automations: [],
  sources: [],
  traces: [],
};

/** The name of the one profile entity each user has, so its id never changes. */
export const USER_PROFILE_ENTITY_NAME = 'profile';

const PROFILE_INSTRUCTIONS = `These memories are about one person, the user, and what they did with an agent. Keep a profile of them that a later agent can read before helping them.

Keep exactly one entity of type user, always named "${USER_PROFILE_ENTITY_NAME}". Create it the first time with a new key like "new:1", and update it afterwards by its id from EXISTING. Its content is the profile, in markdown, with these sections in this order:

## Work context
Who they are at work: role, organization, team, what they work on, and the people they work with.

## Personal context
Where they are based, how they like to communicate, and personal details they chose to share.

## Top of mind
What they are focused on now: open threads, deadlines, decisions in progress.

## Brief history
### Recent months
### Earlier context
### Long-term background

Rewrite the profile whenever memories change it. Use recorded_at dates: keep Top of mind to the last few weeks, and move older threads into Brief history, newest first, summarizing more the further back they go. Write in the third person, by name when the memories give it, in plain prose rather than lists. Keep exact names, dates and numbers.

Record facts behind the profile as facts about the user entity, and people, projects and organizations they mention as entities linked to it.

Never record secrets, credentials or access tokens, or health, financial or other sensitive personal details, even if the memories contain them.`;

export const USER_MEMORIES_DREAMING: ManagedDreamingConfig = {
  group_by: 'user_id',
  sessions: true,
  rounds: true,
  instructions: PROFILE_INSTRUCTIONS,
  entities: [
    {
      type: 'user',
      description: `The person the memories are about. Exactly one, named "${USER_PROFILE_ENTITY_NAME}".`,
      attributes: ['name', 'role', 'organization', 'team', 'location'],
    },
    {
      type: 'person',
      description: 'Someone the user works with or mentions, by full name.',
      attributes: ['role', 'relationship'],
    },
    { type: 'project', description: 'A project, product or initiative the user works on.' },
    { type: 'organization', description: 'A company, team or group the user deals with.' },
  ],
  facts: [
    { type: 'work_context', description: 'Their role, responsibilities and how they work.' },
    { type: 'personal_context', description: 'Personal details they chose to share.' },
    { type: 'preference', description: 'How they like things done, written or presented.' },
    { type: 'top_of_mind', description: 'Something they are focused on now, with its date.' },
    { type: 'history', description: 'Something they did or decided in the past, with its date.' },
  ],
  relationships: [
    { type: 'works_with', source: 'user', target: 'person' },
    { type: 'works_on', source: 'user', target: 'project' },
    { type: 'member_of', source: 'user', target: 'organization' },
  ],
};

/** Registers the user memories AI index that every space gets. */
export const registerUserMemoriesAiIndex = (registry: AiIndexRegistry): void =>
  registry.register(USER_MEMORIES_AI_INDEX_ID, USER_MEMORIES_AI_INDEX, {
    dreaming: USER_MEMORIES_DREAMING,
  });
