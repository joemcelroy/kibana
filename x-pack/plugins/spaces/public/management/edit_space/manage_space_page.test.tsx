/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { EuiCheckboxProps } from '@elastic/eui';
import { EuiButton } from '@elastic/eui';
import { waitFor } from '@testing-library/react';
import type { ReactWrapper } from 'enzyme';
import React from 'react';
import { act } from 'react-dom/test-utils';

import { DEFAULT_APP_CATEGORIES } from '@kbn/core/public';
import { notificationServiceMock, scopedHistoryMock } from '@kbn/core/public/mocks';
import { KibanaFeature } from '@kbn/features-plugin/public';
import { featuresPluginMock } from '@kbn/features-plugin/public/mocks';
import { findTestSubject, mountWithIntl } from '@kbn/test-jest-helpers';

import { ConfirmAlterActiveSpaceModal } from './confirm_alter_active_space_modal';
import { EnabledFeatures } from './enabled_features';
import { ManageSpacePage } from './manage_space_page';
import type { SolutionView, Space } from '../../../common/types/latest';
import { EventTracker } from '../../analytics';
import type { SpacesManager } from '../../spaces_manager';
import { spacesManagerMock } from '../../spaces_manager/mocks';

// To be resolved by EUI team.
// https://github.com/elastic/eui/issues/3712
jest.mock('@elastic/eui/lib/components/overlay_mask', () => {
  return {
    EuiOverlayMask: (props: any) => <div>{props.children}</div>,
  };
});

const space: Space = {
  id: 'my-space',
  name: 'My Space',
  disabledFeatures: [],
};

const featuresStart = featuresPluginMock.createStart();
featuresStart.getFeatures.mockResolvedValue([
  new KibanaFeature({
    id: 'feature-1',
    name: 'feature 1',
    app: [],
    category: DEFAULT_APP_CATEGORIES.kibana,
    privileges: null,
  }),
]);

const reportEvent = jest.fn();
const eventTracker = new EventTracker({ reportEvent });

describe('ManageSpacePage', () => {
  beforeAll(() => {
    Object.defineProperty(window, 'location', {
      value: { reload: jest.fn() },
      writable: true,
    });
  });

  const history = scopedHistoryMock.create();

  it('allows a space to be created', async () => {
    const spacesManager = spacesManagerMock.create();
    spacesManager.createSpace = jest.fn(spacesManager.createSpace);
    spacesManager.getActiveSpace = jest.fn().mockResolvedValue(space);

    const wrapper = mountWithIntl(
      <ManageSpacePage
        spacesManager={spacesManager as unknown as SpacesManager}
        getFeatures={featuresStart.getFeatures}
        notifications={notificationServiceMock.createStartContract()}
        history={history}
        capabilities={{
          navLinks: {},
          management: {},
          catalogue: {},
          spaces: { manage: true },
        }}
        eventTracker={eventTracker}
        allowFeatureVisibility
        allowSolutionVisibility
      />
    );

    await waitFor(() => {
      wrapper.update();
      expect(wrapper.find('input[name="name"]')).toHaveLength(1);
    });

    const nameInput = wrapper.find('input[name="name"]');
    const descriptionInput = wrapper.find('textarea[name="description"]');

    nameInput.simulate('change', { target: { value: 'New Space Name' } });
    descriptionInput.simulate('change', { target: { value: 'some description' } });

    updateSpace(wrapper, false, 'oblt');

    const createButton = wrapper.find('button[data-test-subj="save-space-button"]');
    createButton.simulate('click');
    await Promise.resolve();

    expect(spacesManager.createSpace).toHaveBeenCalledWith({
      id: 'new-space-name',
      name: 'New Space Name',
      description: 'some description',
      initials: 'NS',
      color: '#AA6556',
      imageUrl: '',
      disabledFeatures: [],
      solution: 'oblt',
    });
  });

  it('validates the form (name, initials, solution view...)', async () => {
    const spacesManager = spacesManagerMock.create();
    spacesManager.createSpace = jest.fn(spacesManager.createSpace);
    spacesManager.getActiveSpace = jest.fn().mockResolvedValue(space);

    const wrapper = mountWithIntl(
      <ManageSpacePage
        spacesManager={spacesManager as unknown as SpacesManager}
        getFeatures={featuresStart.getFeatures}
        notifications={notificationServiceMock.createStartContract()}
        history={history}
        capabilities={{
          navLinks: {},
          management: {},
          catalogue: {},
          spaces: { manage: true },
        }}
        eventTracker={eventTracker}
        allowFeatureVisibility
        allowSolutionVisibility
      />
    );

    await waitFor(() => {
      wrapper.update();
      expect(wrapper.find('input[name="name"]')).toHaveLength(1);
    });

    const createButton = wrapper.find('button[data-test-subj="save-space-button"]');
    createButton.simulate('click');
    await Promise.resolve();

    {
      const errors = wrapper.find('.euiFormErrorText').map((node) => node.text());
      expect(errors).toEqual([
        'Enter a name.',
        'Enter a URL identifier.',
        'Enter initials.',
        'Select one solution.',
      ]);

      expect(spacesManager.createSpace).not.toHaveBeenCalled();

      const nameInput = wrapper.find('input[name="name"]');
      nameInput.simulate('change', { target: { value: 'New Space Name' } });
    }

    createButton.simulate('click');
    await Promise.resolve();

    {
      const errors = wrapper.find('.euiFormErrorText').map((node) => node.text());
      expect(errors).toEqual(['Select one solution.']); // requires solution view to be set
    }

    updateSpace(wrapper, false, 'oblt');

    createButton.simulate('click');
    await Promise.resolve();

    {
      const errors = wrapper.find('.euiFormErrorText').map((node) => node.text());
      expect(errors).toEqual([]); // no more errors
    }

    expect(spacesManager.createSpace).toHaveBeenCalled();
  });

  it('shows solution view select when visible', async () => {
    const spacesManager = spacesManagerMock.create();
    spacesManager.createSpace = jest.fn(spacesManager.createSpace);
    spacesManager.getActiveSpace = jest.fn().mockResolvedValue(space);

    const wrapper = mountWithIntl(
      <ManageSpacePage
        spacesManager={spacesManager as unknown as SpacesManager}
        getFeatures={featuresStart.getFeatures}
        notifications={notificationServiceMock.createStartContract()}
        history={history}
        capabilities={{
          navLinks: {},
          management: {},
          catalogue: {},
          spaces: { manage: true },
        }}
        allowFeatureVisibility
        allowSolutionVisibility
        eventTracker={eventTracker}
      />
    );

    await waitFor(() => {
      wrapper.update();
      expect(wrapper.find('input[name="name"]')).toHaveLength(1);
    });

    expect(findTestSubject(wrapper, 'navigationPanel')).toHaveLength(1);
  });

  it('hides solution view select when not visible', async () => {
    const spacesManager = spacesManagerMock.create();
    spacesManager.createSpace = jest.fn(spacesManager.createSpace);
    spacesManager.getActiveSpace = jest.fn().mockResolvedValue(space);

    const wrapper = mountWithIntl(
      <ManageSpacePage
        spacesManager={spacesManager as unknown as SpacesManager}
        getFeatures={featuresStart.getFeatures}
        notifications={notificationServiceMock.createStartContract()}
        history={history}
        capabilities={{
          navLinks: {},
          management: {},
          catalogue: {},
          spaces: { manage: true },
        }}
        allowFeatureVisibility
        allowSolutionVisibility={false}
        eventTracker={eventTracker}
      />
    );

    await waitFor(() => {
      wrapper.update();
      expect(wrapper.find('input[name="name"]')).toHaveLength(1);
    });

    expect(findTestSubject(wrapper, 'navigationPanel')).toHaveLength(0);
  });

  it('shows feature visibility controls when allowed', async () => {
    const spacesManager = spacesManagerMock.create();
    spacesManager.createSpace = jest.fn(spacesManager.createSpace);
    spacesManager.getActiveSpace = jest.fn().mockResolvedValue(space);

    const wrapper = mountWithIntl(
      <ManageSpacePage
        spacesManager={spacesManager as unknown as SpacesManager}
        getFeatures={featuresStart.getFeatures}
        notifications={notificationServiceMock.createStartContract()}
        history={history}
        capabilities={{
          navLinks: {},
          management: {},
          catalogue: {},
          spaces: { manage: true },
        }}
        eventTracker={eventTracker}
        allowFeatureVisibility
        allowSolutionVisibility
      />
    );

    await waitFor(() => {
      wrapper.update();
      expect(wrapper.find('input[name="name"]')).toHaveLength(1);
    });

    expect(wrapper.find(EnabledFeatures)).toHaveLength(1);
  });

  it('hides feature visibility controls when not allowed', async () => {
    const spacesManager = spacesManagerMock.create();
    spacesManager.createSpace = jest.fn(spacesManager.createSpace);
    spacesManager.getActiveSpace = jest.fn().mockResolvedValue(space);

    const wrapper = mountWithIntl(
      <ManageSpacePage
        spacesManager={spacesManager as unknown as SpacesManager}
        getFeatures={featuresStart.getFeatures}
        notifications={notificationServiceMock.createStartContract()}
        history={history}
        capabilities={{
          navLinks: {},
          management: {},
          catalogue: {},
          spaces: { manage: true },
        }}
        eventTracker={eventTracker}
        allowFeatureVisibility={false}
        allowSolutionVisibility
      />
    );

    await waitFor(() => {
      wrapper.update();
      expect(wrapper.find('input[name="name"]')).toHaveLength(1);
    });

    expect(wrapper.find(EnabledFeatures)).toHaveLength(0);
  });

  it('hides feature visibility controls when solution view is not "classic"', async () => {
    const spacesManager = spacesManagerMock.create();

    const wrapper = mountWithIntl(
      <ManageSpacePage
        spacesManager={spacesManager}
        getFeatures={featuresStart.getFeatures}
        notifications={notificationServiceMock.createStartContract()}
        history={history}
        capabilities={{
          navLinks: {},
          management: {},
          catalogue: {},
          spaces: { manage: true },
        }}
        eventTracker={eventTracker}
        allowFeatureVisibility
        allowSolutionVisibility
      />
    );

    await waitFor(async () => {
      await Promise.resolve();

      wrapper.update();

      // default for create space: expect visible features table to exist
      expect(wrapper.find(EnabledFeatures)).toHaveLength(1);
    });

    await waitFor(() => {
      // switch to observability view
      updateSpace(wrapper, false, 'oblt');
      // expect visible features table to not exist
      expect(wrapper.find(EnabledFeatures)).toHaveLength(0);
    });

    await waitFor(() => {
      // switch to classic
      updateSpace(wrapper, false, 'classic');
      // expect visible features table to exist again
      expect(wrapper.find(EnabledFeatures)).toHaveLength(1);
    });
  });

  it('allows a space to be updated', async () => {
    const spaceToUpdate = {
      id: 'existing-space',
      name: 'Existing Space',
      description: 'hey an existing space',
      color: '#aabbcc',
      initials: 'AB',
      disabledFeatures: [],
      solution: 'es',
    };

    const spacesManager = spacesManagerMock.create();
    spacesManager.getSpace = jest.fn().mockResolvedValue({
      ...spaceToUpdate,
    });
    spacesManager.getActiveSpace = jest.fn().mockResolvedValue(space);

    const onLoadSpace = jest.fn();

    const wrapper = mountWithIntl(
      <ManageSpacePage
        spaceId={'existing-space'}
        spacesManager={spacesManager as unknown as SpacesManager}
        onLoadSpace={onLoadSpace}
        getFeatures={featuresStart.getFeatures}
        notifications={notificationServiceMock.createStartContract()}
        history={history}
        capabilities={{
          navLinks: {},
          management: {},
          catalogue: {},
          spaces: { manage: true },
        }}
        eventTracker={eventTracker}
        allowFeatureVisibility
        allowSolutionVisibility
      />
    );

    await waitFor(() => {
      wrapper.update();
      expect(spacesManager.getSpace).toHaveBeenCalledWith('existing-space');
    });

    expect(onLoadSpace).toHaveBeenCalledWith({
      ...spaceToUpdate,
    });

    await Promise.resolve();

    wrapper.update();

    updateSpace(wrapper, true, 'oblt');

    await clickSaveButton(wrapper);

    expect(spacesManager.updateSpace).toHaveBeenCalledWith({
      id: 'existing-space',
      name: 'New Space Name',
      description: 'some description',
      color: '#AABBCC',
      initials: 'AB',
      imageUrl: '',
      disabledFeatures: ['feature-1'],
      solution: 'oblt', // solution has been changed
    });

    expect(reportEvent).toHaveBeenCalledWith('space_solution_changed', {
      action: 'edit',
      solution: 'oblt',
      solution_prev: 'es',
      space_id: 'existing-space',
    });
  });

  it('sets calculated fields for existing spaces', async () => {
    // The Spaces plugin provides functions to calculate the initials and color of a space if they have not been customized. The new space
    // management page explicitly sets these fields when a new space is created, but it should also handle existing "legacy" spaces that do
    // not already have these fields set.
    const spaceToUpdate = {
      id: 'existing-space',
      name: 'Existing Space',
      description: 'hey an existing space',
      color: undefined,
      initials: undefined,
      imageUrl: undefined,
      disabledFeatures: [],
    };

    const spacesManager = spacesManagerMock.create();
    spacesManager.getSpace = jest.fn().mockResolvedValue({
      ...spaceToUpdate,
    });
    spacesManager.getActiveSpace = jest.fn().mockResolvedValue(space);

    const onLoadSpace = jest.fn();

    const wrapper = mountWithIntl(
      <ManageSpacePage
        spaceId={'existing-space'}
        spacesManager={spacesManager as unknown as SpacesManager}
        onLoadSpace={onLoadSpace}
        getFeatures={featuresStart.getFeatures}
        notifications={notificationServiceMock.createStartContract()}
        history={history}
        capabilities={{
          navLinks: {},
          management: {},
          catalogue: {},
          spaces: { manage: true },
        }}
        eventTracker={eventTracker}
        allowFeatureVisibility
        allowSolutionVisibility
      />
    );

    await waitFor(() => {
      wrapper.update();
      expect(spacesManager.getSpace).toHaveBeenCalledWith('existing-space');
    });

    expect(onLoadSpace).toHaveBeenCalledWith({
      ...spaceToUpdate,
    });

    await Promise.resolve();

    wrapper.update();

    // not changing anything, just clicking the "Update space" button
    await clickSaveButton(wrapper);

    expect(spacesManager.updateSpace).toHaveBeenCalledWith({
      ...spaceToUpdate,
      color: '#E7664C',
      initials: 'ES',
      imageUrl: '',
    });
  });

  it('notifies when there is an error retrieving features', async () => {
    const spacesManager = spacesManagerMock.create();
    spacesManager.createSpace = jest.fn(spacesManager.createSpace);
    spacesManager.getActiveSpace = jest.fn().mockResolvedValue(space);

    const error = new Error('something awful happened');

    const notifications = notificationServiceMock.createStartContract();

    const wrapper = mountWithIntl(
      <ManageSpacePage
        spacesManager={spacesManager as unknown as SpacesManager}
        getFeatures={() => Promise.reject(error)}
        notifications={notifications}
        history={history}
        capabilities={{
          navLinks: {},
          management: {},
          catalogue: {},
          spaces: { manage: true },
        }}
        eventTracker={eventTracker}
        allowFeatureVisibility
        allowSolutionVisibility
      />
    );

    await waitFor(() => {
      wrapper.update();
      expect(notifications.toasts.addError).toHaveBeenCalledWith(error, {
        title: 'Error loading available features',
      });
    });
  });

  it('warns when updating features in the active space', async () => {
    const spacesManager = spacesManagerMock.create();
    spacesManager.getSpace = jest.fn().mockResolvedValue({
      id: 'my-space',
      name: 'Existing Space',
      description: 'hey an existing space',
      color: '#aabbcc',
      initials: 'AB',
      disabledFeatures: [],
    });
    spacesManager.getActiveSpace = jest.fn().mockResolvedValue(space);

    const wrapper = mountWithIntl(
      <ManageSpacePage
        spaceId={'my-space'}
        spacesManager={spacesManager as unknown as SpacesManager}
        getFeatures={featuresStart.getFeatures}
        notifications={notificationServiceMock.createStartContract()}
        history={history}
        capabilities={{
          navLinks: {},
          management: {},
          catalogue: {},
          spaces: { manage: true },
        }}
        eventTracker={eventTracker}
        allowFeatureVisibility
        allowSolutionVisibility
      />
    );

    await waitFor(() => {
      wrapper.update();
      expect(spacesManager.getSpace).toHaveBeenCalledWith('my-space');
    });

    await Promise.resolve();

    wrapper.update();

    updateSpace(wrapper);

    await clickSaveButton(wrapper);

    const warningDialog = wrapper.find(ConfirmAlterActiveSpaceModal);
    expect(warningDialog).toHaveLength(1);

    expect(spacesManager.updateSpace).toHaveBeenCalledTimes(0);

    const confirmButton = warningDialog
      .find(EuiButton)
      .find('[data-test-subj="confirmModalConfirmButton"]')
      .find('button');

    confirmButton.simulate('click');

    await Promise.resolve();

    wrapper.update();

    expect(spacesManager.updateSpace).toHaveBeenCalledTimes(1);
  });

  it('does not warn when features are left alone in the active space', async () => {
    const spacesManager = spacesManagerMock.create();
    spacesManager.getSpace = jest.fn().mockResolvedValue({
      id: 'my-space',
      name: 'Existing Space',
      description: 'hey an existing space',
      color: '#aabbcc',
      initials: 'AB',
      disabledFeatures: [],
    });
    spacesManager.getActiveSpace = jest.fn().mockResolvedValue(space);

    const wrapper = mountWithIntl(
      <ManageSpacePage
        spaceId={'my-space'}
        spacesManager={spacesManager as unknown as SpacesManager}
        getFeatures={featuresStart.getFeatures}
        notifications={notificationServiceMock.createStartContract()}
        history={history}
        capabilities={{
          navLinks: {},
          management: {},
          catalogue: {},
          spaces: { manage: true },
        }}
        eventTracker={eventTracker}
        allowFeatureVisibility
        allowSolutionVisibility
      />
    );

    await waitFor(() => {
      wrapper.update();
      expect(spacesManager.getSpace).toHaveBeenCalledWith('my-space');
    });

    await Promise.resolve();

    wrapper.update();

    updateSpace(wrapper, false);

    await clickSaveButton(wrapper);

    const warningDialog = wrapper.find(ConfirmAlterActiveSpaceModal);
    expect(warningDialog).toHaveLength(0);

    expect(spacesManager.updateSpace).toHaveBeenCalledTimes(1);
  });
});

function updateSpace(
  wrapper: ReactWrapper<any, any>,
  updateFeature = true,
  solution?: SolutionView
) {
  const nameInput = wrapper.find('input[name="name"]');
  const descriptionInput = wrapper.find('textarea[name="description"]');

  nameInput.simulate('change', { target: { value: 'New Space Name' } });
  descriptionInput.simulate('change', { target: { value: 'some description' } });

  if (updateFeature) {
    toggleFeature(wrapper);
  }

  if (solution) {
    act(() => {
      findTestSubject(wrapper, `solutionViewSelect`).simulate('click');
    });
    wrapper.update();
    findTestSubject(wrapper, `solutionView${capitalizeFirstLetter(solution)}Option`).simulate(
      'click'
    );
  }
}

function toggleFeature(wrapper: ReactWrapper<any, any>) {
  const {
    onChange = () => {
      throw new Error('expected onChange to be defined');
    },
  } = wrapper.find('input#featureCategoryCheckbox_kibana').props() as EuiCheckboxProps;
  onChange({ target: { checked: false } } as any);

  wrapper.update();
}

async function clickSaveButton(wrapper: ReactWrapper<any, any>) {
  const saveButton = wrapper.find('button[data-test-subj="save-space-button"]');
  saveButton.simulate('click');

  await Promise.resolve();

  wrapper.update();
}

function capitalizeFirstLetter(string: string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}
