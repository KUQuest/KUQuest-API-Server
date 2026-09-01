import type { AuthedContext } from '@/modules/auth';
import { MoneyDomainError, toBaht } from '@/modules/wallet';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';
import { CursorInputError, decodeCursor, parsePageLimit } from '@/shared/cursor';
import {
  ImageLinkUnavailableError,
  ImageTooLargeError,
  ImageUploadError,
  UnsupportedImageTypeError,
} from '@/shared/image-storage';
import { readResourceVersion } from '@/shared/resource-version';

import type { Static } from 'elysia';

import {
  createQuestV2,
  addQuestV2Images,
  checkQuestV2ImageUpload,
  deleteQuestV2Image,
  editQuestV2,
  getPublicQuestV2Detail,
  getQuestV2Detail,
  getQuestV2PublishCheck,
  listOwnQuestV2,
  listQuestBoardV2,
  materializeQuestV2PublicImageResponse,
  materializeQuestV2ImageResponse,
  publishQuestV2,
  questV2ImageRemoveRequestHash,
  questV2ImageUploadRequestHash,
  recordQuestV2ImageCleanupTombstones,
  recordQuestV2ImageCleanupRetry,
  releaseQuestV2ImageUploadReservation,
  QuestV2ImageCleanupUnavailableError,
} from './quest-v2.service';
import type {
  QuestV2ImageCommandContext,
  QuestV2ImageReference,
} from './quest-v2.service';
import type { QuestV2PublishCheck } from './quest-v2.publish.policy';
import { questV2Storage } from './quest.storage';
import type { StoredQuestImage } from './quest.storage';
import type {
  questV2CreateResponseSchema,
  questV2CreateSchema,
  questV2DetailResponseSchema,
  questV2EditHeadersSchema,
  questV2EditResponseSchema,
  questV2EditSchema,
  questV2ImageParamsSchema,
  questV2ImagesResponseSchema,
  questV2ImagesUploadSchema,
  questV2MineQuerySchema,
  questV2MineResponseSchema,
  questV2BoardQuerySchema,
  questV2BoardResponseSchema,
  questV2PublicDetailResponseSchema,
  questV2ParamsSchema,
  questV2PublishCheckResponseSchema,
  questV2PublishResponseSchema,
  questV2WriteHeadersSchema,
} from './quest-v2.schema';

type QuestV2CreateResponse = Static<typeof questV2CreateResponseSchema>['data'];
type QuestV2CreateInput = Static<typeof questV2CreateSchema>;
type QuestV2EditResponse = Static<typeof questV2EditResponseSchema>['data'];
type QuestV2EditInput = Static<typeof questV2EditSchema>;
type QuestV2MineQuery = Static<typeof questV2MineQuerySchema>;
type QuestV2MineResponse = Static<typeof questV2MineResponseSchema>['data'];
type QuestV2BoardQuery = Static<typeof questV2BoardQuerySchema>;
type QuestV2BoardResponse = Static<typeof questV2BoardResponseSchema>['data'];
type QuestV2Params = Static<typeof questV2ParamsSchema>;
type QuestV2WriteHeaders = Static<typeof questV2WriteHeadersSchema>;
type QuestV2EditHeaders = Static<typeof questV2EditHeadersSchema>;
type QuestV2DetailResponse = Static<typeof questV2DetailResponseSchema>['data'];
type QuestV2PublicDetailResponse = Static<typeof questV2PublicDetailResponseSchema>['data'];
type QuestV2PublishCheckResponse = Static<typeof questV2PublishCheckResponseSchema>['data'];
type QuestV2PublishResponse = Static<typeof questV2PublishResponseSchema>['data'];
type QuestV2ImagesResponse = Static<typeof questV2ImagesResponseSchema>['data'];
type QuestV2ImagesUploadInput = Static<typeof questV2ImagesUploadSchema>;
type QuestV2ImageParams = Static<typeof questV2ImageParamsSchema>;

const invalidInput = (set: AuthedContext['set'], code: string, message: string) => {
  set.status = 400;
  return apiError(code, message);
};

const compensateQuestV2ImageUpload = async (
  context: QuestV2ImageCommandContext,
  images: StoredQuestImage[],
): Promise<void> => {
  const pendingCleanup: StoredQuestImage[] = [];
  await Promise.all(
    images.map(async (image) => {
      try {
        await questV2Storage.delete(image.bucket, image.objectKey);
      } catch (error) {
        pendingCleanup.push(image);
        console.error('[quest-v2-image-upload] Compensating object deletion failed', {
          bucket: image.bucket,
          error,
          objectKey: image.objectKey,
        });
      }
    }),
  );

  const cleanupRecordedAt = new Date();
  if (pendingCleanup.length > 0) {
    try {
      await recordQuestV2ImageCleanupTombstones(
        context.userId,
        pendingCleanup,
        cleanupRecordedAt,
      );
    } catch (error) {
      await recordQuestV2ImageCleanupRetry(context, pendingCleanup, cleanupRecordedAt);
      throw new QuestV2ImageCleanupUnavailableError(error);
    }
  }

  try {
    await releaseQuestV2ImageUploadReservation(context);
  } catch (error) {
    console.error('[quest-v2-image-upload] Idempotency reservation release failed', {
      error,
      key: context.key,
      requestHash: context.requestHash,
      userId: context.userId,
    });
  }
};

const serializeQuestV2Images = (
  set: AuthedContext['set'],
  images: QuestV2ImageReference[],
): QuestV2ImagesResponse['images'] | ReturnType<typeof apiError> => {
  try {
    return materializeQuestV2ImageResponse(images);
  } catch (error) {
    if (!(error instanceof ImageLinkUnavailableError)) throw error;

    set.status = 503;
    return apiError(
      'QUEST_IMAGE_STORAGE_UNAVAILABLE',
      'Quest Image storage is unavailable',
    );
  }
};

type IdempotencyOutcome =
  | 'invalid-idempotency-key'
  | 'idempotency-key-reused'
  | 'idempotency-in-progress'
  | 'idempotency-unavailable';

const mapIdempotencyOutcome = (
  set: AuthedContext['set'],
  outcome: IdempotencyOutcome,
  inProgressMessage: string,
): ReturnType<typeof apiError> => {
  if (outcome === 'idempotency-key-reused') {
    set.status = 409;
    return apiError('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request');
  }
  if (outcome === 'idempotency-in-progress') {
    set.status = 409;
    return apiError('IDEMPOTENCY_IN_PROGRESS', inProgressMessage);
  }
  if (outcome === 'idempotency-unavailable') {
    set.status = 503;
    return apiError('IDEMPOTENCY_UNAVAILABLE', 'Idempotency record is unavailable');
  }

  return invalidInput(set, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency key must not be empty');
};

const mapQuestV2ImageMutationOutcome = (
  set: AuthedContext['set'],
  outcome:
    | 'invalid-idempotency-key'
    | 'not-found'
    | 'not-draft'
    | 'limit-reached'
    | 'idempotency-key-reused'
    | 'idempotency-in-progress'
    | 'idempotency-unavailable',
) => {
  if (outcome === 'not-found') {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest not found');
  }
  if (outcome === 'not-draft') {
    set.status = 409;
    return apiError('QUEST_NOT_DRAFT', 'Only Draft Quests can be changed');
  }
  if (outcome === 'limit-reached') {
    set.status = 409;
    return apiError('QUEST_IMAGE_LIMIT_REACHED', 'A Quest can have at most 3 images');
  }

  return mapIdempotencyOutcome(
    set,
    outcome,
    'A Quest Image operation is still processing',
  );
};

const mapQuestV2ImageStorageError = (set: AuthedContext['set'], error: unknown) => {
  if (error instanceof ImageTooLargeError) {
    set.status = 413;
    return apiError('IMAGE_TOO_LARGE', error.message);
  }
  if (error instanceof UnsupportedImageTypeError) {
    set.status = 415;
    return apiError('UNSUPPORTED_IMAGE_TYPE', error.message);
  }
  if (error instanceof ImageUploadError) {
    set.status = 503;
    return apiError('QUEST_IMAGE_STORAGE_UNAVAILABLE', 'Quest Image storage is unavailable');
  }
  if (error instanceof ImageLinkUnavailableError || error instanceof QuestV2ImageCleanupUnavailableError) {
    set.status = 503;
    return apiError('QUEST_IMAGE_STORAGE_UNAVAILABLE', 'Quest Image storage is unavailable');
  }

  return undefined;
};

const compensateQuestV2ImageUploadOrError = async (
  set: AuthedContext['set'],
  context: QuestV2ImageCommandContext,
  images: StoredQuestImage[],
): Promise<ReturnType<typeof apiError> | undefined> => {
  try {
    await compensateQuestV2ImageUpload(context, images);
  } catch (error) {
    const mapped = mapQuestV2ImageStorageError(set, error);
    if (mapped) return mapped;
    throw error;
  }

  return undefined;
};

const toQuestV2PublishCheckResponse = (
  result: QuestV2PublishCheck,
): QuestV2PublishCheckResponse => ({
  ...result,
  questFundingTotal: toBaht(result.questFundingTotalSatang),
  questReward: toBaht(result.questRewardSatang),
  platformFee: toBaht(result.platformFeeSatang),
  escrowRequirement: toBaht(result.escrowRequirementSatang),
});

const mapCreateOutcome = (
  set: AuthedContext['set'],
  outcome: Exclude<Awaited<ReturnType<typeof createQuestV2>>, { quest: unknown }>['outcome'],
) => {
  if (
    outcome === 'idempotency-key-reused' ||
    outcome === 'idempotency-in-progress' ||
    outcome === 'idempotency-unavailable' ||
    outcome === 'invalid-idempotency-key'
  ) {
    return mapIdempotencyOutcome(
      set,
      outcome,
      'A Quest with this idempotency key is still processing',
    );
  }
  if (outcome === 'tag-not-found') return invalidInput(set, 'TAG_NOT_FOUND', 'Tag not found');
  if (outcome === 'invalid-dates') {
    return invalidInput(set, 'INVALID_QUEST_DATES', 'dueAt must be after startTime');
  }
  if (outcome === 'invalid-headcount') {
    return invalidInput(
      set,
      'INVALID_HEADCOUNT',
      'SINGLE participation requires headcount 1 and GROUP participation requires headcount 2 to 20',
    );
  }
  if (outcome === 'invalid-funding') {
    return invalidInput(
      set,
      'INVALID_QUEST_FUNDING_TOTAL',
      'questFundingTotal must use exact satang precision between 1 and 700000 Baht',
    );
  }
  if (outcome === 'invalid-title') {
    return invalidInput(set, 'INVALID_TITLE', 'title must contain 1 to 120 characters');
  }
  if (outcome === 'invalid-description') {
    return invalidInput(set, 'INVALID_DESCRIPTION', 'description must contain at most 1000 characters');
  }
  if (outcome === 'invalid-location') {
    return invalidInput(set, 'INVALID_LOCATIONS', 'locations must contain at most 10 labels');
  }

  return invalidInput(set, 'INVALID_CONDITION', 'At least one valid Condition Item is required');
};

const mapEditOutcome = (
  set: AuthedContext['set'],
  outcome: Exclude<Awaited<ReturnType<typeof editQuestV2>>, { quest: unknown }>['outcome'],
) => {
  if (
    outcome === 'idempotency-key-reused' ||
    outcome === 'idempotency-in-progress' ||
    outcome === 'idempotency-unavailable' ||
    outcome === 'invalid-idempotency-key'
  ) {
    return mapIdempotencyOutcome(
      set,
      outcome,
      'A Quest edit with this idempotency key is still processing',
    );
  }
  if (outcome === 'not-found') {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest not found');
  }
  if (outcome === 'not-draft') {
    set.status = 409;
    return apiError('QUEST_NOT_DRAFT', 'Only Draft Quests can be edited');
  }
  if (outcome === 'conflict') {
    set.status = 409;
    return apiError('QUEST_EDIT_CONFLICT', 'The Draft was changed by another request');
  }
  if (outcome === 'tag-not-found') return invalidInput(set, 'TAG_NOT_FOUND', 'Tag not found');
  if (outcome === 'invalid-dates') {
    return invalidInput(set, 'INVALID_QUEST_DATES', 'dueAt must be after startTime');
  }
  if (outcome === 'invalid-headcount') {
    return invalidInput(
      set,
      'INVALID_HEADCOUNT',
      'SINGLE participation requires headcount 1 and GROUP participation requires headcount 2 to 20',
    );
  }
  if (outcome === 'invalid-funding') {
    return invalidInput(
      set,
      'INVALID_QUEST_FUNDING_TOTAL',
      'questFundingTotal must use exact satang precision between 1 and 700000 Baht',
    );
  }
  if (outcome === 'invalid-version') {
    return invalidInput(set, 'INVALID_VERSION', 'If-Match must be a positive integer');
  }
  if (outcome === 'invalid-title') {
    return invalidInput(set, 'INVALID_TITLE', 'title must contain 1 to 120 characters');
  }
  if (outcome === 'invalid-description') {
    return invalidInput(set, 'INVALID_DESCRIPTION', 'description must contain at most 1000 characters');
  }
  if (outcome === 'invalid-location') {
    return invalidInput(set, 'INVALID_LOCATIONS', 'locations must contain at most 10 labels');
  }
  return invalidInput(set, 'INVALID_CONDITION', 'At least one valid Condition Item is required');
};

export const createQuestV2Controller = async ({
  body,
  headers,
  session,
  set,
}: AuthedContext & {
  body: QuestV2CreateInput;
  headers: QuestV2WriteHeaders;
}): Promise<ApiResponse<QuestV2CreateResponse>> => {
  const result = await createQuestV2(session.user.id, body, headers['idempotency-key']);
  if ('outcome' in result) return mapCreateOutcome(set, result.outcome);

  return apiSuccess(result.quest);
};

export const editQuestV2Controller = async ({
  body,
  headers,
  params,
  request,
  session,
  set,
}: AuthedContext & {
  body: QuestV2EditInput;
  headers: QuestV2EditHeaders;
  params: QuestV2Params;
}): Promise<ApiResponse<QuestV2EditResponse>> => {
  const versionHeader = readResourceVersion(request);
  if (versionHeader.invalid || versionHeader.value === undefined) {
    return invalidInput(set, 'INVALID_VERSION', 'If-Match must be a positive integer');
  }

  const result = await editQuestV2(
    session.user.id,
    params.questId,
    body,
    versionHeader.value,
    headers['idempotency-key'],
  );
  if ('outcome' in result) return mapEditOutcome(set, result.outcome);

  return apiSuccess(result.quest);
};

export const addQuestImagesV2Controller = async ({
  body,
  headers,
  params,
  session,
  set,
}: AuthedContext & {
  body: QuestV2ImagesUploadInput;
  headers: QuestV2WriteHeaders;
  params: QuestV2Params;
}): Promise<ApiResponse<QuestV2ImagesResponse>> => {
  const imageCommand: QuestV2ImageCommandContext = {
    userId: session.user.id,
    questId: params.questId,
    key: headers['idempotency-key'],
    requestHash: await questV2ImageUploadRequestHash(
      session.user.id,
      params.questId,
      body.images,
    ),
  };
  let uploadPlans: Array<ReturnType<typeof questV2Storage.prepareUpload>>;
  try {
    uploadPlans = body.images.map(() => questV2Storage.prepareUpload(session.user.id));
  } catch (error) {
    const mapped = mapQuestV2ImageStorageError(set, error);
    if (mapped) return mapped;
    throw error;
  }

  const preflight = await checkQuestV2ImageUpload(
    imageCommand,
    body.images.length,
    uploadPlans,
  );
  if ('outcome' in preflight) {
    return mapQuestV2ImageMutationOutcome(set, preflight.outcome);
  }

  if ('replay' in preflight) {
    return apiSuccess({ images: preflight.replay.images });
  }

  const uploaded: StoredQuestImage[] = [];
  let operationFailed = false;
  let operationError: unknown;
  let result: Awaited<ReturnType<typeof addQuestV2Images>> | undefined;

  try {
    for (const [index, image] of body.images.entries()) {
      uploaded.push(await questV2Storage.upload(session.user.id, image, uploadPlans[index]!));
    }
    result = await addQuestV2Images(imageCommand, uploaded);
  } catch (error) {
    operationFailed = true;
    operationError = error;
    if (error instanceof ImageUploadError && error.cleanupObject) {
      uploaded.push(error.cleanupObject);
    }
  }

  let shouldCompensate = operationFailed;
  if (result && ('outcome' in result || result.replayed)) shouldCompensate = true;
  if (shouldCompensate) {
    const compensationError = await compensateQuestV2ImageUploadOrError(
      set,
      imageCommand,
      uploaded,
    );
    if (compensationError) return compensationError;
  }

  if (operationFailed) {
    const mapped = mapQuestV2ImageStorageError(set, operationError);
    if (mapped) return mapped;
    throw operationError;
  }
  if (!result) throw new Error('Quest Image upload did not return a result');
  if ('outcome' in result) return mapQuestV2ImageMutationOutcome(set, result.outcome);

  return apiSuccess({ images: result.response });
};

export const deleteQuestImageV2Controller = async ({
  headers,
  params,
  session,
  set,
}: AuthedContext & {
  headers: QuestV2WriteHeaders;
  params: QuestV2ImageParams;
}): Promise<ApiResponse<QuestV2ImagesResponse>> => {
  const imageCommand: QuestV2ImageCommandContext = {
    userId: session.user.id,
    questId: params.questId,
    key: headers['idempotency-key'],
    requestHash: await questV2ImageRemoveRequestHash(
      session.user.id,
      params.questId,
      params.imageId,
    ),
  };
  let result: Awaited<ReturnType<typeof deleteQuestV2Image>>;
  try {
    result = await deleteQuestV2Image(imageCommand, params.imageId);
  } catch (error) {
    const mapped = mapQuestV2ImageStorageError(set, error);
    if (mapped) return mapped;
    throw error;
  }
  if ('outcome' in result) {
    return mapQuestV2ImageMutationOutcome(set, result.outcome);
  }

  return apiSuccess({ images: result.response });
};

const validateMineQuery = (query: QuestV2MineQuery, set: AuthedContext['set']) => {
  try {
    parsePageLimit(query.limit);
    decodeCursor(query.cursor);
  } catch (error) {
    if (error instanceof CursorInputError) return invalidInput(set, error.code, error.message);
    throw error;
  }

  return undefined;
};

const validateBoardQuery = (query: QuestV2BoardQuery, set: AuthedContext['set']) => {
  try {
    parsePageLimit(query.limit);
    decodeCursor(query.cursor);
  } catch (error) {
    if (error instanceof CursorInputError) return invalidInput(set, 'VALIDATION', error.message);
    throw error;
  }

  if (
    query.minQuestReward !== undefined &&
    query.maxQuestReward !== undefined &&
    query.minQuestReward > query.maxQuestReward
  ) {
    return invalidInput(
      set,
      'VALIDATION',
      'minQuestReward must be less than or equal to maxQuestReward',
    );
  }

  if (
    query.startFrom !== undefined &&
    query.startTo !== undefined &&
    new Date(query.startFrom) > new Date(query.startTo)
  ) {
    return invalidInput(set, 'VALIDATION', 'startFrom must be before or equal to startTo');
  }

  return undefined;
};

export const listOwnQuestV2Controller = async ({
  query,
  session,
  set,
}: AuthedContext & {
  query: QuestV2MineQuery;
}): Promise<ApiResponse<QuestV2MineResponse>> => {
  const validationError = validateMineQuery(query, set);
  if (validationError) return validationError;

  return apiSuccess(await listOwnQuestV2(session.user.id, query));
};

export const listQuestBoardV2Controller = async ({
  query,
  session,
  set,
}: AuthedContext & {
  query: QuestV2BoardQuery;
}): Promise<ApiResponse<QuestV2BoardResponse>> => {
  const validationError = validateBoardQuery(query, set);
  if (validationError) return validationError;

  return apiSuccess(await listQuestBoardV2(session.user.id, query));
};

export const getQuestV2DetailController = async ({
  params,
  session,
  set,
}: AuthedContext & {
  params: QuestV2Params;
}): Promise<ApiResponse<QuestV2DetailResponse>> => {
  const questDetail = await getQuestV2Detail(session.user.id, params.questId);
  if (!questDetail) {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest not found');
  }

  const images = serializeQuestV2Images(set, questDetail.images);
  if ('success' in images) return images;
  return apiSuccess({ ...questDetail, images });
};

export const getPublicQuestV2DetailController = async ({
  params,
  session,
  set,
}: AuthedContext & {
  params: QuestV2Params;
}): Promise<ApiResponse<QuestV2PublicDetailResponse>> => {
  const questDetail = await getPublicQuestV2Detail(session.user.id, params.questId);
  if (!questDetail) {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest not found');
  }

  let images: QuestV2PublicDetailResponse['images'];
  try {
    images = materializeQuestV2PublicImageResponse(questDetail.images);
  } catch (error) {
    if (!(error instanceof ImageLinkUnavailableError)) throw error;

    set.status = 503;
    return apiError(
      'QUEST_IMAGE_STORAGE_UNAVAILABLE',
      'Quest Image storage is unavailable',
    );
  }

  return apiSuccess({ ...questDetail, images });
};

export const getQuestV2PublishCheckController = async ({
  params,
  session,
  set,
}: AuthedContext & {
  params: QuestV2Params;
}): Promise<ApiResponse<QuestV2PublishCheckResponse>> => {
  let result: Awaited<ReturnType<typeof getQuestV2PublishCheck>>;
  try {
    result = await getQuestV2PublishCheck(session.user.id, params.questId);
  } catch (error) {
    if (error instanceof MoneyDomainError) {
      set.status = 503;
      return apiError('QUEST_ESCROW_UNAVAILABLE', 'Quest Escrow could not be evaluated');
    }
    throw error;
  }

  if (!result) {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest not found');
  }
  if ('outcome' in result) {
    set.status = 409;
    return apiError('QUEST_NOT_DRAFT', 'Only Draft Quests can be checked');
  }

  return apiSuccess(toQuestV2PublishCheckResponse(result));
};

const mapQuestV2PublishError = (set: AuthedContext['set'], error: MoneyDomainError) => {
  const clientCorrectableCodes = new Set([
    'AMOUNT_OUT_OF_RANGE',
    'INSUFFICIENT_SPENDING_BALANCE',
    'INVALID_WALLET_STATUS',
    'WALLET_NOT_ACTIVE',
  ]);
  if (clientCorrectableCodes.has(error.code)) {
    set.status = 409;
    return apiError(error.code, error.message);
  }

  set.status = 503;
  return apiError('QUEST_ESCROW_UNAVAILABLE', 'Quest Escrow could not be reserved');
};

export const publishQuestV2Controller = async ({
  headers,
  params,
  session,
  set,
}: AuthedContext & {
  headers: QuestV2WriteHeaders;
  params: QuestV2Params;
}): Promise<ApiResponse<QuestV2PublishResponse>> => {
  let result: Awaited<ReturnType<typeof publishQuestV2>>;
  try {
    result = await publishQuestV2(session.user.id, params.questId, headers['idempotency-key']);
  } catch (error) {
    if (error instanceof MoneyDomainError) return mapQuestV2PublishError(set, error);
    throw error;
  }

  if (!result) {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest not found');
  }
  if ('outcome' in result) {
    if (result.outcome === 'blocked') {
      const [firstReason] = result.check.blockingReasons;
      if (!firstReason) {
        throw new Error('Blocked Quest publish has no blocking reason');
      }
      set.status = 409;
      return apiError(firstReason.code, firstReason.message);
    }
    if (result.outcome === 'not-draft') {
      set.status = 409;
      return apiError('QUEST_NOT_DRAFT', 'Only Draft Quests can be published');
    }
    return mapIdempotencyOutcome(
      set,
      result.outcome,
      'A Quest publish with this idempotency key is still processing',
    );
  }

  return apiSuccess(result);
};
