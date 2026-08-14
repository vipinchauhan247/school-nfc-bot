import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  Alert,
  TouchableOpacity,
  AppState,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useFocusEffect } from "@react-navigation/native";
import StatCard, { SyncBadge } from "../components/UI";
import { colors, spacing, radius } from "../theme";
import { api, Student } from "../api";
import { RootStackParamList } from "../types";

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, "AdminDashboard"> };

const SYNC_MS = 12000;

export default function AdminDashboardScreen({ navigation }: Props) {
  const [stats, setStats] = useState({ total: 0, present: 0, absent: 0 });
  const [students, setStudents] = useState<Student[]>([]);
  const [presentIds, setPresentIds] = useState<Set<number>>(new Set());
  const [presentTimes, setPresentTimes] = useState<Record<number, string>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [marking, setMarking] = useState<number | null>(null);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const silent = useRef(false);

  const loadData = async () => {
    try {
      const data = await api.adminDashboard();
      setStats(data.stats);
      setStudents(data.students);
      const ids = new Set<number>();
      const times: Record<number, string> = {};
      for (const row of data.today_attendance || []) {
        ids.add(row.id);
        times[row.id] = row.time_in;
      }
      setPresentIds(ids);
      setPresentTimes(times);
      setLastSynced(new Date());
    } catch {
      if (!silent.current) Alert.alert("Error", "Could not load dashboard");
    }
  };

  useFocusEffect(
    useCallback(() => {
      silent.current = false;
      loadData();
    }, [])
  );

  useEffect(() => {
    const tick = () => {
      silent.current = true;
      loadData();
    };
    const id = setInterval(tick, SYNC_MS);
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        silent.current = true;
        loadData();
      }
    });
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    silent.current = false;
    await loadData();
    setRefreshing(false);
  };

  const markPresent = async (studentId: number) => {
    setMarking(studentId);
    try {
      const result = await api.markAttendance(studentId);
      Alert.alert(result.success ? "Done" : "Info", result.message);
      silent.current = true;
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
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} />
        }
      >
        <View style={styles.topBar}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Staff ERP</Text>
            <Text style={styles.caption}>Same data as the website</Text>
          </View>
          <Text
            style={styles.back}
            onPress={() =>
              navigation.reset({ index: 0, routes: [{ name: "Welcome" }] })
            }
          >
            Exit
          </Text>
        </View>

        <View style={{ marginBottom: spacing.md }}>
          <SyncBadge lastSynced={lastSynced} live />
        </View>

        <View style={styles.statsRow}>
          <StatCard title="Students" value={stats.total} icon="people-outline" color={colors.brand} />
          <StatCard title="Present" value={stats.present} icon="checkmark-circle-outline" color={colors.success} />
        </View>
        <View style={styles.statsRow}>
          <StatCard title="Absent" value={stats.absent} icon="close-circle-outline" color={colors.danger} />
          <StatCard
            title="Rate"
            value={stats.total > 0 ? `${Math.round((stats.present / stats.total) * 100)}%` : "0%"}
            icon="stats-chart-outline"
            color={colors.warning}
          />
        </View>

        <Text style={styles.sectionTitle}>All students ({students.length})</Text>
        {students.map((student) => {
          const isPresent = presentIds.has(student.id);
          return (
            <View key={student.id} style={styles.studentCard}>
              <View style={styles.studentInfo}>
                <Text style={styles.studentName}>{student.name}</Text>
                <Text style={styles.studentMeta}>
                  #{student.admission_no} · {student.class_name}
                  {isPresent && presentTimes[student.id]
                    ? ` · in ${presentTimes[student.id]}`
                    : ""}
                </Text>
              </View>
              {isPresent ? (
                <View style={styles.presentPill}>
                  <Text style={styles.presentPillText}>Present</Text>
                </View>
              ) : (
                <TouchableOpacity
                  style={[styles.markBtn, marking === student.id && styles.markBtnDisabled]}
                  onPress={() => markPresent(student.id)}
                  disabled={marking === student.id}
                >
                  <Text style={styles.markBtnText}>
                    {marking === student.id ? "..." : "Mark"}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.sand },
  scroll: { padding: spacing.lg, paddingBottom: spacing.xl },
  topBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: spacing.sm,
  },
  title: { fontSize: 24, fontWeight: "800", color: colors.ink },
  caption: { fontSize: 12, color: colors.gray500, marginTop: 2 },
  back: { fontSize: 14, color: colors.danger, fontWeight: "700" },
  statsRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.sm },
  sectionTitle: {
    fontSize: 15,
    fontWeight: "800",
    color: colors.ink,
    marginTop: spacing.md,
    marginBottom: spacing.md,
  },
  studentCard: {
    backgroundColor: colors.paper,
    borderRadius: radius.md,
    padding: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.line,
  },
  studentInfo: { flex: 1 },
  studentName: { fontSize: 15, fontWeight: "700", color: colors.ink },
  studentMeta: { fontSize: 12, color: colors.gray500, marginTop: 2 },
  markBtn: {
    backgroundColor: colors.success,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 10,
  },
  markBtnDisabled: { opacity: 0.5 },
  markBtnText: { color: colors.white, fontWeight: "700", fontSize: 13 },
  presentPill: {
    backgroundColor: colors.successSoft,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  presentPillText: { color: colors.success, fontWeight: "700", fontSize: 12 },
});
