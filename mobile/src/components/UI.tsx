import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, ViewStyle } from "react-native";
import { colors, spacing } from "../theme";

interface Props {
  title: string;
  value: string | number;
  icon: string;
  color?: string;
  bgColor?: string;
  style?: ViewStyle;
}

export default function StatCard({ title, value, icon, color = colors.primary, bgColor = colors.primaryLight, style }: Props) {
  return (
    <View style={[styles.card, { borderLeftColor: color }, style]}>
      <Text style={styles.icon}>{icon}</Text>
      <View>
        <Text style={[styles.value, { color }]}>{value}</Text>
        <Text style={styles.title}>{title}</Text>
      </View>
    </View>
  );
}

interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: "primary" | "outline" | "success";
  disabled?: boolean;
}

export function Button({ title, onPress, variant = "primary", disabled }: ButtonProps) {
  const bg = variant === "primary" ? colors.primary : variant === "success" ? colors.success : "transparent";
  const textColor = variant === "outline" ? colors.primary : colors.white;
  return (
    <TouchableOpacity
      style={[styles.btn, { backgroundColor: bg }, variant === "outline" && styles.btnOutline, disabled && styles.btnDisabled]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.8}
    >
      <Text style={[styles.btnText, { color: textColor }]}>{title}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    borderLeftWidth: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
    flex: 1,
  },
  icon: { fontSize: 28 },
  value: { fontSize: 22, fontWeight: "700" },
  title: { fontSize: 12, color: colors.gray500, fontWeight: "500", marginTop: 2 },
  btn: {
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 12,
    alignItems: "center",
  },
  btnOutline: {
    borderWidth: 1.5,
    borderColor: colors.primary,
  },
  btnDisabled: { opacity: 0.5 },
  btnText: { fontSize: 16, fontWeight: "600" },
});
