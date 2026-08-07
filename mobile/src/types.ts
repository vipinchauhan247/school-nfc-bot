import { Student } from "./api";

export type RootStackParamList = {
  Welcome: undefined;
  StudentLogin: undefined;
  ParentLogin: undefined;
  StudentPortal: { student: Student };
  ParentPortal: { student: Student };
  AdminLogin: undefined;
  AdminDashboard: undefined;
};
