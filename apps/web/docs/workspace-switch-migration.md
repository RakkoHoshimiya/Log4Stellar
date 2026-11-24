# Workspace switching: release blocker

Status: development only. Do not deploy this branch over an existing Web
installation until old browser backups have a tested recovery path.

Older workbenches use `vscode-test-web://mount-<account>/` for the account's
then-default workspace. That URI does not record a workspace ID, and the default
can change when membership is revoked. Consequently the currently selected
workspace is not evidence of where an old unsaved draft came from.

This branch uses `mount-<account>.<workspace>` and refuses legacy and empty
authorities. A separate, non-destructive recovery flow must enumerate old backups
without exposing them as files of an arbitrarily selected workspace, allow the
user to export or explicitly place them, preserve the originals, and be tested
with changed membership, multiple accounts, cancelled restoration, and rollback.
No automatic write to the current default workspace is allowed.

The Web release must also pass browser tests for selection, dirty-editor saves,
account changes, revoked membership and cross-workspace same-path editing.
