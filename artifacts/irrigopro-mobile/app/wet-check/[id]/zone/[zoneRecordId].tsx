import { Feather } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { LoadingScreen } from "@/components/Loading";
import { useColors } from "@/hooks/useColors";
import { ApiError, apiRequest } from "@/lib/api";
import {
  captureZonePhoto,
  deleteLocalPhoto,
  ensureCameraPermission,
  ensureMediaLibraryPermission,
  LocalPhoto,
  pickZonePhotoFromLibrary,
} from "@/lib/photo-upload";
import { friendlyErrorMessage } from "@/lib/toast";
import { useScopeConflictTick } from "@/lib/sync/use-sync-status";
import {
  WetCheckConflictError,
  wetCheckDetailQueryKey,
  wetCheckIssueTypesQueryKey,
  wetCheckMutate,
  wetCheckMutationKey,
  wetCheckPartsByIssueQueryKey,
} from "@/lib/wet-check";

type WetCheckPhoto = {
  id: number;
  wetCheckId: number;
  zoneRecordId: number | null;
  findingId: number | null;
  url: string;
  caption: string | null;
  takenAt: string | null;
};

type WetCheckFinding = {
  id: number;
  zoneRecordId: number;
  issueType: string;
  resolution: string;
  partId: number | null;
  partName: string | null;
  partPrice: string | null;
  quantity: number;
  laborHours: string | null;
  notes: string | null;
};

type ZoneStatus =
  | "not_checked"
  | "checked_ok"
  | "checked_with_issues"
  | "not_applicable";

type WetCheckZoneRecord = {
  id: number;
  wetCheckId: number;
  controllerLetter: string;
  zoneNumber: number;
  status: ZoneStatus;
  markedCompleteAt: string | null;
  notes: string | null;
  observedPressure: string | null;
  observedFlow: string | null;
  ranSuccessfully: boolean | null;
  findings: WetCheckFinding[];
};

type WetCheckDetail = {
  id: number;
  customerId: number;
  customerName: string;
  status: string;
  zoneRecords: WetCheckZoneRecord[];
  photos: WetCheckPhoto[];
  /** Task #1856: resolved controllers from irrigation_controllers (letter + name + zone count). */
  controllers?: Array<{ letter: string; name: string; zoneCount: number | null }>;
};

type IssueTypeConfig = {
  id: number;
  issueType: string;
  issueGroup: string;
  displayLabel: string;
  defaultLaborHours: string;
  partCategoryFilter: string | null;
  isActive: boolean;
  sortOrder: number;
};

type Part = {
  id: number;
  name: string;
  description: string | null;
  price: string;
  category: string;
};

type PartsByIssueResponse = {
  parts: Part[];
  recentPartIds: number[];
};

const ZONE_STATUS_LABELS: Record<ZoneStatus, string> = {
  checked_ok: "Ran OK",
  checked_with_issues: "Needs work",
  not_applicable: "Skipped (N/A)",
  not_checked: "Not checked",
};

const ZONE_STATUS_OPTIONS: ReadonlyArray<{ value: ZoneStatus; tone: { bg: string; fg: string } }> = [
  { value: "checked_ok", tone: { bg: "#16a34a", fg: "#ffffff" } },
  { value: "checked_with_issues", tone: { bg: "#dc2626", fg: "#ffffff" } },
  { value: "not_applicable", tone: { bg: "#9ca3af", fg: "#ffffff" } },
  { value: "not_checked", tone: { bg: "#e5e7eb", fg: "#374151" } },
];

const FINDING_RESOLUTION_LABELS: Record<string, string> = {
  pending: "Pending decision",
  repaired_in_field: "Completed in field",
  sent_to_estimate: "Sent to estimate",
  deferred_to_work_order: "Deferred to work order",
  documented_only: "Documented only",
};

function prettyIssueType(s: string): string {
  return s
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function zoneStatusColor(status: string, colors: ReturnType<typeof useColors>) {
  switch (status) {
    case "checked_ok":
      return { bg: "#16a34a", fg: "#ffffff" };
    case "checked_with_issues":
      return { bg: "#dc2626", fg: "#ffffff" };
    case "not_applicable":
      return { bg: "#9ca3af", fg: "#ffffff" };
    default:
      return { bg: colors.secondary, fg: colors.secondaryForeground };
  }
}

export default function ZoneDetailScreen() {
  const colors = useColors();
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ id: string; zoneRecordId: string }>();
  const wetCheckId = useMemo(() => {
    const n = Number(params.id);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [params.id]);
  const zoneRecordId = useMemo(() => {
    const n = Number(params.zoneRecordId);
    // Accept negative ids: offline-queued zone records use a temporary negative
    // id until the creation request drains and the server assigns a real id.
    return Number.isFinite(n) && n !== 0 ? n : null;
  }, [params.zoneRecordId]);

  const [conflict, setConflict] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  // Inline error banners for the zone screen — we surface mutation failures
  // here instead of via native Alerts so the error stays visible while the
  // tech retries (and matches the task's "validation errors via inline UX"
  // language).
  const [statusError, setStatusError] = useState<string | null>(null);
  const [findingError, setFindingError] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [localPhotos, setLocalPhotos] = useState<LocalPhoto[]>([]);
  // Counter shown while pickZonePhotoFromLibrary is compressing photos so the
  // tech can see "Processing X of Y…" instead of a frozen screen. null = idle.
  const [processingLibrary, setProcessingLibrary] = useState<{ done: number; total: number } | null>(null);
  // Tracks how many photos in the current batch are still awaiting onSuccess so
  // we can fire a single queryClient.invalidateQueries after the last one
  // instead of one per photo (which causes a re-render storm on 50-photo batches).
  const pendingBatchCountRef = React.useRef(0);

  // Surface 409s discovered by background queue drains in the same
  // conflict banner as inline-mutation conflicts.
  const conflictTick = useScopeConflictTick(
    wetCheckId != null ? `wc:${wetCheckId}` : null,
  );
  useEffect(() => {
    if (conflictTick > 0) setConflict(true);
  }, [conflictTick]);

  const detailQuery = useQuery({
    queryKey:
      wetCheckId != null
        ? wetCheckDetailQueryKey(wetCheckId)
        : ["wet-check", "missing"],
    enabled: wetCheckId != null,
    queryFn: () => apiRequest<WetCheckDetail>(`/api/wet-checks/${wetCheckId}`),
    staleTime: 30_000,
  });

  const wc = detailQuery.data;

  const zone = useMemo<WetCheckZoneRecord | undefined>(() => {
    if (!wc || zoneRecordId == null) return undefined;
    return wc.zoneRecords.find((z) => z.id === zoneRecordId);
  }, [wc, zoneRecordId]);

  // Prefetch and cache the company's issue types as soon as we land on a
  // zone — the M5 finding editor needs them, and React Query keeps them
  // around for the rest of the wet-check session.
  useQuery({
    queryKey: wetCheckIssueTypesQueryKey,
    queryFn: () => apiRequest<IssueTypeConfig[]>("/api/wet-checks/issue-types"),
    staleTime: 5 * 60_000,
    enabled: wetCheckId != null,
  });

  const isLocked = wc != null && wc.status !== "in_progress";

  const zonePhotos = useMemo<WetCheckPhoto[]>(() => {
    if (!wc || zoneRecordId == null) return [];
    const findingIds = new Set(
      wc.zoneRecords
        .find((z) => z.id === zoneRecordId)
        ?.findings.map((f) => f.id) ?? [],
    );
    return wc.photos.filter(
      (p) => p.zoneRecordId === zoneRecordId || (p.findingId != null && findingIds.has(p.findingId)),
    );
  }, [wc, zoneRecordId]);

  // Task #1856: show letter + controller name + zone count in header.
  const controllerForZone = useMemo(() => {
    if (!wc?.controllers || !zone) return undefined;
    return wc.controllers.find((c) => c.letter === zone.controllerLetter);
  }, [wc, zone]);

  const headerTitle = zone
    ? controllerForZone
      ? `${controllerForZone.letter} — ${controllerForZone.name} (${controllerForZone.zoneCount ?? "?"} zones) · Zone ${zone.zoneNumber ?? "?"}`
      : `Controller ${zone.controllerLetter} · Zone ${zone.zoneNumber ?? "?"}`
    : "Zone";

  // ─── Mutations ─────────────────────────────────────────────────────────

  const handleConflict = useCallback(() => {
    setConflict(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(
      () => undefined,
    );
  }, []);

  // Returns an error message to surface inline. Returns null if the error was
  // already handled (e.g. 409 conflict shows the banner instead).
  const errorMessage = useCallback((err: unknown): string | null => {
    if (err instanceof WetCheckConflictError) {
      handleConflict();
      return null;
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(
      () => undefined,
    );
    return friendlyErrorMessage(err, "Something went wrong");
  }, [handleConflict]);

  // ── Zone status PATCH (optimistic) ──
  const statusMutation = useMutation({
    mutationKey:
      wetCheckId != null && zoneRecordId != null
        ? wetCheckMutationKey(wetCheckId, "zone-status", zoneRecordId)
        : ["wet-check", "mutation", -1, "zone-status"],
    mutationFn: async (next: ZoneStatus) => {
      if (zoneRecordId == null) throw new Error("Missing zone id");
      return wetCheckMutate<WetCheckZoneRecord, { status: ZoneStatus }>({
        path: `/api/wet-checks/zone-records/${zoneRecordId}`,
        method: "PATCH",
        body: { status: next },
        wetCheckId: wetCheckId ?? undefined,
        label: "Update zone status",
      });
    },
    onMutate: async (next) => {
      if (wetCheckId == null || zoneRecordId == null) return { previous: undefined };
      await queryClient.cancelQueries({ queryKey: wetCheckDetailQueryKey(wetCheckId) });
      const previous = queryClient.getQueryData<WetCheckDetail>(
        wetCheckDetailQueryKey(wetCheckId),
      );
      if (previous) {
        queryClient.setQueryData<WetCheckDetail>(
          wetCheckDetailQueryKey(wetCheckId),
          {
            ...previous,
            zoneRecords: previous.zoneRecords.map((z) =>
              z.id === zoneRecordId
                ? {
                    ...z,
                    status: next,
                    // Mirror the server: leaving Needs Work clears the badge.
                    markedCompleteAt:
                      next === "checked_with_issues" ? z.markedCompleteAt : null,
                  }
                : z,
            ),
          },
        );
      }
      return { previous };
    },
    onSuccess: () => {
      setStatusError(null);
      Haptics.selectionAsync().catch(() => undefined);
    },
    onError: (err, _next, ctx) => {
      if (wetCheckId != null && ctx?.previous) {
        queryClient.setQueryData(wetCheckDetailQueryKey(wetCheckId), ctx.previous);
      }
      const m = errorMessage(err);
      if (m != null) setStatusError(m);
    },
    onSettled: () => {
      if (wetCheckId != null) {
        queryClient.invalidateQueries({ queryKey: wetCheckDetailQueryKey(wetCheckId) });
      }
    },
  });

  // ── Add finding (POST) ──
  const addFindingMutation = useMutation({
    mutationKey:
      wetCheckId != null && zoneRecordId != null
        ? wetCheckMutationKey(wetCheckId, "finding-add", zoneRecordId)
        : ["wet-check", "mutation", -1, "finding-add"],
    mutationFn: async (input: {
      issueType: string;
      partId: number | null;
      partName: string | null;
      partPrice: string | null;
      quantity: number;
      laborHours: string;
      notes: string | null;
    }) => {
      if (zoneRecordId == null) throw new Error("Missing zone id");
      return wetCheckMutate<WetCheckFinding, typeof input>({
        path: `/api/wet-checks/zone-records/${zoneRecordId}/findings`,
        method: "POST",
        body: input,
        wetCheckId: wetCheckId ?? undefined,
        label: "Add finding",
      });
    },
    onMutate: async (input) => {
      if (wetCheckId == null || zoneRecordId == null) return { previous: undefined };
      await queryClient.cancelQueries({ queryKey: wetCheckDetailQueryKey(wetCheckId) });
      const previous = queryClient.getQueryData<WetCheckDetail>(
        wetCheckDetailQueryKey(wetCheckId),
      );
      if (previous) {
        const placeholder: WetCheckFinding = {
          id: -1,
          zoneRecordId: zoneRecordId,
          issueType: input.issueType,
          partId: input.partId,
          partName: input.partName,
          partPrice: input.partPrice,
          quantity: input.quantity,
          laborHours: input.laborHours,
          notes: input.notes,
          resolution: "needs_manager_review",
        };
        queryClient.setQueryData<WetCheckDetail>(
          wetCheckDetailQueryKey(wetCheckId),
          {
            ...previous,
            zoneRecords: previous.zoneRecords.map((z) =>
              z.id === zoneRecordId
                ? { ...z, findings: [...z.findings, placeholder] }
                : z,
            ),
          },
        );
      }
      return { previous };
    },
    onSuccess: () => {
      setFindingError(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => undefined,
      );
      setEditorOpen(false);
    },
    onError: (err, _input, ctx) => {
      if (wetCheckId != null && ctx?.previous) {
        queryClient.setQueryData(wetCheckDetailQueryKey(wetCheckId), ctx.previous);
      }
      const m = errorMessage(err);
      if (m != null) setFindingError(m);
    },
    onSettled: () => {
      if (wetCheckId != null) {
        queryClient.invalidateQueries({ queryKey: wetCheckDetailQueryKey(wetCheckId) });
      }
    },
  });

  // ── Delete finding ──
  // All delete-finding mutations on this zone share one key (no per-finding
  // subId): there's no useMutation-per-row, and any successful delete is a
  // strong signal that the tech has recovered from the prior delete error.
  const deleteFindingMutation = useMutation({
    mutationKey:
      wetCheckId != null
        ? wetCheckMutationKey(wetCheckId, "finding-delete")
        : ["wet-check", "mutation", -1, "finding-delete"],
    mutationFn: async (findingId: number) => {
      return wetCheckMutate<{ ok: boolean }>({
        path: `/api/wet-checks/findings/${findingId}`,
        method: "DELETE",
        wetCheckId: wetCheckId ?? undefined,
        label: "Remove finding",
      });
    },
    onSuccess: () => {
      setFindingError(null);
      Haptics.selectionAsync().catch(() => undefined);
      if (wetCheckId != null) {
        queryClient.invalidateQueries({ queryKey: wetCheckDetailQueryKey(wetCheckId) });
      }
    },
    onError: (err) => {
      const m = errorMessage(err);
      if (m != null) setFindingError(m);
    },
  });


  // ── Delete server photo (optimistic) ──
  const deletePhotoMutation = useMutation({
    mutationKey:
      wetCheckId != null
        ? wetCheckMutationKey(wetCheckId, "photo-delete")
        : ["wet-check", "mutation", -1, "photo-delete"],
    mutationFn: async (photoId: number) => {
      return wetCheckMutate<{ ok: boolean }>({
        path: `/api/wet-checks/photos/${photoId}`,
        method: "DELETE",
        wetCheckId: wetCheckId ?? undefined,
        label: "Remove photo",
      });
    },
    onMutate: async (photoId) => {
      if (wetCheckId == null) return { previous: undefined };
      await queryClient.cancelQueries({
        queryKey: wetCheckDetailQueryKey(wetCheckId),
      });
      const previous = queryClient.getQueryData<WetCheckDetail>(
        wetCheckDetailQueryKey(wetCheckId),
      );
      if (previous) {
        queryClient.setQueryData<WetCheckDetail>(
          wetCheckDetailQueryKey(wetCheckId),
          {
            ...previous,
            photos: previous.photos.filter((p) => p.id !== photoId),
          },
        );
      }
      return { previous };
    },
    onSuccess: () => {
      setPhotoError(null);
      Haptics.selectionAsync().catch(() => undefined);
    },
    onError: (err, _photoId, ctx) => {
      if (wetCheckId != null && ctx?.previous) {
        queryClient.setQueryData(
          wetCheckDetailQueryKey(wetCheckId),
          ctx.previous,
        );
      }
      const m = errorMessage(err);
      if (m != null) setPhotoError(m);
    },
    onSettled: () => {
      if (wetCheckId != null) {
        queryClient.invalidateQueries({
          queryKey: wetCheckDetailQueryKey(wetCheckId),
        });
      }
    },
  });

  const onRemoveServerPhoto = useCallback(
    (photo: WetCheckPhoto) => {
      Alert.alert("Remove photo?", "Remove this photo from the wet check?", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => deletePhotoMutation.mutate(photo.id),
        },
      ]);
    },
    [deletePhotoMutation],
  );

  // ── Add photo (wet-check-photo queue entry) ──
  const addPhotoMutation = useMutation({
    mutationKey:
      wetCheckId != null && zoneRecordId != null
        ? wetCheckMutationKey(wetCheckId, "photo-add", zoneRecordId)
        : ["wet-check", "mutation", -1, "photo-add"],
    mutationFn: async (photo: LocalPhoto) => {
      if (wetCheckId == null || zoneRecordId == null)
        throw new Error("Missing ids");
      return wetCheckMutate({
        path: `/api/wet-checks/${wetCheckId}/photos`,
        method: "POST",
        isPhoto: true,
        id: photo.clientId,
        wetCheckId,
        label: "Add zone photo",
        photo: {
          localUri: photo.localUri,
          takenAt: photo.takenAt,
          zoneRecordId: photo.zoneRecordId,
          findingId: photo.findingId,
        },
      });
    },
    onSuccess: (_result, photo) => {
      setPhotoError(null);
      Haptics.selectionAsync().catch(() => undefined);
      setLocalPhotos((prev) =>
        prev.filter((p) => p.clientId !== photo.clientId),
      );
      // Batch-aware invalidation: when multiple photos are queued at once,
      // decrement the counter and only invalidate after the last one settles
      // so a 50-photo upload doesn't cause 50 sequential re-renders.
      if (pendingBatchCountRef.current > 1) {
        pendingBatchCountRef.current -= 1;
      } else {
        pendingBatchCountRef.current = 0;
        if (wetCheckId != null) {
          queryClient.invalidateQueries({
            queryKey: wetCheckDetailQueryKey(wetCheckId),
          });
        }
      }
    },
    onError: (err, photo) => {
      // Count an error as "settled" so the final invalidation still fires
      // even when some uploads in a batch fail.
      if (pendingBatchCountRef.current > 1) {
        pendingBatchCountRef.current -= 1;
      } else {
        pendingBatchCountRef.current = 0;
        if (wetCheckId != null) {
          queryClient.invalidateQueries({
            queryKey: wetCheckDetailQueryKey(wetCheckId),
          });
        }
      }
      setLocalPhotos((prev) =>
        prev.filter((p) => p.clientId !== photo.clientId),
      );
      deleteLocalPhoto(photo.localUri);
      const m = errorMessage(err);
      if (m != null) setPhotoError(m);
    },
  });

  const onAddZonePhoto = useCallback(() => {
    if (isLocked || wetCheckId == null || zoneRecordId == null) return;
    setPhotoError(null);

    const captureFromCamera = async () => {
      const perm = await ensureCameraPermission();
      if (perm !== "granted") {
        Alert.alert(
          "Camera Access Required",
          perm === "blocked"
            ? "Camera access is blocked. Enable it in Settings to take photos."
            : "Camera permission is required to take photos.",
          perm === "blocked"
            ? [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Open Settings",
                  onPress: () => Linking.openSettings(),
                },
              ]
            : [{ text: "OK" }],
        );
        return;
      }
      let photo: LocalPhoto | null = null;
      try {
        photo = await captureZonePhoto({
          wetCheckId,
          zoneRecordId,
          findingId: null,
        });
      } catch (err) {
        setPhotoError(friendlyErrorMessage(err, "Couldn't open the camera"));
        return;
      }
      if (!photo) return;
      setLocalPhotos((prev) => [...prev, photo!]);
      addPhotoMutation.mutate(photo);
    };

    const pickFromLibrary = async () => {
      const perm = await ensureMediaLibraryPermission();
      if (perm !== "granted") {
        Alert.alert(
          "Library Access Required",
          perm === "blocked"
            ? "Photo library access is blocked. Enable it in Settings."
            : "Photo library permission is required to pick photos.",
          perm === "blocked"
            ? [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Open Settings",
                  onPress: () => Linking.openSettings(),
                },
              ]
            : [{ text: "OK" }],
        );
        return;
      }
      let photos: LocalPhoto[] = [];
      try {
        photos = await pickZonePhotoFromLibrary({
          wetCheckId,
          zoneRecordId,
          findingId: null,
          onProgress: (done, total) =>
            setProcessingLibrary({ done, total }),
        });
      } catch (err) {
        setPhotoError(
          friendlyErrorMessage(err, "Couldn't open the photo library"),
        );
        return;
      } finally {
        setProcessingLibrary(null);
      }
      if (photos.length === 0) return;
      pendingBatchCountRef.current = photos.length;
      setLocalPhotos((prev) => [...prev, ...photos]);
      for (const photo of photos) {
        addPhotoMutation.mutate(photo);
      }
    };

    Alert.alert("Add Photo", undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Take Photo", onPress: captureFromCamera },
      {
        text: "Choose from Library (select multiple)",
        onPress: pickFromLibrary,
      },
    ]);
  }, [isLocked, wetCheckId, zoneRecordId, addPhotoMutation]);

  const onAddFindingPhoto = useCallback(
    (findingId: number) => {
      if (isLocked || wetCheckId == null || zoneRecordId == null) return;
      setPhotoError(null);

      const captureFromCamera = async () => {
        const perm = await ensureCameraPermission();
        if (perm !== "granted") {
          Alert.alert(
            "Camera Access Required",
            perm === "blocked"
              ? "Camera access is blocked. Enable it in Settings to take photos."
              : "Camera permission is required to take photos.",
            perm === "blocked"
              ? [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Open Settings",
                    onPress: () => Linking.openSettings(),
                  },
                ]
              : [{ text: "OK" }],
          );
          return;
        }
        let photo: LocalPhoto | null = null;
        try {
          photo = await captureZonePhoto({
            wetCheckId,
            zoneRecordId,
            findingId,
          });
        } catch (err) {
          setPhotoError(friendlyErrorMessage(err, "Couldn't open the camera"));
          return;
        }
        if (!photo) return;
        setLocalPhotos((prev) => [...prev, photo!]);
        addPhotoMutation.mutate(photo);
      };

      const pickFromLibrary = async () => {
        const perm = await ensureMediaLibraryPermission();
        if (perm !== "granted") {
          Alert.alert(
            "Library Access Required",
            perm === "blocked"
              ? "Photo library access is blocked. Enable it in Settings."
              : "Photo library permission is required to pick photos.",
            perm === "blocked"
              ? [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Open Settings",
                    onPress: () => Linking.openSettings(),
                  },
                ]
              : [{ text: "OK" }],
          );
          return;
        }
        let photos: LocalPhoto[] = [];
        try {
          photos = await pickZonePhotoFromLibrary({
            wetCheckId,
            zoneRecordId,
            findingId,
            onProgress: (done, total) =>
              setProcessingLibrary({ done, total }),
          });
        } catch (err) {
          setPhotoError(
            friendlyErrorMessage(err, "Couldn't open the photo library"),
          );
          return;
        } finally {
          setProcessingLibrary(null);
        }
        if (photos.length === 0) return;
        pendingBatchCountRef.current = photos.length;
        setLocalPhotos((prev) => [...prev, ...photos]);
        for (const photo of photos) {
          addPhotoMutation.mutate(photo);
        }
      };

      Alert.alert("Add Finding Photo", undefined, [
        { text: "Cancel", style: "cancel" },
        { text: "Take Photo", onPress: captureFromCamera },
        { text: "Choose from Library", onPress: pickFromLibrary },
      ]);
    },
    [isLocked, wetCheckId, zoneRecordId, addPhotoMutation],
  );

  const onRemoveFinding = useCallback(
    (finding: WetCheckFinding) => {
      Alert.alert(
        "Remove finding?",
        `Remove "${prettyIssueType(finding.issueType)}" from this zone?`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Remove",
            style: "destructive",
            onPress: () => deleteFindingMutation.mutate(finding.id),
          },
        ],
      );
    },
    [deleteFindingMutation],
  );

  return (
    <>
      <Stack.Screen
        options={{
          title: headerTitle,
          headerStyle: { backgroundColor: colors.background },
          headerTitleStyle: { color: colors.foreground },
          headerTintColor: colors.primary,
        }}
      />
      <SafeAreaView
        style={[styles.safe, { backgroundColor: colors.background }]}
        edges={["left", "right", "bottom"]}
      >
        {wetCheckId == null || zoneRecordId == null ? (
          <View style={styles.center}>
            <Text style={[styles.errorTitle, { color: colors.foreground }]}>
              Invalid zone
            </Text>
            <PrimaryButton label="Go back" colors={colors} onPress={() => router.back()} />
          </View>
        ) : detailQuery.isLoading ? (
          <LoadingScreen />
        ) : detailQuery.isError || !wc ? (
          <View style={styles.center}>
            <Feather name="alert-circle" size={32} color={colors.destructive} />
            <Text style={[styles.errorTitle, { color: colors.foreground }]}>
              Couldn't load zone
            </Text>
            <Text style={[styles.errorBody, { color: colors.mutedForeground }]}>
              {friendlyErrorMessage(detailQuery.error)}
            </Text>
            <PrimaryButton label="Try again" colors={colors} onPress={() => detailQuery.refetch()} />
          </View>
        ) : !zone ? (
          <View style={styles.center}>
            <Text style={[styles.errorTitle, { color: colors.foreground }]}>
              Zone not found
            </Text>
            <Text style={[styles.errorBody, { color: colors.mutedForeground }]}>
              This zone is no longer part of the wet check.
            </Text>
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={styles.scroll}
            refreshControl={
              <RefreshControl
                refreshing={detailQuery.isRefetching}
                onRefresh={() => {
                  setConflict(false);
                  detailQuery.refetch();
                }}
                tintColor={colors.primary}
              />
            }
          >
            {conflict ? (
              <ConflictBanner
                colors={colors}
                onRefresh={() => {
                  setConflict(false);
                  detailQuery.refetch();
                }}
              />
            ) : null}

            <ZoneStatusCard zone={zone} colors={colors} photoCount={zonePhotos.length} />

            <Section title="Zone status" colors={colors}>
              {statusError ? (
                <InlineErrorBanner
                  colors={colors}
                  message={statusError}
                  onDismiss={() => setStatusError(null)}
                />
              ) : null}
              <View style={styles.statusGroup}>
                {ZONE_STATUS_OPTIONS.map((opt) => {
                  const selected = zone.status === opt.value;
                  const disabled =
                    isLocked ||
                    (statusMutation.isPending && statusMutation.variables !== opt.value);
                  return (
                    <Pressable
                      key={opt.value}
                      onPress={() => {
                        if (isLocked || zone.status === opt.value) return;
                        statusMutation.mutate(opt.value);
                      }}
                      disabled={disabled}
                      accessibilityRole="radio"
                      accessibilityState={{ selected, disabled }}
                      accessibilityLabel={ZONE_STATUS_LABELS[opt.value]}
                      style={({ pressed }) => [
                        styles.statusOption,
                        {
                          backgroundColor: selected ? opt.tone.bg : colors.background,
                          borderColor: selected ? opt.tone.bg : colors.border,
                          opacity: pressed && !disabled ? 0.85 : disabled && !selected ? 0.5 : 1,
                        },
                      ]}
                    >
                      <View
                        style={[
                          styles.radioDot,
                          {
                            borderColor: selected ? opt.tone.fg : colors.mutedForeground,
                            backgroundColor: selected ? opt.tone.fg : "transparent",
                          },
                        ]}
                      />
                      <Text
                        style={[
                          styles.statusOptionText,
                          { color: selected ? opt.tone.fg : colors.foreground },
                        ]}
                      >
                        {ZONE_STATUS_LABELS[opt.value]}
                      </Text>
                      {statusMutation.isPending && statusMutation.variables === opt.value ? (
                        <ActivityIndicator
                          size="small"
                          color={selected ? opt.tone.fg : colors.primary}
                        />
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
              {isLocked ? (
                <Text style={[styles.lockedHint, { color: colors.mutedForeground }]}>
                  This wet check has been submitted — zones are read-only.
                </Text>
              ) : null}
            </Section>

            {zone.notes ? (
              <Section title="Zone notes" colors={colors}>
                <Text style={[styles.bodyText, { color: colors.foreground }]}>
                  {zone.notes}
                </Text>
              </Section>
            ) : null}

            <Section title={`Findings (${zone.findings.length})`} colors={colors}>
              {findingError ? (
                <InlineErrorBanner
                  colors={colors}
                  message={findingError}
                  onDismiss={() => setFindingError(null)}
                />
              ) : null}
              {zone.findings.length === 0 ? (
                <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                  No findings recorded for this zone.
                </Text>
              ) : (
                zone.findings.map((f, idx) => (
                  <View
                    key={f.id}
                    style={[
                      styles.findingRow,
                      idx > 0 && {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: colors.border,
                        paddingTop: 12,
                      },
                    ]}
                  >
                    <View style={styles.findingTopRow}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 }}>
                        <Text style={[styles.findingTitle, { color: colors.foreground }]}>
                          {prettyIssueType(f.issueType)}
                        </Text>
                        {(() => {
                          const fc = zonePhotos.filter((p) => p.findingId === f.id).length;
                          if (fc === 0) return null;
                          return (
                            <View
                              style={{
                                flexDirection: "row",
                                alignItems: "center",
                                gap: 3,
                                paddingHorizontal: 6,
                                paddingVertical: 2,
                                borderRadius: 999,
                                backgroundColor: colors.muted,
                              }}
                              accessibilityLabel={`${fc} photo${fc === 1 ? "" : "s"} on this finding`}
                            >
                              <Feather name="camera" size={10} color={colors.foreground} />
                              <Text style={{ fontSize: 11, fontWeight: "700", color: colors.foreground }}>
                                {fc}
                              </Text>
                            </View>
                          );
                        })()}
                      </View>
                      <View
                        style={[
                          styles.resolutionPill,
                          { backgroundColor: colors.secondary, borderRadius: 999 },
                        ]}
                      >
                        <Text
                          style={[
                            styles.resolutionText,
                            { color: colors.secondaryForeground },
                          ]}
                        >
                          {FINDING_RESOLUTION_LABELS[f.resolution] ?? f.resolution}
                        </Text>
                      </View>
                    </View>
                    {f.partName ? (
                      <DetailLine
                        icon="package"
                        label={`${f.partName} × ${f.quantity}`}
                        colors={colors}
                      />
                    ) : null}
                    {f.laborHours && parseFloat(f.laborHours) > 0 ? (
                      <DetailLine
                        icon="clock"
                        label={`${f.laborHours} labor hr${
                          parseFloat(f.laborHours) === 1 ? "" : "s"
                        }`}
                        colors={colors}
                      />
                    ) : null}
                    {f.notes ? (
                      <Text style={[styles.findingNotes, { color: colors.mutedForeground }]}>
                        {f.notes}
                      </Text>
                    ) : null}
                    {!isLocked ? (
                      <View style={styles.findingActions}>
                        <Pressable
                          onPress={() => onAddFindingPhoto(f.id)}
                          accessibilityRole="button"
                          accessibilityLabel={`Add photo to finding ${prettyIssueType(f.issueType)}`}
                          style={({ pressed }) => [
                            styles.findingPhotoButton,
                            { borderColor: colors.primary, borderRadius: colors.radius - 4, opacity: pressed ? 0.7 : 1 },
                          ]}
                        >
                          <Feather name="camera" size={14} color={colors.primary} />
                          <Text style={[styles.findingPhotoButtonText, { color: colors.primary }]}>
                            Add Photo
                          </Text>
                        </Pressable>
                        <Pressable
                          onPress={() => onRemoveFinding(f)}
                          disabled={
                            deleteFindingMutation.isPending &&
                            deleteFindingMutation.variables === f.id
                          }
                          accessibilityRole="button"
                          accessibilityLabel={`Remove finding ${prettyIssueType(f.issueType)}`}
                          style={({ pressed }) => [
                            styles.removeButton,
                            { opacity: pressed ? 0.7 : 1 },
                          ]}
                        >
                          {deleteFindingMutation.isPending &&
                          deleteFindingMutation.variables === f.id ? (
                            <ActivityIndicator size="small" color={colors.destructive} />
                          ) : (
                            <Feather name="trash-2" size={14} color={colors.destructive} />
                          )}
                          <Text style={[styles.removeButtonText, { color: colors.destructive }]}>
                            Remove
                          </Text>
                        </Pressable>
                      </View>
                    ) : null}
                  </View>
                ))
              )}

              {!isLocked ? (
                <Pressable
                  onPress={() => setEditorOpen(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Add finding"
                  style={({ pressed }) => [
                    styles.addFindingButton,
                    {
                      borderColor: colors.primary,
                      borderRadius: colors.radius - 4,
                      opacity: pressed ? 0.85 : 1,
                    },
                  ]}
                >
                  <Feather name="plus" size={16} color={colors.primary} />
                  <Text style={[styles.addFindingText, { color: colors.primary }]}>
                    Add finding
                  </Text>
                </Pressable>
              ) : null}
            </Section>

            <Section
              title={`Photos (${zonePhotos.length + localPhotos.length})`}
              colors={colors}
            >
              {photoError ? (
                <InlineErrorBanner
                  colors={colors}
                  message={photoError}
                  onDismiss={() => setPhotoError(null)}
                />
              ) : null}
              {processingLibrary != null ? (
                <View style={styles.processingBanner}>
                  <ActivityIndicator size="small" color={colors.primary} />
                  <Text style={[styles.processingBannerText, { color: colors.mutedForeground }]}>
                    Processing {processingLibrary.done} of {processingLibrary.total}…
                  </Text>
                </View>
              ) : null}
              {zonePhotos.length === 0 && localPhotos.length === 0 ? (
                <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                  No photos for this zone.
                </Text>
              ) : (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.photoStrip}
                >
                  {localPhotos.map((p) => (
                    <View
                      key={`local-${p.clientId}`}
                      style={[
                        styles.photoFrame,
                        {
                          borderColor: colors.border,
                          borderRadius: colors.radius - 4,
                          backgroundColor: colors.secondary,
                        },
                      ]}
                    >
                      <Image
                        source={{ uri: p.localUri }}
                        style={styles.photoImage}
                        contentFit="cover"
                        transition={120}
                        cachePolicy="memory"
                        accessibilityLabel="Uploading zone photo"
                      />
                      <View style={styles.photoOverlay} pointerEvents="none">
                        <View style={styles.photoOverlayCenter}>
                          <ActivityIndicator color="#ffffff" />
                        </View>
                      </View>
                    </View>
                  ))}
                  {zonePhotos.map((p) => (
                    <View
                      key={p.id}
                      style={[
                        styles.photoFrame,
                        {
                          borderColor: colors.border,
                          borderRadius: colors.radius - 4,
                          backgroundColor: colors.secondary,
                        },
                      ]}
                    >
                      <Image
                        source={{ uri: p.url }}
                        style={styles.photoImage}
                        contentFit="cover"
                        transition={150}
                        cachePolicy="memory-disk"
                        accessibilityLabel={p.caption ?? "Wet check photo"}
                      />
                      {!isLocked ? (
                        <Pressable
                          onPress={() => onRemoveServerPhoto(p)}
                          disabled={
                            deletePhotoMutation.isPending &&
                            deletePhotoMutation.variables === p.id
                          }
                          accessibilityRole="button"
                          accessibilityLabel="Remove photo"
                          hitSlop={6}
                          style={({ pressed }) => [
                            styles.photoDeleteButton,
                            { opacity: pressed ? 0.7 : 1 },
                          ]}
                        >
                          {deletePhotoMutation.isPending &&
                          deletePhotoMutation.variables === p.id ? (
                            <ActivityIndicator size="small" color="#ffffff" />
                          ) : (
                            <Feather name="trash-2" size={12} color="#ffffff" />
                          )}
                        </Pressable>
                      ) : null}
                    </View>
                  ))}
                </ScrollView>
              )}
              {!isLocked ? (
                <Pressable
                  onPress={onAddZonePhoto}
                  accessibilityRole="button"
                  accessibilityLabel="Add Photo"
                  style={({ pressed }) => [
                    styles.addPhotoButton,
                    {
                      backgroundColor: colors.primary,
                      borderRadius: colors.radius,
                      opacity: pressed ? 0.85 : 1,
                    },
                  ]}
                >
                  <Feather name="camera" size={20} color={colors.primaryForeground} />
                  <Text style={[styles.addPhotoText, { color: colors.primaryForeground }]}>
                    Add Photo
                  </Text>
                </Pressable>
              ) : null}
            </Section>

            <View style={{ height: 24 }} />
          </ScrollView>
        )}

        {wc && zone && wetCheckId != null ? (
          <FindingEditorModal
            visible={editorOpen}
            onClose={() => setEditorOpen(false)}
            colors={colors}
            customerId={wc.customerId}
            isSaving={addFindingMutation.isPending}
            onSubmit={(payload) => addFindingMutation.mutate(payload)}
          />
        ) : null}
      </SafeAreaView>
    </>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────

function ZoneStatusCard({
  zone,
  colors,
  photoCount,
}: {
  zone: WetCheckZoneRecord;
  colors: ReturnType<typeof useColors>;
  photoCount: number;
}) {
  const tone = zoneStatusColor(zone.status, colors);
  return (
    <View
      style={[
        styles.headerCard,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          borderRadius: colors.radius,
        },
      ]}
    >
      <View style={styles.headerTopRow}>
        <Text
          style={[styles.headerNumber, { color: colors.mutedForeground }]}
          numberOfLines={1}
        >
          Controller {zone.controllerLetter} · Zone {zone.zoneNumber ?? "?"}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {photoCount > 0 ? (
            <View
              style={[
                styles.statusPill,
                {
                  backgroundColor: colors.muted,
                  borderRadius: 999,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 4,
                },
              ]}
              accessibilityLabel={`${photoCount} photo${photoCount === 1 ? "" : "s"} on this zone`}
            >
              <Feather name="camera" size={11} color={colors.foreground} />
              <Text style={[styles.statusText, { color: colors.foreground }]}>
                {photoCount}
              </Text>
            </View>
          ) : null}
          <View
            style={[
              styles.statusPill,
              { backgroundColor: tone.bg, borderRadius: 999 },
            ]}
          >
            <Text style={[styles.statusText, { color: tone.fg }]}>
              {ZONE_STATUS_LABELS[zone.status] ?? zone.status}
            </Text>
          </View>
        </View>
      </View>

      {zone.status === "checked_with_issues" && zone.markedCompleteAt ? (
        <View style={styles.markedCompleteRow}>
          <Feather name="check-circle" size={14} color="#16a34a" />
          <Text style={[styles.markedCompleteText, { color: colors.foreground }]}>
            Marked complete by tech
          </Text>
        </View>
      ) : null}

      {zone.observedPressure || zone.observedFlow ? (
        <View style={styles.metricsRow}>
          {zone.observedPressure ? (
            <DetailLine
              icon="activity"
              label={`Pressure ${zone.observedPressure} PSI`}
              colors={colors}
            />
          ) : null}
          {zone.observedFlow ? (
            <DetailLine
              icon="droplet"
              label={`Flow ${zone.observedFlow} GPM`}
              colors={colors}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function InlineErrorBanner({
  colors,
  message,
  onDismiss,
}: {
  colors: ReturnType<typeof useColors>;
  message: string;
  onDismiss: () => void;
}) {
  return (
    <View
      style={[
        styles.inlineErrorBanner,
        {
          backgroundColor: "#fee2e2",
          borderColor: "#fca5a5",
          borderRadius: colors.radius - 4,
        },
      ]}
      accessibilityRole="alert"
    >
      <Feather name="alert-octagon" size={16} color="#b91c1c" />
      <Text style={[styles.inlineErrorText]} numberOfLines={3}>
        {message}
      </Text>
      <Pressable onPress={onDismiss} hitSlop={10} accessibilityLabel="Dismiss error">
        <Feather name="x" size={16} color="#7f1d1d" />
      </Pressable>
    </View>
  );
}

function ConflictBanner({
  colors,
  onRefresh,
}: {
  colors: ReturnType<typeof useColors>;
  onRefresh: () => void;
}) {
  return (
    <View
      style={[
        styles.conflictBanner,
        {
          backgroundColor: "#fef3c7",
          borderColor: "#f59e0b",
          borderRadius: colors.radius,
        },
      ]}
    >
      <Feather name="alert-triangle" size={18} color="#b45309" />
      <View style={{ flex: 1 }}>
        <Text style={styles.conflictTitle}>
          This wet check was edited in the office
        </Text>
        <Text style={styles.conflictBody}>
          Refresh to see the latest version before continuing.
        </Text>
      </View>
      <Pressable
        onPress={onRefresh}
        style={({ pressed }) => [
          styles.conflictRefresh,
          { borderRadius: 999, opacity: pressed ? 0.85 : 1 },
        ]}
      >
        <Text style={styles.conflictRefreshText}>Refresh</Text>
      </Pressable>
    </View>
  );
}

function Section({
  title,
  children,
  colors,
}: {
  title: string;
  children: React.ReactNode;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
        {title.toUpperCase()}
      </Text>
      <View
        style={[
          styles.sectionCard,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
            borderRadius: colors.radius,
          },
        ]}
      >
        {children}
      </View>
    </View>
  );
}

function DetailLine({
  icon,
  label,
  colors,
}: {
  icon: React.ComponentProps<typeof Feather>["name"];
  label: string;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={styles.detailLine}>
      <Feather name={icon} size={14} color={colors.mutedForeground} />
      <Text style={[styles.detailLineText, { color: colors.foreground }]}>
        {label}
      </Text>
    </View>
  );
}

function PrimaryButton({
  label,
  colors,
  onPress,
}: {
  label: string;
  colors: ReturnType<typeof useColors>;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.retryButton,
        {
          backgroundColor: colors.primary,
          borderRadius: colors.radius - 4,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <Text style={[styles.retryText, { color: colors.primaryForeground }]}>
        {label}
      </Text>
    </Pressable>
  );
}

// ─── Finding Editor Modal ─────────────────────────────────────────────────

type FindingEditorPayload = {
  issueType: string;
  partId: number | null;
  partName: string | null;
  partPrice: string | null;
  quantity: number;
  laborHours: string;
  notes: string | null;
};

function FindingEditorModal({
  visible,
  onClose,
  colors,
  customerId,
  isSaving,
  onSubmit,
}: {
  visible: boolean;
  onClose: () => void;
  colors: ReturnType<typeof useColors>;
  customerId: number;
  isSaving: boolean;
  onSubmit: (payload: FindingEditorPayload) => void;
}) {
  const [issueType, setIssueType] = useState<IssueTypeConfig | null>(null);
  const [selectedPart, setSelectedPart] = useState<Part | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [laborHours, setLaborHours] = useState("");
  const [notes, setNotes] = useState("");
  const [partPickerOpen, setPartPickerOpen] = useState(false);

  const issueTypesQuery = useQuery({
    queryKey: wetCheckIssueTypesQueryKey,
    queryFn: () => apiRequest<IssueTypeConfig[]>("/api/wet-checks/issue-types"),
    staleTime: 5 * 60_000,
  });

  // Reset state whenever the modal closes.
  React.useEffect(() => {
    if (!visible) {
      setIssueType(null);
      setSelectedPart(null);
      setQuantity("1");
      setLaborHours("");
      setNotes("");
      setPartPickerOpen(false);
    }
  }, [visible]);

  // When the user picks an issue type, prefill labor hours from its default.
  React.useEffect(() => {
    if (issueType && !laborHours) {
      setLaborHours(issueType.defaultLaborHours);
    }
    // Reset selected part when issue type changes — categories may differ.
    setSelectedPart(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueType?.id]);

  const canSubmit =
    issueType != null && Number(quantity) >= 1 && !isSaving;

  const onSave = () => {
    if (!issueType) return;
    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    const labor = String(laborHours || "0");
    onSubmit({
      issueType: issueType.issueType,
      partId: selectedPart?.id ?? null,
      partName: selectedPart?.name ?? null,
      partPrice: selectedPart?.price ?? null,
      quantity: qty,
      laborHours: labor,
      notes: notes.trim() ? notes.trim() : null,
    });
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView
        style={[styles.modalSafe, { backgroundColor: colors.background }]}
      >
        <View
          style={[
            styles.modalHeader,
            { borderBottomColor: colors.border },
          ]}
        >
          <Pressable onPress={onClose} hitSlop={12} disabled={isSaving}>
            <Text style={[styles.modalCancel, { color: colors.primary, opacity: isSaving ? 0.5 : 1 }]}>
              Cancel
            </Text>
          </Pressable>
          <Text style={[styles.modalTitle, { color: colors.foreground }]}>
            Add finding
          </Text>
          <Pressable onPress={onSave} disabled={!canSubmit} hitSlop={12}>
            {isSaving ? (
              <ActivityIndicator color={colors.primary} size="small" />
            ) : (
              <Text
                style={[
                  styles.modalSave,
                  { color: canSubmit ? colors.primary : colors.mutedForeground },
                ]}
              >
                Save
              </Text>
            )}
          </Pressable>
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView
            contentContainerStyle={styles.modalScroll}
            keyboardShouldPersistTaps="handled"
          >
            <FieldLabel colors={colors}>Issue type</FieldLabel>
            {issueTypesQuery.isLoading ? (
              <View style={{ paddingVertical: 16, alignItems: "center" }}>
                <ActivityIndicator color={colors.primary} size="small" />
              </View>
            ) : (issueTypesQuery.data ?? []).length === 0 ? (
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                No issue types configured for this company yet.
              </Text>
            ) : (
              <View style={styles.issueTypeList}>
                {(issueTypesQuery.data ?? []).map((opt) => {
                  const selected = issueType?.id === opt.id;
                  return (
                    <Pressable
                      key={opt.id}
                      onPress={() => setIssueType(opt)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      accessibilityLabel={opt.displayLabel}
                      style={({ pressed }) => [
                        styles.pickerRow,
                        {
                          backgroundColor: selected ? colors.secondary : "transparent",
                          borderRadius: colors.radius - 4,
                          borderBottomColor: colors.border,
                          opacity: pressed ? 0.85 : 1,
                        },
                      ]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.pickerRowTitle, { color: colors.foreground }]}>
                          {opt.displayLabel}
                        </Text>
                        <Text style={[styles.pickerRowMeta, { color: colors.mutedForeground }]}>
                          {prettyIssueType(opt.issueGroup)} · default {opt.defaultLaborHours} hr
                        </Text>
                      </View>
                      {selected ? (
                        <Feather name="check" size={18} color={colors.primary} />
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            )}

            <FieldLabel colors={colors}>Part (optional)</FieldLabel>
            <Pressable
              onPress={() => {
                if (!issueType) return;
                setPartPickerOpen(true);
              }}
              disabled={!issueType}
              style={({ pressed }) => [
                styles.fieldButton,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  borderRadius: colors.radius - 4,
                  opacity: pressed ? 0.85 : !issueType ? 0.5 : 1,
                },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Pick part"
              accessibilityState={{ disabled: !issueType }}
            >
              <Text
                style={[
                  styles.fieldButtonText,
                  { color: selectedPart ? colors.foreground : colors.mutedForeground },
                ]}
                numberOfLines={1}
              >
                {selectedPart
                  ? selectedPart.name
                  : issueType
                    ? "Select a part…"
                    : "Pick an issue first"}
              </Text>
              {selectedPart ? (
                <Pressable
                  onPress={() => setSelectedPart(null)}
                  hitSlop={10}
                  accessibilityLabel="Clear part"
                >
                  <Feather name="x" size={16} color={colors.mutedForeground} />
                </Pressable>
              ) : (
                <Feather name="chevron-down" size={16} color={colors.mutedForeground} />
              )}
            </Pressable>

            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <FieldLabel colors={colors}>Quantity</FieldLabel>
                <TextInput
                  value={quantity}
                  onChangeText={setQuantity}
                  keyboardType="number-pad"
                  style={[
                    styles.textInput,
                    {
                      backgroundColor: colors.card,
                      borderColor: colors.border,
                      borderRadius: colors.radius - 4,
                      color: colors.foreground,
                    },
                  ]}
                  accessibilityLabel="Quantity"
                />
              </View>
              <View style={{ flex: 1 }}>
                <FieldLabel colors={colors}>Labor hours</FieldLabel>
                <TextInput
                  value={laborHours}
                  onChangeText={setLaborHours}
                  keyboardType="decimal-pad"
                  placeholder="0.00"
                  placeholderTextColor={colors.mutedForeground}
                  style={[
                    styles.textInput,
                    {
                      backgroundColor: colors.card,
                      borderColor: colors.border,
                      borderRadius: colors.radius - 4,
                      color: colors.foreground,
                    },
                  ]}
                  accessibilityLabel="Labor hours"
                />
              </View>
            </View>

            <FieldLabel colors={colors}>Notes (optional)</FieldLabel>
            <TextInput
              value={notes}
              onChangeText={setNotes}
              multiline
              placeholder="Anything the office should know"
              placeholderTextColor={colors.mutedForeground}
              style={[
                styles.textInput,
                styles.textArea,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  borderRadius: colors.radius - 4,
                  color: colors.foreground,
                },
              ]}
              accessibilityLabel="Notes"
            />
          </ScrollView>
        </KeyboardAvoidingView>

        {issueType ? (
          <PartPickerModal
            visible={partPickerOpen}
            onClose={() => setPartPickerOpen(false)}
            colors={colors}
            issueType={issueType.issueType}
            customerId={customerId}
            onSelect={(part) => {
              setSelectedPart(part);
              setPartPickerOpen(false);
            }}
          />
        ) : null}
      </SafeAreaView>
    </Modal>
  );
}

function FieldLabel({
  colors,
  children,
}: {
  colors: ReturnType<typeof useColors>;
  children: React.ReactNode;
}) {
  return (
    <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>
      {String(children).toUpperCase()}
    </Text>
  );
}

function PartPickerModal({
  visible,
  onClose,
  colors,
  issueType,
  customerId,
  onSelect,
}: {
  visible: boolean;
  onClose: () => void;
  colors: ReturnType<typeof useColors>;
  issueType: string;
  customerId: number;
  onSelect: (part: Part) => void;
}) {
  const [search, setSearch] = useState("");

  const partsQuery = useQuery({
    queryKey: wetCheckPartsByIssueQueryKey(issueType, customerId),
    queryFn: () =>
      apiRequest<PartsByIssueResponse>(
        `/api/wet-checks/parts/by-issue?issueType=${encodeURIComponent(issueType)}&customerId=${customerId}`,
      ),
    staleTime: 5 * 60_000,
    enabled: visible,
  });

  React.useEffect(() => {
    if (!visible) setSearch("");
  }, [visible]);

  const filtered = useMemo(() => {
    const all = partsQuery.data?.parts ?? [];
    if (!search.trim()) return all;
    const needle = search.trim().toLowerCase();
    return all.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        (p.description ?? "").toLowerCase().includes(needle) ||
        (p.category ?? "").toLowerCase().includes(needle),
    );
  }, [partsQuery.data, search]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={[styles.modalSafe, { backgroundColor: colors.background }]}>
        <View
          style={[
            styles.modalHeader,
            { borderBottomColor: colors.border },
          ]}
        >
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={[styles.modalCancel, { color: colors.primary }]}>Cancel</Text>
          </Pressable>
          <Text style={[styles.modalTitle, { color: colors.foreground }]}>Pick part</Text>
          <View style={{ width: 60 }} />
        </View>

        <View style={{ padding: 12 }}>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search parts"
            placeholderTextColor={colors.mutedForeground}
            style={[
              styles.textInput,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
                borderRadius: colors.radius - 4,
                color: colors.foreground,
              },
            ]}
            accessibilityLabel="Search parts"
          />
        </View>

        {partsQuery.isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : partsQuery.isError ? (
          <View style={styles.center}>
            <Feather name="alert-circle" size={28} color={colors.destructive} />
            <Text style={[styles.errorTitle, { color: colors.foreground }]}>
              Couldn't load parts
            </Text>
            <PrimaryButton
              label="Try again"
              colors={colors}
              onPress={() => partsQuery.refetch()}
            />
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.pickerList} keyboardShouldPersistTaps="handled">
            {filtered.length === 0 ? (
              <Text style={[styles.emptyText, { color: colors.mutedForeground, padding: 24 }]}>
                No parts match your search.
              </Text>
            ) : (
              filtered.map((p) => (
                <Pressable
                  key={p.id}
                  onPress={() => onSelect(p)}
                  style={({ pressed }) => [
                    styles.pickerRow,
                    {
                      opacity: pressed ? 0.85 : 1,
                      borderBottomColor: colors.border,
                    },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={p.name}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.pickerRowTitle, { color: colors.foreground }]}>
                      {p.name}
                    </Text>
                    <Text style={[styles.pickerRowMeta, { color: colors.mutedForeground }]} numberOfLines={1}>
                      {p.category}{p.description ? ` · ${p.description}` : ""}
                    </Text>
                  </View>
                </Pressable>
              ))
            )}
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const PHOTO_SIZE = 120;

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scroll: { padding: 16, gap: 12 },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 32,
  },
  errorTitle: { fontSize: 18, fontWeight: "600", marginTop: 8 },
  errorBody: { fontSize: 14, textAlign: "center", maxWidth: 280 },
  retryButton: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    marginTop: 12,
  },
  retryText: { fontSize: 15, fontWeight: "600" },
  headerCard: {
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    gap: 8,
  },
  headerTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  headerNumber: { fontSize: 13, fontWeight: "600", flexShrink: 1 },
  statusPill: { paddingHorizontal: 10, paddingVertical: 4 },
  statusText: { fontSize: 12, fontWeight: "700" },
  markedCompleteRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  markedCompleteText: { fontSize: 13, fontWeight: "600" },
  metricsRow: { gap: 4 },
  section: { gap: 6 },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.6,
    paddingHorizontal: 4,
  },
  sectionCard: {
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    gap: 8,
  },
  bodyText: { fontSize: 14, lineHeight: 20 },
  emptyText: { fontSize: 14 },
  findingRow: { gap: 4 },
  findingTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  findingTitle: { fontSize: 15, fontWeight: "600", flexShrink: 1 },
  resolutionPill: { paddingHorizontal: 8, paddingVertical: 3 },
  resolutionText: { fontSize: 11, fontWeight: "600" },
  findingNotes: { fontSize: 13, lineHeight: 18, marginTop: 2 },
  detailLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  detailLineText: { fontSize: 13 },
  findingActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 4,
  },
  findingPhotoButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  findingPhotoButtonText: { fontSize: 12, fontWeight: "600" },
  removeButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
  },
  removeButtonText: { fontSize: 12, fontWeight: "600" },
  addFindingButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: "dashed",
  },
  addFindingText: { fontSize: 14, fontWeight: "600" },
  addPhotoButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    marginTop: 4,
  },
  addPhotoText: { fontSize: 16, fontWeight: "700" },
  processingBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
  },
  processingBannerText: { fontSize: 13 },
  issueTypeList: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    overflow: "hidden",
  },
  // Task #612 facelift — bigger, glove-friendly primary actions.
  // Each row is now a 56pt-tall tappable target with a heavier border
  // when selected, mirroring the web ZoneScreen primary buttons.
  statusGroup: { gap: 8 },
  statusOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 16,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 2,
    minHeight: 56,
  },
  statusOptionText: { fontSize: 16, fontWeight: "700", flex: 1 },
  radioDot: {
    width: 18,
    height: 18,
    borderRadius: 999,
    borderWidth: 2,
  },
  lockedHint: { fontSize: 12, paddingTop: 4 },
  photoStrip: { gap: 8, paddingVertical: 4 },
  photoFrame: {
    width: PHOTO_SIZE,
    height: PHOTO_SIZE,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    position: "relative",
  },
  photoImage: { width: "100%", height: "100%" },
  photoOverlay: {
    position: "absolute",
    inset: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  photoOverlayCenter: {
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.35)",
    gap: 4,
  },
  photoOverlayCaption: {
    color: "#ffffff",
    fontSize: 11,
    fontWeight: "700",
    textShadowColor: "rgba(0,0,0,0.6)",
    textShadowRadius: 2,
  },
  photoErrorOverlay: {
    width: "100%",
    height: "100%",
    backgroundColor: "rgba(127,29,29,0.55)",
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 6,
  },
  photoOverlayButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "rgba(0,0,0,0.45)",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  photoOverlayButtonText: { color: "#ffffff", fontSize: 12, fontWeight: "700" },
  photoOverlayDismiss: {
    width: 26,
    height: 26,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  photoDeleteButton: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 24,
    height: 24,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  conflictBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  conflictTitle: { fontSize: 13, fontWeight: "700", color: "#92400e" },
  conflictBody: { fontSize: 12, marginTop: 2, color: "#78350f" },
  conflictRefresh: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: "#b45309",
  },
  conflictRefreshText: { color: "#ffffff", fontSize: 12, fontWeight: "700" },
  inlineErrorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  inlineErrorText: { flex: 1, fontSize: 13, color: "#7f1d1d" },
  modalSafe: { flex: 1 },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalTitle: { fontSize: 16, fontWeight: "700" },
  modalCancel: { fontSize: 15, fontWeight: "500", minWidth: 60 },
  modalSave: { fontSize: 15, fontWeight: "700", minWidth: 60, textAlign: "right" },
  modalScroll: { padding: 16, gap: 6 },
  fieldLabel: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.6,
    marginTop: 12,
    marginBottom: 4,
  },
  fieldButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  fieldButtonText: { fontSize: 15, flex: 1 },
  textInput: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 15,
  },
  textArea: { minHeight: 80, textAlignVertical: "top" },
  row: { flexDirection: "row", gap: 12 },
  pickerList: { paddingBottom: 24 },
  pickerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pickerRowTitle: { fontSize: 15, fontWeight: "600" },
  pickerRowMeta: { fontSize: 12, marginTop: 2 },
});
