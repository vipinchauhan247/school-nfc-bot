import React from "react";
import { View, Text, StyleSheet, ScrollView, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { usePortal } from "../../context/PortalContext";
import { colors, spacing } from "../../theme";

export default function NoticesTab() {
  const { data, refreshing, refresh } = usePortal();
  const notices = data?.notices ?? [];

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />}
      >
        <Text style={styles.title}>📢 School Notices</Text>
        <Text style={styles.subtitle}>Latest announcements from school</Text>

        {notices.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No notices at the moment</Text>
          </View>
        ) : (
          notices.map((notice) => (
            <View key={notice.id} style={styles.card}>
              <View style={styles.cardTop}>
                <Text style={styles.noticeTitle}>{notice.title}</Text>
                {notice.audience !== "all" && (
                  <Text style={styles.audienceBadge}>
                    {notice.audience === "students" ? "Students" : "Parents"}
                  </Text>
                )}
              </View>
              <Text style={styles.noticeBody}>{notice.body}</Text>
              <Text style={styles.noticeDate}>{notice.created_at?.slice(0, 10)}</Text>
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
  title: { fontSize: 22, fontWeight: "700", color: colors.gray900 },
  subtitle: { fontSize: 14, color: colors.gray500, marginBottom: spacing.lg, marginTop: 4 },
  card: {
    backgroundColor: colors.white, borderRadius: 14, padding: spacing.md,
    marginBottom: spacing.sm, borderLeftWidth: 4, borderLeftColor: colors.primary,
  },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  noticeTitle: { fontSize: 16, fontWeight: "700", color: colors.gray900, flex: 1 },
  audienceBadge: {
    fontSize: 10, fontWeight: "600", color: colors.primary,
    backgroundColor: colors.primaryLight, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8,
  },
  noticeBody: { fontSize: 14, color: colors.gray700, marginTop: 8, lineHeight: 21 },
  noticeDate: { fontSize: 11, color: colors.gray400, marginTop: 8 },
  empty: { backgroundColor: colors.white, borderRadius: 16, padding: spacing.xl, alignItems: "center" },
  emptyText: { color: colors.gray400 },
});
