import React from "react";
import { PortalProvider } from "../context/PortalContext";
import PortalTabs from "../navigation/PortalTabs";
import { UserRole } from "../context/PortalContext";
import { Student } from "../api";

interface Props {
  role: UserRole;
  student: Student;
}

export default function PortalScreen({ role, student }: Props) {
  return (
    <PortalProvider role={role} student={student}>
      <PortalTabs />
    </PortalProvider>
  );
}
