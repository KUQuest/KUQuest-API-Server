# End a Quest when proof is not approved

When a Hirer does not approve a Proof Submission, the work is unsuccessful and
the Quest ends immediately. The Quest uses a distinct terminal
`QUEST_FAILED` status instead of `QUEST_CANCELLED`, because
cancellation means the Quest was stopped while failure means the submitted work
did not pass review; no Rework or further Proof Submission is allowed. The
system also creates one `Admin Review Item` and notifies Admin automatically so
the failed decision can be reviewed without delaying or reopening the Quest.
The Hirer and eligible Workers may still create a Review after the Quest becomes
`QUEST_FAILED`; the Review does not change the failure or the Admin Review Item.

A Worker whose Proof Submission was approved before another Worker caused the Quest to fail keeps the Quest Reward. This also applies when the failure comes from missing required proof at `dueAt`. A Worker whose work was not approved or not submitted receives no Quest Reward.

Status: accepted.
