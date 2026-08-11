---
name: Validation run resource exhaustion
description: Parallel validation runs can fail with spawn EAGAIN / uv_thread_create / pino ERR_WORKER_INIT_FAILED — transient, not real test failures.
---

The full validation run executes ~19 suites concurrently and can exhaust process/thread limits. Symptoms: `spawn ... EAGAIN` from vitest's tinypool, `uv_thread_create` assertion, or pino's `ERR_WORKER_INIT_FAILED` in api-server tests.

**Why:** container thread/process limits, not the code under test — the same suite passes when run alone.

**How to apply:** when a validation failure's log shows one of these signatures, rerun the single suite in the shell to confirm it passes, then just call markTaskComplete again; do not "fix" the test.
