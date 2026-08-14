import React from "react";
import { View, Text, StyleSheet, ScrollView, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { usePortal } from "../../context/PortalContext";
import { SyncBadge } from "../../components/UI";
import { colors, spacing, radius } from "../../theme";

function dueLabel(dueDate: string) {
  const today = new Date().toISOString().slice(0, 10);
  if (dueDate < today) return { text: "Overdue", color: colors.danger, bg: colors.dangerSoft };
  if (dueDate === today) return { text: "Due today", color: colors.warning, bg: colors.warningSoft };
  return { text: `Due ${dueDate}`, color: colors.brand, bg: colors.brandSoft };
}

export default function HomeworkTab() {
  const { role, student, data, refreshing, refresh, lastSynced } = usePortal();
  const homework = data?.homework ?? [];

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
            <Text style={styles.title}>Homework</Text>
            <Text style={styles.subtitle}>
              {role === "student"
                ? `Assignments for ${student.class_name}`
                : `${student.name}'s class assignments`}
            </Text>
          </View>
          <SyncBadge lastSynced={lastSynced} live />
        </View>

        {homework.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No homework assigned</Text>
          </View>
        ) : (
          homework.map((hw) => {
            const due = dueLabel(hw.due_date);
            return (
              <View key={hw.id} style={styles.card}>
                <View style={styles.cardHeader}>
                  <Text style={styles.subject}>{hw.subject}</Text>
                  <Text style={[styles.dueBadge, { color: due.color, backgroundColor: due.bg }]}>
                    {due.text}
                  </Text>
                </View>
                <Text style={styles.hwTitle}>{hw.title}</Text>
                {hw.description ? <Text style={styles.hwDesc}>{hw.description}</Text> : null}
              </View>
            );
          })
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
    marginBottom: spacing.lg,
  },
  title: { fontSize: 24, fontWeight: "800", color: colors.ink, letterSpacing: -0.3 },
  subtitle: { fontSize: 13, color: colors.gray500, marginTop: 4 },
  card: {
    backgroundColor: colors.paper,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.line,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  subject: {
    fontSize: 12,
    fontWeight: "800",
    color: colors.brand,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  dueBadge: {
    fontSize: 11,
    fontWeight: "700",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  hwTitle: { fontSize: 16, fontWeight: "700", color: colors.ink },
  hwDesc: { fontSize: 13, color: colors.gray500, marginTop: 6, lineHeight: 20 },
  empty: {
    alignItems: "center",
    padding: spacing.xl,
    backgroundColor: colors.paper,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
  },
  emptyText: { color: colors.muted, fontSize: 15 },
});
