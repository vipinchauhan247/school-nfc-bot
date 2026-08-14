import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  ReactNode,
} from "react";
import { Alert, AppState } from "react-native";
import { api, DashboardData, Student } from "../api";

export type UserRole = "student" | "parent";

const SYNC_INTERVAL_MS = 12000;

interface PortalContextType {
  role: UserRole;
  student: Student;
  data: DashboardData | null;
  refreshing: boolean;
  lastSynced: Date | null;
  refresh: () => Promise<void>;
}

const PortalContext = createContext<PortalContextType | null>(null);

export function usePortal() {
  const ctx = useContext(PortalContext);
  if (!ctx) throw new Error("usePortal must be used within PortalProvider");
  return ctx;
}

interface Props {
  role: UserRole;
  student: Student;
  children: ReactNode;
}

export function PortalProvider({ role, student, children }: Props) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const silent = useRef(false);

  const refresh = useCallback(async () => {
    if (!silent.current) setRefreshing(true);
    try {
      const result =
        role === "student"
          ? await api.studentDashboard(student.admission_no)
          : await api.parentDashboard(student.admission_no);
      setData(result);
      setLastSynced(new Date());
    } catch {
      if (!silent.current) {
        Alert.alert("Error", "Could not load data. Check your connection.");
      }
    } finally {
      setRefreshing(false);
      silent.current = false;
    }
  }, [role, student.admission_no]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-sync with website / NFC / admin changes
  useEffect(() => {
    const tick = () => {
      silent.current = true;
      refresh();
    };
    const id = setInterval(tick, SYNC_INTERVAL_MS);
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        silent.current = true;
        refresh();
      }
    });
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [refresh]);

  return (
    <PortalContext.Provider
      value={{ role, student, data, refreshing, lastSynced, refresh }}
    >
      {children}
    </PortalContext.Provider>
  );
}
