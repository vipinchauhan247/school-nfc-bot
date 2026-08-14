import React, { useRef, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ViewStyle,
  Animated,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "../theme";

interface Props {
  title: string;
  value: string | number;
  icon: keyof typeof Ionicons.glyphMap;
  color?: string;
  style?: ViewStyle;
}

export default function StatCard({
  title,
  value,
  icon,
  color = colors.brand,
  style,
}: Props) {
  return (
    <View style={[styles.card, style]}>
      <View style={[styles.iconWrap, { backgroundColor: color + "18" }]}>
        <Ionicons name={icon} size={20} color={color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.value, { color }]}>{value}</Text>
        <Text style={styles.title}>{title}</Text>
      </View>
    </View>
  );
}

interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: "primary" | "outline" | "success" | "ghost";
  disabled?: boolean;
  loading?: boolean;
}

export function Button({
  title,
  onPress,
  variant = "primary",
  disabled,
  loading,
}: ButtonProps) {
  const scale = useRef(new Animated.Value(1)).current;
  const bg =
    variant === "primary"
      ? colors.brand
      : variant === "success"
        ? colors.success
        : "transparent";
  const textColor =
    variant === "outline" || variant === "ghost" ? colors.brand : colors.white;

  const pressIn = () =>
    Animated.spring(scale, { toValue: 0.97, useNativeDriver: true, speed: 40 }).start();
  const pressOut = () =>
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 40 }).start();

  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <TouchableOpacity
        style={[
          styles.btn,
          { backgroundColor: bg },
          variant === "outline" && styles.btnOutline,
          variant === "ghost" && styles.btnGhost,
          (disabled || loading) && styles.btnDisabled,
        ]}
        onPress={onPress}
        disabled={disabled || loading}
        activeOpacity={0.9}
        onPressIn={pressIn}
        onPressOut={pressOut}
      >
        {loading ? (
          <ActivityIndicator color={textColor} />
        ) : (
          <Text style={[styles.btnText, { color: textColor }]}>{title}</Text>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

export function SyncBadge({
  lastSynced,
  live,
}: {
  lastSynced: Date | null;
  live?: boolean;
}) {
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!live) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [live, pulse]);

  const time = lastSynced
    ? lastSynced.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";

  return (
    <View style={styles.syncRow}>
      <Animated.View style={[styles.syncDot, { opacity: live ? pulse : 1 }]} />
      <Text style={styles.syncText}>
        {live ? "Live sync" : "Synced"} · {time}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.paper,
    borderRadius: radius.md,
    padding: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.line,
    flex: 1,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  value: { fontSize: 22, fontWeight: "700", letterSpacing: -0.3 },
  title: { fontSize: 12, color: colors.gray500, fontWeight: "500", marginTop: 2 },
  btn: {
    paddingVertical: 15,
    paddingHorizontal: 24,
    borderRadius: radius.md,
    alignItems: "center",
    minHeight: 52,
    justifyContent: "center",
  },
  btnOutline: {
    borderWidth: 1.5,
    borderColor: colors.brand,
  },
  btnGhost: {
    backgroundColor: colors.brandSoft,
  },
  btnDisabled: { opacity: 0.5 },
  btnText: { fontSize: 16, fontWeight: "700", letterSpacing: 0.2 },
  syncRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    alignSelf: "flex-start",
    backgroundColor: colors.brandSoft,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  syncDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.success,
  },
  syncText: { fontSize: 11, fontWeight: "600", color: colors.brandDark },
});
