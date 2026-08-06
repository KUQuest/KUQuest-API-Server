import { authGuard } from '@/modules/auth';
import { apiSuccessSchema, betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V1_PREFIX } from '@/shared/api-version';
import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import { Elysia } from 'elysia';

import {
  getCertificate,
  getCertificates,
  patchCertificate,
  postCertificate,
  removeCertificate,
} from './certificate.controller';
import {
  certificateCreateSchema,
  certificateListResponseSchema,
  certificateParamsSchema,
  certificateResponseSchema,
  certificateUpdateSchema,
} from './certificate.schema';

export const certificateRoute = new Elysia({
  name: 'certificate-route',
  prefix: `${API_V1_PREFIX}/profile/certificates`,
})
  .use(authGuard)
  .get('', getCertificates, {
    response: responses(certificateListResponseSchema, 401),
    detail: {
      tags: ['Certificates'],
      summary: 'List certificates',
      description: 'Get every certificate owned by the current user.',
      operationId: 'listCertificates',
      security: betterAuthSecurity,
    },
  })
  .get('/:certificateId', getCertificate, {
    params: certificateParamsSchema,
    response: responses(certificateResponseSchema, 400, 401, 404),
    detail: {
      tags: ['Certificates'],
      summary: 'Get a certificate',
      description: 'Get a single certificate owned by the current user.',
      operationId: 'getCertificate',
      security: betterAuthSecurity,
    },
  })
  .post('', postCertificate, {
    body: certificateCreateSchema,
    transform: rejectUnknownFields(certificateCreateSchema),
    response: responses(certificateResponseSchema, 400, 401),
    detail: {
      tags: ['Certificates'],
      summary: 'Create a certificate',
      description: 'Create a certificate owned by the current user.',
      operationId: 'createCertificate',
      security: betterAuthSecurity,
    },
  })
  .patch('/:certificateId', patchCertificate, {
    params: certificateParamsSchema,
    body: certificateUpdateSchema,
    transform: rejectUnknownFields(certificateUpdateSchema),
    response: responses(certificateResponseSchema, 400, 401, 404),
    detail: {
      tags: ['Certificates'],
      summary: 'Update a certificate',
      description: 'Update the supplied fields of a certificate owned by the current user.',
      operationId: 'updateCertificate',
      security: betterAuthSecurity,
    },
  })
  .delete('/:certificateId', removeCertificate, {
    params: certificateParamsSchema,
    response: responses(apiSuccessSchema, 400, 401, 404),
    detail: {
      tags: ['Certificates'],
      summary: 'Delete a certificate',
      description: 'Delete a certificate owned by the current user.',
      operationId: 'deleteCertificate',
      security: betterAuthSecurity,
    },
  });
