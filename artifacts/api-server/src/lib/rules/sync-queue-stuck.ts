import type { Rule, RuleEvalResult } from "./types";

// Task #1857: field_work_sessions table was dropped as part of retiring the
// field-portal prototype. This rule previously counted stuck offline sync
// sessions from that table; it now always returns non-firing until a
// replacement queue source is added (see follow-up task).
export const syncQueueStuckRule: Rule = {
  id: "sync_queue_stuck",
  severity: "P3",
  async evaluate(): Promise<RuleEvalResult> {
    return {
      firing: false,
      summary: "Sync queue rule inactive (field portal retired)",
      affectedUsers: [],
      details: { stuck: 0, threshold: 5 },
    };
  },
};
