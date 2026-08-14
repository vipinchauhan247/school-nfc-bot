import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Alert,
  TouchableOpacity,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { colors, spacing, radius } from "../theme";
import { Button } from "../components/UI";
import { api } from "../api";
import { RootStackParamList } from "../types";

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, "AdminLogin"> };

export default function AdminLoginScreen({ navigation }: Props) {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    setLoading(true);
    try {
      await api.adminLogin(password);
      navigation.replace("AdminDashboard");
    } catch {
      Alert.alert("Error", "Invalid admin password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.inner}
      >
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backRow}>
          <Ionicons name="arrow-back" size={20} color={colors.brand} />
          <Text style={styles.back}>Back</Text>
        </TouchableOpacity>

        <View style={styles.header}>
          <View style={styles.iconBubble}>
            <Ionicons name="shield-checkmark-outline" size={28} color={colors.brand} />
          </View>
          <Text style={styles.title}>Staff Login</Text>
          <Text style={styles.subtitle}>School ERP · attendance & students</Text>
        </View>

        <View style={styles.form}>
          <Text style={styles.label}>Admin Password</Text>
          <TextInput
            style={styles.input}
            placeholder="Enter password"
            placeholderTextColor={colors.gray400}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoFocus
          />
          <Button title="Sign In" onPress={handleLogin} loading={loading} disabled={loading} />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.sand },
  inner: { flex: 1, padding: spacing.lg },
  backRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: spacing.lg },
  back: { fontSize: 16, color: colors.brand, fontWeight: "600" },
  header: { alignItems: "center", marginBottom: spacing.xl },
  iconBubble: {
    width: 64,
    height: 64,
    borderRadius: 20,
    backgroundColor: colors.brandSoft,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.md,
  },
  title: { fontSize: 24, fontWeight: "800", color: colors.ink },
  subtitle: { fontSize: 14, color: colors.gray500, marginTop: spacing.xs },
  form: {
    backgroundColor: colors.paper,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.line,
  },
  label: { fontSize: 13, fontWeight: "700", color: colors.gray700 },
  input: {
    borderWidth: 1.5,
    borderColor: colors.line,
    borderRadius: radius.md,
    padding: 14,
    fontSize: 16,
    color: colors.ink,
    backgroundColor: colors.gray50,
  },
});
