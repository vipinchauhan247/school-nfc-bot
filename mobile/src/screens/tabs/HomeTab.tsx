import React from "react";
import { View, Text, StyleSheet, ScrollView, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { usePortal } from "../../context/PortalContext";
import { colors, spacing } from "../../theme";

export default function HomeTab() {
  const { role, student, data, refreshing, refresh } = usePortal();

  const present = data?.today.present ?? false;
  const timeIn = data?.today.time_in;
  const history = data?.history ?? [];
  const summary = data?.summary;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />}
      >
        <Text style={styles.greeting}>
          {role === "student" ? `Hello, ${student.name.split(" ")[0]} 👋` : "Hello, Parent 👋"}
        </Text>

        {role === "parent" && (
          <View style={styles.childCard}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{student.name.charAt(0)}</Text>
            </View>
            <Text style={styles.childName}>{student.name}</Text>
            <Text style={styles.childMeta}>{student.class_name} · #{student.admission_no}</Text>
          </View>
        )}

        <View style={[styles.statusCard, present ? styles.present : styles.absent]}>
          <Text style={styles.statusIcon}>{present ? "✅" : "⏳"}</Text>
          <View style={styles.statusText}>
            <Text style={styles.statusTitle}>
              {role === "student"
                ? present ? "You're Present Today!" : "Not Checked In Yet"
                : present ? "Present Today" : "Not Checked In"}
            </Text>
            <Text style={styles.statusSub}>
              {present ? `Arrived at ${timeIn}` : "Tap NFC card at school gate"}
            </Text>
          </View>
        </View>

        {summary && (
          <View style={styles.statsRow}>
            <View style={styles.statBox}>
              <Text style={styles.statValue}>{summary.present_days}</Text>
              <Text style={styles.statLabel}>Days Present</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={[styles.statValue, { color: colors.primary }]}>{summary.percentage}%</Text>
              <Text style={styles.statLabel}>30-Day Rate</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.statValue}>{summary.period_days - summary.present_days}</Text>
              <Text style={styles.statLabel}>Days Absent</Text>
            </View>
          </View>
        )}

        <Text style={styles.sectionTitle}>Recent Attendance</Text>
        {history.length === 0 ? (
          <View style={styles.empty}><Text style={styles.emptyText}>No records yet</Text></View>
        ) : (
          history.slice(0, 7).map((r, i) => (
            <View key={i} style={styles.historyRow}>
              <View style={styles.dot} />
              <View style={{ flex: 1 }}>
                <Text style={styles.historyDate}>{r.date}</Text>
                <Text style={styles.historyTime}>{r.time_in}</Text>
              </View>
              <Text style={styles.badge}>Present</Text>
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
  greeting: { fontSize: 22, fontWeight: "700", color: colors.gray900, marginBottom: spacing.md },
  childCard: {
    backgroundColor: colors.white, borderRadius: 16, padding: spacing.lg,
    alignItems: "center", marginBottom: spacing.md,
    shadowColor: "#000", shadowOpacity: 0.05, shadowRadius: 8, elevation: 2,
  },
  avatar: {
    width: 56, height: 56, borderRadius: 28, backgroundColor: colors.primaryLight,
    alignItems: "center", justifyContent: "center", marginBottom: spacing.sm,
  },
  avatarText: { fontSize: 24, fontWeight: "700", color: colors.primary },
  childName: { fontSize: 18, fontWeight: "700", color: colors.gray900 },
  childMeta: { fontSize: 13, color: colors.gray500, marginTop: 2 },
  statusCard: {
    flexDirection: "row", alignItems: "center", gap: spacing.md,
    borderRadius: 16, padding: spacing.lg, marginBottom: spacing.md,
  },
  present: { backgroundColor: colors.successLight },
  absent: { backgroundColor: colors.dangerLight },
  statusIcon: { fontSize: 32 },
  statusText: { flex: 1 },
  statusTitle: { fontSize: 17, fontWeight: "700", color: colors.gray900 },
  statusSub: { fontSize: 13, color: colors.gray500, marginTop: 2 },
  statsRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.lg },
  statBox: {
    flex: 1, backgroundColor: colors.white, borderRadius: 12,
    padding: spacing.md, alignItems: "center",
  },
  statValue: { fontSize: 20, fontWeight: "700", color: colors.gray900 },
  statLabel: { fontSize: 11, color: colors.gray500, marginTop: 2, textAlign: "center" },
  sectionTitle: { fontSize: 16, fontWeight: "700", color: colors.gray900, marginBottom: spacing.md },
  historyRow: {
    backgroundColor: colors.white, borderRadius: 12, padding: spacing.md,
    flexDirection: "row", alignItems: "center", marginBottom: spacing.sm,
  },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.success, marginRight: spacing.md },
  historyDate: { fontSize: 14, fontWeight: "600", color: colors.gray900 },
  historyTime: { fontSize: 12, color: colors.gray500 },
  badge: {
    fontSize: 11, fontWeight: "600", color: colors.success,
    backgroundColor: colors.successLight, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8,
  },
  empty: { backgroundColor: colors.white, borderRadius: 12, padding: spacing.xl, alignItems: "center" },
  emptyText: { color: colors.gray400 },
});
