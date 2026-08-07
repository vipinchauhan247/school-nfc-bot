export const API_BASE = process.env.EXPO_PUBLIC_API_URL || "http://127.0.0.1:8080";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.message || "Request failed");
  }
  return data;
}

export interface Student {
  id: number;
  admission_no: string;
  name: string;
  class_name: string;
  parent_name: string;
  parent_phone: string;
}

export interface AttendanceRecord {
  date: string;
  time_in: string;
  status: string;
}

export const api = {
  getSchoolInfo: () => request<{ school_name: string; stats: { total: number; present: number; absent: number } }>("/api/mobile/school"),

  parentLogin: (admission_no: string) =>
    request<{ success: boolean; student: Student; today: { present: boolean; time_in: string | null } }>(
      "/api/mobile/parent/login",
      { method: "POST", body: JSON.stringify({ admission_no }) }
    ),

  parentStatus: (admission_no: string) =>
    request<{
      success: boolean;
      student: Student;
      today: { present: boolean; time_in: string | null };
      history: AttendanceRecord[];
    }>(`/api/mobile/parent/${admission_no}/status`),

  adminLogin: (password: string) =>
    request<{ success: boolean }>("/api/mobile/admin/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  adminDashboard: () =>
    request<{
      success: boolean;
      stats: { total: number; present: number; absent: number };
      students: Student[];
      today_attendance: (Student & { time_in: string })[];
    }>("/api/mobile/admin/dashboard"),

  markAttendance: (studentId: number) =>
    request<{ success: boolean; message: string }>(`/api/mobile/admin/mark/${studentId}`, { method: "POST" }),
};
