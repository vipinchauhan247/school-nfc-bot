import { Student } from "./api";

export type RootStackParamList = {
  Welcome: undefined;
  ParentLogin: undefined;
  ParentHome: { student: Student };
  AdminLogin: undefined;
  AdminDashboard: undefined;
};
