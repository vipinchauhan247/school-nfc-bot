import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { colors, spacing } from "../theme";
import { RootStackParamList } from "../types";

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, "Welcome"> };

const ROLES = [
  { key: "StudentLogin" as const, icon: "🎒", title: "Student", desc: "Homework, notices & attendance", color: colors.primary },
  { key: "ParentLogin" as const, icon: "👨‍👩‍👧", title: "Parent", desc: "Track your child's progress", color: colors.success },
  { key: "AdminLogin" as const, icon: "🔐", title: "Staff", desc: "Manage attendance", color: colors.gray500 },
];

export default function WelcomeScreen({ navigation }: Props) {
  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.hero}>
          <Text style={styles.emoji}>🏫</Text>
          <Text style={styles.title}>School App</Text>
          <Text style={styles.subtitle}>Madan Mohan Malviya{"\n"}Junior High School</Text>
        </View>

        <View style={styles.features}>
          <Text style={styles.feature}>✅ Attendance tracking</Text>
          <Text style={styles.feature}>📚 Homework & assignments</Text>
          <Text style={styles.feature}>📢 School notices</Text>
        </View>

        <View style={styles.cards}>
          {ROLES.map((role) => (
            <TouchableOpacity
              key={role.key}
              style={styles.card}
              onPress={() => navigation.navigate(role.key)}
              activeOpacity={0.85}
            >
              <Text style={styles.cardIcon}>{role.icon}</Text>
              <View style={styles.cardText}>
                <Text style={styles.cardTitle}>{role.title}</Text>
                <Text style={styles.cardDesc}>{role.desc}</Text>
              </View>
              <Text style={styles.arrow}>›</Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.gray50 },
  scroll: { padding: spacing.lg, flexGrow: 1 },
  hero: { alignItems: "center", marginTop: spacing.lg, marginBottom: spacing.lg },
  emoji: { fontSize: 56, marginBottom: spacing.sm },
  title: { fontSize: 30, fontWeight: "700", color: colors.gray900 },
  subtitle: { fontSize: 15, color: colors.gray500, textAlign: "center", marginTop: spacing.sm, lineHeight: 22 },
  features: { backgroundColor: colors.primaryLight, borderRadius: 12, padding: spacing.md, marginBottom: spacing.lg, gap: 6 },
  feature: { fontSize: 14, color: colors.primary, fontWeight: "500" },
  cards: { gap: spacing.sm },
  card: {
    backgroundColor: colors.white, borderRadius: 16, padding: spacing.lg,
    flexDirection: "row", alignItems: "center",
    shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 3,
  },
  cardIcon: { fontSize: 32, marginRight: spacing.md },
  cardText: { flex: 1 },
  cardTitle: { fontSize: 17, fontWeight: "700", color: colors.gray900 },
  cardDesc: { fontSize: 12, color: colors.gray500, marginTop: 2 },
  arrow: { fontSize: 26, color: colors.gray400 },
});
