import {t} from 'elysia';

export const maxPortfolioImages = 10;

const titleSchema = t.String({ minLength: 1, maxLength: 120, pattern: '\\S' });
const descriptionSchema = t.String({ minLength: 1, maxLength: 1000, pattern: '\\S' });

export const portfolioParamSchema = t.Object({
  portfolioId: t.String({ format: 'uuid'}),
});

export const portfolioCreateSchema = t.Object(
  {
    title: titleSchema,
    description: t.Optional(descriptionSchema),
    images: t.Files({maxItems: maxPortfolioImages}),
  },
  { additionalProperties: false},
);

export const portfolioUpdateSchema = t.Object(
  {
    title: t.Optional(titleSchema),
    description: t.Optional(descriptionSchema),
  },
  {additionalProperties: false},
);

const portfolioImageSchema = t.Object({
  fileId: t.String({format: 'uuid'}),
  position: t.Integer(),
  url: t.String({format: 'uri'}),
});

const portfolioItemSchema = t.Object({
  id: t.String({format:'uuid'}),
  title: t.String(),
  description: t.Nullable(t.String()),
  images: t.Array(portfolioImageSchema),
  createdAt: t.String({format: 'date-time'}),
});

export const portfolioListRespondSchema = 
t.Object({
  success: t.Literal(true),
  data: t.Array(portfolioItemSchema),
});

export const portfolioCreateResponseSchema =
t.Object({
  success: t.Literal(true),
  data: t.Object({
    id: t.String({ format: 'uuid'}),
  }),
});