---
name: Validation run thread/PID exhaustion
description: Parallel completion validation dies with EAGAIN / pthread_create / ERR_WORKER_INIT_FAILED. Retry ONCE; if every run fails, it is a hard ceiling — skip validation instead.
---

Completion validation runs every registered command **concurrently**. Symptoms of exhaustion:
`Error: EAGAIN`, `pthread_create: Resource temporarily unavailable`, `uv_thread_create`,
tinypool `Worker exited unexpectedly`, pino `ERR_WORKER_INIT_FAILED`.

These are never assertion failures. Confirm by reading the inspect log: if there is no
assertion error, the code under test is not what broke.

**Why:** the container has a hard cgroup process cap — `/sys/fs/cgroup/pids.max` is **1024**
(~309 PIDs in use at idle). Each vitest suite spawns pnpm + node + a tinypool of workers, and
each Node process claims ~10 platform threads. Past ~20 concurrent commands the run races for
the last few PIDs. CPU (8 cores) and RAM (16 GB) are NOT the constraint — only PIDs are.

**How to apply — and when to STOP:**
1. Re-run the affected suites **serially** in the shell to prove the diff is green:
   `npx vitest run <file> --pool=forks --poolOptions.forks.singleFork` (one file per command).
2. Retry `markTaskComplete` **once**. A single transient flake usually clears.
3. **Stop condition — this is the part that matters.** If consecutive runs all fail *and the
   failing subset is different each time*, it is the PID ceiling, not a flake. Retrying can
   never converge, because every retry re-launches the same over-subscribed fan-out. Do not
   keep retrying: each attempt costs the user real money. Escalate to `markTaskComplete` with
   a `skip_validation_reason` documenting the cap, the shifting failure set, the absence of
   assertion errors, and the serial runs that passed.

A shifting failure set with zero assertion errors is the fingerprint. Read it early.
