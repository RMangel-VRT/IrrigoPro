import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { safeGet, safeRemove, safeSet } from "@/utils/safeStorage";
import { clearSessionAndLogout } from "@/lib/queryClient";
import type { Role } from "@workspace/shared";

export type WebUser = {
  id: number;
  username: string;
  name: string;
  email: string;
  role: Role;
  companyId?: number | null;
  isActive: boolean;
};

type AuthContextValue = {
  user: WebUser | null;
  isLoading: boolean;
  setUser: (user: WebUser | null) => void;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function readUserFromStorage(): WebUser | null {
  try {
    const saved = safeGet("user");
    if (saved) return JSON.parse(saved) as WebUser;
  } catch (e) {
    console.error("[auth] error parsing saved user:", e);
    try {
      safeRemove("user");
    } catch {}
  }
  return null;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // Lazy initialiser: reads localStorage synchronously so the very first
  // render already knows the correct role. Eliminates the stale-null window
  // that caused super_admin to land on AdminDashboard on BFCache restore.
  const [user, setUserState] = useState<WebUser | null>(readUserFromStorage);

  // isLoading is only true momentarily when no saved user was found (fresh
  // first visit / after logout). We resolve it immediately because the web
  // app uses session cookies — there's no async token check.
  const [isLoading, setIsLoading] = useState<boolean>(
    () => readUserFromStorage() === null,
  );

  useEffect(() => {
    // Resolve the loading gate immediately — no async bootstrap needed.
    setIsLoading(false);

    // BFCache guard: when the browser restores this page from the
    // Back-Forward Cache re-read localStorage so any post-login user change
    // is reflected without a hard refresh.
    const handlePageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      try {
        setUserState(readUserFromStorage());
      } catch (e) {
        console.error("[auth] BFCache re-read failed:", e);
      }
    };
    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, []);

  // setUser — updates both the React state and localStorage so non-React
  // callers (apiRequest, impersonation helpers) that read safeGet("user")
  // stay in sync with the context.
  const setUser = useCallback((next: WebUser | null) => {
    if (next === null) {
      safeRemove("user");
    } else {
      safeSet("user", JSON.stringify(next));
    }
    setUserState(next);
  }, []);

  const logout = useCallback(() => {
    setUserState(null);
    clearSessionAndLogout();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, isLoading, setUser, logout }),
    [user, isLoading, setUser, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
