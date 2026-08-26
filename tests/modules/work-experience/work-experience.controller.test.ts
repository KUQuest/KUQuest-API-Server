import * as workExperienceService from '@/modules/work-experience/work-experience.service';
import {
  createOwnWorkExperience,
  deleteOwnWorkExperience,
  listOwnWorkExperiences,
  updateOwnWorkExperience,
} from '@/modules/work-experience/work-experience.controller';

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

const session = { user: { id: 'student-1' } };

const storedExperience = {
  id: '018f47a7-1c7d-7c98-9a11-690d7e83430c',
  version: 1,
  title: 'Senior Peer Tutor',
  employmentType: 'Part-time',
  organization: 'University Academic Center',
  description: 'Assisted students.',
  startedAt: '2022-06-01',
  endedAt: null,
  createdAt: new Date('2026-08-12T00:00:00.000Z'),
  updatedAt: new Date('2026-08-12T00:00:00.000Z'),
};

const context = (set: { status?: number | string } = {}) => ({
  session: session as never,
  set: set as never,
});

afterEach(() => mock.restore());

describe('work experience controller', () => {
  it('serializes database timestamps and keeps the list response as an array', async () => {
    spyOn(workExperienceService, 'listWorkExperiences').mockResolvedValue([storedExperience]);

    expect(await listOwnWorkExperiences(context())).toEqual({
      success: true,
      data: [{
        ...storedExperience,
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:00:00.000Z',
      }],
    });
  });

  it('returns the approved validation error without writing invalid dates', async () => {
    const create = spyOn(workExperienceService, 'createWorkExperience').mockResolvedValue({
      outcome: 'invalid-date-range',
    });
    const set: { status?: number | string } = {};

    expect(await createOwnWorkExperience({
      ...context(set),
      body: {
        title: 'Role',
        employmentType: 'Internship',
        startedAt: '2024-02-02',
        endedAt: '2024-02-01',
      },
    } as never)).toEqual({
      success: false,
      error: {
        code: 'INVALID_EXPERIENCE_DATES',
        message: 'endedAt must be on or after startedAt',
      },
    });
    expect(set.status).toBe(400);
    expect(create).toHaveBeenCalledWith('student-1', expect.any(Object));
  });

  it('returns not found for an unowned update or delete', async () => {
    spyOn(workExperienceService, 'updateWorkExperience').mockResolvedValue(undefined);
    spyOn(workExperienceService, 'deleteWorkExperience').mockResolvedValue(undefined);
    const updateSet: { status?: number | string } = {};
    const deleteSet: { status?: number | string } = {};

    expect(await updateOwnWorkExperience({
      ...context(updateSet),
      params: { experienceId: storedExperience.id },
      body: { title: 'Nope' },
    } as never)).toEqual({
      success: false,
      error: { code: 'EXPERIENCE_NOT_FOUND', message: 'Work experience not found' },
    });
    expect(await deleteOwnWorkExperience({
      ...context(deleteSet),
      params: { experienceId: storedExperience.id },
    } as never)).toEqual({
      success: false,
      error: { code: 'EXPERIENCE_NOT_FOUND', message: 'Work experience not found' },
    });
    expect(updateSet.status).toBe(404);
    expect(deleteSet.status).toBe(404);
  });

  it('maps an invalid PATCH date range to the shared client error', async () => {
    spyOn(workExperienceService, 'updateWorkExperience').mockResolvedValue({
      outcome: 'invalid-date-range',
    });
    const set: { status?: number | string } = {};

    expect(await updateOwnWorkExperience({
      ...context(set),
      params: { experienceId: storedExperience.id },
      body: { startedAt: '2025-01-02' },
    } as never)).toEqual({
      success: false,
      error: {
        code: 'INVALID_EXPERIENCE_DATES',
        message: 'endedAt must be on or after startedAt',
      },
    });
    expect(set.status).toBe(400);
  });
});
