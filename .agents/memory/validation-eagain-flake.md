---
name: Validation-run EAGAIN flakes
description: Completion validation runs many suites in parallel and can exhaust threads.
---

The rule: a completion-validation failure whose log shows `Error: EAGAIN`, `ERR_WORKER_INIT_FAILED`, or a tinypool "Worker exited unexpectedly" native crash is resource exhaustion, not a test failure.

**Why:** validation runs every registered command concurrently; Node worker-thread creation fails under that fan-out (seen 2026-08-11 — both "failed" suites passed cleanly when run alone).

**How to apply:** check the inspect log for those signatures first; if present and the suite passes locally, re-call `markTaskComplete` without changing code.
