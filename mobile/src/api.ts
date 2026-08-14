// ERP website on Vercel: https://mmmjhschool.com
// Do not point this app at NFC / @Vipinbellbot.
export const API_BASE =
  process.env.EXPO_PUBLIC_API_URL || "https://mmmjhschool.com";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(`${API_BASE}${path}`, {
      headers: { "Content-Type": "application/json", ...options?.headers },
      ...options,
      signal: controller.signal,
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.message || "Request failed");
    }
    return data;
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new Error("Server timed out. Check API URL / internet.");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
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

export interface Notice {
  id: number;
  title: string;
  body: string;
  audience: string;
  created_at: string;
}

export interface Homework {
  id: number;
  class_name: string;
  subject: string;
  title: string;
  description: string;
  due_date: string;
}

export interface DashboardData {
  success: boolean;
  student: Student;
  today: { present: boolean; time_in: string | null };
  history: AttendanceRecord[];
  summary: { present_days: number; period_days: number; percentage: number };
  notices: Notice[];
  homework: Homework[];
}

export const api = {
  getSchoolInfo: () =>
    request<{ school_name: string; stats: { total: number; present: number; absent: number } }>(
      "/api/mobile/school"
    ),

  parentLogin: (admission_no: string) =>
    request<{
      success: boolean;
      student: Student;
      today: { present: boolean; time_in: string | null };
    }>("/api/mobile/parent/login", {
      method: "POST",
      body: JSON.stringify({ admission_no }),
    }),

  studentLogin: (admission_no: string) =>
    request<{
      success: boolean;
      student: Student;
      today: { present: boolean; time_in: string | null };
    }>("/api/mobile/student/login", {
      method: "POST",
      body: JSON.stringify({ admission_no }),
    }),

  parentDashboard: (admission_no: string) =>
    request<DashboardData>(`/api/mobile/parent/${admission_no}/status`),

  studentDashboard: (admission_no: string) =>
    request<DashboardData>(`/api/mobile/student/${admission_no}/dashboard`),

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
    request<{ success: boolean; message: string }>(
      `/api/mobile/admin/mark/${studentId}`,
      { method: "POST" }
    ),
};
