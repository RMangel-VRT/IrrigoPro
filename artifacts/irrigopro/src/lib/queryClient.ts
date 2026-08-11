import {
  QueryClient,
  QueryFunction,
  useQuery,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { safeGet, safeRemove } from "@/utils/safeStorage";
import { getImpersonationToken } from "@/lib/impersonation";

// Task #556 — global "read-auth lost" signal.
//
// Background: `getQueryFn({ on401: "returnNull" })` collapses a 401
// response to `null`, which `useArrayQuery` then collapses to `[]`.
// That keeps list pages from crashing but makes a session loss look
// indistinguishable from a genuinely-empty account: a field tech
// whose session has expired sees "No wet checks yet." instead of a
// signal to sign back in.
//
// We track "the last time a default-loaded read came back 401" in a
// tiny module-local store, and expose `useUnauthenticatedReads()` so
// the field-tech shell can render a single re-login banner and the
// individual list pages can swap their empty state for a re-login
// affordance. Multiple 401s in the same render burst collapse to one
// signal — the listener set is fired only when the boolean changes.
let _unauthenticatedAt = 0;
const _unauthListeners = new Set<() => void>();
const _emitUnauth = () => {
  _unauthListeners.forEach((fn) => {
    try { fn(); } catch { /* ignore */ }
  });
};

export function markUnauthenticatedRead(): void {
  if (_unauthenticatedAt > 0) return; // debounce: already flagged
  _unauthenticatedAt = Date.now();
  _emitUnauth();
  // Clear the stale localStorage session and hard-redirect to login.
  // This fires before the React tree re-renders, so it works even when
  // the shell component that would normally show the re-login banner
  // never mounts (e.g. all queries 401 simultaneously on first paint).
  try {
    if (!window.location.pathname.startsWith("/login")) {
      safeRemove("user");
      window.location.replace("/login");
    }
  } catch { /* non-browser context */ }
}

export function clearUnauthenticatedRead(): void {
  if (_unauthenticatedAt === 0) return;
  _unauthenticatedAt = 0;
  _emitUnauth();
}

function _isUnauthSnapshot(): boolean {
  return _unauthenticatedAt > 0;
}

export function useUnauthenticatedReads(): boolean {
  return useSyncExternalStore(
    (cb) => {
      _unauthListeners.add(cb);
      return () => { _unauthListeners.delete(cb); };
    },
    _isUnauthSnapshot,
    () => false,
  );
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

// Heartbeat hook so the offline sync engine can update its online state
// from any apiRequest activity, not just its own dispatches and the
// 30s `/api/health` poll. Set by the engine bootstrap in main.tsx.
let apiHeartbeat: ((ok: boolean) => void) | null = null;
export function setApiHeartbeat(fn: ((ok: boolean) => void) | null) {
  apiHeartbeat = fn;
}

export async function apiRequest(
  url: string,
  method: string = "GET",
  data?: unknown | undefined,
): Promise<any> {
  const headers: Record<string, string> = data ? { "Content-Type": "application/json" } : {};

  // Task #554 — propagate the server-issued impersonation token on
  // every authed request so `requireAuthentication` can swap the
  // effective identity to the target user.
  const impToken = getImpersonationToken();
  if (impToken) headers["x-impersonation-token"] = impToken;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
      credentials: "include",
      // Task #469 — defense-in-depth against a stale PWA shell or HTTP
      // cache returning a generic HTML 403/login page for an /api/*
      // request. `no-store` skips any browser/SW cache for this fetch
      // so the real Express response is what the engine sees.
      cache: "no-store",
    });
  } catch (e) {
    if (apiHeartbeat) try { apiHeartbeat(false); } catch {}
    throw e;
  }
  if (apiHeartbeat) {
    try { apiHeartbeat(res.status < 500); } catch {}
  }

  // Task #556 — flag the global "session lost" signal whenever a
  // logged-in user's read 401s through the imperative apiRequest path.
  const user = (() => {
    const savedUser = safeGet("user");
    if (!savedUser) return null;
    try { return JSON.parse(savedUser); } catch { return null; }
  })();
  if (res.status === 401 && user?.id != null) {
    markUnauthenticatedRead();
  }

  await throwIfResNotOk(res);
  return await res.json();
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const headers: Record<string, string> = {};

    // Task #554 — same impersonation-token propagation as
    // `apiRequest` so default-loaded React Query reads (work orders
    // list, customers list, etc.) also resolve as the target user
    // on the server during an active impersonation session.
    const impToken = getImpersonationToken();
    if (impToken) headers["x-impersonation-token"] = impToken;

    const res = await fetch(queryKey.join("/") as string, {
      credentials: "include",
      headers,
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      // Task #556 — flag the global "session lost" signal whenever a
      // logged-in tech's default-loaded read 401s. We only mark the
      // signal when there's actually a saved user (otherwise the
      // login screen itself can briefly probe /api/auth and trip it).
      const savedUser = safeGet("user");
      const user = savedUser ? (() => { try { return JSON.parse(savedUser); } catch { return null; } })() : null;
      if (user?.id != null) {
        markUnauthenticatedRead();
      }
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

// Build an `<img src>`-friendly URL for the authenticated photo proxy.
// With real session-cookie auth, the browser sends the session cookie
// automatically for same-origin <img> requests — no auth query params
// needed. If an impersonation token is active we fall back to the
// query-param channel (browsers can't attach custom headers to <img>).
export function authedPhotoSrc(
  photoId: string,
  variant?: "thumb" | "medium" | "original",
): string {
  const params = new URLSearchParams();
  if (variant) params.set("variant", variant);

  // During impersonation the session belongs to the super-admin, not
  // the target user. Pass the signed token as a query param so the
  // server can swap identity for this resource request too.
  const impToken = getImpersonationToken();
  if (impToken) params.set("x-impersonation-token", impToken);

  const qs = params.toString();
  return `/api/photos/${encodeURIComponent(photoId)}${qs ? `?${qs}` : ""}`;
}

// Task #605 — build an authenticated URL for opening a PDF in a new tab
// or as a download. With real session-cookie auth the browser sends the
// session cookie on direct navigations, so no auth query params are
// needed. Extra params (e.g. download flag) are still forwarded.
export function authedPdfUrl(path: string, extraParams?: Record<string, string>): string {
  if (!extraParams || Object.keys(extraParams).length === 0) return path;
  const params = new URLSearchParams(extraParams);
  return `${path}?${params.toString()}`;
}

// Task #540 — null-safe array helper for list payloads.
//
// `getQueryFn` above returns `null` on a 401 in `returnNull` mode, and
// many of our endpoints can also legitimately return `null` for nested
// array fields on freshly-created records (e.g. `wetCheck.zoneRecords`,
// `zoneRecord.findings`, `wetCheck.photos`). The TypeScript types
// declare these as `T[]` so the compiler can't catch the mismatch and
// any `.map / .filter / .length / .flatMap` against the value crashes
// the page. Always wrap a list value with `asArray()` before calling
// array methods on it.
//
//   const records = asArray(wc.zoneRecords);   // T[] guaranteed
//   const items = asArray<Item>(maybeItems);   // explicit element type
export function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

// Task #540 — `useArrayQuery<T>` is the canonical wrapper for any list
// endpoint. It pipes the raw payload through `asArray` via `select`,
// so `data` is always `T[]` once the query has resolved — even when
// the global `getQueryFn({ on401: "returnNull" })` returns `null` on
// a 401. Use it instead of `useQuery<T[]>(...)` for all list reads:
//
//   const { data: customers = [], isLoading } = useArrayQuery<Customer>({
//     queryKey: ["/api/customers"],
//   });
//
// The `= []` destructure default is still required for the loading
// state (during which `data` is `undefined` because `select` has not
// run yet); the wrapper guarantees `null` from a 401 collapses to
// `[]` instead of crashing the page on the first `.map / .filter /
// .length` call.
export function useArrayQuery<T>(
  options: Omit<UseQueryOptions<T[] | null | undefined, Error, T[]>, "select">,
): UseQueryResult<T[], Error> {
  return useQuery<T[] | null | undefined, Error, T[]>({
    ...options,
    select: (data) => asArray<T>(data as T[] | null | undefined),
  });
}

// Task #1922 — deliberate cache windows for the expanded invoice row.
//
// The three reads under an expanded row (line items, reminder history,
// A/R notes) are issued only when a row opens, and working an aging list
// means opening and closing the same rows repeatedly while comparing
// invoices. These constants make the caching decision explicit instead of
// inherited:
//
//   * Line items and reminder history change only through in-app actions
//     that already invalidate their keys (send reminder, void, correct),
//     so a 5-minute window is safe: a reopen within it renders straight
//     from cache with zero requests.
//   * A/R notes are the one thing written from inside the region, and the
//     one thing a *colleague* may have written moments ago. The panel's
//     own writes invalidate the key immediately (so "add a note" always
//     shows the new note without waiting), but reads go stale after one
//     minute so someone else's fresh note is picked up on the next reopen.
//
// The gc window is deliberately longer than both stale windows so a closed
// row's cache actually survives long enough to serve the reopen — a
// staleTime with a shorter gcTime would be a no-op, since closing the row
// unmounts the queries.
export const INVOICE_EXPANSION_STALE_MS = 5 * 60_000;
export const INVOICE_AR_NOTES_STALE_MS = 60_000;
export const INVOICE_EXPANSION_GC_MS = 10 * 60_000;

export function parseApiError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const jsonStart = message.indexOf("{");
  if (jsonStart !== -1) {
    try {
      const parsed: unknown = JSON.parse(message.slice(jsonStart));
      if (parsed !== null && typeof parsed === "object" && "message" in parsed && typeof (parsed as Record<string, unknown>).message === "string") {
        return (parsed as Record<string, unknown>).message as string;
      }
    } catch {
    }
  }
  return fallback;
}

// Task #532 — connection-aware polling helper. Components that opt into
// background polling pass their nominal interval through this helper so
// that:
//   - on a fast/typical connection, the original cadence is used
//   - on `4g`/`3g`-with-saveData, polling is doubled
//   - on `2g`/`slow-2g` (or browser-reported saveData), polling backs off
//     to once every 5 minutes — usually plenty for badge counts
//   - if the user explicitly enables Data Saver, we also back off
// Returns `false` to disable polling entirely when the network looks
// hostile to background traffic. Combine with `refetchIntervalInBackground:
// false` (now the default below) so hidden tabs don't compete with the
// active screen for bandwidth either.
export function adaptiveRefetchInterval(baseMs: number): number | false {
  if (typeof navigator === "undefined") return baseMs;
  const conn: any =
    (navigator as any).connection ||
    (navigator as any).mozConnection ||
    (navigator as any).webkitConnection;
  if (!conn) return baseMs;
  const eff = String(conn.effectiveType || "").toLowerCase();
  const saveData = conn.saveData === true;
  if (eff === "slow-2g" || eff === "2g") return 5 * 60_000;
  if (saveData) return Math.max(baseMs * 2, 2 * 60_000);
  if (eff === "3g") return Math.max(baseMs * 2, baseMs);
  return baseMs;
}

// Shared logout teardown. Every logout path in the app calls this
// instead of duplicating the three-line inline block. Calling
// `queryClient.clear()` first guarantees that the next user who logs
// in on this device always sees a clean loading state — no leftover
// dashboard data from the previous session leaks through staleTime:Infinity.
// `replace` instead of `href` keeps the login page out of browser history
// so the back button can't return to a stale dashboard.
export function clearSessionAndLogout(): void {
  try { queryClient.clear(); } catch { /* non-browser / test context */ }
  try { safeRemove("user"); } catch { /* ignore */ }
  void fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
  try { window.location.replace("/login"); } catch { /* non-browser context */ }
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "returnNull" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      // Task #532 — never poll a hidden tab. Components that schedule
      // their own `refetchInterval` are explicitly opting into a poll;
      // we still don't want it to run while the tab is in the background
      // and the user can't see the result anyway. Saves a lot of bandwidth
      // for techs who switch between the app and a phone call.
      refetchIntervalInBackground: false,
      // Refresh stale data when the device comes back online.
      refetchOnReconnect: true,
      staleTime: Infinity,
      retry: false,
      throwOnError: false,
    },
    mutations: {
      retry: false,
      throwOnError: false,
    },
  },
});
