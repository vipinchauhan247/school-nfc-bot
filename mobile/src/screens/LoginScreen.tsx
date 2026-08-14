import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Alert,
  TouchableOpacity,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { colors, spacing, radius } from "../theme";
import { Button } from "../components/UI";
import { api } from "../api";
import { RootStackParamList } from "../types";
import { UserRole } from "../context/PortalContext";

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, "StudentLogin" | "ParentLogin">;
  role: UserRole;
};

async function saveAdmissionNo(role: UserRole, admissionNo: string) {
  const key = role === "student" ? "student_admission_no" : "parent_admission_no";
  if (Platform.OS === "web") {
    localStorage.setItem(key, admissionNo);
    return;
  }
  const SecureStore = await import("expo-secure-store");
  await SecureStore.setItemAsync(key, admissionNo);
}

export default function LoginScreen({ navigation, role }: Props) {
  const [admissionNo, setAdmissionNo] = useState("");
  const [loading, setLoading] = useState(false);

  const isStudent = role === "student";

  const handleLogin = async () => {
    if (!admissionNo.trim()) {
      Alert.alert("Error", "Please enter admission number");
      return;
    }
    setLoading(true);
    try {
      const loginFn = isStudent ? api.studentLogin : api.parentLogin;
      const data = await loginFn(admissionNo.trim());
      await saveAdmissionNo(role, admissionNo.trim());
      navigation.replace(isStudent ? "StudentPortal" : "ParentPortal", {
        student: data.student,
      });
    } catch (e: any) {
      Alert.alert("Not Found", e.message || "Student not found. Check admission number.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.inner}
      >
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backRow}>
          <Ionicons name="arrow-back" size={20} color={colors.brand} />
          <Text style={styles.back}>Back</Text>
        </TouchableOpacity>

        <View style={styles.header}>
          <View style={styles.iconBubble}>
            <Ionicons
              name={isStudent ? "school-outline" : "people-outline"}
              size={28}
              color={colors.brand}
            />
          </View>
          <Text style={styles.title}>{isStudent ? "Student Login" : "Parent Login"}</Text>
          <Text style={styles.subtitle}>
            {isStudent
              ? "Enter your admission number"
              : "Enter your child’s admission number"}
          </Text>
        </View>

        <View style={styles.form}>
          <Text style={styles.label}>Admission Number</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. 2211"
            placeholderTextColor={colors.gray400}
            value={admissionNo}
            onChangeText={setAdmissionNo}
            keyboardType="number-pad"
            autoFocus
          />
          <Button
            title="Continue"
            onPress={handleLogin}
            loading={loading}
            disabled={loading}
          />
        </View>

        <Text style={styles.hint}>Use a real admission number from the school Google Sheet</Text>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.sand },
  inner: { flex: 1, padding: spacing.lg },
  backRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: spacing.lg },
  back: { fontSize: 16, color: colors.brand, fontWeight: "600" },
  header: { alignItems: "center", marginBottom: spacing.xl },
  iconBubble: {
    width: 64,
    height: 64,
    borderRadius: 20,
    backgroundColor: colors.brandSoft,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.md,
  },
  title: { fontSize: 24, fontWeight: "800", color: colors.ink, letterSpacing: -0.3 },
  subtitle: {
    fontSize: 14,
    color: colors.gray500,
    marginTop: spacing.xs,
    textAlign: "center",
  },
  form: {
    backgroundColor: colors.paper,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.line,
  },
  label: { fontSize: 13, fontWeight: "700", color: colors.gray700 },
  input: {
    borderWidth: 1.5,
    borderColor: colors.line,
    borderRadius: radius.md,
    padding: 14,
    fontSize: 20,
    fontWeight: "700",
    color: colors.ink,
    letterSpacing: 1.5,
    backgroundColor: colors.gray50,
  },
  hint: { textAlign: "center", color: colors.muted, fontSize: 12, marginTop: spacing.lg },
});
