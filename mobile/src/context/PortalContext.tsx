import React, { createContext, useContext, useState, useCallback, ReactNode } from "react";
import { Alert } from "react-native";
import { api, DashboardData, Student } from "../api";

export type UserRole = "student" | "parent";

interface PortalContextType {
  role: UserRole;
  student: Student;
  data: DashboardData | null;
  refreshing: boolean;
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

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const result =
        role === "student"
          ? await api.studentDashboard(student.admission_no)
          : await api.parentDashboard(student.admission_no);
      setData(result);
    } catch {
      Alert.alert("Error", "Could not load data. Check your connection.");
    } finally {
      setRefreshing(false);
    }
  }, [role, student.admission_no]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <PortalContext.Provider value={{ role, student, data, refreshing, refresh }}>
      {children}
    </PortalContext.Provider>
  );
}
