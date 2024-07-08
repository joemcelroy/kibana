/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { useEffect, useState } from 'react';
import { UseFormReturn } from 'react-hook-form';
import { ChatForm } from '../types';

interface HistoryEntry {
  id: string;
  timestamp: number;
  formData: ChatForm;
}

export const useFormHistory = <TFieldValues extends ChatForm>(
  form: UseFormReturn<TFieldValues>,
  storageKey: string = 'PLAYGROUND'
) => {
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    // Load history from localStorage
    const storedHistory = localStorage.getItem(storageKey);
    if (storedHistory) {
      setHistory(JSON.parse(storedHistory));
    }
  }, [storageKey]);

  useEffect(() => {
    const subscription = form.watch(() => {
      const newEntry: HistoryEntry = {
        id: Date.now().toString(),
        timestamp: Date.now(),
        formData: form.getValues(),
      };

      setHistory((prevHistory) => {
        const updatedHistory = [newEntry, ...prevHistory];

        // Prune entries older than 30 days
        const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
        const prunedHistory = updatedHistory.filter((entry) => entry.timestamp >= thirtyDaysAgo);

        // Save updated history to localStorage
        localStorage.setItem(storageKey, JSON.stringify(prunedHistory));

        return prunedHistory;
      });
    });

    return () => subscription.unsubscribe();
  }, [form, storageKey]);

  const revertToVersion = (id: string) => {
    const entry = history.find((item) => item.id === id);
    if (entry && entry.formData) {
      // @ts-ignore
      form.reset(entry.formData);
    }
  };

  const getHistory = () => {
    return history.reduce<Record<string, any>>((acc, entry) => {
      const date = new Date(entry.timestamp);
      const dateStr = `${date.toLocaleString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })}`;
      if (!acc[dateStr]) {
        acc[dateStr] = [];
      }
      const summary = [
        `Model: ${entry.formData.summarization_model}`,
        `Prompt: ${entry.formData.prompt}`,
        `Indices: ${entry.formData.indices.join(', ')}`,
      ];

      const existingEntry = acc[dateStr].find(
        (existing) => existing.summary.join('') === summary.join('')
      );
      if (!existingEntry) {
        acc[dateStr].push({
          id: entry.id,
          timestamp: entry.timestamp,
          summary,
        });
      }

      return acc;
    }, {});
  };

  return {
    getHistory,
    revertToVersion,
  };
};
