import React from "react";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../theme";
import HomeTab from "../screens/tabs/HomeTab";
import HomeworkTab from "../screens/tabs/HomeworkTab";
import NoticesTab from "../screens/tabs/NoticesTab";
import ProfileTab from "../screens/tabs/ProfileTab";

const Tab = createBottomTabNavigator();

export default function PortalTabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.gray400,
        tabBarStyle: {
          backgroundColor: colors.white,
          borderTopColor: colors.gray200,
          paddingBottom: 4,
          height: 60,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
        tabBarIcon: ({ color, size }) => {
          const icons: Record<string, keyof typeof Ionicons.glyphMap> = {
            Home: "home",
            Homework: "book",
            Notices: "megaphone",
            Profile: "person",
          };
          return <Ionicons name={icons[route.name]} size={size} color={color} />;
        },
      })}
    >
      <Tab.Screen name="Home" component={HomeTab} />
      <Tab.Screen name="Homework" component={HomeworkTab} />
      <Tab.Screen name="Notices" component={NoticesTab} />
      <Tab.Screen name="Profile" component={ProfileTab} />
    </Tab.Navigator>
  );
}
