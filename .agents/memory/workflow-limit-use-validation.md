---
name: Workflow limit vs. per-suite test workflows
description: This project is past the 10-workflow cap, so register new test suites as validation commands instead.
---

`configureWorkflow` refuses with "Workflow limit exceeded (N/10)". This project
long ago passed that cap with one workflow per test suite plus the artifact
services, so **a new test suite cannot get its own workflow.**

Register it as a validation command instead:
`setValidationCommand({ name, command })` then
`startValidationRun({ commandIds: [...] })`. Same command string, no cap, and
the run returns per-command status without needing a log scrape.

**Why:** the alternative is deleting somebody else's test workflow to make
room, which silently removes a check that a past task deliberately installed.

**How to apply:** default to a validation command for any new test suite here.
Reserve workflows for long-running processes — artifact services already own
theirs and must be restarted with the workflow tool, never reconfigured.
