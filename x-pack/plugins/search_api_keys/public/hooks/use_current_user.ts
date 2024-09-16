/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { useState, useEffect } from 'react';
import { useKibana } from '@kbn/kibana-react-plugin/public';
import { AuthenticatedUser } from '@kbn/core-security-common';

export const useCurrentUser = () => {
  const { security } = useKibana().services;
  const [user, setUser] = useState<AuthenticatedUser | undefined>(undefined);

  useEffect(() => {
    const getCurrentUser = async () => {
      try {
        const authenticatedUser = await security!.authc.getCurrentUser();
        setUser(authenticatedUser);
      } catch {
        setUser(undefined);
      }
    };
    getCurrentUser();
  }, [security]);

  return user;
};
