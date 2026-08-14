import React from "react";
import { View, Text, StyleSheet, ScrollView, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { usePortal } from "../../context/PortalContext";
import { SyncBadge } from "../../components/UI";
import { colors, spacing, radius } from "../../theme";

export default function NoticesTab() {
  const { data, refreshing, refresh, lastSynced } = usePortal();
  const notices = data?.notices ?? [];

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
            <Text style={styles.title}>Notices</Text>
            <Text style={styles.subtitle}>School announcements</Text>
          </View>
          <SyncBadge lastSynced={lastSynced} live />
        </View>

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
    borderLeftWidth: 4,
    borderLeftColor: colors.brand,
    borderWidth: 1,
    borderColor: colors.line,
  },
  cardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 8,
  },
  noticeTitle: { fontSize: 16, fontWeight: "800", color: colors.ink, flex: 1 },
  audienceBadge: {
    fontSize: 10,
    fontWeight: "700",
    color: colors.brand,
    backgroundColor: colors.brandSoft,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  noticeBody: { fontSize: 14, color: colors.gray700, marginTop: 8, lineHeight: 21 },
  noticeDate: { fontSize: 11, color: colors.muted, marginTop: 8 },
  empty: {
    backgroundColor: colors.paper,
    borderRadius: radius.lg,
    padding: spacing.xl,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.line,
  },
  emptyText: { color: colors.muted },
});
