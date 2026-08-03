import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import { ValidationError, t } from 'elysia';
import { describe, expect, it } from 'bun:test';

const schema = t.Object({
  title: t.Optional(t.String()),
  description: t.Optional(t.String()),
});

const reject = rejectUnknownFields(schema);

describe('rejectUnknownFields', () => {
  it('allows a body with only known fields', () => {
    expect(() => reject({ body: { title: 'a' } })).not.toThrow();
  });

  it('allows an empty body', () => {
    expect(() => reject({ body: {} })).not.toThrow();
  });

  it('allows an undefined or null body', () => {
    expect(() => reject({ body: undefined })).not.toThrow();
    expect(() => reject({ body: null })).not.toThrow();
  });

  it('rejects a body containing an unknown field', () => {
    expect(() => reject({ body: { title: 'a', bogus: 'x' } })).toThrow(ValidationError);
  });

  it('rejects a non-object body', () => {
    expect(() => reject({ body: 'nope' })).toThrow(ValidationError);
  });

  it('rejects an array body', () => {
    expect(() => reject({ body: ['title'] })).toThrow(ValidationError);
  });
});
