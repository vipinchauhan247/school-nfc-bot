import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { colors, spacing } from "../theme";
import { RootStackParamList } from "../types";

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, "Welcome"> };

export default function WelcomeScreen({ navigation }: Props) {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.hero}>
        <Text style={styles.emoji}>🏫</Text>
        <Text style={styles.title}>School Attendance</Text>
        <Text style={styles.subtitle}>Madan Mohan Malviya{"\n"}Junior High School</Text>
      </View>

      <View style={styles.cards}>
        <TouchableOpacity style={styles.card} onPress={() => navigation.navigate("ParentLogin")} activeOpacity={0.85}>
          <Text style={styles.cardIcon}>👨‍👩‍👧</Text>
          <View style={styles.cardText}>
            <Text style={styles.cardTitle}>Parent</Text>
            <Text style={styles.cardDesc}>Check your child's attendance</Text>
          </View>
          <Text style={styles.arrow}>›</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.card} onPress={() => navigation.navigate("AdminLogin")} activeOpacity={0.85}>
          <Text style={styles.cardIcon}>🔐</Text>
          <View style={styles.cardText}>
            <Text style={styles.cardTitle}>Admin</Text>
            <Text style={styles.cardDesc}>Manage students & attendance</Text>
          </View>
          <Text style={styles.arrow}>›</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.footer}>Instant NFC check-in alerts for parents</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.gray50, padding: spacing.lg },
  hero: { alignItems: "center", marginTop: spacing.xl, marginBottom: spacing.xl },
  emoji: { fontSize: 64, marginBottom: spacing.md },
  title: { fontSize: 28, fontWeight: "700", color: colors.gray900, textAlign: "center" },
  subtitle: { fontSize: 15, color: colors.gray500, textAlign: "center", marginTop: spacing.sm, lineHeight: 22 },
  cards: { gap: spacing.md },
  card: {
    backgroundColor: colors.white,
    borderRadius: 16,
    padding: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  cardIcon: { fontSize: 36, marginRight: spacing.md },
  cardText: { flex: 1 },
  cardTitle: { fontSize: 18, fontWeight: "700", color: colors.gray900 },
  cardDesc: { fontSize: 13, color: colors.gray500, marginTop: 2 },
  arrow: { fontSize: 28, color: colors.gray400, fontWeight: "300" },
  footer: { textAlign: "center", color: colors.gray400, fontSize: 13, marginTop: "auto", paddingBottom: spacing.md },
});
