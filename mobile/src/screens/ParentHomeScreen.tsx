import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, RefreshControl, Alert, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { RouteProp, useFocusEffect } from "@react-navigation/native";
import { colors, spacing } from "../theme";
import { api, AttendanceRecord, Student } from "../api";
import { RootStackParamList } from "../types";

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, "ParentHome">;
  route: RouteProp<RootStackParamList, "ParentHome">;
};

export default function ParentHomeScreen({ navigation, route }: Props) {
  const [student, setStudent] = useState<Student>(route.params.student);
  const [present, setPresent] = useState(false);
  const [timeIn, setTimeIn] = useState<string | null>(null);
  const [history, setHistory] = useState<AttendanceRecord[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = async () => {
    try {
      const data = await api.parentStatus(student.admission_no);
      setStudent(data.student);
      setPresent(data.today.present);
      setTimeIn(data.today.time_in);
      setHistory(data.history);
    } catch {
      Alert.alert("Error", "Could not refresh attendance data");
    }
  };

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [student.admission_no])
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  };

  const logout = async () => {
    if (Platform.OS === "web") {
      localStorage.removeItem("admission_no");
    } else {
      const SecureStore = await import("expo-secure-store");
      await SecureStore.deleteItemAsync("admission_no");
    }
    navigation.reset({ index: 0, routes: [{ name: "Welcome" }] });
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        <View style={styles.topBar}>
          <Text style={styles.greeting}>Hello, Parent 👋</Text>
          <Text style={styles.logout} onPress={logout}>Logout</Text>
        </View>

        <View style={styles.profileCard}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{student.name.charAt(0)}</Text>
          </View>
          <Text style={styles.name}>{student.name}</Text>
          <Text style={styles.meta}>Admission: {student.admission_no} · {student.class_name}</Text>
        </View>

        <View style={[styles.statusCard, present ? styles.statusPresent : styles.statusAbsent]}>
          <Text style={styles.statusIcon}>{present ? "✅" : "⏳"}</Text>
          <View>
            <Text style={styles.statusTitle}>{present ? "Present Today" : "Not Checked In"}</Text>
            {present && timeIn && <Text style={styles.statusTime}>Arrived at {timeIn}</Text>}
            {!present && <Text style={styles.statusTime}>Waiting for NFC check-in</Text>}
          </View>
        </View>

        <Text style={styles.sectionTitle}>Attendance History</Text>
        {history.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No attendance records yet</Text>
          </View>
        ) : (
          history.map((record, i) => (
            <View key={i} style={styles.historyItem}>
              <View style={styles.historyDot} />
              <View style={styles.historyInfo}>
                <Text style={styles.historyDate}>{record.date}</Text>
                <Text style={styles.historyTime}>Checked in at {record.time_in}</Text>
              </View>
              <Text style={styles.historyBadge}>Present</Text>
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.gray50 },
  scroll: { padding: spacing.lg, paddingBottom: spacing.xl },
  topBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.lg },
  greeting: { fontSize: 16, fontWeight: "600", color: colors.gray700 },
  logout: { fontSize: 14, color: colors.danger, fontWeight: "500" },
  profileCard: {
    backgroundColor: colors.white,
    borderRadius: 16,
    padding: spacing.lg,
    alignItems: "center",
    marginBottom: spacing.md,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.primaryLight,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm,
  },
  avatarText: { fontSize: 28, fontWeight: "700", color: colors.primary },
  name: { fontSize: 22, fontWeight: "700", color: colors.gray900 },
  meta: { fontSize: 13, color: colors.gray500, marginTop: 4 },
  statusCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    borderRadius: 16,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  statusPresent: { backgroundColor: colors.successLight },
  statusAbsent: { backgroundColor: colors.dangerLight },
  statusIcon: { fontSize: 36 },
  statusTitle: { fontSize: 18, fontWeight: "700", color: colors.gray900 },
  statusTime: { fontSize: 13, color: colors.gray500, marginTop: 2 },
  sectionTitle: { fontSize: 16, fontWeight: "700", color: colors.gray900, marginBottom: spacing.md },
  historyItem: {
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.sm,
  },
  historyDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.success, marginRight: spacing.md },
  historyInfo: { flex: 1 },
  historyDate: { fontSize: 14, fontWeight: "600", color: colors.gray900 },
  historyTime: { fontSize: 12, color: colors.gray500, marginTop: 2 },
  historyBadge: { fontSize: 11, fontWeight: "600", color: colors.success, backgroundColor: colors.successLight, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  empty: { backgroundColor: colors.white, borderRadius: 12, padding: spacing.xl, alignItems: "center" },
  emptyText: { color: colors.gray400, fontSize: 14 },
});
