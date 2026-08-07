import React from "react";
import { View, Text, StyleSheet, ScrollView, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { usePortal } from "../../context/PortalContext";
import { colors, spacing } from "../../theme";

function dueLabel(dueDate: string) {
  const today = new Date().toISOString().slice(0, 10);
  if (dueDate < today) return { text: "Overdue", color: colors.danger, bg: colors.dangerLight };
  if (dueDate === today) return { text: "Due Today", color: colors.warning, bg: "#FEF3C7" };
  return { text: `Due ${dueDate}`, color: colors.primary, bg: colors.primaryLight };
}

export default function HomeworkTab() {
  const { role, student, data, refreshing, refresh } = usePortal();
  const homework = data?.homework ?? [];

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />}
      >
        <Text style={styles.title}>📚 Homework</Text>
        <Text style={styles.subtitle}>
          {role === "student"
            ? `Assignments for ${student.class_name}`
            : `${student.name}'s class assignments`}
        </Text>

        {homework.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>🎉</Text>
            <Text style={styles.emptyText}>No homework assigned!</Text>
          </View>
        ) : (
          homework.map((hw) => {
            const due = dueLabel(hw.due_date);
            return (
              <View key={hw.id} style={styles.card}>
                <View style={styles.cardHeader}>
                  <Text style={styles.subject}>{hw.subject}</Text>
                  <Text style={[styles.dueBadge, { color: due.color, backgroundColor: due.bg }]}>{due.text}</Text>
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
  container: { flex: 1, backgroundColor: colors.gray50 },
  scroll: { padding: spacing.lg, paddingBottom: spacing.xl },
  title: { fontSize: 22, fontWeight: "700", color: colors.gray900 },
  subtitle: { fontSize: 14, color: colors.gray500, marginBottom: spacing.lg, marginTop: 4 },
  card: {
    backgroundColor: colors.white, borderRadius: 14, padding: spacing.md,
    marginBottom: spacing.sm, shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 4, elevation: 1,
  },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  subject: { fontSize: 12, fontWeight: "700", color: colors.primary, textTransform: "uppercase" },
  dueBadge: { fontSize: 11, fontWeight: "600", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  hwTitle: { fontSize: 16, fontWeight: "600", color: colors.gray900 },
  hwDesc: { fontSize: 13, color: colors.gray500, marginTop: 6, lineHeight: 20 },
  empty: { alignItems: "center", padding: spacing.xl, backgroundColor: colors.white, borderRadius: 16 },
  emptyIcon: { fontSize: 40, marginBottom: spacing.sm },
  emptyText: { color: colors.gray400, fontSize: 15 },
});
