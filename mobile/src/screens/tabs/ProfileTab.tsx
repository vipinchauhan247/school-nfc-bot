import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { usePortal } from "../../context/PortalContext";
import { colors, spacing } from "../../theme";
import { RootStackParamList } from "../../types";

export default function ProfileTab() {
  const { role, student } = usePortal();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const logout = async () => {
    const key = role === "student" ? "student_admission_no" : "parent_admission_no";
    if (Platform.OS === "web") {
      localStorage.removeItem(key);
    } else {
      const SecureStore = await import("expo-secure-store");
      await SecureStore.deleteItemAsync(key);
    }
    navigation.reset({ index: 0, routes: [{ name: "Welcome" }] });
  };

  const rows = [
    { label: "Name", value: student.name },
    { label: "Admission No", value: student.admission_no },
    { label: "Class", value: student.class_name },
    ...(role === "parent"
      ? [
          { label: "Parent Name", value: student.parent_name || "—" },
          { label: "Phone", value: student.parent_phone || "—" },
        ]
      : []),
  ];

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.content}>
        <View style={styles.header}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{student.name.charAt(0)}</Text>
          </View>
          <Text style={styles.name}>{student.name}</Text>
          <Text style={styles.role}>{role === "student" ? "Student" : "Parent"}</Text>
        </View>

        <View style={styles.card}>
          {rows.map((row, i) => (
            <View key={row.label} style={[styles.row, i < rows.length - 1 && styles.rowBorder]}>
              <Text style={styles.rowLabel}>{row.label}</Text>
              <Text style={styles.rowValue}>{row.value}</Text>
            </View>
          ))}
        </View>

        <View style={styles.schoolCard}>
          <Text style={styles.schoolEmoji}>🏫</Text>
          <Text style={styles.schoolName}>Madan Mohan Malviya{"\n"}Junior High School</Text>
        </View>

        <TouchableOpacity style={styles.logoutBtn} onPress={logout}>
          <Text style={styles.logoutText}>Logout</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.gray50 },
  content: { padding: spacing.lg },
  header: { alignItems: "center", marginBottom: spacing.lg },
  avatar: {
    width: 72, height: 72, borderRadius: 36, backgroundColor: colors.primaryLight,
    alignItems: "center", justifyContent: "center", marginBottom: spacing.sm,
  },
  avatarText: { fontSize: 32, fontWeight: "700", color: colors.primary },
  name: { fontSize: 22, fontWeight: "700", color: colors.gray900 },
  role: { fontSize: 14, color: colors.gray500, marginTop: 2 },
  card: { backgroundColor: colors.white, borderRadius: 16, overflow: "hidden", marginBottom: spacing.md },
  row: { flexDirection: "row", justifyContent: "space-between", padding: spacing.md },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.gray100 },
  rowLabel: { fontSize: 14, color: colors.gray500 },
  rowValue: { fontSize: 14, fontWeight: "600", color: colors.gray900 },
  schoolCard: {
    backgroundColor: colors.primaryLight, borderRadius: 16, padding: spacing.lg,
    alignItems: "center", marginBottom: spacing.lg,
  },
  schoolEmoji: { fontSize: 32, marginBottom: spacing.sm },
  schoolName: { fontSize: 14, fontWeight: "600", color: colors.primary, textAlign: "center", lineHeight: 22 },
  logoutBtn: {
    backgroundColor: colors.white, borderRadius: 12, padding: spacing.md,
    alignItems: "center", borderWidth: 1, borderColor: colors.dangerLight,
  },
  logoutText: { color: colors.danger, fontWeight: "600", fontSize: 15 },
});
