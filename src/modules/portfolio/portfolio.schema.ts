import {t} from 'elysia';

export const maxPortfolioImages = 10;

const titleSchema = t.String({
  minLength: 1,
  maxLength: 120,
  pattern: '\\S',
  example: 'Capstone Project',
});
const descriptionSchema = t.String({
  minLength: 1,
  maxLength: 1000,
  pattern: '\\S',
  example: 'A short description of the work.',
});

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
  fileId: t.String({ format: 'uuid' }),
  position: t.Integer(),
  url: t.String({ format: 'uri', example: 'https://storage.example.com/portfolio/a.png' }),
});

const portfolioItemSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  title: t.String({ example: 'Capstone Project' }),
  description: t.Nullable(t.String({ example: 'A short description of the work.' })),
  images: t.Array(portfolioImageSchema),
  createdAt: t.String({ format: 'date-time' }),
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