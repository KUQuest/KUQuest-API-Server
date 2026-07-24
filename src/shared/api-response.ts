export const apiSuccess = <T>(data: T) => ({
  success: true as const,
  data,
});

export const apiError = (code: string, message: string) => ({
  success: false as const,
  error: { code, message },
});
