export function apiSuccess(): { success: true };
export function apiSuccess<T>(data: T): { success: true; data: T };
export function apiSuccess<T>(data?: T) {
  return data === undefined
    ? { success: true as const }
    : { success: true as const, data };
}

export const apiError = (code: string, message: string) => ({
  success: false as const,
  error: { code, message },
});
