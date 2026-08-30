# Quest Image Contract

Part of the [Quest and Work Chat Rulebook](quest-work-chat-rulebook.md). Defines accepted policy for v2 Quest Images, draft management, storage, validation, and temporary access URLs.

## Upload and deletion scope

- Quest Images are optional. A Quest with zero images may publish.
- The v2 Hirer endpoints are:
  - `POST /api/v2/quests/:questId/images` with a multipart `images` field.
  - `DELETE /api/v2/quests/:questId/images/:imageId`.
- Only the Quest's Hirer may upload or remove its images, and both operations are allowed only while the Quest is `QUEST_DRAFT`. A file from another Member or another Quest cannot be attached.
- After publish, Quest Images are immutable.

## Batch rules and ordering

- A Quest has zero to three Quest Images.
- An upload appends images in request order. The complete batch is rejected if it would exceed three images.
- Replacement is explicit: remove the old image, then upload the new image.
- Removing an image repacks the remaining positions from `0` without changing their relative order.
- Each successful upload or remove returns the complete current ordered `images` array (`imageId`, `fileId`, `position`, `url`, `urlExpiresAt`).

## Validation and storage

- A Quest Image is a valid JPEG, PNG, or WebP file of at most 5 MB.
- The Server checks the decoded file content and actual byte size; it does not trust a filename or client-declared `Content-Type` alone.
- Every v2 image write requires `Idempotency-Key`. Retries replay the original response; reuse with a different request returns `409 IDEMPOTENCY_KEY_REUSED`.
- The Server validates the full upload batch before attaching any file. If a validation or storage operation fails, no attachment commits and uploaded objects are cleaned up (503 `QUEST_IMAGE_STORAGE_UNAVAILABLE`).
- Removing an image soft-deletes its file metadata immediately.

## Visibility and URLs

- The API never returns a permanent storage URL. Each temporary link is valid for 15 minutes.
- Hirer reads show Draft images; Worker and public reads follow Quest detail visibility and do not expose Draft images.
- Quest Images are not shown on the Quest Board card.
