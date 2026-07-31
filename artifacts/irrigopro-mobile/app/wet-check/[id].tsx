import { Feather } from "@expo/vector-icons";
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { LoadingScreen } from "@/components/Loading";
import { useColors } from "@/hooks/useColors";
import { apiRequest } from "@/lib/api";
import { friendlyErrorMessage } from "@/lib/toast";
import { isOfflineQueuedResult } from "@/lib/sync/errors";
import { useScopeConflictTick } from "@/lib/sync/use-sync-status";
import {
  WetCheckConflictError,
  wetCheckDetailQueryKey,
  wetCheckIssueTypesQueryKey,
  wetCheckMutate,
  wetCheckMutationKey,
  wetCheckMutationKeyPrefix,
  wetCheckPartsByIssueQueryKey,
} from "@/lib/wet-check";

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

export { wetCheckDetailQueryKey } from "@/lib/wet-check";

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
  partName: string | null;
  quantity: number;
  laborHours: string | null;
  notes: string | null;
};

type WetCheckZoneRecord = {
  id: number;
  wetCheckId: number;
  controllerLetter: string;
  zoneNumber: number;
  status: string;
  markedCompleteAt: string | null;
  notes: string | null;
  findings: WetCheckFinding[];
};

type WetCheckDetail = {
  id: number;
  customerId: number;
  customerName: string;
  propertyAddress: string | null;
  status: string;
  numControllers: number;
  startedAt: string | null;
  submittedAt: string | null;
  weather: string | null;
  notes: string | null;
  zoneRecords: WetCheckZoneRecord[];
  photos: WetCheckPhoto[];
  /** Task #1856: resolved controllers from irrigation_controllers (letter + name + zone count). */
  controllers?: Array<{ letter: string; name: string; zoneCount: number | null }>;
};

type PropertyController = {
  id: number;
  controllerLetter: string;
  zoneCount: number;
};

const STATUS_LABELS: Record<string, string> = {
  in_progress: "In progress",
  submitted: "Submitted",
  approved: "Approved",
  partially_converted: "Partially converted",
  converted: "Converted",
};

type ZoneStatusTone = {
  bg: string;
  fg: string;
  borderColor?: string;
};

function zoneStatusTone(
  status: string,
  colors: ReturnType<typeof useColors>,
): ZoneStatusTone {
  switch (status) {
    case "checked_ok":
      return { bg: "#16a34a", fg: "#ffffff" };
    case "checked_with_issues":
      return { bg: "#dc2626", fg: "#ffffff" };
    case "not_applicable":
      return { bg: "#9ca3af", fg: "#ffffff" };
    default:
      return {
        bg: colors.card,
        fg: colors.foreground,
        borderColor: colors.border,
      };
  }
}

export default function WetCheckDetailScreen() {
  const colors = useColors();
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ id: string }>();
  const id = useMemo(() => {
    const n = Number(params.id);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [params.id]);

  const [conflict, setConflict] = useState(false);

  // Surface 409s discovered by background queue drains in the same
  // banner as inline-mutation conflicts.
  const conflictTick = useScopeConflictTick(id != null ? `wc:${id}` : null);
  useEffect(() => {
    if (conflictTick > 0) setConflict(true);
  }, [conflictTick]);

  const detailQuery = useQuery({
    queryKey: id != null ? wetCheckDetailQueryKey(id) : ["wet-check", "missing"],
    enabled: id != null,
    queryFn: () => apiRequest<WetCheckDetail>(`/api/wet-checks/${id}`),
    staleTime: 30_000,
  });

  const wcd = detailQuery.data;

  // Prefetch the issue type catalog and a parts list for each issue type for
  // this customer when the user lands on the wet check. The Add Finding modal
  // (M5) opens off this cache so the issue + parts pickers feel instant on the
  // first tap. Issue types and parts are nearly static at the company level
  // and the staleTime is 5 minutes, so this is cheap.
  const issueTypesQuery = useQuery({
    queryKey: wetCheckIssueTypesQueryKey,
    queryFn: () => apiRequest<IssueTypeConfig[]>("/api/wet-checks/issue-types"),
    staleTime: 5 * 60_000,
    enabled: id != null,
  });

  useEffect(() => {
    if (!wcd || !issueTypesQuery.data) return;
    const customerId = wcd.customerId;
    for (const it of issueTypesQuery.data) {
      const key = wetCheckPartsByIssueQueryKey(it.issueType, customerId);
      if (queryClient.getQueryData(key) !== undefined) continue;
      queryClient
        .prefetchQuery({
          queryKey: key,
          queryFn: () =>
            apiRequest<PartsByIssueResponse>(
              `/api/wet-checks/parts/by-issue?issueType=${encodeURIComponent(it.issueType)}&customerId=${customerId}`,
            ),
          staleTime: 5 * 60_000,
        })
        .catch(() => undefined);
    }
  }, [wcd, issueTypesQuery.data, queryClient]);

  // Track failed mutations against this wet check (zone status, add finding,
  // remove finding, submit). If any logical operation has errored and not
  // yet been retried successfully, gate Submit so a tech can't accidentally
  // submit with un-saved local edits.
  //
  // The TanStack mutation cache retains historical mutations until gcTime
  // expires, so a once-failed mutation that was later retried successfully
  // would otherwise keep `hasPendingLocalError` true. We subscribe to the
  // cache and, whenever a mutation succeeds, prune *only* the errored
  // mutations whose `mutationKey` is identical to the successful one —
  // i.e. errors for the *same logical operation* (zone-status for zone N,
  // finding-add for zone N, finding-delete for finding F, or submit). An
  // unrelated failed edit on another zone keeps Submit gated.
  useEffect(() => {
    if (id == null) return;
    const cache = queryClient.getMutationCache();
    const prefix = wetCheckMutationKeyPrefix(id);
    const sameKey = (a: readonly unknown[] | undefined, b: readonly unknown[]) =>
      a != null && a.length === b.length && a.every((v, i) => v === b[i]);
    const startsWithPrefix = (k: readonly unknown[] | undefined) =>
      k != null && k.length >= prefix.length && prefix.every((v, i) => k[i] === v);
    const unsub = cache.subscribe((event) => {
      if (event.type !== "updated") return;
      if (event.mutation.state.status !== "success") return;
      const winner = event.mutation.options.mutationKey;
      if (!startsWithPrefix(winner)) return;
      for (const m of cache.getAll()) {
        if (m === event.mutation) continue;
        if (m.state.status !== "error") continue;
        if (!sameKey(m.options.mutationKey, winner as readonly unknown[])) continue;
        cache.remove(m);
      }
    });
    return unsub;
  }, [id, queryClient]);

  const failedMutations = useMutationState({
    filters: id != null
      ? { mutationKey: wetCheckMutationKeyPrefix(id), status: "error", exact: false }
      : { mutationKey: ["wet-check", "mutation", -1], status: "error", exact: false },
    select: (m) => ({
      key: m.options.mutationKey,
      error: m.state.error,
    }),
  });
  // Dedupe by mutationKey — multiple historical errors for the same logical
  // op shouldn't be counted twice, and the cleanup subscriber above already
  // ensures successes prune their own key's prior errors.
  const uniqueFailedKeys = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ key: readonly unknown[] | undefined; error: unknown }> = [];
    for (const f of failedMutations) {
      const k = JSON.stringify(f.key ?? []);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(f);
    }
    return out;
  }, [failedMutations]);
  const hasPendingLocalError = uniqueFailedKeys.length > 0;
  const inFlightMutations = useMutationState({
    filters: id != null
      ? { mutationKey: wetCheckMutationKeyPrefix(id), status: "pending", exact: false }
      : { mutationKey: ["wet-check", "mutation", -1], status: "pending", exact: false },
  });
  const hasInFlightMutation = inFlightMutations.length > 0;

  const onRefresh = useCallback(() => {
    setConflict(false);
    detailQuery.refetch();
  }, [detailQuery]);

  const headerTitle = wcd ? `Wet check #${wcd.id}` : "Wet check";

  // Fetch property controllers to know zoneCount per letter for the full grid.
  const controllersQuery = useQuery({
    queryKey: ["property-controllers", wcd?.customerId],
    enabled: wcd != null,
    queryFn: () =>
      apiRequest<PropertyController[]>(`/api/properties/${wcd!.customerId}/controllers`),
    staleTime: 5 * 60_000,
  });
  // Task #1856: prefer zone counts from wcd.controllers (stored on irrigation_controllers).
  // Fall back to the legacy property-controllers query for pre-profile customers.
  const zoneCountByLetter = useMemo(() => {
    const map = new Map<string, number>();
    if (wcd?.controllers && wcd.controllers.length > 0) {
      for (const c of wcd.controllers) {
        if (c.zoneCount != null) map.set(c.letter, c.zoneCount);
      }
    } else {
      for (const c of controllersQuery.data ?? []) {
        map.set(c.controllerLetter, c.zoneCount);
      }
    }
    return map;
  }, [wcd, controllersQuery.data]);

  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  const grouped = useMemo(() => {
    if (!wcd) return [] as Array<{ letter: string; zones: Array<WetCheckZoneRecord | null> }>;
    // Build a lookup from (letter#zone) → existing record
    const recordMap = new Map<string, WetCheckZoneRecord>();
    for (const z of wcd.zoneRecords) {
      recordMap.set(`${z.controllerLetter}#${z.zoneNumber}`, z);
    }
    // Task #1856: derive letters from stored controllers when available;
    // fall back to positional A…N from numControllers for legacy data.
    const baseLetters: string[] = wcd.controllers && wcd.controllers.length > 0
      ? wcd.controllers.map(c => c.letter)
      : Array.from({ length: wcd.numControllers ?? 0 }, (_, i) => ALPHABET[i]).filter(Boolean) as string[];
    const letterSet = new Set(baseLetters);
    // Supplement with any letters from existing zone records not already in the list
    for (const z of wcd.zoneRecords) {
      if (!letterSet.has(z.controllerLetter)) {
        letterSet.add(z.controllerLetter);
        baseLetters.push(z.controllerLetter);
      }
    }
    baseLetters.sort();
    const letters = baseLetters;
    return letters.map((letter) => {
      // Determine zone count for this controller (fall back to max existing zone number)
      const zoneCount =
        zoneCountByLetter.get(letter) ??
        Math.max(
          0,
          ...wcd.zoneRecords
            .filter((z) => z.controllerLetter === letter)
            .map((z) => z.zoneNumber),
        );
      // Build a slot per zone 1..zoneCount, null where no record exists yet
      const zones: Array<WetCheckZoneRecord | null> = [];
      for (let z = 1; z <= zoneCount; z++) {
        zones.push(recordMap.get(`${letter}#${z}`) ?? null);
      }
      // Include any extra records whose zoneNumber exceeds zoneCount
      for (const r of wcd.zoneRecords) {
        if (r.controllerLetter === letter && r.zoneNumber > zoneCount) {
          zones.push(r);
        }
      }
      return { letter, zones };
    });
  }, [wcd, zoneCountByLetter]);

  const photoCountByZoneId = useMemo(() => {
    const map = new Map<number, number>();
    if (!wcd) return map;
    const zones = wcd.zoneRecords ?? [];
    const findingToZone = new Map<number, number>();
    for (const z of zones) {
      map.set(z.id, 0);
      for (const f of z.findings ?? []) findingToZone.set(f.id, z.id);
    }
    for (const p of wcd.photos ?? []) {
      let zid: number | null = null;
      if (p.zoneRecordId != null) zid = p.zoneRecordId;
      else if (p.findingId != null) zid = findingToZone.get(p.findingId) ?? null;
      if (zid != null) map.set(zid, (map.get(zid) ?? 0) + 1);
    }
    return map;
  }, [wcd]);

  const counts = useMemo(() => {
    if (!wcd) return { ok: 0, issues: 0, na: 0, notChecked: 0, markedComplete: 0 };
    let ok = 0;
    let issues = 0;
    let na = 0;
    let notChecked = 0;
    let markedComplete = 0;
    for (const z of wcd.zoneRecords) {
      if (z.status === "checked_ok") ok++;
      else if (z.status === "checked_with_issues") {
        issues++;
        // Task #612 facelift — mirror the web summary header so the tech
        // can see at a glance how many Needs Work zones have already
        // been reviewed and confirmed (Mark Zone Complete pressed).
        if (z.markedCompleteAt) markedComplete++;
      } else if (z.status === "not_applicable") na++;
      else notChecked++;  // existing not_checked records
    }
    // Virtual zones (no record yet) also count as not-checked.
    // Task #1856: use stored letters from wcd.controllers; fall back to
    // positional A…N from numControllers for legacy data.
    const recordedKeys = new Set(wcd.zoneRecords.map((z) => `${z.controllerLetter}#${z.zoneNumber}`));
    const ctrlLetters = wcd.controllers && wcd.controllers.length > 0
      ? wcd.controllers.map(c => c.letter)
      : (Array.from({ length: wcd.numControllers ?? 0 }, (_, i) => ALPHABET[i]).filter(Boolean) as string[]);
    for (const letter of ctrlLetters) {
      const zoneCount = zoneCountByLetter.get(letter) ?? 0;
      for (let z = 1; z <= zoneCount; z++) {
        if (!recordedKeys.has(`${letter}#${z}`)) notChecked++;
      }
    }
    return { ok, issues, na, notChecked, markedComplete };
  }, [wcd, zoneCountByLetter]);

  const prefetchZone = useCallback(() => {
    if (id == null || !wcd) return;
    queryClient.setQueryData(wetCheckDetailQueryKey(id), wcd);
  }, [queryClient, id, wcd]);

  // Lazy-create a zone record on first tap of an unrecorded zone tile, then
  // navigate into it. Uses wetCheckMutate so the creation is durably queued
  // when offline. The server upsert is idempotent so double-taps are safe.
  const lazyCreateMut = useMutation({
    mutationFn: async ({ letter, zoneNumber }: { letter: string; zoneNumber: number }) => {
      if (id == null) throw new Error("Missing wet check id");
      return wetCheckMutate<WetCheckZoneRecord, { controllerLetter: string; zoneNumber: number; status: string }>({
        path: `/api/wet-checks/${id}/zone-records`,
        method: "POST",
        body: { controllerLetter: letter, zoneNumber, status: "not_checked" },
        wetCheckId: id,
        label: "Create zone record",
      });
    },
    onSuccess: (data, { letter: _l, zoneNumber: _z }) => {
      if (id == null) return;
      // Whether online or offline-queued, inject the record into the cache so
      // the zone screen can render immediately. Offline: data.id is a temp
      // negative id (from makeOptimistic); the zone screen now accepts those.
      // When the queue drains the wet-check detail refetches and replaces it
      // with the real id; subsequent mutations set offline against the temp id
      // may need to be re-applied after sync (known limitation).
      queryClient.setQueryData<WetCheckDetail | undefined>(
        wetCheckDetailQueryKey(id),
        (prev) =>
          prev
            ? { ...prev, zoneRecords: [...prev.zoneRecords, { ...data, findings: [] }] }
            : prev,
      );
      router.push({
        pathname: "/wet-check/[id]/zone/[zoneRecordId]",
        params: { id: String(id), zoneRecordId: String(data.id) },
      });
    },
    onError: (err) => {
      Alert.alert("Couldn't open zone", friendlyErrorMessage(err, "Please try again."));
    },
  });

  const [submitError, setSubmitError] = useState<string | null>(null);

  const submitMutation = useMutation({
    mutationKey: id != null ? wetCheckMutationKey(id, "submit") : ["wet-check", "mutation", -1, "submit"],
    mutationFn: async () => {
      if (id == null) throw new Error("Missing wet check id");
      return wetCheckMutate<WetCheckDetail & { billingSheetId?: number | null }>({
        path: `/api/wet-checks/${id}/submit`,
        method: "POST",
        wetCheckId: id,
        label: "Submit wet check",
      });
    },
    onSuccess: async (data) => {
      setSubmitError(null);
      if (id != null) {
        // When the submit was queued offline (synthetic placeholder), skip
        // the cache merge — its negative `id` would corrupt the wet-check
        // detail cache. The engine will refetch on successful drain.
        if (!isOfflineQueuedResult(data)) {
          // Merge submit response into cache: it contains the updated wet
          // check top-level fields. Keep zoneRecords/photos from current
          // cache.
          queryClient.setQueryData<WetCheckDetail | undefined>(
            wetCheckDetailQueryKey(id),
            (prev) =>
              prev
                ? { ...prev, ...data, zoneRecords: prev.zoneRecords, photos: prev.photos }
                : prev,
          );
        }
        await queryClient.invalidateQueries({ queryKey: wetCheckDetailQueryKey(id) });
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    },
    onError: (err) => {
      if (err instanceof WetCheckConflictError) {
        setConflict(true);
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
      setSubmitError(friendlyErrorMessage(err, "Couldn't submit wet check"));
    },
  });

  const canSubmit =
    wcd?.status === "in_progress" &&
    !submitMutation.isPending &&
    !hasPendingLocalError &&
    !hasInFlightMutation;

  const onSubmitPressed = useCallback(() => {
    if (!wcd) return;
    Alert.alert(
      "Submit wet check?",
      "This sends the wet check to the office for review. You won't be able to edit zones or add findings after submitting.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Submit",
          style: "destructive",
          onPress: () => submitMutation.mutate(),
        },
      ],
    );
  }, [wcd, submitMutation]);

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
        {id == null ? (
          <View style={styles.center}>
            <Text style={[styles.errorTitle, { color: colors.foreground }]}>
              Invalid wet check
            </Text>
            <RetryButton
              label="Go back"
              colors={colors}
              onPress={() => router.back()}
            />
          </View>
        ) : detailQuery.isLoading ? (
          <LoadingScreen />
        ) : detailQuery.isError || !wcd ? (
          <View style={styles.center}>
            <Feather name="alert-circle" size={32} color={colors.destructive} />
            <Text style={[styles.errorTitle, { color: colors.foreground }]}>
              Couldn't load wet check
            </Text>
            <Text style={[styles.errorBody, { color: colors.mutedForeground }]}>
              {friendlyErrorMessage(detailQuery.error)}
            </Text>
            <RetryButton
              label="Try again"
              colors={colors}
              onPress={() => detailQuery.refetch()}
            />
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={styles.scroll}
            refreshControl={
              <RefreshControl
                refreshing={detailQuery.isRefetching}
                onRefresh={onRefresh}
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
                  WC #{wcd.id}
                </Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  {(() => {
                    const total = (wcd.photos ?? []).length;
                    if (total === 0) return null;
                    return (
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
                        accessibilityLabel={`${total} photo${total === 1 ? "" : "s"} on this wet check`}
                      >
                        <Feather name="camera" size={11} color={colors.foreground} />
                        <Text
                          style={[
                            styles.statusText,
                            { color: colors.foreground },
                          ]}
                        >
                          {total}
                        </Text>
                      </View>
                    );
                  })()}
                  <View
                    style={[
                      styles.statusPill,
                      { backgroundColor: colors.secondary, borderRadius: 999 },
                    ]}
                  >
                    <Text
                      style={[
                        styles.statusText,
                        { color: colors.secondaryForeground },
                      ]}
                    >
                      {STATUS_LABELS[wcd.status] ?? wcd.status}
                    </Text>
                  </View>
                </View>
              </View>
              <Text style={[styles.headerCustomer, { color: colors.foreground }]}>
                {wcd.customerName}
              </Text>
              {wcd.propertyAddress ? (
                <Text
                  style={[styles.headerAddress, { color: colors.mutedForeground }]}
                  numberOfLines={2}
                >
                  {wcd.propertyAddress}
                </Text>
              ) : null}
            </View>

            <ChipRow counts={counts} colors={colors} />

            {wcd.weather || wcd.notes ? (
              <View style={styles.section}>
                {wcd.weather ? (
                  <View
                    style={[
                      styles.notesCard,
                      {
                        backgroundColor: colors.card,
                        borderColor: colors.border,
                        borderRadius: colors.radius,
                      },
                    ]}
                  >
                    <Text style={[styles.notesLabel, { color: colors.mutedForeground }]}>
                      WEATHER
                    </Text>
                    <Text style={[styles.notesBody, { color: colors.foreground }]}>
                      {wcd.weather}
                    </Text>
                  </View>
                ) : null}
                {wcd.notes ? (
                  <View
                    style={[
                      styles.notesCard,
                      {
                        backgroundColor: colors.card,
                        borderColor: colors.border,
                        borderRadius: colors.radius,
                        marginTop: wcd.weather ? 8 : 0,
                      },
                    ]}
                  >
                    <Text style={[styles.notesLabel, { color: colors.mutedForeground }]}>
                      NOTES
                    </Text>
                    <Text style={[styles.notesBody, { color: colors.foreground }]}>
                      {wcd.notes}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}

            {(() => {
              // Task #597 — loose-photos amber banner. Photos with no
              // zoneRecordId AND no findingId are unattached and easy
              // to miss; surface them on the overview so a tech can
              // route them to the right zone before submitting.
              const loose = (wcd.photos ?? []).filter(
                (p) => p.zoneRecordId == null && p.findingId == null,
              );
              if (loose.length === 0) return null;
              return (
                <View
                  style={[styles.loosePhotosBanner, { borderRadius: colors.radius }]}
                  testID="loose-photos-banner"
                  accessibilityLabel={`${loose.length} loose photo${loose.length === 1 ? "" : "s"} not attached to a zone`}
                >
                  <Feather name="alert-triangle" size={16} color="#92400e" />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.loosePhotosTitle}>
                      {loose.length} loose photo{loose.length === 1 ? "" : "s"}
                    </Text>
                    <Text style={styles.loosePhotosBody}>
                      Open a zone to attach {loose.length === 1 ? "it" : "them"} so the office can find {loose.length === 1 ? "it" : "them"}.
                    </Text>
                  </View>
                </View>
              );
            })()}

            {grouped.length === 0 ? (
              <View
                style={[
                  styles.emptyCard,
                  {
                    backgroundColor: colors.card,
                    borderColor: colors.border,
                    borderRadius: colors.radius,
                  },
                ]}
              >
                <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                  No zones recorded yet.
                </Text>
              </View>
            ) : (
              grouped.map(({ letter, zones }) => (
                <ControllerSection
                  key={letter}
                  letter={letter}
                  zones={zones}
                  photoCountByZoneId={photoCountByZoneId}
                  colors={colors}
                  isCreatingZone={lazyCreateMut.isPending}
                  onZonePress={(zone, zoneNumber) => {
                    if (zone === null) {
                      lazyCreateMut.mutate({ letter, zoneNumber });
                    } else {
                      prefetchZone();
                      router.push({
                        pathname: "/wet-check/[id]/zone/[zoneRecordId]",
                        params: {
                          id: String(wcd.id),
                          zoneRecordId: String(zone.id),
                        },
                      });
                    }
                  }}
                />
              ))
            )}

            {wcd.status === "in_progress" ? (
              <View style={[styles.section, { marginTop: 8 }]}>
                <Pressable
                  onPress={onSubmitPressed}
                  disabled={!canSubmit}
                  style={({ pressed }) => [
                    styles.submitButton,
                    {
                      backgroundColor: canSubmit ? colors.primary : colors.muted,
                      borderRadius: colors.radius,
                      opacity: pressed && canSubmit ? 0.85 : 1,
                    },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Submit wet check"
                  accessibilityState={{ disabled: !canSubmit }}
                >
                  {submitMutation.isPending ? (
                    <ActivityIndicator color={colors.primaryForeground} />
                  ) : (
                    <>
                      <Feather
                        name="check-circle"
                        size={18}
                        color={canSubmit ? colors.primaryForeground : colors.mutedForeground}
                      />
                      <Text
                        style={[
                          styles.submitText,
                          {
                            color: canSubmit
                              ? colors.primaryForeground
                              : colors.mutedForeground,
                          },
                        ]}
                      >
                        Submit wet check
                      </Text>
                    </>
                  )}
                </Pressable>
                {submitError ? (
                  <Text
                    style={[styles.submitHint, { color: colors.destructive }]}
                  >
                    {submitError}
                  </Text>
                ) : hasPendingLocalError ? (
                  <Text
                    style={[styles.submitHint, { color: colors.destructive }]}
                  >
                    {uniqueFailedKeys.length === 1
                      ? "A change couldn't be saved. Retry the failed edit before submitting."
                      : `${uniqueFailedKeys.length} changes couldn't be saved. Retry them before submitting.`}
                  </Text>
                ) : hasInFlightMutation ? (
                  <Text
                    style={[styles.submitHint, { color: colors.mutedForeground }]}
                  >
                    Saving your changes…
                  </Text>
                ) : counts.notChecked > 0 ? (
                  <Text
                    style={[
                      styles.submitHint,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    {counts.notChecked} zone{counts.notChecked === 1 ? "" : "s"} still
                    need to be checked.
                  </Text>
                ) : null}
              </View>
            ) : null}

            <View style={{ height: 24 }} />
          </ScrollView>
        )}
      </SafeAreaView>
    </>
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
        <Text style={[styles.conflictTitle, { color: "#92400e" }]}>
          This wet check was edited in the office
        </Text>
        <Text style={[styles.conflictBody, { color: "#78350f" }]}>
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

function ChipRow({
  counts,
  colors,
}: {
  counts: { ok: number; issues: number; na: number; notChecked: number; markedComplete?: number };
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={styles.chipRow}>
      <Chip label={`Ran OK · ${counts.ok}`} bg="#16a34a" fg="#ffffff" />
      <Chip label={`Needs work · ${counts.issues}`} bg="#dc2626" fg="#ffffff" />
      <Chip label={`N/A · ${counts.na}`} bg="#9ca3af" fg="#ffffff" />
      {(counts.markedComplete ?? 0) > 0 ? (
        <Chip label={`Marked complete · ${counts.markedComplete}`} bg="#dbeafe" fg="#1e3a8a" />
      ) : null}
      {counts.notChecked > 0 ? (
        <Chip
          label={`Not checked · ${counts.notChecked}`}
          bg={colors.secondary}
          fg={colors.secondaryForeground}
        />
      ) : null}
    </View>
  );
}

function Chip({ label, bg, fg }: { label: string; bg: string; fg: string }) {
  return (
    <View style={[styles.chip, { backgroundColor: bg }]}>
      <Text style={[styles.chipText, { color: fg }]}>{label}</Text>
    </View>
  );
}

function ControllerSection({
  letter,
  zones,
  photoCountByZoneId,
  colors,
  onZonePress,
  isCreatingZone,
}: {
  letter: string;
  zones: Array<WetCheckZoneRecord | null>;
  photoCountByZoneId: Map<number, number>;
  colors: ReturnType<typeof useColors>;
  onZonePress: (zone: WetCheckZoneRecord | null, zoneNumber: number) => void;
  isCreatingZone: boolean;
}) {
  const findingCountForZone = (z: WetCheckZoneRecord): number =>
    Array.isArray(z.findings) ? z.findings.length : 0;
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
        CONTROLLER {letter}
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
        {zones.length === 0 ? (
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
            No zones configured for this controller.
          </Text>
        ) : (
          <View style={styles.zoneGrid}>
            {zones.map((z, idx) => {
              // For virtual (null) zones, zoneNumber is derived from position.
              // For extra records beyond zoneCount, use the record's zoneNumber.
              const zoneNumber = z != null ? z.zoneNumber : idx + 1;
              const tone = z != null ? zoneStatusTone(z.status, colors) : {
                bg: colors.card,
                fg: colors.foreground,
                borderColor: colors.border,
              };
              const markedComplete =
                z != null &&
                z.status === "checked_with_issues" &&
                z.markedCompleteAt != null;
              return (
                <View key={z != null ? z.id : `virtual-${letter}-${zoneNumber}`} style={styles.zoneCell}>
                  <Pressable
                    onPress={() => onZonePress(z, zoneNumber)}
                    disabled={isCreatingZone && z === null}
                    style={({ pressed }) => [
                      styles.zoneTile,
                      {
                        backgroundColor: tone.bg,
                        borderColor: tone.borderColor ?? "transparent",
                        borderWidth: tone.borderColor ? StyleSheet.hairlineWidth : 0,
                        opacity: (pressed || (isCreatingZone && z === null)) ? 0.7 : 1,
                      },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={`Zone ${zoneNumber}${z === null ? ", not yet recorded" : ""}`}
                  >
                    <Text style={[styles.zoneTileText, { color: tone.fg }]}>
                      {zoneNumber}
                    </Text>
                    {markedComplete ? (
                      <View style={styles.markedCompleteDot}>
                        <Feather name="check" size={10} color="#16a34a" />
                      </View>
                    ) : null}
                    {z != null && (photoCountByZoneId.get(z.id) ?? 0) > 0 ? (
                      <View
                        style={styles.photoCountDot}
                        accessibilityLabel={`${photoCountByZoneId.get(z.id)} photo${(photoCountByZoneId.get(z.id) ?? 0) === 1 ? "" : "s"}`}
                      >
                        <Feather name="camera" size={8} color="#1f2937" />
                        <Text style={styles.photoCountDotText}>
                          {photoCountByZoneId.get(z.id)}
                        </Text>
                      </View>
                    ) : null}
                    {z != null && findingCountForZone(z) > 0 ? (
                      <View
                        style={styles.findingCountDot}
                        accessibilityLabel={`${findingCountForZone(z)} work item${findingCountForZone(z) === 1 ? "" : "s"}`}
                      >
                        <Feather name="tool" size={8} color="#ffffff" />
                        <Text style={styles.findingCountDotText}>
                          {findingCountForZone(z)}
                        </Text>
                      </View>
                    ) : null}
                  </Pressable>
                </View>
              );
            })}
          </View>
        )}
      </View>
    </View>
  );
}

function RetryButton({
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
    gap: 6,
  },
  headerTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerNumber: { fontSize: 12, fontWeight: "600", letterSpacing: 0.4 },
  statusPill: { paddingHorizontal: 10, paddingVertical: 4 },
  statusText: { fontSize: 12, fontWeight: "600" },
  headerCustomer: { fontSize: 19, fontWeight: "700", marginTop: 4 },
  headerAddress: { fontSize: 14 },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  chipText: { fontSize: 12, fontWeight: "600" },
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
  },
  notesCard: {
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    gap: 4,
  },
  notesLabel: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.6,
  },
  notesBody: { fontSize: 14, lineHeight: 20 },
  zoneGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginHorizontal: -3,
  },
  zoneCell: {
    width: "20%",
    padding: 3,
  },
  zoneTile: {
    aspectRatio: 1,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  zoneTileText: { fontSize: 16, fontWeight: "700" },
  markedCompleteDot: {
    position: "absolute",
    top: -4,
    right: -4,
    width: 16,
    height: 16,
    borderRadius: 999,
    backgroundColor: "#ffffff",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#16a34a",
  },
  photoCountDot: {
    position: "absolute",
    bottom: -4,
    right: -4,
    minWidth: 18,
    height: 14,
    borderRadius: 999,
    paddingHorizontal: 3,
    backgroundColor: "#ffffff",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 1,
    borderWidth: 1,
    borderColor: "#9ca3af",
  },
  photoCountDotText: {
    fontSize: 9,
    fontWeight: "700",
    color: "#1f2937",
  },
  // Task #612 — work-item count dot, top-left of the tile so it
  // doesn't collide with the marked-complete dot (top-right) or the
  // photo dot (bottom-right).
  findingCountDot: {
    position: "absolute",
    top: -4,
    left: -4,
    minWidth: 18,
    height: 14,
    borderRadius: 999,
    paddingHorizontal: 3,
    backgroundColor: "#b91c1c",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 1,
    borderWidth: 1,
    borderColor: "#ffffff",
  },
  findingCountDotText: {
    fontSize: 9,
    fontWeight: "700",
    color: "#ffffff",
  },
  emptyCard: {
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    alignItems: "center",
  },
  emptyText: { fontSize: 14 },
  submitButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 18,
  },
  submitText: { fontSize: 16, fontWeight: "700" },
  submitHint: {
    fontSize: 12,
    paddingHorizontal: 4,
    textAlign: "center",
  },
  conflictBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  conflictTitle: { fontSize: 13, fontWeight: "700" },
  conflictBody: { fontSize: 12, marginTop: 2 },
  conflictRefresh: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: "#b45309",
  },
  conflictRefreshText: { color: "#ffffff", fontSize: 12, fontWeight: "700" },
  loosePhotosBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 12,
    marginBottom: 8,
    backgroundColor: "#fef3c7",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#f59e0b",
  },
  loosePhotosTitle: { fontSize: 13, fontWeight: "700", color: "#92400e" },
  loosePhotosBody: { fontSize: 12, marginTop: 2, color: "#92400e" },
});
