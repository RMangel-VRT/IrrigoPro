import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Eye, Server, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { apiRequest } from "@/lib/queryClient";
import { MigrationStatusBadge } from "@/components/admin/MigrationStatusBadge";
import { MigrationRunner } from "@/components/admin/MigrationRunner";
import type {
  MigrationListItem,
  MigrationPreview,
  MigrationProgress,
  MigrationTarget,
} from "@/types/migrations";

// Task #1982 — the migrations page must name the database it is acting on, so
// a production repair can never be mistaken for a dev one. Shared by the page
// header and the run dialog.
export function useMigrationTarget() {
  return useQuery<MigrationTarget>({
    queryKey: ["/api/admin/migrations", "environment"],
    queryFn: async () => {
      return await apiRequest("/api/admin/migrations/environment", "GET");
    },
  });
}

export function TargetBanner({ target }: { target?: MigrationTarget }) {
  if (!target) return null;
  const isProd = target.environment === "production" || target.deployment;
  return (
    <div
      data-testid="migration-target"
      className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs ${
        isProd
          ? "bg-red-50 border-red-300 text-red-800"
          : "bg-gray-50 border-gray-200 text-gray-700"
      }`}
    >
      <Server className="w-3.5 h-3.5 shrink-0" />
      <span>
        Acting on <span className="font-semibold uppercase">{target.environment}</span>
        {" · "}
        database <span className="font-mono">{target.database}</span>
        {" on "}
        <span className="font-mono">{target.host}</span>
      </span>
    </div>
  );
}

function useCurrentUser() {
  const raw = localStorage.getItem("user");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function PreviewModal({
  migrationId,
  onClose,
}: {
  migrationId: string;
  onClose: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [lastProgress, setLastProgress] = useState<MigrationProgress | null>(null);
  const queryClient = useQueryClient();
  const { data: target } = useMigrationTarget();

  const { data: preview, isLoading, error } = useQuery<MigrationPreview>({
    queryKey: ["/api/admin/migrations", migrationId, "preview"],
    queryFn: async () => {
      return await apiRequest(`/api/admin/migrations/${migrationId}/preview`, "GET");
    },
  });

  const hasOrphans = preview
    ? Object.values(preview.orphanRows).some((n) => n > 0)
    : false;
  const hasWarnings = (preview?.warnings?.length ?? 0) > 0;

  const canRun = (!hasOrphans && !hasWarnings) || acknowledged;

  // Task #1982 — the app sets `staleTime: Infinity` globally, so neither the
  // preview nor the migration list ever refreshes on its own. Without these
  // invalidations the counts beside a finished run are the ones fetched
  // *before* it ran — which is exactly how a green banner ended up next to
  // "14 missing". Invalidate explicitly so the numbers on screen are post-run.
  function handleRunComplete(prog: MigrationProgress) {
    setLastProgress(prog);
    setRunOpen(false);
    void queryClient.invalidateQueries({
      queryKey: ["/api/admin/migrations", migrationId, "preview"],
    });
    void queryClient.invalidateQueries({ queryKey: ["/api/admin/migrations"], exact: true });
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Migration Preview</DialogTitle>
        </DialogHeader>

        <TargetBanner target={target} />

        {isLoading && (
          <div className="py-8 text-center text-gray-500 text-sm">Loading preview…</div>
        )}

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            Failed to load preview.
          </div>
        )}

        {/*
          When a refetch fails React Query keeps the last successful data, so
          the counts below would silently be the pre-run ones. Numbers that
          cannot be re-read must not be shown at all — that ambiguity is the
          whole incident.
        */}

        {preview && (
          <div className="space-y-4">
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Steps</p>
              <ol className="space-y-1.5">
                {preview.steps.map((step, i) => (
                  <li key={step.id} className="flex gap-2 text-sm text-gray-700">
                    <span className="shrink-0 font-mono text-gray-400">{i + 1}.</span>
                    {step.description}
                  </li>
                ))}
              </ol>
            </div>

            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Orphan row counts</p>
              {error ? (
                <p className="text-sm text-red-700">
                  These counts could not be re-read, so the numbers from before are not shown.
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  {Object.entries(preview.orphanRows).map(([tbl, n]) => (
                    <div key={tbl} className="flex justify-between gap-2">
                      <span className="font-mono text-gray-600">{tbl}</span>
                      <span className={n > 0 ? "text-red-600 font-semibold" : "text-green-700"}>{n}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {(hasOrphans || preview.warnings.length > 0) && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg space-y-1.5">
                {preview.warnings.map((w, i) => (
                  <p key={i} className="text-sm text-red-700">{w}</p>
                ))}
                <label className="flex items-start gap-2 mt-2 cursor-pointer">
                  <Checkbox
                    checked={acknowledged}
                    onCheckedChange={(v) => setAcknowledged(Boolean(v))}
                    className="mt-0.5"
                  />
                  <span className="text-sm text-red-700">
                    I understand the risks described above and wish to proceed.
                  </span>
                </label>
              </div>
            )}

            {lastProgress && (
              <div
                data-testid="migration-last-run"
                className={`p-3 rounded-lg border text-sm ${
                  lastProgress.state === "succeeded"
                    ? "bg-green-50 border-green-200 text-green-700"
                    : lastProgress.state === "mismatched"
                      ? "bg-amber-50 border-2 border-amber-500 text-amber-900"
                      : "bg-red-50 border-red-200 text-red-700"
                }`}
              >
                <p>Last run: {lastProgress.state}{lastProgress.finishedAt && ` at ${new Date(lastProgress.finishedAt).toLocaleTimeString()}`}</p>
                {/* The post-run re-read, not the run's own report. */}
                {lastProgress.postRun && (
                  <p className="text-xs mt-1 opacity-80">
                    Verified against the database after the run: status{" "}
                    {lastProgress.postRun.status.state.replace(/_/g, " ")}.
                  </p>
                )}
                {lastProgress.state === "mismatched" && lastProgress.mismatch && (
                  <p className="text-xs mt-1 font-semibold">{lastProgress.mismatch.details}</p>
                )}
                {lastProgress.state !== "succeeded" && lastProgress.errorMessage && (
                  <p className="text-xs mt-1 opacity-80">{lastProgress.errorMessage}</p>
                )}
                {lastProgress.state !== "succeeded" && lastProgress.steps.some((s) => s.status === "failed" && s.error) && (
                  <p className="text-xs mt-1 opacity-80">
                    {lastProgress.steps.find((s) => s.status === "failed")?.error}
                  </p>
                )}
              </div>
            )}

            {!runOpen ? (
              <Button
                onClick={() => setRunOpen(true)}
                disabled={!canRun}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
              >
                Run Migration
              </Button>
            ) : (
              <MigrationRunner
                migrationId={migrationId}
                acknowledged={acknowledged}
                onComplete={handleRunComplete}
              />
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function AdminMigrationsPage() {
  const [, navigate] = useLocation();
  const user = useCurrentUser();
  const [previewFor, setPreviewFor] = useState<string | null>(null);

  if (!user || user.role !== "super_admin") {
    navigate("/", { replace: true });
    return null;
  }

  const { data: target } = useMigrationTarget();

  const { data: migrations = [], isLoading, error, refetch } = useQuery<MigrationListItem[]>({
    queryKey: ["/api/admin/migrations"],
    queryFn: async () => {
      return await apiRequest("/api/admin/migrations", "GET");
    },
    refetchInterval: 30_000,
  });

  return (
    <div className="max-w-3xl mx-auto py-8 px-4 space-y-6">
      <div className="flex items-center gap-3">
        <Database className="w-6 h-6 text-gray-600" />
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Database Migrations</h1>
          <p className="text-sm text-gray-500">Managed schema migrations with full visibility and idempotent execution.</p>
        </div>
        <span className="ml-auto inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700">
          <Shield className="w-3 h-3" />
          Super Admin
        </span>
      </div>

      <TargetBanner target={target} />

      {isLoading && (
        <div className="py-10 text-center text-gray-500 text-sm">Loading migrations…</div>
      )}

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          Failed to load migrations.
          <Button variant="ghost" size="sm" onClick={() => refetch()} className="ml-2 text-red-700">
            Retry
          </Button>
        </div>
      )}

      {migrations.map((m) => (
        <Card key={m.id} className="border border-gray-200">
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-0.5 min-w-0">
                <CardTitle className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                  <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded font-mono">{m.id}</code>
                  {m.title}
                </CardTitle>
                <CardDescription className="text-xs text-gray-500">{m.description}</CardDescription>
              </div>
              <MigrationStatusBadge status={m.status} />
            </div>
          </CardHeader>
          <CardContent className="pt-2">
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPreviewFor(m.id)}
                className="flex items-center gap-1.5"
              >
                <Eye className="w-3.5 h-3.5" />
                Preview
              </Button>
              {m.status.state !== "completed" && (
                <Button
                  size="sm"
                  onClick={() => setPreviewFor(m.id)}
                  className="bg-blue-600 hover:bg-blue-700 text-white"
                >
                  Run Migration
                </Button>
              )}
              {m.status.state === "completed" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPreviewFor(m.id)}
                >
                  Re-run (idempotent)
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      ))}

      {previewFor && (
        <PreviewModal
          migrationId={previewFor}
          onClose={() => {
            setPreviewFor(null);
            refetch();
          }}
        />
      )}
    </div>
  );
}
