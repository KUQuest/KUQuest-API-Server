import type { AuthenticatedSession } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';

import type { Static } from 'elysia';
import type { StatusMap } from 'elysia/utils';

import type { certificateCreateSchema, certificateUpdateSchema } from './certificate.schema';
import {
  createCertificate,
  deleteCertificate,
  findCertificate,
  listCertificates,
  updateCertificate,
} from './certificate.service';

type AuthedContext = {
  session: AuthenticatedSession;
  set: { status?: number | keyof StatusMap };
};

type CertificateParams = { params: { certificateId: string } };

type CertificateRecord = Awaited<ReturnType<typeof findCertificate>>;

const NOT_FOUND = apiError('CERTIFICATE_NOT_FOUND', 'Certificate not found');

export const getCertificates = async ({
  session,
}: AuthedContext): Promise<ApiResponse<{ certificates: NonNullable<CertificateRecord>[] }>> => {
  const certificates = await listCertificates(session.user.id);

  return apiSuccess({ certificates });
};

export const getCertificate = async ({
  session,
  params,
  set,
}: AuthedContext & CertificateParams): Promise<
  ApiResponse<{ certificate: NonNullable<CertificateRecord> }>
> => {
  const certificate = await findCertificate(session.user.id, params.certificateId);

  if (!certificate) {
    set.status = 404;
    return NOT_FOUND;
  }

  return apiSuccess({ certificate });
};

export const postCertificate = async ({
  session,
  body,
}: AuthedContext & { body: Static<typeof certificateCreateSchema> }): Promise<
  ApiResponse<{ certificate: NonNullable<CertificateRecord> }>
> => {
  const certificate = await createCertificate(session.user.id, body);

  return apiSuccess({ certificate });
};

export const patchCertificate = async ({
  session,
  params,
  body,
  set,
}: AuthedContext &
  CertificateParams & { body: Static<typeof certificateUpdateSchema> }): Promise<
  ApiResponse<{ certificate: NonNullable<CertificateRecord> }>
> => {
  const certificate = await updateCertificate(session.user.id, params.certificateId, body);

  if (!certificate) {
    set.status = 404;
    return NOT_FOUND;
  }

  return apiSuccess({ certificate });
};

export const removeCertificate = async ({
  session,
  params,
  set,
}: AuthedContext & CertificateParams): Promise<ApiResponse> => {
  const deleted = await deleteCertificate(session.user.id, params.certificateId);

  if (!deleted) {
    set.status = 404;
    return NOT_FOUND;
  }

  return apiSuccess();
};
