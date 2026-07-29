import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';

import type { Static } from 'elysia';

import type { certificateCreateSchema, certificateUpdateSchema } from './certificate.schema';
import type { Certificate } from './certificate.service';
import {
  createCertificate,
  deleteCertificate,
  findCertificate,
  listCertificates,
  updateCertificate,
} from './certificate.service';

type CertificateParams = { params: { certificateId: string } };

const notFound = apiError('CERTIFICATE_NOT_FOUND', 'Certificate not found');

export const getCertificates = async ({
  session,
}: AuthedContext): Promise<ApiResponse<{ certificates: Certificate[] }>> => {
  const certificates = await listCertificates(session.user.id);

  return apiSuccess({ certificates });
};

export const getCertificate = async ({
  session,
  params,
  set,
}: AuthedContext & CertificateParams): Promise<ApiResponse<{ certificate: Certificate }>> => {
  const certificate = await findCertificate(session.user.id, params.certificateId);

  if (!certificate) {
    set.status = 404;
    return notFound;
  }

  return apiSuccess({ certificate });
};

export const postCertificate = async ({
  session,
  body,
}: AuthedContext & { body: Static<typeof certificateCreateSchema> }): Promise<
  ApiResponse<{ certificate: Certificate }>
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
  ApiResponse<{ certificate: Certificate }>
> => {
  const certificate = await updateCertificate(session.user.id, params.certificateId, body);

  if (!certificate) {
    set.status = 404;
    return notFound;
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
    return notFound;
  }

  return apiSuccess();
};
