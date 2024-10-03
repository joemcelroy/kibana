/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type {
  IndicesGetMappingResponse,
  MappingProperty,
  SearchHit,
} from '@elastic/elasticsearch/lib/api/types';
import type { MetaDataProps, FieldProps } from './result_types';

const TITLE_KEYS = ['title', 'name'];

const isRecord = (source: unknown | undefined): source is Record<PropertyKey, unknown> => {
  return typeof source === 'object' && source !== null;
};

function hasStringKey<T extends Record<PropertyKey, unknown>, K extends PropertyKey>(
  source: T,
  key: K
): source is T & Record<K, string> {
  return typeof source[key] === 'string';
}

export const resultTitle = (result: SearchHit): string | undefined => {
  if (isRecord(result._source)) {
    for (const key of TITLE_KEYS) {
      if (hasStringKey(result._source, key)) {
        return result._source[key];
      }
    }
  }
  return undefined;
};

export const resultMetaData = (result: SearchHit): MetaDataProps => ({
  id: result._id!,
  title: resultTitle(result),
  score: result._score,
});

const MAPPING_TYPE_ORDER = ['semantic_text', 'dense_vector', 'sparse_vector'];
const SPECIAL_NAME_FIELDS = ['headings'];

export const reorderFieldsInImportance = (fields: FieldProps[]) => {
  return fields.sort((a, b) => {
    const specialA = SPECIAL_NAME_FIELDS.indexOf(a.fieldName);
    const specialB = SPECIAL_NAME_FIELDS.indexOf(b.fieldName);

    if (specialA !== -1 || specialB !== -1) {
      if (specialA === -1) return 1;
      if (specialB === -1) return -1;
      return specialA - specialB;
    }

    const typeA = MAPPING_TYPE_ORDER.indexOf(a.fieldType!);
    const typeB = MAPPING_TYPE_ORDER.indexOf(b.fieldType!);
    const orderA = typeA === -1 ? MAPPING_TYPE_ORDER.length : typeA;
    const orderB = typeB === -1 ? MAPPING_TYPE_ORDER.length : typeB;

    if (orderA === orderB) {
      return a.fieldName.localeCompare(b.fieldName);
    }
    return orderA - orderB;
  });
};

export const resultToFieldFromMappingResponse = (
  result: SearchHit,
  mappings?: IndicesGetMappingResponse
): FieldProps[] => {
  if (mappings && mappings[result._index] && result._source && !Array.isArray(result._source)) {
    if (typeof result._source === 'object') {
      return Object.entries(result._source).map(([key, value]) => {
        return {
          fieldName: key,
          fieldType: mappings[result._index]?.mappings?.properties?.[key]?.type ?? 'object',
          fieldValue: JSON.stringify(value, null, 2),
        };
      });
    }
  }
  return [];
};

export const resultToFieldFromMappings = (
  result: SearchHit,
  mappings?: Record<string, MappingProperty>
): FieldProps[] => {
  if (mappings && result._source && !Array.isArray(result._source)) {
    return Object.entries(result._source).map(([key, value]) => {
      return {
        fieldName: key,
        fieldType: mappings[key]?.type ?? 'object',
        fieldValue: JSON.stringify(value, null, 2),
      };
    });
  }
  return [];
};
