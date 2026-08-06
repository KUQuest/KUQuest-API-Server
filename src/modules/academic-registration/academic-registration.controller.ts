import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';

import type { Static } from 'elysia';

import {
  getAcademicRegistrationOptions,
  getAcademicRegistrationStatus,
  updateAcademicRegistration,
} from './academic-registration.service';
import type {
  academicRegistrationOptionsResponseSchema,
  academicRegistrationStatusResponseSchema,
  academicRegistrationUpdateSchema,
} from './academic-registration.schema';

type AcademicRegistrationStatus = Static<typeof academicRegistrationStatusResponseSchema>['data'];
type AcademicRegistrationOptions = Static<typeof academicRegistrationOptionsResponseSchema>['data'];

const studentNotFound = (set: AuthedContext['set']) => {
  set.status = 404;

  return apiError('STUDENT_NOT_FOUND', 'Student not found');
};

export const getAcademicRegistrationStatusController = async ({
  session,
  set,
}: AuthedContext): Promise<ApiResponse<AcademicRegistrationStatus>> => {
  const status = await getAcademicRegistrationStatus(session.user.id);

  if (!status) return studentNotFound(set);

  return apiSuccess({
    ...status,
    termsAcceptedAt: status.termsAcceptedAt ? status.termsAcceptedAt.toISOString() : null,
  });
};

export const getAcademicRegistrationOptionsController = async (): Promise<
  ApiResponse<AcademicRegistrationOptions>
> => apiSuccess(await getAcademicRegistrationOptions());

export const updateAcademicRegistrationController = async ({
  session,
  set,
  body,
}: AuthedContext & { body: Static<typeof academicRegistrationUpdateSchema> }): Promise<ApiResponse> => {
  const outcome = await updateAcademicRegistration(session.user.id, body);

  if (outcome === 'student-not-found') return studentNotFound(set);

  if (outcome === 'department-not-found') {
    set.status = 400;
    return apiError('DEPARTMENT_NOT_FOUND', 'Department not found');
  }

  if (outcome === 'occupation-not-found') {
    set.status = 400;
    return apiError('OCCUPATION_NOT_FOUND', 'Occupation not found');
  }

  if (outcome === 'student-id-already-exists') {
    set.status = 409;
    return apiError('STUDENT_ID_ALREADY_EXISTS', 'Student ID already exists');
  }

  return apiSuccess();
};
