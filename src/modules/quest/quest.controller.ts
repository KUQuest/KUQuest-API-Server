import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';
import { CursorInputError, decodeCursor, parsePageLimit } from '@/shared/cursor';
import {
  ImageLinkUnavailableError,
  ImageTooLargeError,
  ImageUploadError,
  UnsupportedImageTypeError,
} from '@/shared/image-storage';

import type { Static } from 'elysia';

import type {
  questBoardResponseSchema,
  questCreateResponseSchema,
  questCreateSchema,
  questDetailResponseSchema,
  questImageParamsSchema,
  questImagesUploadResponseSchema,
  questImagesUploadSchema,
  questEditSchema,
  questListQuerySchema,
  questMineQuerySchema,
  questMineResponseSchema,
  questParamsSchema,
  questPublishCheckResponseSchema,
} from './quest.schema';
import {
  addQuestImages,
  checkQuestImageUpload,
  createQuest,
  deleteQuestImage,
  editQuest,
  getQuestDetail,
  getQuestPublishCheck,
  listBoardQuests,
  listOwnQuests,
  publishQuest,
} from './quest.service';
import type { QuestImage, QuestImageMutationOutcome } from './quest.service';
import { questStorage } from './quest.storage';
import type { StoredQuestImage } from './quest.storage';

type CreateResponse = Static<typeof questCreateResponseSchema>['data'];
type BoardResponse = Static<typeof questBoardResponseSchema>['data'];
type MineResponse = Static<typeof questMineResponseSchema>['data'];
type DetailResponse = Static<typeof questDetailResponseSchema>['data'];
type QuestImagesUploadResponse = Static<typeof questImagesUploadResponseSchema>['data'];
type CreateInput = Static<typeof questCreateSchema>;
type EditInput = Static<typeof questEditSchema>;
type QuestImagesUploadInput = Static<typeof questImagesUploadSchema>;
type ListQuery = Static<typeof questListQuerySchema>;
type MineQuery = Static<typeof questMineQuerySchema>;
type QuestParams = Static<typeof questParamsSchema>;
type PublishCheckResponse = Static<typeof questPublishCheckResponseSchema>['data'];
type QuestDetail = NonNullable<Awaited<ReturnType<typeof getQuestDetail>>>;

const invalidInput = (set: AuthedContext['set'], code: string, message: string) => {
  set.status = 400;
  return apiError(code, message);
};

const discardUploadedImages = async (images: StoredQuestImage[]): Promise<void> => {
  await Promise.all(
    images.map(async (image) => {
      try {
        await questStorage.delete(image.bucket, image.objectKey);
      } catch (error) {
        console.error('[quest-image-upload] Compensating object deletion failed', {
          bucket: image.bucket,
          error,
          objectKey: image.objectKey,
        });
      }
    }),
  );
};

const buildQuestImage = (
  image: QuestImage,
): QuestImagesUploadResponse['images'][number] => {
  try {
    return {
      fileId: image.fileId,
      position: image.position,
      url: questStorage.linkFor(image),
    };
  } catch (error) {
    console.error('Building the Quest Image link failed', error);

    throw new ImageLinkUnavailableError('Quest Image link generation failed', { cause: error });
  }
};

const serializeQuestImages = (images: QuestImage[]) => images.map(buildQuestImage);

const serializeQuestImagesOrError = (
  set: AuthedContext['set'],
  images: QuestImage[],
): QuestImagesUploadResponse['images'] | ReturnType<typeof apiError> => {
  try {
    return serializeQuestImages(images);
  } catch (error) {
    if (error instanceof ImageLinkUnavailableError) {
      set.status = 502;
      return apiError('IMAGE_LINK_FAILED', 'Image link generation failed');
    }

    throw error;
  }
};

const mapImageUploadError = (set: AuthedContext['set'], error: unknown) => {
  if (error instanceof ImageTooLargeError) {
    set.status = 413;
    return apiError('IMAGE_TOO_LARGE', error.message);
  }
  if (error instanceof UnsupportedImageTypeError) {
    set.status = 415;
    return apiError('UNSUPPORTED_IMAGE_TYPE', error.message);
  }
  if (error instanceof ImageUploadError) {
    set.status = 502;
    return apiError('IMAGE_UPLOAD_FAILED', 'Image upload failed');
  }

  return undefined;
};

const mapQuestImageMutationOutcome = (
  set: AuthedContext['set'],
  outcome: QuestImageMutationOutcome,
) => {
  if (outcome.outcome === 'not-found') {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest not found');
  }
  if (outcome.outcome === 'not-editable') {
    set.status = 409;
    return apiError('QUEST_NOT_EDITABLE', 'Only Draft Quests can be edited');
  }

  set.status = 409;
  return apiError('QUEST_IMAGE_LIMIT_REACHED', 'A Quest can have at most 3 images');
};

const questNotFound = (set: AuthedContext['set']) => {
  set.status = 404;
  return apiError('QUEST_NOT_FOUND', 'Quest not found');
};

const mapQuestEditOutcome = (
  set: AuthedContext['set'],
  outcome: Exclude<Awaited<ReturnType<typeof editQuest>>, { id: string }>['outcome'],
) => {
  if (outcome === 'not-found') return questNotFound(set);

  if (outcome === 'requires-consent') {
    set.status = 409;
    return apiError(
      'QUEST_EDIT_REQUIRES_CONSENT',
      'Quest edits require consent after participation starts',
    );
  }

  if (outcome === 'not-editable') {
    set.status = 409;
    return apiError('QUEST_NOT_EDITABLE', 'Only an eligible OPEN Quest can be edited');
  }

  if (outcome === 'invalid-dates') {
    set.status = 400;
    return apiError('INVALID_QUEST_DATES', 'dueAt must be after startTime');
  }

  if (outcome === 'tag-not-found') {
    set.status = 400;
    return apiError('TAG_NOT_FOUND', 'Tag not found');
  }

  if (outcome === 'tag-required') {
    set.status = 400;
    return apiError('TAG_REQUIRED', 'An OPEN Quest must have a Tag');
  }

  set.status = 400;
  return apiError('EMPTY_QUEST_EDIT', 'At least one Quest field must be supplied');
};

const toFilters = (query: ListQuery) => ({
  ...query,
  startFrom: query.startFrom ? new Date(query.startFrom) : undefined,
  startTo: query.startTo ? new Date(query.startTo) : undefined,
});

const validateListQuery = (query: ListQuery, set: AuthedContext['set']) => {
  if ((query.latitude === undefined) !== (query.longitude === undefined)) {
    return invalidInput(set, 'INVALID_COORDINATES', 'latitude and longitude must be supplied together');
  }

  try {
    parsePageLimit(query.limit);
    decodeCursor(query.cursor);
  } catch (error) {
    if (error instanceof CursorInputError) return invalidInput(set, error.code, error.message);
    throw error;
  }

  return undefined;
};

const validateMineQuery = (query: MineQuery, set: AuthedContext['set']) => {
  try {
    parsePageLimit(query.limit);
    decodeCursor(query.cursor);
  } catch (error) {
    if (error instanceof CursorInputError) return invalidInput(set, error.code, error.message);
    throw error;
  }

  return undefined;
};

const serializeQuestDetailResponse = (
  set: AuthedContext['set'],
  questDetail: QuestDetail,
): ApiResponse<DetailResponse> => {
  const images = serializeQuestImagesOrError(set, questDetail.images);
  if ('success' in images) return images;

  return apiSuccess({ ...questDetail, images });
};

export const createQuestController = async ({
  body,
  session,
  set,
}: AuthedContext & { body: CreateInput }): Promise<ApiResponse<CreateResponse>> => {
  const result = await createQuest(session.user.id, body);

  if ('outcome' in result) {
    if (result.outcome === 'tag-not-found') {
      return invalidInput(set, 'TAG_NOT_FOUND', 'Tag not found');
    }
    if (result.outcome === 'invalid-dates') {
      return invalidInput(set, 'INVALID_QUEST_DATES', 'dueAt must be after startTime');
    }

    return invalidInput(set, 'INVALID_HEADCOUNT', 'SINGLE participation requires headcount 1');
  }

  return apiSuccess(result);
};

export const addQuestImagesController = async ({
  body,
  params,
  session,
  set,
}: AuthedContext & {
  body: QuestImagesUploadInput;
  params: QuestParams;
}): Promise<ApiResponse<QuestImagesUploadResponse>> => {
  const uploadCheck = await checkQuestImageUpload(
    session.user.id,
    params.questId,
    body.images.length,
  );
  if (uploadCheck) return mapQuestImageMutationOutcome(set, uploadCheck);

  const uploaded: StoredQuestImage[] = [];

  try {
    for (const image of body.images) {
      uploaded.push(await questStorage.upload(session.user.id, image));
    }
  } catch (error) {
    await discardUploadedImages(uploaded);
    const mapped = mapImageUploadError(set, error);
    if (mapped) return mapped;
    throw error;
  }

  let result: Awaited<ReturnType<typeof addQuestImages>>;
  try {
    result = await addQuestImages(session.user.id, params.questId, uploaded);
  } catch (error) {
    await discardUploadedImages(uploaded);
    throw error;
  }
  if ('outcome' in result) {
    await discardUploadedImages(uploaded);
    return mapQuestImageMutationOutcome(set, result);
  }

  const images = serializeQuestImagesOrError(set, result.images);
  if ('success' in images) return images;

  return apiSuccess({ images });
};

export const deleteQuestImageController = async ({
  params,
  session,
  set,
}: AuthedContext & {
  params: Static<typeof questImageParamsSchema>;
}): Promise<ApiResponse> => {
  const result = await deleteQuestImage(session.user.id, params.questId, params.imageId);

  if (result.outcome !== 'deleted') {
    return mapQuestImageMutationOutcome(set, result);
  }

  try {
    await questStorage.delete(result.bucket, result.objectKey);
  } catch (error) {
    console.error('[quest-image-delete] Object deletion failed', {
      bucket: result.bucket,
      error,
      objectKey: result.objectKey,
    });
  }

  return apiSuccess();
};

export const listBoardQuestsController = async ({
  query,
  set,
}: AuthedContext & { query: ListQuery }): Promise<ApiResponse<BoardResponse>> => {
  const invalid = validateListQuery(query, set);
  if (invalid) return invalid;

  return apiSuccess(await listBoardQuests(toFilters(query)));
};

export const listOwnQuestsController = async ({
  query,
  session,
  set,
}: AuthedContext & { query: MineQuery }): Promise<ApiResponse<MineResponse>> => {
  const invalid = validateMineQuery(query, set);
  if (invalid) return invalid;

  return apiSuccess(await listOwnQuests(session.user.id, query));
};

export const getQuestDetailController = async ({
  params,
  session,
  set,
}: AuthedContext & { params: QuestParams }): Promise<ApiResponse<DetailResponse>> => {
  const questDetail = await getQuestDetail(session.user.id, params.questId);
  if (!questDetail) return questNotFound(set);

  return serializeQuestDetailResponse(set, questDetail);
};

export const editQuestController = async ({
  body,
  params,
  session,
  set,
}: AuthedContext & {
  body: EditInput;
  params: QuestParams;
}): Promise<ApiResponse<DetailResponse>> => {
  const result = await editQuest(session.user.id, params.questId, body);
  if ('outcome' in result) return mapQuestEditOutcome(set, result.outcome);

  const questDetail = await getQuestDetail(session.user.id, result.id);
  if (!questDetail) return questNotFound(set);

  return serializeQuestDetailResponse(set, questDetail);
};

const notDraft = (set: AuthedContext['set']) => {
  set.status = 409;
  return apiError('QUEST_NOT_DRAFT', 'Only Draft Quests can be published');
};

export const getQuestPublishCheckController = async ({
  params,
  session,
  set,
}: AuthedContext & { params: QuestParams }): Promise<ApiResponse<PublishCheckResponse>> => {
  const result = await getQuestPublishCheck(session.user.id, params.questId);
  if (!result) {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest not found');
  }
  if ('outcome' in result) return notDraft(set);

  return apiSuccess(result);
};

export const publishQuestController = async ({
  params,
  session,
  set,
}: AuthedContext & { params: QuestParams }): Promise<ApiResponse> => {
  const result = await publishQuest(session.user.id, params.questId);
  if (!result) {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest not found');
  }
  if (result.outcome === 'not-draft') return notDraft(set);
  if (result.outcome === 'blocked') {
    const [firstReason] = result.check.blockingReasons;
    set.status = 409;
    return apiError(firstReason.code, firstReason.message);
  }

  return apiSuccess();
};
