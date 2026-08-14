import React from "react";
import { View, Text, StyleSheet, ScrollView, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { usePortal } from "../../context/PortalContext";
import { SyncBadge } from "../../components/UI";
import { colors, spacing, radius } from "../../theme";

export default function HomeTab() {
  const { role, student, data, refreshing, refresh, lastSynced } = usePortal();

  const present = data?.today.present ?? false;
  const timeIn = data?.today.time_in;
  const history = data?.history ?? [];
  const summary = data?.summary;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.brand} />
        }
      >
        <View style={styles.top}>
          <View style={{ flex: 1 }}>
            <Text style={styles.greeting}>
              {role === "student"
                ? `Hello, ${student.name.split(" ")[0]}`
                : "Hello, Parent"}
            </Text>
            <Text style={styles.sub}>
              {role === "student"
                ? `${student.class_name} · #${student.admission_no}`
                : "Live attendance from school ERP"}
            </Text>
          </View>
          <SyncBadge lastSynced={lastSynced} live />
        </View>

        {role === "parent" && (
          <View style={styles.childCard}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{student.name.charAt(0)}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.childName}>{student.name}</Text>
              <Text style={styles.childMeta}>
                {student.class_name} · #{student.admission_no}
              </Text>
            </View>
          </View>
        )}

        <View style={[styles.statusCard, present ? styles.present : styles.absent]}>
          <View
            style={[
              styles.statusIcon,
              { backgroundColor: present ? colors.successSoft : colors.dangerSoft },
            ]}
          >
            <Ionicons
              name={present ? "checkmark-circle" : "time-outline"}
              size={28}
              color={present ? colors.success : colors.danger}
            />
          </View>
          <View style={styles.statusText}>
            <Text style={styles.statusTitle}>
              {role === "student"
                ? present
                  ? "You’re present today"
                  : "Not checked in yet"
                : present
                  ? "Present today"
                  : "Not checked in"}
            </Text>
            <Text style={styles.statusSub}>
              {present
                ? `Arrived at ${timeIn}`
                : "Updates when NFC gate or staff marks attendance"}
            </Text>
          </View>
        </View>

        {summary && (
          <View style={styles.statsRow}>
            <View style={styles.statBox}>
              <Text style={styles.statValue}>{summary.present_days}</Text>
              <Text style={styles.statLabel}>Days present</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={[styles.statValue, { color: colors.brand }]}>
                {summary.percentage}%
              </Text>
              <Text style={styles.statLabel}>30-day rate</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.statValue}>
                {summary.period_days - summary.present_days}
              </Text>
              <Text style={styles.statLabel}>Days absent</Text>
            </View>
          </View>
        )}

        <Text style={styles.sectionTitle}>Recent attendance</Text>
        {history.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No records yet</Text>
          </View>
        ) : (
          history.slice(0, 7).map((r, i) => (
            <View key={`${r.date}-${i}`} style={styles.historyRow}>
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
  container: { flex: 1, backgroundColor: colors.sand },
  scroll: { padding: spacing.lg, paddingBottom: spacing.xl },
  top: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  greeting: { fontSize: 24, fontWeight: "800", color: colors.ink, letterSpacing: -0.4 },
  sub: { fontSize: 13, color: colors.gray500, marginTop: 4 },
  childCard: {
    backgroundColor: colors.paper,
    borderRadius: radius.lg,
    padding: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.line,
    gap: spacing.md,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: colors.brandSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: 20, fontWeight: "800", color: colors.brand },
  childName: { fontSize: 16, fontWeight: "700", color: colors.ink },
  childMeta: { fontSize: 12, color: colors.gray500, marginTop: 2 },
  statusCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
  },
  present: { backgroundColor: colors.successSoft, borderColor: "#A7F3D0" },
  absent: { backgroundColor: colors.dangerSoft, borderColor: "#FECACA" },
  statusIcon: {
    width: 52,
    height: 52,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  statusText: { flex: 1 },
  statusTitle: { fontSize: 16, fontWeight: "800", color: colors.ink },
  statusSub: { fontSize: 13, color: colors.gray500, marginTop: 3, lineHeight: 18 },
  statsRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.lg },
  statBox: {
    flex: 1,
    backgroundColor: colors.paper,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.line,
  },
  statValue: { fontSize: 20, fontWeight: "800", color: colors.ink },
  statLabel: { fontSize: 11, color: colors.gray500, marginTop: 2, textAlign: "center" },
  sectionTitle: {
    fontSize: 15,
    fontWeight: "800",
    color: colors.ink,
    marginBottom: spacing.md,
  },
  historyRow: {
    backgroundColor: colors.paper,
    borderRadius: radius.md,
    padding: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.line,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.success,
    marginRight: spacing.md,
  },
  historyDate: { fontSize: 14, fontWeight: "700", color: colors.ink },
  historyTime: { fontSize: 12, color: colors.gray500 },
  badge: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.success,
    backgroundColor: colors.successSoft,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  empty: {
    backgroundColor: colors.paper,
    borderRadius: radius.md,
    padding: spacing.xl,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.line,
  },
  emptyText: { color: colors.muted },
});
