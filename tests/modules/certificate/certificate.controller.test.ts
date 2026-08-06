import {
  getCertificate,
  getCertificates,
  patchCertificate,
  postCertificate,
  removeCertificate,
} from '@/modules/certificate/certificate.controller';
import * as certificateService from '@/modules/certificate/certificate.service';

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

const studentAuthId = 'student-1';
const certificateId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const session = { user: { id: studentAuthId } };

const certificate = {
  id: certificateId,
  name: 'AWS Certified Cloud Practitioner',
  issuer: 'Amazon Web Services',
  issuedAt: '2024-05-01',
  verifyUrl: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const serialized = {
  ...certificate,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

afterEach(() => {
  mock.restore();
});

describe('getCertificates', () => {
  it('serializes createdAt/updatedAt as ISO strings', async () => {
    spyOn(certificateService, 'listCertificates').mockResolvedValue([certificate]);

    const result = await getCertificates({ session: session as never, set: {} as never });

    expect(result).toEqual({ success: true, data: { certificates: [serialized] } });
  });
});

describe('getCertificate', () => {
  it('returns a serialized certificate', async () => {
    spyOn(certificateService, 'findCertificate').mockResolvedValue(certificate);
    const set: { status?: number } = {};

    const result = await getCertificate({
      session: session as never,
      params: { certificateId },
      set: set as never,
    });

    expect(result).toEqual({ success: true, data: { certificate: serialized } });
    expect(set.status).toBeUndefined();
  });

  it('reports a missing or unowned certificate as not found', async () => {
    spyOn(certificateService, 'findCertificate').mockResolvedValue(undefined as never);
    const set: { status?: number } = {};

    const result = await getCertificate({
      session: session as never,
      params: { certificateId },
      set: set as never,
    });

    expect(result).toEqual({
      success: false,
      error: { code: 'CERTIFICATE_NOT_FOUND', message: 'Certificate not found' },
    });
    expect(set.status).toBe(404);
  });
});

describe('postCertificate', () => {
  it('creates and returns a serialized certificate', async () => {
    spyOn(certificateService, 'createCertificate').mockResolvedValue(certificate);

    const result = await postCertificate({
      session: session as never,
      set: {} as never,
      body: {
        name: certificate.name,
        issuer: certificate.issuer,
        issuedAt: certificate.issuedAt,
      },
    });

    expect(result).toEqual({ success: true, data: { certificate: serialized } });
  });
});

describe('patchCertificate', () => {
  it('updates and returns a serialized certificate', async () => {
    spyOn(certificateService, 'updateCertificate').mockResolvedValue(certificate);
    const set: { status?: number } = {};

    const result = await patchCertificate({
      session: session as never,
      params: { certificateId },
      body: { name: 'Renamed' },
      set: set as never,
    });

    expect(result).toEqual({ success: true, data: { certificate: serialized } });
    expect(set.status).toBeUndefined();
  });

  it('reports a missing or unowned certificate as not found', async () => {
    spyOn(certificateService, 'updateCertificate').mockResolvedValue(undefined as never);
    const set: { status?: number } = {};

    const result = await patchCertificate({
      session: session as never,
      params: { certificateId },
      body: { name: 'Renamed' },
      set: set as never,
    });

    expect(result).toEqual({
      success: false,
      error: { code: 'CERTIFICATE_NOT_FOUND', message: 'Certificate not found' },
    });
    expect(set.status).toBe(404);
  });
});

describe('removeCertificate', () => {
  it('deletes and reports success without echoing the certificate back', async () => {
    spyOn(certificateService, 'deleteCertificate').mockResolvedValue({ id: certificateId });
    const set: { status?: number } = {};

    const result = await removeCertificate({
      session: session as never,
      params: { certificateId },
      set: set as never,
    });

    expect(result).toEqual({ success: true });
    expect(set.status).toBeUndefined();
  });

  it('reports a missing or unowned certificate as not found', async () => {
    spyOn(certificateService, 'deleteCertificate').mockResolvedValue(undefined as never);
    const set: { status?: number } = {};

    const result = await removeCertificate({
      session: session as never,
      params: { certificateId },
      set: set as never,
    });

    expect(result).toEqual({
      success: false,
      error: { code: 'CERTIFICATE_NOT_FOUND', message: 'Certificate not found' },
    });
    expect(set.status).toBe(404);
  });
});
