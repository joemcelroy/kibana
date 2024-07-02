/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { useFormContext } from 'react-hook-form';
import { ChatForm } from '../types';
import { useEffect, useRef } from 'react';
import { debounce } from 'lodash';

export const useFormHistory = () => {
  const { reset, watch, getValues } = useFormContext<ChatForm>();

  const formValues = watch();

  const saveFormToLocalStorage = (data) => {
    const serializedData = JSON.stringify({
      timestamp: new Date().toISOString(),
      data,
    });
    localStorage.setItem(`form_${Date.now()}`, serializedData);
  };

  const debouncedSaveForm = debounce(() => {
    debugger;
    saveFormToLocalStorage(getValues());
  }, 3000);

  useEffect(() => {
    debouncedSaveForm();
  }, [formValues]);

  return {};
};
