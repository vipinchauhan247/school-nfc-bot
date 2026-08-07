import React, { useState } from "react";
import { View, Text, StyleSheet, TextInput, KeyboardAvoidingView, Platform, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { colors, spacing } from "../theme";
import { Button } from "../components/UI";
import { api } from "../api";
import { RootStackParamList } from "../types";

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, "ParentLogin"> };

async function saveAdmissionNo(admissionNo: string) {
  if (Platform.OS === "web") {
    localStorage.setItem("admission_no", admissionNo);
    return;
  }
  const SecureStore = await import("expo-secure-store");
  await SecureStore.setItemAsync("admission_no", admissionNo);
}

export default function ParentLoginScreen({ navigation }: Props) {
  const [admissionNo, setAdmissionNo] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!admissionNo.trim()) {
      Alert.alert("Error", "Please enter admission number");
      return;
    }
    setLoading(true);
    try {
      const data = await api.parentLogin(admissionNo.trim());
      await saveAdmissionNo(admissionNo.trim());
      navigation.replace("ParentHome", { student: data.student });
    } catch (e: any) {
      Alert.alert("Not Found", e.message || "Student not found. Check admission number.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.inner}>
        <Text style={styles.back} onPress={() => navigation.goBack()}>← Back</Text>

        <View style={styles.header}>
          <Text style={styles.emoji}>👨‍👩‍👧</Text>
          <Text style={styles.title}>Parent Login</Text>
          <Text style={styles.subtitle}>Enter your child's admission number</Text>
        </View>

        <View style={styles.form}>
          <Text style={styles.label}>Admission Number</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. 2211"
            placeholderTextColor={colors.gray400}
            value={admissionNo}
            onChangeText={setAdmissionNo}
            keyboardType="number-pad"
            autoFocus
          />
          <Button title={loading ? "Checking..." : "Continue"} onPress={handleLogin} disabled={loading} />
        </View>

        <Text style={styles.hint}>Example: 2211, 2212, 2213...</Text>
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
    fontSize: 18,
    fontWeight: "600",
    color: colors.gray900,
    letterSpacing: 1,
  },
  hint: { textAlign: "center", color: colors.gray400, fontSize: 13, marginTop: spacing.lg },
});
