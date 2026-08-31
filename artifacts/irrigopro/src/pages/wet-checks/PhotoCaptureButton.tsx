import { useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Loader2, Camera, ImageIcon } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  PHOTO_OFFLINE_MESSAGE,
  isProbablyOffline,
  isOfflinePhotosEnabled,
  ensurePersistentStorage,
  queuePhotoUpload,
} from "@/lib/offline/api";
import { photoErrorMessage } from "@/lib/offline/connection-errors";
import type { WetCheckPhoto } from "@workspace/db/schema";
import { newClientId, uploadPhotoToStorage } from "./helpers";

// Compact photo capture button. Wraps a file input with camera capture and
// posts the resulting URL to /api/wet-checks/:id/photos with a client-side
// takenAt so true camera time survives offline-then-sync.
export function PhotoCaptureButton({
  wetCheckId,
  wetCheckClientId,
  zoneRecordId,
  zoneRecordClientId,
  findingId,
  findingClientId,
  onUploaded,
  skipInvalidate,
  testIdSuffix,
}: {
  wetCheckId: number;
  // 4C — when the OFFLINE_PHOTOS flag is on, the captured Blob is queued
  // through the offline engine using these clientIds as parents. The
  // wet-check clientId is required to take the offline path; without it
  // we fall back to the direct online sign→PUT→finalize flow.
  wetCheckClientId?: string | null;
  zoneRecordId?: number | null;
  zoneRecordClientId?: string | null;
  findingId?: number | null;
  findingClientId?: string | null;
  onUploaded?: (photo: WetCheckPhoto) => void;
  skipInvalidate?: boolean;
  testIdSuffix?: string;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  // Tracks batch progress for multi-photo library picks.
  // null when idle or uploading a single photo.
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const libraryInputRef = useRef<HTMLInputElement | null>(null);

  // Upload one file through whichever path is active (offline-queue or direct).
  // Does not fire a toast or invalidate — caller handles that so batches can
  // suppress per-photo noise and fire one message at the end.
  // Returns the optimistic/created photo on success, throws on failure.
  const uploadOneFile = async (file: File, suppressInvalidate: boolean): Promise<WetCheckPhoto> => {
    if (isOfflinePhotosEnabled() && wetCheckClientId) {
      const queued = await queuePhotoUpload({
        file,
        wetCheckClientId,
        wetCheckId,
        zoneRecordClientId: zoneRecordClientId ?? null,
        zoneRecordId: zoneRecordId ?? null,
        findingClientId: findingClientId ?? null,
        findingId: findingId ?? null,
      });
      if (!suppressInvalidate) {
        queryClient.invalidateQueries({ queryKey: ["/api/wet-checks", wetCheckId] });
      }
      const optimistic: WetCheckPhoto = {
        id: -Date.now(),
        wetCheckId,
        url: queued.localUrl || "",
        takenAt: new Date().toISOString(),
        zoneRecordId: zoneRecordId ?? null,
        findingId: findingId ?? null,
        clientId: queued.clientId,
        findingClientId: findingClientId ?? null,
        zoneRecordClientId: zoneRecordClientId ?? null,
      } as unknown as WetCheckPhoto;
      onUploaded?.(optimistic);
      return optimistic;
    }
    // Legacy direct-upload path (offline photos flag off).
    const takenAt = file.lastModified
      ? new Date(file.lastModified).toISOString()
      : new Date().toISOString();
    const url = await uploadPhotoToStorage(file);
    const created: WetCheckPhoto = await apiRequest(
      `/api/wet-checks/${wetCheckId}/photos`,
      "POST",
      {
        url,
        takenAt,
        zoneRecordId: zoneRecordId ?? null,
        findingId: findingId ?? null,
        clientId: newClientId(),
      },
    );
    if (!suppressInvalidate) {
      queryClient.invalidateQueries({ queryKey: ["/api/wet-checks", wetCheckId] });
    }
    onUploaded?.(created);
    return created;
  };

  // ── Camera handler (always single-file) ─────────────────────────────────────
  const onPickCamera = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    // 4C offline guard
    if (isOfflinePhotosEnabled() && wetCheckClientId) {
      void ensurePersistentStorage().then((s) => {
        if (s.quotaTight) {
          toast({
            title: "Storage almost full",
            description:
              "Free up space on your device — queued photos may not save.",
            variant: "destructive",
          });
        }
      });
    } else if (isProbablyOffline()) {
      toast({
        title: "Photo not captured",
        description: PHOTO_OFFLINE_MESSAGE,
        variant: "destructive",
      });
      return;
    }

    setBusy(true);
    try {
      await uploadOneFile(file, skipInvalidate ?? false);
      toast({
        title: isProbablyOffline() ? "Photo queued offline" : "Photo attached",
        description: isProbablyOffline()
          ? "Will upload when you're back online."
          : undefined,
      });
    } catch (err: any) {
      toast({
        title: "Photo capture failed",
        description: photoErrorMessage(err),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  // ── Library handler (supports multiple selection) ────────────────────────────
  const onPickLibrary = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    e.target.value = "";

    // Offline guard before we do any work
    if (!isOfflinePhotosEnabled() && isProbablyOffline()) {
      toast({
        title: "Photos not captured",
        description: PHOTO_OFFLINE_MESSAGE,
        variant: "destructive",
      });
      return;
    }

    if (isOfflinePhotosEnabled() && wetCheckClientId) {
      void ensurePersistentStorage().then((s) => {
        if (s.quotaTight) {
          toast({
            title: "Storage almost full",
            description:
              "Free up space on your device — queued photos may not save.",
            variant: "destructive",
          });
        }
      });
    }

    setBusy(true);

    // Single-file path: keep the same single-upload toast behaviour
    if (files.length === 1) {
      try {
        await uploadOneFile(files[0], skipInvalidate ?? false);
        toast({
          title: isProbablyOffline() ? "Photo queued offline" : "Photo attached",
          description: isProbablyOffline()
            ? "Will upload when you're back online."
            : undefined,
        });
      } catch (err: any) {
        toast({
          title: "Photo upload failed",
          description: photoErrorMessage(err),
          variant: "destructive",
        });
      } finally {
        setBusy(false);
      }
      return;
    }

    // Multi-file batch: suppress per-file invalidation and toasts.
    // Show "N / M" progress in the button label while processing.
    setBatchProgress({ done: 0, total: files.length });
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < files.length; i++) {
      setBatchProgress({ done: i + 1, total: files.length });
      try {
        await uploadOneFile(files[i], /* suppressInvalidate */ true);
        successCount++;
      } catch {
        failCount++;
      }
    }

    // Single invalidation for the whole batch
    if (!skipInvalidate) {
      queryClient.invalidateQueries({ queryKey: ["/api/wet-checks", wetCheckId] });
    }

    // Summary toast
    const offline = isProbablyOffline();
    if (failCount === 0) {
      toast({
        title: offline
          ? `${successCount} photo${successCount === 1 ? "" : "s"} queued offline`
          : `${successCount} photo${successCount === 1 ? "" : "s"} attached`,
        description: offline ? "Will upload when you're back online." : undefined,
      });
    } else if (successCount > 0) {
      toast({
        title: `${successCount} of ${files.length} photos attached — ${failCount} failed`,
        variant: "destructive",
      });
    } else {
      toast({
        title: "Photos couldn't be attached",
        description: "None of the selected photos uploaded successfully. Try again.",
        variant: "destructive",
      });
    }

    setBatchProgress(null);
    setBusy(false);
  };

  const suffix = testIdSuffix ?? `${zoneRecordId ?? findingId ?? "wc"}`;
  const buttonLabel = batchProgress
    ? `${batchProgress.done} / ${batchProgress.total}`
    : "Photo";

  return (
    <>
      {/* Camera input — `capture="environment"` opens the rear camera live.
          No `multiple` here: camera captures one shot at a time. */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={onPickCamera}
        data-testid={`photo-input-${suffix}`}
      />
      {/* Library input — `multiple` allows selecting several at once. */}
      <input
        ref={libraryInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={onPickLibrary}
        data-testid={`photo-input-library-${suffix}`}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={busy}
            className="min-h-[44px] tabular-nums"
            data-testid={`btn-photo-${suffix}`}
          >
            {busy ? (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            ) : (
              <Camera className="w-4 h-4 mr-1" />
            )}
            {buttonLabel}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              cameraInputRef.current?.click();
            }}
            data-testid={`btn-photo-${suffix}-camera`}
          >
            <Camera className="w-4 h-4 mr-2" />
            Take Photo
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              libraryInputRef.current?.click();
            }}
            data-testid={`btn-photo-${suffix}-library`}
          >
            <ImageIcon className="w-4 h-4 mr-2" />
            Choose from Library
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
