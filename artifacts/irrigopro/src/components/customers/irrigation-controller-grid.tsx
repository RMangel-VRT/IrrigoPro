import { useState, useRef, useMemo, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Camera,
  ImageIcon,
  History,
  AlertTriangle,
  Loader2,
  Trash2,
  Save,
  X,
  Eye,
  Clock,
  ArrowLeft,
  Minus,
  Cpu,
} from "lucide-react";
import type {
  IrrigationController,
  IrrigationProgram,
  IrrigationProfileZone,
  IrrigationProfileHistory,
} from "@workspace/db/schema";
import {
  computeRunSchedule,
  minutesToTime,
  type ScheduleInputProgram,
  type ScheduleInputZone,
  type ProgramSchedule,
} from "@workspace/shared";
import { uploadPhotoToStorage } from "@/pages/wet-checks/helpers";
import { apiRequest } from "@/lib/queryClient";

// ── Constants ────────────────────────────────────────────────────────────────

const MIN_ZONES = 1;
const MAX_ZONES = 100;

// ── Types ────────────────────────────────────────────────────────────────────

type ControllerWithDetail = IrrigationController & {
  programs: IrrigationProgram[];
  zones: IrrigationProfileZone[];
};

type HistoryEntry = IrrigationProfileHistory & {
  snapshotJson: {
    controller: IrrigationController;
    programs: IrrigationProgram[];
    zones: IrrigationProfileZone[];
  };
};

const ZONE_TYPES = [
  { value: "pop_up_spray", label: "Pop-up Spray" },
  { value: "rotor", label: "Rotor" },
  { value: "drip", label: "Drip" },
  { value: "netafim", label: "Netafim" },
  { value: "bubbler", label: "Bubbler" },
  { value: "other", label: "Other" },
];

const DAYS_OF_WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtDateTime(val: string | Date | null | undefined): string {
  if (!val) return "—";
  const d = new Date(val as string);
  if (isNaN(d.getTime())) return String(val);
  return (
    d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
    " " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  );
}

function zoneTypeLabel(t: string): string {
  return ZONE_TYPES.find((z) => z.value === t)?.label ?? t;
}

// ── Day pill selector ────────────────────────────────────────────────────────

function DayPillSelector({
  value,
  onChange,
}: {
  value: string[];
  onChange: (days: string[]) => void;
}) {
  const toggle = (day: string) => {
    onChange(value.includes(day) ? value.filter((d) => d !== day) : [...value, day]);
  };
  return (
    <div className="flex flex-wrap gap-1">
      {DAYS_OF_WEEK.map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => toggle(d)}
          className={`text-xs px-2 py-1 rounded-full border transition-colors ${
            value.includes(d)
              ? "bg-blue-600 text-white border-blue-600"
              : "bg-white text-gray-600 border-gray-300 hover:border-blue-400"
          }`}
        >
          {d}
        </button>
      ))}
    </div>
  );
}

// ── Start times multi-input ──────────────────────────────────────────────────

function StartTimesInput({
  value,
  onChange,
}: {
  value: string[];
  onChange: (times: string[]) => void;
}) {
  const add = () => onChange([...value, "06:00"]);
  const remove = (i: number) => onChange(value.filter((_, idx) => idx !== i));
  const update = (i: number, v: string) => {
    const copy = [...value];
    copy[i] = v;
    onChange(copy);
  };
  return (
    <div className="space-y-1">
      {value.map((t, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="time"
            value={t}
            onChange={(e) => update(i, e.target.value)}
            className="text-sm border rounded px-2 py-1 w-28"
          />
          {value.length > 1 && (
            <button
              type="button"
              onClick={() => remove(i)}
              className="text-gray-400 hover:text-red-500"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="text-xs text-blue-600 hover:underline flex items-center gap-1"
      >
        <Plus className="w-3 h-3" /> Add start time
      </button>
    </div>
  );
}

// ── Run-schedule panel ───────────────────────────────────────────────────────

function RunSchedulePanel({
  programs,
  zones,
}: {
  programs: IrrigationProgram[];
  zones: IrrigationProfileZone[];
}) {
  const schedulePrograms: ScheduleInputProgram[] = programs.map((p) => ({
    id: p.id,
    name: p.name,
    wateringDays: p.wateringDays,
    startTimes: p.startTimes,
    seasonalAdjustPct: p.seasonalAdjustPct,
    isActive: p.isActive,
    sortOrder: p.sortOrder,
  }));

  const scheduleZones: ScheduleInputZone[] = zones.map((z) => ({
    id: z.id,
    programId: z.programId,
    zoneNumber: z.zoneNumber,
    name: z.name,
    zoneType: z.zoneType,
    runTimeMinutes: z.runTimeMinutes,
    zoneOrder: z.zoneOrder,
    isActive: z.isActive,
    overrideStartTime: z.overrideStartTime,
    overrideDays: z.overrideDays,
  }));

  const schedule: ProgramSchedule[] = useMemo(
    () => computeRunSchedule(schedulePrograms, scheduleZones),
    [schedulePrograms, scheduleZones],
  );

  if (schedule.length === 0) {
    return (
      <div className="text-sm text-gray-500 italic">
        No active programs with zones assigned. Add programs and zones to see the run schedule.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {schedule.map((ps, pi) => (
        <div key={`${ps.programId}-${ps.startTime}-${pi}`}>
          <div className="flex items-center gap-2 mb-2">
            <Clock className="w-4 h-4 text-blue-500" />
            <span className="font-medium text-sm">
              Program {ps.programName} — Start {ps.startTime}
            </span>
            {ps.wateringDays.length > 0 && (
              <span className="text-xs text-gray-500">
                ({ps.wateringDays.join(", ")})
              </span>
            )}
          </div>
          {ps.entries.length === 0 ? (
            <p className="text-xs text-gray-400 ml-6">No active zones in this program.</p>
          ) : (
            <div className="ml-6 overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-gray-50">
                    <th className="text-left px-2 py-1 border border-gray-200 font-medium text-gray-600">Zone #</th>
                    <th className="text-left px-2 py-1 border border-gray-200 font-medium text-gray-600">Name</th>
                    <th className="text-left px-2 py-1 border border-gray-200 font-medium text-gray-600">Type</th>
                    <th className="text-right px-2 py-1 border border-gray-200 font-medium text-gray-600">Start</th>
                    <th className="text-right px-2 py-1 border border-gray-200 font-medium text-gray-600">End</th>
                    <th className="text-right px-2 py-1 border border-gray-200 font-medium text-gray-600">Runtime</th>
                    <th className="text-center px-2 py-1 border border-gray-200 font-medium text-gray-600">Override</th>
                  </tr>
                </thead>
                <tbody>
                  {ps.entries.map((entry) => (
                    <tr key={entry.zoneId} className={entry.isOverride ? "bg-amber-50" : "bg-white"}>
                      <td className="px-2 py-1 border border-gray-200">{entry.zoneNumber}</td>
                      <td className="px-2 py-1 border border-gray-200">{entry.zoneName}</td>
                      <td className="px-2 py-1 border border-gray-200 text-gray-500">
                        {zoneTypeLabel(entry.zoneType)}
                      </td>
                      <td className="px-2 py-1 border border-gray-200 text-right font-mono">
                        {minutesToTime(entry.expectedStartMinutes)}
                      </td>
                      <td className="px-2 py-1 border border-gray-200 text-right font-mono">
                        {minutesToTime(entry.expectedEndMinutes)}
                      </td>
                      <td className="px-2 py-1 border border-gray-200 text-right">
                        {entry.adjustedRunTimeMinutes} min
                      </td>
                      <td className="px-2 py-1 border border-gray-200 text-center">
                        {entry.isOverride ? (
                          <span className="text-amber-600 font-medium">Override</span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── History drawer ───────────────────────────────────────────────────────────

function HistoryDrawer({ controllerId }: { controllerId: number }) {
  const [open, setOpen] = useState(false);
  const [snapshotEntry, setSnapshotEntry] = useState<HistoryEntry | null>(null);

  const { data: history = [], isLoading } = useQuery<HistoryEntry[]>({
    queryKey: [`/api/irrigation-controllers/${controllerId}/history`],
    enabled: open,
  });

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <History className="w-4 h-4" />
          View History
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Change History</SheetTitle>
        </SheetHeader>
        {snapshotEntry ? (
          <div className="mt-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSnapshotEntry(null)}
              className="mb-4"
            >
              <ArrowLeft className="w-4 h-4 mr-1" /> Back to history
            </Button>
            <div className="text-xs text-gray-500 mb-3">
              Snapshot from {fmtDateTime(snapshotEntry.changedAt)} by{" "}
              {snapshotEntry.changedByName ?? "Unknown"}
            </div>
            <SnapshotView
              controller={snapshotEntry.snapshotJson.controller}
              programs={snapshotEntry.snapshotJson.programs ?? []}
              zones={snapshotEntry.snapshotJson.zones ?? []}
            />
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {isLoading && (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            )}
            {!isLoading && history.length === 0 && (
              <p className="text-sm text-gray-500">No history recorded yet.</p>
            )}
            {history.map((entry) => (
              <div key={entry.id} className="border rounded-lg p-3 bg-gray-50 space-y-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-800">
                      {entry.changedByName ?? "Unknown"}
                    </p>
                    <p className="text-xs text-gray-500">{fmtDateTime(entry.changedAt)}</p>
                    {entry.summary && (
                      <p className="text-xs text-gray-600 mt-1">{entry.summary}</p>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0 text-xs gap-1"
                    onClick={() => setSnapshotEntry(entry)}
                  >
                    <Eye className="w-3 h-3" />
                    View snapshot
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ── Snapshot read-only view ──────────────────────────────────────────────────

function SnapshotView({
  controller,
  programs,
  zones,
}: {
  controller: IrrigationController;
  programs: IrrigationProgram[];
  zones: IrrigationProfileZone[];
}) {
  return (
    <div className="space-y-4 text-sm">
      <div className="border rounded-lg p-3 bg-white space-y-2">
        <p className="font-semibold">{controller.name}</p>
        {controller.location && <p className="text-gray-600">📍 {controller.location}</p>}
        {controller.brand && <p className="text-gray-600">Brand: {controller.brand}</p>}
        {controller.model && <p className="text-gray-600">Model: {controller.model}</p>}
        {!controller.isActive && (
          <Badge className="bg-amber-100 text-amber-800 border-amber-200">Inactive</Badge>
        )}
      </div>
      {programs.map((prog) => {
        const progZones = zones.filter((z) => z.programId === prog.id);
        return (
          <div key={prog.id} className="border rounded-lg p-3 bg-white space-y-2">
            <div className="flex items-center gap-2">
              <p className="font-medium">Program {prog.name}</p>
              {!prog.isActive && (
                <Badge variant="outline" className="text-xs">Inactive</Badge>
              )}
            </div>
            {(prog.wateringDays ?? []).length > 0 && (
              <p className="text-xs text-gray-500">
                Days: {(prog.wateringDays ?? []).join(", ")}
              </p>
            )}
            {(prog.startTimes ?? []).length > 0 && (
              <p className="text-xs text-gray-500">
                Start: {(prog.startTimes ?? []).join(", ")}
              </p>
            )}
            <p className="text-xs text-gray-500">Seasonal: {prog.seasonalAdjustPct}%</p>
            {progZones.length > 0 && (
              <table className="w-full text-xs border-collapse mt-2">
                <thead>
                  <tr className="bg-gray-50">
                    <th className="text-left px-2 py-1 border border-gray-200">#</th>
                    <th className="text-left px-2 py-1 border border-gray-200">Name</th>
                    <th className="text-right px-2 py-1 border border-gray-200">Runtime</th>
                  </tr>
                </thead>
                <tbody>
                  {progZones
                    .sort((a, b) => a.zoneOrder - b.zoneOrder)
                    .map((z) => (
                      <tr key={z.id}>
                        <td className="px-2 py-1 border border-gray-200">{z.zoneNumber}</td>
                        <td className="px-2 py-1 border border-gray-200">{z.name}</td>
                        <td className="px-2 py-1 border border-gray-200 text-right">
                          {z.runTimeMinutes} min
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Settings photo section ───────────────────────────────────────────────────

function SettingsPhoto({
  controller,
  onUploaded,
  canUploadPhoto,
}: {
  controller: ControllerWithDetail;
  onUploaded: (url: string) => void;
  canUploadPhoto: boolean;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setBusy(true);
    try {
      const url = await uploadPhotoToStorage(file);
      await apiRequest(`/api/irrigation-controllers/${controller.id}/photo`, "POST", { url });
      queryClient.invalidateQueries({
        queryKey: [`/api/irrigation-controllers/${controller.id}`],
      });
      onUploaded(url);
      toast({ title: "Photo saved" });
    } catch (err: any) {
      toast({
        title: "Photo upload failed",
        description: err?.message ?? "Try again",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      {controller.settingsPhotoUrl ? (
        <div className="relative">
          <img
            src={controller.settingsPhotoUrl}
            alt="Controller settings"
            className="w-full max-w-xs h-40 object-cover rounded-lg border"
          />
        </div>
      ) : (
        <div className="w-full max-w-xs h-32 flex items-center justify-center bg-gray-50 border-2 border-dashed border-gray-200 rounded-lg">
          <p className="text-xs text-gray-400">No photo yet</p>
        </div>
      )}
      {canUploadPhoto && (
        <>
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={onPick}
          />
          <input ref={libraryRef} type="file" accept="image/*" className="hidden" onChange={onPick} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" type="button" disabled={busy} className="gap-1.5">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
                {controller.settingsPhotoUrl ? "Replace Photo" : "Add Photo"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  cameraRef.current?.click();
                }}
              >
                <Camera className="w-4 h-4 mr-2" /> Take Photo
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  libraryRef.current?.click();
                }}
              >
                <ImageIcon className="w-4 h-4 mr-2" /> Choose from Library
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  );
}

// ── Program card ─────────────────────────────────────────────────────────────

function ProgramCard({
  program,
  controllerId,
  onSaved,
  onDeleted,
  onDraftChange,
  canManagePrograms,
}: {
  program: IrrigationProgram;
  controllerId: number;
  onSaved: () => void;
  onDeleted: () => void;
  onDraftChange?: (draft: IrrigationProgram) => void;
  canManagePrograms: boolean;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draft, setDraft] = useState({ ...program });
  const queryClient = useQueryClient();

  useEffect(() => {
    if (editing) onDraftChange?.(draft as IrrigationProgram);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, editing]);

  const saveMutation = useMutation({
    mutationFn: (data: Partial<IrrigationProgram>) =>
      apiRequest(`/api/irrigation-programs/${program.id}`, "PUT", data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [`/api/irrigation-controllers/${controllerId}`],
      });
      setEditing(false);
      toast({ title: "Program saved" });
      onSaved();
    },
    onError: (err: any) => {
      toast({
        title: "Save failed",
        description: err?.message ?? "Try again",
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiRequest(`/api/irrigation-programs/${program.id}`, "DELETE"),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [`/api/irrigation-controllers/${controllerId}`],
      });
      toast({ title: "Program deleted" });
      onDeleted();
    },
    onError: (err: any) => {
      toast({
        title: "Delete failed",
        description: err?.message ?? "Try again",
        variant: "destructive",
      });
    },
  });

  if (!editing || !canManagePrograms) {
    return (
      <div
        className={`border rounded-lg p-3 space-y-2 ${
          !program.isActive ? "bg-amber-50 border-amber-200" : "bg-white"
        }`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-blue-700">Program {program.name}</span>
            {!program.isActive && (
              <Badge className="bg-amber-100 text-amber-800 border-amber-200 text-xs gap-1">
                <AlertTriangle className="w-3 h-3" /> Needs attention
              </Badge>
            )}
          </div>
          {canManagePrograms && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft({ ...program });
                setEditing(true);
              }}
            >
              Edit
            </Button>
          )}
        </div>
        <div className="text-xs text-gray-600 space-y-0.5">
          {(program.wateringDays ?? []).length > 0 && (
            <p>Days: {(program.wateringDays ?? []).join(", ")}</p>
          )}
          {(program.startTimes ?? []).length > 0 && (
            <p>Start: {(program.startTimes ?? []).join(", ")}</p>
          )}
          <p>Seasonal: {program.seasonalAdjustPct}%</p>
        </div>
      </div>
    );
  }

  return (
    <div className="border-2 border-blue-300 rounded-lg p-3 space-y-3 bg-blue-50/30">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Program Name</Label>
          <Input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className="h-8 text-sm mt-1"
          />
        </div>
        <div>
          <Label className="text-xs">Seasonal Adjust %</Label>
          <div className="flex items-center gap-2 mt-1">
            <Slider
              value={[draft.seasonalAdjustPct]}
              min={0}
              max={200}
              step={5}
              onValueChange={([v]) => setDraft({ ...draft, seasonalAdjustPct: v })}
              className="flex-1"
            />
            <span className="text-sm font-medium w-10 text-right">{draft.seasonalAdjustPct}%</span>
          </div>
        </div>
      </div>
      <div>
        <Label className="text-xs">Watering Days</Label>
        <div className="mt-1">
          <DayPillSelector
            value={draft.wateringDays ?? []}
            onChange={(days) => setDraft({ ...draft, wateringDays: days })}
          />
        </div>
      </div>
      <div>
        <Label className="text-xs">Start Times</Label>
        <div className="mt-1">
          <StartTimesInput
            value={draft.startTimes ?? []}
            onChange={(times) => setDraft({ ...draft, startTimes: times })}
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Switch
          checked={draft.isActive}
          onCheckedChange={(v) => setDraft({ ...draft, isActive: v })}
          id={`prog-active-${program.id}`}
        />
        <Label htmlFor={`prog-active-${program.id}`} className="text-xs">Active</Label>
      </div>
      <div className="flex items-center gap-2 pt-1 border-t">
        <Button
          size="sm"
          disabled={saveMutation.isPending}
          onClick={() =>
            saveMutation.mutate({
              name: draft.name,
              wateringDays: draft.wateringDays ?? [],
              startTimes: draft.startTimes ?? [],
              seasonalAdjustPct: draft.seasonalAdjustPct,
              isActive: draft.isActive,
            })
          }
          className="gap-1.5"
        >
          {saveMutation.isPending ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Save className="w-3.5 h-3.5" />
          )}
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)} className="gap-1.5">
          <X className="w-3.5 h-3.5" /> Cancel
        </Button>
        {canManagePrograms && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-red-600 hover:text-red-700 hover:bg-red-50 gap-1.5"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </Button>
        )}
      </div>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Program {program.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the program and unassign all its zones. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => deleteMutation.mutate()}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Zone row ──────────────────────────────────────────────────────────────────

function ZoneRow({
  zone,
  programs,
  controllerId,
  onSaved,
  onDeleted,
  onDraftChange,
  canEditZone,
  canDeleteZone,
}: {
  zone: IrrigationProfileZone;
  programs: IrrigationProgram[];
  controllerId: number;
  onSaved: () => void;
  onDeleted: () => void;
  onDraftChange?: (draft: IrrigationProfileZone) => void;
  canEditZone: boolean;
  canDeleteZone: boolean;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draft, setDraft] = useState({ ...zone });
  const queryClient = useQueryClient();

  useEffect(() => {
    if (editing) onDraftChange?.(draft as IrrigationProfileZone);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, editing]);

  const saveMutation = useMutation({
    mutationFn: (data: Partial<IrrigationProfileZone>) =>
      apiRequest(`/api/irrigation-zones/${zone.id}`, "PUT", data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [`/api/irrigation-controllers/${controllerId}`],
      });
      setEditing(false);
      toast({ title: "Zone saved" });
      onSaved();
    },
    onError: (err: any) => {
      toast({
        title: "Save failed",
        description: err?.message ?? "Try again",
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiRequest(`/api/irrigation-zones/${zone.id}`, "DELETE"),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [`/api/irrigation-controllers/${controllerId}`],
      });
      toast({ title: "Zone deleted" });
      onDeleted();
    },
    onError: (err: any) => {
      toast({
        title: "Delete failed",
        description: err?.message ?? "Try again",
        variant: "destructive",
      });
    },
  });

  if (!editing) {
    return (
      <tr className={!zone.isActive ? "bg-amber-50" : undefined}>
        <td className="px-2 py-2 border border-gray-200 text-center text-sm">{zone.zoneNumber}</td>
        <td className="px-2 py-2 border border-gray-200">
          <div className="flex items-center gap-1.5">
            <span className="text-sm">{zone.name}</span>
            {!zone.isActive && (
              <Badge className="bg-amber-100 text-amber-800 border-amber-200 text-xs gap-1">
                <AlertTriangle className="w-3 h-3" /> Needs attention
              </Badge>
            )}
          </div>
        </td>
        <td className="px-2 py-2 border border-gray-200 text-xs text-gray-600">
          {programs.find((p) => p.id === zone.programId)?.name ?? "—"}
        </td>
        <td className="px-2 py-2 border border-gray-200 text-xs text-gray-600">
          {zoneTypeLabel(zone.zoneType)}
        </td>
        <td className="px-2 py-2 border border-gray-200 text-sm text-right">{zone.runTimeMinutes}</td>
        <td className="px-2 py-2 border border-gray-200 text-sm text-center">{zone.zoneOrder}</td>
        <td className="px-2 py-2 border border-gray-200 text-center">
          <span
            className={`text-xs px-1.5 py-0.5 rounded-full ${
              zone.isActive ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
            }`}
          >
            {zone.isActive ? "Active" : "Inactive"}
          </span>
        </td>
        <td className="px-2 py-2 border border-gray-200 text-xs text-gray-500 max-w-[120px] truncate">
          {zone.notes || "—"}
        </td>
        <td className="px-2 py-2 border border-gray-200">
          {canEditZone && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setDraft({ ...zone });
                setEditing(true);
              }}
            >
              Edit
            </Button>
          )}
        </td>
      </tr>
    );
  }

  return (
    <tr className="bg-blue-50/40">
      <td colSpan={9} className="p-3 border border-blue-300">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-3">
          <div>
            <Label className="text-xs">Zone #</Label>
            <Input
              type="number"
              value={draft.zoneNumber}
              onChange={(e) => setDraft({ ...draft, zoneNumber: parseInt(e.target.value) || 0 })}
              className="h-8 text-sm mt-1"
            />
          </div>
          <div>
            <Label className="text-xs">Name</Label>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="h-8 text-sm mt-1"
            />
          </div>
          <div>
            <Label className="text-xs">Program</Label>
            <Select
              value={draft.programId != null ? String(draft.programId) : "none"}
              onValueChange={(v) =>
                setDraft({ ...draft, programId: v === "none" ? null : parseInt(v) })
              }
            >
              <SelectTrigger className="h-8 text-sm mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— None —</SelectItem>
                {programs.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    Program {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Zone Type</Label>
            <Select
              value={draft.zoneType}
              onValueChange={(v) => setDraft({ ...draft, zoneType: v })}
            >
              <SelectTrigger className="h-8 text-sm mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ZONE_TYPES.map((zt) => (
                  <SelectItem key={zt.value} value={zt.value}>
                    {zt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Run Time (min)</Label>
            <Input
              type="number"
              min={0}
              value={draft.runTimeMinutes}
              onChange={(e) =>
                setDraft({ ...draft, runTimeMinutes: parseInt(e.target.value) || 0 })
              }
              className="h-8 text-sm mt-1"
            />
          </div>
          <div>
            <Label className="text-xs">Zone Order</Label>
            <Input
              type="number"
              value={draft.zoneOrder}
              onChange={(e) => setDraft({ ...draft, zoneOrder: parseInt(e.target.value) || 0 })}
              className="h-8 text-sm mt-1"
            />
          </div>
          <div>
            <Label className="text-xs">Override Start</Label>
            <input
              type="time"
              value={draft.overrideStartTime ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, overrideStartTime: e.target.value || null })
              }
              className="h-8 text-sm mt-1 border rounded px-2 py-1 w-full"
            />
          </div>
          <div className="flex items-end gap-2 pb-1">
            <div className="flex items-center gap-2">
              <Switch
                checked={draft.isActive}
                onCheckedChange={(v) => setDraft({ ...draft, isActive: v })}
                id={`zone-active-${zone.id}`}
              />
              <Label htmlFor={`zone-active-${zone.id}`} className="text-xs">Active</Label>
            </div>
          </div>
        </div>
        {draft.overrideStartTime && (
          <div className="mb-3">
            <Label className="text-xs">Override Days</Label>
            <div className="mt-1">
              <DayPillSelector
                value={draft.overrideDays ?? []}
                onChange={(days) => setDraft({ ...draft, overrideDays: days })}
              />
            </div>
          </div>
        )}
        <div className="mb-3">
          <Label className="text-xs">Notes</Label>
          <Input
            value={draft.notes ?? ""}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value || null })}
            className="h-8 text-sm mt-1"
            placeholder="Optional notes…"
          />
        </div>
        <div className="flex items-center gap-2 border-t pt-2">
          <Button
            size="sm"
            disabled={saveMutation.isPending}
            onClick={() =>
              saveMutation.mutate({
                zoneNumber: draft.zoneNumber,
                name: draft.name,
                programId: draft.programId,
                zoneType: draft.zoneType,
                runTimeMinutes: draft.runTimeMinutes,
                zoneOrder: draft.zoneOrder,
                isActive: draft.isActive,
                notes: draft.notes,
                overrideStartTime: draft.overrideStartTime,
                overrideDays: draft.overrideDays,
              })
            }
            className="gap-1.5"
          >
            {saveMutation.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Save className="w-3.5 h-3.5" />
            )}
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)} className="gap-1.5">
            <X className="w-3.5 h-3.5" /> Cancel
          </Button>
          {canDeleteZone && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto text-red-600 hover:text-red-700 hover:bg-red-50 gap-1.5"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </Button>
          )}
        </div>
        <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Zone {zone.zoneNumber}?</AlertDialogTitle>
              <AlertDialogDescription>
                This removes Zone {zone.zoneNumber} — "{zone.name}" from this controller. This
                cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-red-600 hover:bg-red-700"
                onClick={() => deleteMutation.mutate()}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </td>
    </tr>
  );
}

// ── Add zone row ──────────────────────────────────────────────────────────────

function AddZoneRow({
  controllerId,
  programs,
  nextZoneNumber,
  onAdded,
}: {
  controllerId: number;
  programs: IrrigationProgram[];
  nextZoneNumber: number;
  onAdded: () => void;
}) {
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    zoneNumber: nextZoneNumber,
    name: "",
    programId: null as number | null,
    zoneType: "other",
    runTimeMinutes: 10,
    zoneOrder: nextZoneNumber,
    isActive: true,
    notes: null as string | null,
  });
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (data: typeof draft) =>
      apiRequest(`/api/irrigation-controllers/${controllerId}/zones`, "POST", data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [`/api/irrigation-controllers/${controllerId}`],
      });
      setAdding(false);
      toast({ title: "Zone added" });
      onAdded();
    },
    onError: (err: any) => {
      toast({
        title: "Failed to add zone",
        description: err?.message ?? "Try again",
        variant: "destructive",
      });
    },
  });

  if (!adding) {
    return (
      <tr>
        <td colSpan={9} className="px-2 py-2 border border-gray-200 border-t-0">
          <Button
            variant="ghost"
            size="sm"
            className="text-blue-600 gap-1.5"
            onClick={() => {
              setDraft({ ...draft, zoneNumber: nextZoneNumber, zoneOrder: nextZoneNumber });
              setAdding(true);
            }}
          >
            <Plus className="w-4 h-4" /> Add Zone
          </Button>
        </td>
      </tr>
    );
  }

  return (
    <tr className="bg-green-50/40">
      <td colSpan={9} className="p-3 border border-green-300">
        <p className="text-sm font-medium text-green-700 mb-2">New Zone</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-3">
          <div>
            <Label className="text-xs">Zone #</Label>
            <Input
              type="number"
              value={draft.zoneNumber}
              onChange={(e) => setDraft({ ...draft, zoneNumber: parseInt(e.target.value) || 0 })}
              className="h-8 text-sm mt-1"
            />
          </div>
          <div>
            <Label className="text-xs">Name *</Label>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="h-8 text-sm mt-1"
              placeholder="e.g. Front lawn"
            />
          </div>
          <div>
            <Label className="text-xs">Program</Label>
            <Select
              value={draft.programId != null ? String(draft.programId) : "none"}
              onValueChange={(v) =>
                setDraft({ ...draft, programId: v === "none" ? null : parseInt(v) })
              }
            >
              <SelectTrigger className="h-8 text-sm mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— None —</SelectItem>
                {programs.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    Program {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Zone Type</Label>
            <Select
              value={draft.zoneType}
              onValueChange={(v) => setDraft({ ...draft, zoneType: v })}
            >
              <SelectTrigger className="h-8 text-sm mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ZONE_TYPES.map((zt) => (
                  <SelectItem key={zt.value} value={zt.value}>
                    {zt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Run Time (min)</Label>
            <Input
              type="number"
              min={0}
              value={draft.runTimeMinutes}
              onChange={(e) =>
                setDraft({ ...draft, runTimeMinutes: parseInt(e.target.value) || 0 })
              }
              className="h-8 text-sm mt-1"
            />
          </div>
          <div>
            <Label className="text-xs">Zone Order</Label>
            <Input
              type="number"
              value={draft.zoneOrder}
              onChange={(e) => setDraft({ ...draft, zoneOrder: parseInt(e.target.value) || 0 })}
              className="h-8 text-sm mt-1"
            />
          </div>
        </div>
        <div className="flex items-center gap-2 border-t pt-2">
          <Button
            size="sm"
            disabled={mutation.isPending || !draft.name}
            onClick={() => mutation.mutate(draft)}
            className="gap-1.5"
          >
            {mutation.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Plus className="w-3.5 h-3.5" />
            )}
            Add Zone
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAdding(false)} className="gap-1.5">
            <X className="w-3.5 h-3.5" /> Cancel
          </Button>
        </div>
      </td>
    </tr>
  );
}

// ── Controller grid tile (collapsed + expandable) ────────────────────────────

interface ControllerGridTileProps {
  controller: IrrigationController;
  customerId: number;
  canManageControllers: boolean;
  canEditZones: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  onRefreshList: () => void;
}

function ControllerGridTile({
  controller,
  customerId,
  canManageControllers,
  canEditZones,
  isExpanded,
  onToggle,
  onRefreshList,
}: ControllerGridTileProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editingDetails, setEditingDetails] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draft, setDraft] = useState<Partial<IrrigationController>>({});

  const [draftPrograms, setDraftPrograms] = useState<IrrigationProgram[]>([]);
  const [draftZones, setDraftZones] = useState<IrrigationProfileZone[]>([]);

  const { data: detail, isLoading: detailLoading } = useQuery<ControllerWithDetail>({
    queryKey: [`/api/irrigation-controllers/${controller.id}`],
    enabled: isExpanded,
  });

  useEffect(() => {
    if (detail) {
      setDraftPrograms(detail.programs ?? []);
      setDraftZones(detail.zones ?? []);
    }
  }, [detail]);

  const handleProgramDraftChange = useCallback((updated: IrrigationProgram) => {
    setDraftPrograms((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  }, []);

  const handleZoneDraftChange = useCallback((updated: IrrigationProfileZone) => {
    setDraftZones((prev) => prev.map((z) => (z.id === updated.id ? updated : z)));
  }, []);

  // Use the stored letter (Task #1856). Fall back to first character of name for
  // pre-backfill rows that have letter IS NULL.
  const letter = controller.letter ?? controller.name.slice(0, 1).toUpperCase();
  const zoneCount = controller.totalZones;

  const updateZoneCount = useMutation({
    mutationFn: async (next: number) =>
      apiRequest(`/api/irrigation-controllers/${controller.id}`, "PUT", { totalZones: next }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [`/api/customers/${customerId}/controllers-profile`],
      });
      queryClient.invalidateQueries({
        queryKey: [`/api/irrigation-controllers/${controller.id}`],
      });
      toast({ title: "Zone count updated" });
      onRefreshList();
    },
    onError: (err: any) => {
      toast({
        title: "Could not update zone count",
        description: err?.message ?? "Try again in a moment.",
        variant: "destructive",
      });
    },
  });

  const saveMutation = useMutation({
    mutationFn: (data: Partial<IrrigationController>) =>
      apiRequest(`/api/irrigation-controllers/${controller.id}`, "PUT", data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [`/api/irrigation-controllers/${controller.id}`],
      });
      queryClient.invalidateQueries({
        queryKey: [`/api/customers/${customerId}/controllers-profile`],
      });
      setEditingDetails(false);
      toast({ title: "Controller saved" });
      onRefreshList();
    },
    onError: (err: any) => {
      toast({
        title: "Save failed",
        description: err?.message ?? "Try again",
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiRequest(`/api/irrigation-controllers/${controller.id}`, "DELETE"),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [`/api/customers/${customerId}/controllers-profile`],
      });
      toast({ title: "Controller deleted" });
      onRefreshList();
    },
    onError: (err: any) => {
      toast({
        title: "Delete failed",
        description: err?.message ?? "Try again",
        variant: "destructive",
      });
    },
  });

  const addProgramMutation = useMutation({
    mutationFn: (name: string) =>
      apiRequest(`/api/irrigation-controllers/${controller.id}/programs`, "POST", {
        name,
        wateringDays: [],
        startTimes: ["06:00"],
        seasonalAdjustPct: 100,
        isActive: true,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [`/api/irrigation-controllers/${controller.id}`],
      });
      toast({ title: "Program added" });
    },
    onError: (err: any) => {
      toast({
        title: "Failed to add program",
        description: err?.message ?? "Try again",
        variant: "destructive",
      });
    },
  });

  const programs = detail?.programs ?? [];
  const zones = detail?.zones ?? [];
  const nextZoneNumber = zones.length > 0 ? Math.max(...zones.map((z) => z.zoneNumber)) + 1 : 1;

  const suggestNextProgramName = () => {
    const existing = new Set(programs.map((p) => p.name.toUpperCase()));
    for (const l of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      if (!existing.has(l)) return l;
    }
    return `${programs.length + 1}`;
  };

  const startEditDetails = () => {
    setDraft({
      name: controller.name,
      location: controller.location,
      brand: controller.brand,
      model: controller.model,
      totalZones: controller.totalZones,
      notes: controller.notes,
      isActive: controller.isActive,
    });
    setEditingDetails(true);
  };

  return (
    <div
      className={`rounded-xl border bg-gradient-to-br from-blue-50/40 to-white overflow-hidden ${
        !controller.isActive ? "border-amber-200" : "border-gray-200"
      }`}
      data-testid={`controller-tile-${letter}`}
    >
      {/* ── Tile header — always visible ── */}
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <button
            type="button"
            className="flex items-center gap-2 flex-1 min-w-0 text-left"
            onClick={onToggle}
          >
            <div className="w-9 h-9 rounded-lg bg-blue-600 text-white font-bold flex items-center justify-center shadow-sm shrink-0">
              {letter}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-900 flex items-center gap-1.5 flex-wrap">
                {controller.name}
                {!controller.isActive && (
                  <Badge className="bg-amber-100 text-amber-800 border-amber-200 gap-1 text-xs">
                    <AlertTriangle className="w-3 h-3" /> Needs attention
                  </Badge>
                )}
              </p>
              <p className="text-xs text-gray-500 flex items-center gap-1">
                <Cpu className="w-3 h-3" />
                {zoneCount != null ? zoneCount : "—"} {zoneCount === 1 ? "zone" : "zones"}
                {controller.location && (
                  <span className="ml-1 truncate">· 📍 {controller.location}</span>
                )}
              </p>
            </div>
          </button>

          <div className="flex items-center gap-1.5 shrink-0">
            {canManageControllers && !isExpanded && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!updateZoneCount.isPending && (zoneCount ?? 0) > MIN_ZONES) {
                      updateZoneCount.mutate((zoneCount ?? 0) - 1);
                    }
                  }}
                  disabled={updateZoneCount.isPending || (zoneCount ?? 0) <= MIN_ZONES}
                  data-testid={`button-zone-decrement-${letter}`}
                >
                  <Minus className="w-3 h-3" />
                </Button>
                <span className="w-8 text-center text-sm font-medium tabular-nums">{zoneCount ?? "—"}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!updateZoneCount.isPending && (zoneCount ?? 0) < MAX_ZONES) {
                      updateZoneCount.mutate((zoneCount ?? 0) + 1);
                    }
                  }}
                  disabled={updateZoneCount.isPending || (zoneCount ?? 0) >= MAX_ZONES}
                  data-testid={`button-zone-increment-${letter}`}
                >
                  <Plus className="w-3 h-3" />
                </Button>
                {updateZoneCount.isPending && (
                  <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                )}
              </>
            )}
            <button
              type="button"
              onClick={onToggle}
              className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
              aria-label={isExpanded ? "Collapse" : "Expand"}
            >
              {isExpanded ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>

        {/* Zone number chips */}
        {!isExpanded && (
          <div className="flex flex-wrap gap-1.5">
            {Array.from({ length: zoneCount ?? 0 }, (_, i) => i + 1).map((zone) => (
              <span
                key={zone}
                className="inline-flex items-center justify-center min-w-[28px] h-7 px-1.5 rounded-md bg-white border border-blue-200 text-xs font-medium text-blue-900 shadow-sm"
                data-testid={`zone-chip-${letter}-${zone}`}
              >
                {zone}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ── Expanded detail section ── */}
      {isExpanded && (
        <div className="border-t border-gray-200 px-4 pb-4 pt-3 space-y-6 bg-white">
          {detailLoading ? (
            <div className="space-y-3 py-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : (
            <>
              {/* ── Controller details ── */}
              <section>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-medium text-sm text-gray-700">Controller Details</h3>
                  <div className="flex gap-2">
                    {canManageControllers && !editingDetails && (
                      <Button variant="outline" size="sm" onClick={startEditDetails}>
                        Edit Details
                      </Button>
                    )}
                    <HistoryDrawer controllerId={controller.id} />
                    {canManageControllers && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 text-red-600 hover:bg-red-50 hover:text-red-700"
                        onClick={() => setConfirmDelete(true)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                </div>

                {editingDetails ? (
                  <div className="space-y-3 p-3 border rounded-lg bg-blue-50/20">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs">Name *</Label>
                        <Input
                          value={draft.name ?? ""}
                          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                          className="h-8 text-sm mt-1"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Location</Label>
                        <Input
                          value={draft.location ?? ""}
                          onChange={(e) =>
                            setDraft({ ...draft, location: e.target.value || null })
                          }
                          className="h-8 text-sm mt-1"
                          placeholder="e.g. 4521 Woodglen Dr"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Brand</Label>
                        <Input
                          value={draft.brand ?? ""}
                          onChange={(e) => setDraft({ ...draft, brand: e.target.value || null })}
                          className="h-8 text-sm mt-1"
                          placeholder="e.g. Rainbird"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Model</Label>
                        <Input
                          value={draft.model ?? ""}
                          onChange={(e) => setDraft({ ...draft, model: e.target.value || null })}
                          className="h-8 text-sm mt-1"
                          placeholder="e.g. ESP-Me"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Total Zones</Label>
                        <Input
                          type="number"
                          min={0}
                          value={draft.totalZones ?? ""}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              totalZones: e.target.value ? parseInt(e.target.value) : null,
                            })
                          }
                          className="h-8 text-sm mt-1"
                        />
                      </div>
                    </div>
                    <div>
                      <Label className="text-xs">Notes</Label>
                      <Textarea
                        value={draft.notes ?? ""}
                        onChange={(e) => setDraft({ ...draft, notes: e.target.value || null })}
                        className="text-sm mt-1 resize-none"
                        rows={2}
                        placeholder="Any notes about this controller…"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={draft.isActive ?? true}
                        onCheckedChange={(v) => setDraft({ ...draft, isActive: v })}
                        id={`ctrl-active-${controller.id}`}
                      />
                      <Label htmlFor={`ctrl-active-${controller.id}`} className="text-xs">
                        {draft.isActive ? "Active" : "Inactive — Needs attention"}
                      </Label>
                    </div>
                    <div className="flex gap-2 border-t pt-2">
                      <Button
                        size="sm"
                        disabled={saveMutation.isPending || !draft.name}
                        onClick={() => saveMutation.mutate(draft)}
                        className="gap-1.5"
                      >
                        {saveMutation.isPending ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Save className="w-3.5 h-3.5" />
                        )}
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditingDetails(false)}
                        className="gap-1.5"
                      >
                        <X className="w-3.5 h-3.5" /> Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1 text-sm">
                    {controller.location && (
                      <>
                        <span className="text-gray-500 text-xs">Location</span>
                        <span className="col-span-2 sm:col-span-2 text-gray-800">
                          {controller.location}
                        </span>
                      </>
                    )}
                    {controller.brand && (
                      <>
                        <span className="text-gray-500 text-xs">Brand</span>
                        <span className="text-gray-800">{controller.brand}</span>
                      </>
                    )}
                    {controller.model && (
                      <>
                        <span className="text-gray-500 text-xs">Model</span>
                        <span className="text-gray-800">{controller.model}</span>
                      </>
                    )}
                    {controller.totalZones != null && (
                      <>
                        <span className="text-gray-500 text-xs">Total Zones</span>
                        <span className="text-gray-800">{controller.totalZones}</span>
                      </>
                    )}
                    {controller.notes && (
                      <div className="col-span-2 sm:col-span-3">
                        <span className="text-gray-500 text-xs block">Notes</span>
                        <span className="text-gray-800 whitespace-pre-wrap text-sm">
                          {controller.notes}
                        </span>
                      </div>
                    )}
                    {controller.lastUpdatedAt && (
                      <div className="col-span-2 sm:col-span-3 text-xs text-gray-400 mt-1">
                        Last updated {fmtDateTime(controller.lastUpdatedAt)}
                        {controller.lastUpdatedByName
                          ? ` by ${controller.lastUpdatedByName}`
                          : ""}
                      </div>
                    )}
                    {!controller.location &&
                      !controller.brand &&
                      !controller.model &&
                      controller.totalZones == null &&
                      !controller.notes && (
                        <p className="col-span-3 text-xs text-gray-400 italic">
                          No details on file. Click "Edit Details" to add.
                        </p>
                      )}
                  </div>
                )}
              </section>

              {/* ── Settings photo ── */}
              <section>
                <h3 className="font-medium text-sm text-gray-700 mb-2">Settings Photo</h3>
                {detail && (
                  <SettingsPhoto
                    controller={detail}
                    canUploadPhoto={canEditZones}
                    onUploaded={() => {
                      queryClient.invalidateQueries({
                        queryKey: [`/api/customers/${customerId}/controllers-profile`],
                      });
                    }}
                  />
                )}
              </section>

              {/* ── Programs ── */}
              <section>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-medium text-sm text-gray-700">Programs</h3>
                  {canManageControllers && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={addProgramMutation.isPending}
                      onClick={() => addProgramMutation.mutate(suggestNextProgramName())}
                      className="gap-1.5"
                    >
                      {addProgramMutation.isPending ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Plus className="w-3.5 h-3.5" />
                      )}
                      Add Program
                    </Button>
                  )}
                </div>
                {programs.length === 0 ? (
                  <p className="text-sm text-gray-400 italic">
                    No programs yet. Add a program to define watering schedules.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {programs.map((prog) => (
                      <ProgramCard
                        key={prog.id}
                        program={prog}
                        controllerId={controller.id}
                        onSaved={() => {}}
                        onDeleted={() => {}}
                        onDraftChange={handleProgramDraftChange}
                        canManagePrograms={canManageControllers}
                      />
                    ))}
                  </div>
                )}
              </section>

              {/* ── Zones table ── */}
              <section>
                <h3 className="font-medium text-sm text-gray-700 mb-3">Zones</h3>
                {zones.length === 0 && !canEditZones ? (
                  <p className="text-sm text-gray-400 italic">No zones configured.</p>
                ) : (
                  <div className="overflow-x-auto -mx-1">
                    <table className="w-full text-sm border-collapse min-w-[700px]">
                      <thead>
                        <tr className="bg-gray-50">
                          <th className="text-center px-2 py-1.5 border border-gray-200 text-xs font-medium text-gray-600 w-12">#</th>
                          <th className="text-left px-2 py-1.5 border border-gray-200 text-xs font-medium text-gray-600">Name</th>
                          <th className="text-left px-2 py-1.5 border border-gray-200 text-xs font-medium text-gray-600">Program</th>
                          <th className="text-left px-2 py-1.5 border border-gray-200 text-xs font-medium text-gray-600">Type</th>
                          <th className="text-right px-2 py-1.5 border border-gray-200 text-xs font-medium text-gray-600">Runtime</th>
                          <th className="text-center px-2 py-1.5 border border-gray-200 text-xs font-medium text-gray-600">Order</th>
                          <th className="text-center px-2 py-1.5 border border-gray-200 text-xs font-medium text-gray-600">Status</th>
                          <th className="text-left px-2 py-1.5 border border-gray-200 text-xs font-medium text-gray-600">Notes</th>
                          <th className="w-16 border border-gray-200"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {zones.map((zone) => (
                          <ZoneRow
                            key={zone.id}
                            zone={zone}
                            programs={programs}
                            controllerId={controller.id}
                            onSaved={() => {}}
                            onDeleted={() => {}}
                            onDraftChange={handleZoneDraftChange}
                            canEditZone={canEditZones}
                            canDeleteZone={canManageControllers}
                          />
                        ))}
                        {canEditZones && (
                          <AddZoneRow
                            controllerId={controller.id}
                            programs={programs}
                            nextZoneNumber={nextZoneNumber}
                            onAdded={() => {}}
                          />
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* ── Run-time schedule ── */}
              {(draftPrograms.length > 0 || draftZones.length > 0) && (
                <section>
                  <h3 className="font-medium text-sm text-gray-700 mb-3">Auto Run-Time Schedule</h3>
                  <div className="bg-gray-50 rounded-lg p-3">
                    <RunSchedulePanel programs={draftPrograms} zones={draftZones} />
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      )}

      {/* Delete confirmation */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Controller "{controller.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this controller, all its programs, zones, and history
              snapshots. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => deleteMutation.mutate()}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── IrrigationControllerGrid (exported shared component) ─────────────────────

export interface IrrigationControllerGridProps {
  controllers: IrrigationController[];
  customerId: number;
  canManageControllers: boolean;
  canEditZones: boolean;
  onRefreshList?: () => void;
}

export function IrrigationControllerGrid({
  controllers,
  customerId,
  canManageControllers,
  canEditZones,
  onRefreshList,
}: IrrigationControllerGridProps) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const handleToggle = (id: number) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  if (controllers.length === 0) {
    return null;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {controllers.map((ctrl) => (
        <div
          key={ctrl.id}
          className={expandedId === ctrl.id ? "md:col-span-2" : ""}
        >
          <ControllerGridTile
            controller={ctrl}
            customerId={customerId}
            canManageControllers={canManageControllers}
            canEditZones={canEditZones}
            isExpanded={expandedId === ctrl.id}
            onToggle={() => handleToggle(ctrl.id)}
            onRefreshList={onRefreshList ?? (() => {})}
          />
        </div>
      ))}
    </div>
  );
}
