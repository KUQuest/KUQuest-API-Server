# `main` is the stable release branch

`develop` is the integration branch and `main` is the stable release branch. Every Pull Request that changes application code targets `develop`. Backend CI runs on it, and Backend Staging CD builds and deploys each `develop` commit that passes CI, publishing `ghcr.io/kuquest/kuquest-api-server:<sha>`. `main` holds only commits that a person promoted after the same image passed UAT, so a commit on `main` means: built once, run on Staging, signed off on UAT.

Promotion is manual and happens in this order. First, the commit passes Backend CI and Staging CD on `develop`. Second, a reviewer dispatches `Backend UAT CD` with that exact `image_sha` and tests it on UAT. Third, after sign-off, a Pull Request from `develop` into `main` brings in that commit and nothing newer: the Pull Request head is the signed-off commit, not the moving tip of `develop`. Fourth, a release tag `vMAJOR.MINOR.PATCH` is created on the merge commit on `main`. UAT never builds an image and never deploys on a merge to either branch; the tag and the image `<sha>` name the same release.

Workflow files are the one exception to the promotion order. GitHub reads `on: workflow_run` and `workflow_dispatch` workflows only from the default branch, so a workflow change under `.github/workflows/` goes in its own Pull Request with base `main` and contains only workflow files (see `AGENTS.md`). Such a Pull Request does not mark any application commit as stable. Because `main` and `develop` then differ only in workflow files, the next promotion merges `main` into `develop` first, so a promotion Pull Request never replaces a live workflow with an older copy.

GitHub branch protection cannot restrict which branch a Pull Request comes from, so "only the signed-off `develop` commit, or a workflow-only fix, reaches `main`" is a team rule enforced by review. `main` keeps its current protection: the `validate` check and one approving review.

Two alternatives lost. Deploying UAT automatically on a merge to `main` removes the reviewer approval and runs migrations against a database that holds tester data, and image rollback does not roll the schema back. Tagging `develop` commits directly leaves no branch that answers "what is stable?" without reading tags.

The first promotion needs a one-time sync. At the time of this decision `develop` is 587 commits ahead of `main`, and `main` holds 30 workflow-only commits that `develop` lacks. After the first UAT sign-off, merge `main` into `develop`, then promote the signed-off commit and tag it `v0.1.0`.
