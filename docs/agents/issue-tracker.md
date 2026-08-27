# Issue Tracker: GitHub

Issues and specs for this repository live as GitHub Issues. Use the `gh` CLI
for all issue operations.

## Repository

- Repository: `KUQuest/KUQuest-API-Server`
- Issues: enabled
- CLI: `gh`

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a
  heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, and include labels
  when the issue's triage state matters.
- **List issues**: `gh issue list --state open` with suitable label and state
  filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`.
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or
  `--remove-label "..."`.
- **Close an issue**: `gh issue close <number> --comment "..."`.

## Pull requests as a triage surface

**PRs as a request surface: no.** External PRs do not enter the issue triage
queue automatically. Pull requests remain implementation artifacts and must
link to their related GitHub Issue.

GitHub shares one number space across Issues and pull requests. Resolve a
number with `gh pr view <number>` first, then use `gh issue view <number>` when
it is not a pull request.

## When a skill says "publish to the issue tracker"

Create a GitHub Issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

The `/wayfinder` map is a single GitHub Issue with child Issues as tickets.

- **Map**: create one Issue labelled `wayfinder:map` with the Notes,
  Decisions-so-far, and Fog sections.
- **Child ticket**: link the child Issue as a GitHub sub-issue when supported.
  Otherwise, add `Part of #<map>` at the top of its body and keep a task list
  in the map body. Use `wayfinder:<type>` labels for `research`, `prototype`,
  `grilling`, or `task`.
- **Blocking**: use GitHub native Issue dependencies when available. If they
  are not available, add `Blocked by: #<n>, #<n>` at the top of the child body.
- **Claim**: assign the Issue to the current user with
  `gh issue edit <number> --add-assignee @me`.
- **Resolve**: comment the answer, close the Issue, and append a context
  pointer to the map's Decisions-so-far.
