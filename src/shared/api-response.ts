export type ApiSuccess<T = undefined> = T extends undefined
  ? { success: true }
  : { success: true; data: T };

export type ApiError = {
  success: false;
  error: { code: string; message: string };
};

export type ApiResponse<T = undefined> = ApiSuccess<T> | ApiError;

export function apiSuccess(): { success: true };
export function apiSuccess<T>(data: T): { success: true; data: T };
export function apiSuccess<T>(data?: T) {
  return data === undefined
    ? { success: true as const }
    : { success: true as const, data };
}

export const apiError = (code: string, message: string): ApiError => ({
  success: false as const,
  error: { code, message },
});
