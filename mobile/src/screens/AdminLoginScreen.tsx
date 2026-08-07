import React, { useState } from "react";
import { View, Text, StyleSheet, TextInput, KeyboardAvoidingView, Platform, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { colors, spacing } from "../theme";
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
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.inner}>
        <Text style={styles.back} onPress={() => navigation.goBack()}>← Back</Text>

        <View style={styles.header}>
          <Text style={styles.emoji}>🔐</Text>
          <Text style={styles.title}>Admin Login</Text>
          <Text style={styles.subtitle}>School staff access only</Text>
        </View>

        <View style={styles.form}>
          <Text style={styles.label}>Password</Text>
          <TextInput
            style={styles.input}
            placeholder="Enter admin password"
            placeholderTextColor={colors.gray400}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoFocus
          />
          <Button title={loading ? "Signing in..." : "Sign In"} onPress={handleLogin} disabled={loading} />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.gray50 },
  inner: { flex: 1, padding: spacing.lg },
  back: { fontSize: 16, color: colors.primary, fontWeight: "500", marginBottom: spacing.lg },
  header: { alignItems: "center", marginBottom: spacing.xl },
  emoji: { fontSize: 48, marginBottom: spacing.sm },
  title: { fontSize: 24, fontWeight: "700", color: colors.gray900 },
  subtitle: { fontSize: 14, color: colors.gray500, marginTop: spacing.xs },
  form: { backgroundColor: colors.white, borderRadius: 16, padding: spacing.lg, gap: spacing.md },
  label: { fontSize: 13, fontWeight: "600", color: colors.gray700 },
  input: {
    borderWidth: 1.5,
    borderColor: colors.gray200,
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    color: colors.gray900,
  },
});
