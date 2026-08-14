import React from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { RootStackParamList } from "./src/types";
import WelcomeScreen from "./src/screens/WelcomeScreen";
import LoginScreen from "./src/screens/LoginScreen";
import PortalScreen from "./src/screens/PortalScreen";
import AdminLoginScreen from "./src/screens/AdminLoginScreen";
import AdminDashboardScreen from "./src/screens/AdminDashboardScreen";
import { colors } from "./src/theme";

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  return (
    <NavigationContainer>
      <StatusBar style="light" />
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
          animation: "slide_from_right",
          contentStyle: { backgroundColor: colors.sand },
        }}
      >
        <Stack.Screen name="Welcome" component={WelcomeScreen} />
        <Stack.Screen name="StudentLogin">
          {(props) => <LoginScreen {...props} role="student" />}
        </Stack.Screen>
        <Stack.Screen name="ParentLogin">
          {(props) => <LoginScreen {...props} role="parent" />}
        </Stack.Screen>
        <Stack.Screen name="StudentPortal">
          {({ route }) => (
            <PortalScreen role="student" student={route.params.student} />
          )}
        </Stack.Screen>
        <Stack.Screen name="ParentPortal">
          {({ route }) => (
            <PortalScreen role="parent" student={route.params.student} />
          )}
        </Stack.Screen>
        <Stack.Screen name="AdminLogin" component={AdminLoginScreen} />
        <Stack.Screen name="AdminDashboard" component={AdminDashboardScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
