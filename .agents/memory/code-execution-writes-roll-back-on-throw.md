---
name: A throwing CodeExecution block discards its own writes
description: Why file writes vanish when a later statement in the same block fails, and how to sequence blocks to avoid losing work.
---

# A throwing CodeExecution block discards its own writes

If any statement in a CodeExecution block throws, the `writeFile` calls earlier
in that same block do not survive. The file is left at its previous contents.

**Why:** The runtime is durable and replays blocks; a block that ends in an
exception is not committed. This is easy to misread as "the edit worked but my
verification command is broken", because the error message points at the last
statement — typically a `shellExec` `grep` whose quoting was wrong — not at the
write.

**How to apply:** Never end a block that performs writes with a fragile shell
command. Put `writeFile` calls in their own block, and do verification greps in
a separate call. After a block errors, assume nothing in it persisted and
re-check the file before re-applying — an edit you "already made" may be absent.
Quoting `\${...}` and backticks inside a `grep` pattern is the usual trigger;
prefer `grep -c` on a plain identifier, or read the file back instead.
