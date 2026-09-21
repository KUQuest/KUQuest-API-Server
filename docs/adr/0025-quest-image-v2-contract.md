# Define the Quest Image v2 contract

The v2 Quest Image gallery is a Quest-owned subresource, separate from Draft
creation and edit. It is optional and limited to three validated JPEG, PNG, or
WebP files of 5 MB or less; the Hirer can append or soft-delete images only
while the Quest is `QUEST_DRAFT`. Each write is idempotent and all-or-nothing,
reads use 15-minute temporary links, and the image set is immutable after
publish. This keeps file ownership and cleanup within the Quest boundary while
avoiding accidental replacement and permanent storage URL exposure.
