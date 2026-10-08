import { t } from 'elysia';

export const unionOfLiterals = (values: readonly string[]) =>
  t.Union(
    values.map((value) => t.Literal(value)) as [
      ReturnType<typeof t.Literal<string>>,
      ...ReturnType<typeof t.Literal<string>>[],
    ]
  );
