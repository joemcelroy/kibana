/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { i18n } from '@kbn/i18n';
import type { Calendar, CalendarId } from '../../../common/types/calendars';
import type { JobId } from '../../../common/types/anomaly_detection_jobs';
import type { MlApiServices } from './ml_api_service';

class CalendarService {
  /**
   * Assigns a job id to the calendar.
   * @param calendar
   * @param jobId
   */
  async assignNewJobId(mlApiServices: MlApiServices, calendar: Calendar, jobId: JobId) {
    const { calendar_id: calendarId } = calendar;
    try {
      await mlApiServices.updateCalendar({
        ...calendar,
        calendarId,
        job_ids: [...calendar.job_ids, jobId],
      });
    } catch (e) {
      throw new Error(
        i18n.translate('xpack.ml.calendarService.assignNewJobIdErrorMessage', {
          defaultMessage: 'Unable to assign {jobId} to {calendarId}',
          values: { calendarId, jobId },
        })
      );
    }
  }

  /**
   * Fetches calendars by the list of ids.
   * @param calendarIds
   */
  async fetchCalendarsByIds(
    mlApiServices: MlApiServices,
    calendarIds: CalendarId[]
  ): Promise<Calendar[]> {
    try {
      const calendars = await mlApiServices.calendars({ calendarIds });
      return Array.isArray(calendars) ? calendars : [calendars];
    } catch (e) {
      throw new Error(
        i18n.translate('xpack.ml.calendarService.fetchCalendarsByIdsErrorMessage', {
          defaultMessage: 'Unable to fetch calendars: {calendarIds}',
          values: { calendarIds: calendarIds.join(', ') },
        })
      );
    }
  }
}

export const mlCalendarService = new CalendarService();
