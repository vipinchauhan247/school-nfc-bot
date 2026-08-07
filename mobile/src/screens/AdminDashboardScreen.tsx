import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, RefreshControl, Alert, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useFocusEffect } from "@react-navigation/native";
import StatCard, { Button } from "../components/UI";
import { colors, spacing } from "../theme";
import { api, Student } from "../api";
import { RootStackParamList } from "../types";

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, "AdminDashboard"> };

export default function AdminDashboardScreen({ navigation }: Props) {
  const [stats, setStats] = useState({ total: 0, present: 0, absent: 0 });
  const [students, setStudents] = useState<Student[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [marking, setMarking] = useState<number | null>(null);

  const loadData = async () => {
    try {
      const data = await api.adminDashboard();
      setStats(data.stats);
      setStudents(data.students);
    } catch {
      Alert.alert("Error", "Could not load dashboard");
    }
  };

  useFocusEffect(useCallback(() => { loadData(); }, []));

  const onRefresh = async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  };

  const markPresent = async (studentId: number) => {
    setMarking(studentId);
    try {
      const result = await api.markAttendance(studentId);
      Alert.alert(result.success ? "Done" : "Info", result.message);
      await loadData();
    } catch (e: any) {
      Alert.alert("Error", e.message);
    } finally {
      setMarking(null);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        <View style={styles.topBar}>
          <Text style={styles.title}>Admin Dashboard</Text>
          <Text style={styles.back} onPress={() => navigation.reset({ index: 0, routes: [{ name: "Welcome" }] })}>
            Exit
          </Text>
        </View>

        <View style={styles.statsRow}>
          <StatCard title="Students" value={stats.total} icon="👨‍🎓" color={colors.primary} />
          <StatCard title="Present" value={stats.present} icon="✅" color={colors.success} />
        </View>
        <View style={styles.statsRow}>
          <StatCard title="Absent" value={stats.absent} icon="❌" color={colors.danger} />
          <StatCard
            title="Rate"
            value={stats.total > 0 ? `${Math.round((stats.present / stats.total) * 100)}%` : "0%"}
            icon="📊"
            color={colors.warning}
          />
        </View>

        <Text style={styles.sectionTitle}>All Students ({students.length})</Text>
        {students.map((student) => (
          <View key={student.id} style={styles.studentCard}>
            <View style={styles.studentInfo}>
              <Text style={styles.studentName}>{student.name}</Text>
              <Text style={styles.studentMeta}>
                #{student.admission_no} · {student.class_name}
              </Text>
            </View>
            <TouchableOpacity
              style={[styles.markBtn, marking === student.id && styles.markBtnDisabled]}
              onPress={() => markPresent(student.id)}
              disabled={marking === student.id}
            >
              <Text style={styles.markBtnText}>{marking === student.id ? "..." : "Mark"}</Text>
            </TouchableOpacity>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.gray50 },
  scroll: { padding: spacing.lg, paddingBottom: spacing.xl },
  topBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.lg },
  title: { fontSize: 22, fontWeight: "700", color: colors.gray900 },
  back: { fontSize: 14, color: colors.danger, fontWeight: "500" },
  statsRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.sm },
  sectionTitle: { fontSize: 16, fontWeight: "700", color: colors.gray900, marginTop: spacing.md, marginBottom: spacing.md },
  studentCard: {
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.sm,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  studentInfo: { flex: 1 },
  studentName: { fontSize: 15, fontWeight: "600", color: colors.gray900 },
  studentMeta: { fontSize: 12, color: colors.gray500, marginTop: 2 },
  markBtn: {
    backgroundColor: colors.success,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  markBtnDisabled: { opacity: 0.5 },
  markBtnText: { color: colors.white, fontWeight: "600", fontSize: 13 },
});
