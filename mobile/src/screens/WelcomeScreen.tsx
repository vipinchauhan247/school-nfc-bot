import React, { useEffect, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Animated,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { colors, spacing, radius } from "../theme";
import { RootStackParamList } from "../types";

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, "Welcome"> };

const ROLES = [
  {
    key: "StudentLogin" as const,
    icon: "school-outline" as const,
    title: "Student",
    desc: "Attendance, homework & notices",
  },
  {
    key: "ParentLogin" as const,
    icon: "people-outline" as const,
    title: "Parent",
    desc: "Track your child’s day at school",
  },
  {
    key: "AdminLogin" as const,
    icon: "shield-checkmark-outline" as const,
    title: "Staff",
    desc: "Mark attendance & manage ERP",
  },
];

export default function WelcomeScreen({ navigation }: Props) {
  const fade = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(24)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 520, useNativeDriver: true }),
      Animated.timing(slide, { toValue: 0, duration: 520, useNativeDriver: true }),
    ]).start();
  }, [fade, slide]);

  return (
    <View style={styles.root}>
      <LinearGradient
        colors={["#0F766E", "#115E59", "#134E4A"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.hero}
      >
        <SafeAreaView edges={["top"]}>
          <Animated.View style={{ opacity: fade, transform: [{ translateY: slide }] }}>
            <Text style={styles.brandMark}>MMM SCHOOL</Text>
            <Text style={styles.brand}>Madan Mohan Malviya</Text>
            <Text style={styles.brandSub}>Junior High School · ERP</Text>
            <Text style={styles.tagline}>
              One live system for attendance, homework, and notices — phone or website.
            </Text>
          </Animated.View>
        </SafeAreaView>
      </LinearGradient>

      <ScrollView
        style={styles.sheet}
        contentContainerStyle={styles.sheetContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.choose}>Continue as</Text>
        {ROLES.map((role) => (
          <TouchableOpacity
            key={role.key}
            style={styles.card}
            onPress={() => navigation.navigate(role.key)}
            activeOpacity={0.88}
          >
            <View style={styles.cardIcon}>
              <Ionicons name={role.icon} size={22} color={colors.brand} />
            </View>
            <View style={styles.cardText}>
              <Text style={styles.cardTitle}>{role.title}</Text>
              <Text style={styles.cardDesc}>{role.desc}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.muted} />
          </TouchableOpacity>
        ))}
            <Text style={styles.footerNote}>
              ERP bot @mmmjhschoolbot · MMMJHS Telegram sheet (not NFC / @Vipinbellbot)
            </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.sand },
  hero: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl,
    paddingTop: spacing.sm,
  },
  brandMark: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 2,
    marginBottom: spacing.sm,
    marginTop: spacing.md,
  },
  brand: {
    color: colors.white,
    fontSize: 30,
    fontWeight: "800",
    letterSpacing: -0.6,
    lineHeight: 36,
  },
  brandSub: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 15,
    fontWeight: "500",
    marginTop: 6,
  },
  tagline: {
    color: "rgba(255,255,255,0.78)",
    fontSize: 14,
    lineHeight: 21,
    marginTop: spacing.md,
    maxWidth: 320,
  },
  sheet: {
    flex: 1,
    marginTop: -18,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    backgroundColor: colors.sand,
  },
  sheetContent: { padding: spacing.lg, paddingBottom: spacing.xl },
  choose: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.gray500,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: spacing.md,
  },
  card: {
    backgroundColor: colors.paper,
    borderRadius: radius.lg,
    padding: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.line,
  },
  cardIcon: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor: colors.brandSoft,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.md,
  },
  cardText: { flex: 1 },
  cardTitle: { fontSize: 17, fontWeight: "700", color: colors.ink },
  cardDesc: { fontSize: 13, color: colors.gray500, marginTop: 2 },
  footerNote: {
    textAlign: "center",
    color: colors.muted,
    fontSize: 12,
    marginTop: spacing.lg,
    lineHeight: 18,
  },
});
