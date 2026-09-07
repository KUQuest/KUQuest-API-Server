import {
  getCertificate,
  getCertificates,
  patchCertificate,
  postCertificate,
  removeCertificate,
  setCertificateImage,
} from '@/modules/certificate/certificate.controller';
import * as certificateService from '@/modules/certificate/certificate.service';
import { certificateStorage } from '@/modules/certificate/certificate.storage';
import { ImageLinkUnavailableError, ImageUploadError } from '@/shared/image-storage';

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

const studentAuthId = 'student-1';
const certificateId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const session = { user: { id: studentAuthId } };

const certificate = {
  id: certificateId,
  version: 1,
  name: 'AWS Certified Cloud Practitioner',
  issuer: 'Amazon Web Services',
  issuedAt: '2024-05-01',
  imageFileId: null,
  imageBucket: null,
  imageObjectKey: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const serialized = {
  id: certificate.id,
  version: certificate.version,
  name: certificate.name,
  issuer: certificate.issuer,
  issuedAt: certificate.issuedAt,
  image: null,
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

  it('turns a stored image reference into a link that expires', async () => {
    const fileId = '018f47a7-1c7d-7c98-9a11-690d7e83430c';
    spyOn(certificateService, 'findCertificate').mockResolvedValue({
      ...certificate,
      imageFileId: fileId,
      imageBucket: 'kuquest',
      imageObjectKey: `certificates/${studentAuthId}/current.png`,
    });
    spyOn(certificateStorage, 'linkFor').mockReturnValue('https://storage.test/signed-link');

    const result = await getCertificate({
      session: session as never,
      params: { certificateId },
      set: {} as never,
    });

    expect(result).toEqual({
      success: true,
      data: { certificate: { ...serialized, image: { fileId, url: 'https://storage.test/signed-link' } } },
    });
  });

  it('still answers with the certificate when the image link cannot be built', async () => {
    spyOn(certificateService, 'findCertificate').mockResolvedValue({
      ...certificate,
      imageFileId: '018f47a7-1c7d-7c98-9a11-690d7e83430c',
      imageBucket: 'kuquest',
      imageObjectKey: `certificates/${studentAuthId}/current.png`,
    });
    spyOn(certificateStorage, 'linkFor').mockImplementation(() => {
      throw new ImageLinkUnavailableError('Object storage is not configured');
    });

    const result = await getCertificate({
      session: session as never,
      params: { certificateId },
      set: {} as never,
    });

    expect(result).toEqual({ success: true, data: { certificate: serialized } });
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

    expect(result).toEqual({ success: true, data: { version: 1 } });
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

const fileId = '018f47a7-1c7d-7c98-9a11-690d7e83430c';
const previousFileId = '018f47a7-1c7d-7c98-9a11-690d7e83430d';

const invokeSetCertificateImage = (image: File) => {
  const set: { status?: number | string } = {};

  return {
    result: setCertificateImage({
      body: { image },
      session: session as never,
      params: { certificateId },
      set: set as never,
    }),
    set,
  };
};

describe('setCertificateImage', () => {
  it('returns the stored file reference and a link that expires', async () => {
    const storedImage = {
      bucket: 'kuquest',
      objectKey: `certificates/${studentAuthId}/image.png`,
      contentType: 'image/png' as const,
      sizeBytes: 12,
    };
    spyOn(certificateStorage, 'upload').mockResolvedValue(storedImage);
    spyOn(certificateService, 'replaceCertificateImage').mockResolvedValue({
      fileId,
      previousFileId: null,
      version: 2,
    });
    spyOn(certificateStorage, 'linkFor').mockReturnValue('https://storage.test/signed-link');

    const { result, set } = invokeSetCertificateImage(
      new File(['image-content'], 'image.png', { type: 'image/png' }),
    );

    expect(await result).toEqual({
      success: true,
      data: { image: { fileId, url: 'https://storage.test/signed-link' }, version: 2 },
    });
    expect(set.status).toBeUndefined();
    expect(certificateStorage.upload).toHaveBeenCalledWith(studentAuthId, expect.any(File));
    expect(certificateService.replaceCertificateImage).toHaveBeenCalledWith(
      studentAuthId,
      certificateId,
      storedImage,
    );
  });

  it('removes the previous image only after storing its replacement', async () => {
    spyOn(certificateStorage, 'upload').mockResolvedValue({
      bucket: 'kuquest',
      objectKey: `certificates/${studentAuthId}/new.png`,
      contentType: 'image/png',
      sizeBytes: 12,
    });
    spyOn(certificateService, 'replaceCertificateImage').mockResolvedValue({
      fileId,
      previousFileId,
      version: 2,
    });
    spyOn(certificateService, 'getPreviousCertificateImageFile').mockResolvedValue({
      bucket: 'old-bucket',
      objectKey: `certificates/${studentAuthId}/old.png`,
    });
    const markDeleted = spyOn(certificateService, 'markCertificateImageDeleted').mockResolvedValue(
      undefined,
    );
    const deleteObject = spyOn(certificateStorage, 'delete').mockResolvedValue();
    spyOn(certificateStorage, 'linkFor').mockReturnValue('https://storage.test/signed-link');

    const { result } = invokeSetCertificateImage(
      new File(['image-content'], 'image.png', { type: 'image/png' }),
    );

    expect(await result).toEqual({
      success: true,
      data: { image: { fileId, url: 'https://storage.test/signed-link' }, version: 2 },
    });
    expect(certificateStorage.delete).toHaveBeenCalledWith(
      'old-bucket',
      `certificates/${studentAuthId}/old.png`,
    );
    expect(markDeleted).toHaveBeenCalledTimes(1);
    expect(deleteObject.mock.invocationCallOrder[0]).toBeLessThan(
      markDeleted.mock.invocationCallOrder[0],
    );
  });

  it('reports a missing or unowned certificate as not found, and discards the upload', async () => {
    const storedImage = {
      bucket: 'kuquest',
      objectKey: `certificates/${studentAuthId}/image.png`,
      contentType: 'image/png' as const,
      sizeBytes: 12,
    };
    spyOn(certificateStorage, 'upload').mockResolvedValue(storedImage);
    spyOn(certificateService, 'replaceCertificateImage').mockResolvedValue(undefined);
    const deleteObject = spyOn(certificateStorage, 'delete').mockResolvedValue();

    const { result, set } = invokeSetCertificateImage(
      new File(['image-content'], 'image.png', { type: 'image/png' }),
    );

    expect(await result).toEqual({
      success: false,
      error: { code: 'CERTIFICATE_NOT_FOUND', message: 'Certificate not found' },
    });
    expect(set.status).toBe(404);
    expect(deleteObject).toHaveBeenCalledWith(storedImage.bucket, storedImage.objectKey);
  });

  it('rejects an image larger than 5 MB', async () => {
    const image = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'image.png', {
      type: 'image/png',
    });

    const { result, set } = invokeSetCertificateImage(image);

    expect(await result).toEqual({
      success: false,
      error: {
        code: 'CERTIFICATE_IMAGE_TOO_LARGE',
        message: 'Image must be 5 MB or smaller',
      },
    });
    expect(set.status).toBe(413);
  });

  it('rejects truncated content with a supported signature', async () => {
    const truncatedPng = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      'image.png',
      { type: 'image/png' },
    );

    const { result, set } = invokeSetCertificateImage(truncatedPng);

    expect(await result).toEqual({
      success: false,
      error: {
        code: 'UNSUPPORTED_CERTIFICATE_IMAGE_TYPE',
        message: 'Image must be a valid JPEG, PNG, or WebP file',
      },
    });
    expect(set.status).toBe(415);
  });

  it('returns a safe error when object storage rejects the upload', async () => {
    spyOn(certificateStorage, 'upload').mockRejectedValue(
      new ImageUploadError('secret RustFS detail'),
    );

    const { result, set } = invokeSetCertificateImage(
      new File(['image-content'], 'image.png', { type: 'image/png' }),
    );
    const body = await result;

    expect(set.status).toBe(502);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'CERTIFICATE_IMAGE_UPLOAD_FAILED',
        message: 'Certificate image upload failed',
      },
    });
    expect(JSON.stringify(body)).not.toContain('secret RustFS detail');
  });
});
