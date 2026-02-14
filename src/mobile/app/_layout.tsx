// Root layout — wraps the entire app with safe area + navigation container.
// expo-router auto-wraps with NavigationContainer so we just define the Stack.

import { Stack } from 'expo-router';

export default function RootLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: '#09090b' },
      }}
    >
      {/* Tabs are the default group */}
      <Stack.Screen name="(tabs)" />

      {/* Deep-link target for email verification */}
      <Stack.Screen
        name="verify-email"
        options={{
          presentation: 'modal',
          headerShown: true,
          headerTitle: 'Verify Email',
          headerStyle: { backgroundColor: '#09090b' },
          headerTintColor: '#fafafa',
        }}
      />
    </Stack>
  );
}
