---
name: react-native
description: React Native mobile app authority — Expo SDK, native modules, iOS and Android builds, push notifications, deep linking, App Store and Play Store submission, over-the-air updates, native gesture handlers, and cross-platform mobile app architecture
---

# react-native

Production cross-platform mobile development. Covers Expo-managed and bare React Native workflows, native module integration, and App Store / Play Store shipping.

## Project Setup — Expo

Expo is the default for new projects. Managed workflow handles native builds, EAS Build handles binaries, EAS Update handles OTA.

```bash
npx create-expo-app@latest my-app --template
cd my-app && npm start              # opens dev menu
# iOS simulator (macOS only)
npm run ios
# Android emulator
npm run android
# Physical device: scan QR in Expo Go app
```

```json
// app.json — Expo config
{
  "expo": {
    "name": "Ask Meridian",
    "slug": "ask-meridian",
    "version": "1.0.0",
    "orientation": "portrait",
    "icon": "./assets/icon.png",
    "splash": { "image": "./assets/splash.png", "backgroundColor": "#08080f" },
    "ios": {
      "bundleIdentifier": "uk.ask-meridian.mobile",
      "buildNumber": "1",
      "supportsTablet": true
    },
    "android": {
      "package": "uk.ask_meridian.mobile",
      "versionCode": 1,
      "adaptiveIcon": { "foregroundImage": "./assets/adaptive-icon.png" }
    },
    "plugins": ["expo-router", "expo-notifications", "expo-secure-store"]
  }
}
```

## Navigation with Expo Router

File-based routing — a React Native Next.js-alike.

```
app/
├── _layout.tsx        # root layout (tab bar, navigation container)
├── index.tsx          # /
├── verify.tsx         # /verify
├── (tabs)/
│   ├── _layout.tsx    # tab navigator
│   ├── home.tsx       # /home
│   └── history.tsx    # /history
└── skill/[slug].tsx   # dynamic route
```

```tsx
// app/_layout.tsx
import { Stack } from 'expo-router';
export default function RootLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="skill/[slug]" options={{ presentation: 'modal' }} />
    </Stack>
  );
}
```

## Push Notifications

iOS requires APNs certs via Apple Developer portal; Android uses FCM. Expo unifies both.

```tsx
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';

async function registerForPush() {
  if (!Device.isDevice) return null;
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') return null;
  const token = await Notifications.getExpoPushTokenAsync({
    projectId: 'your-expo-project-id',
  });
  return token.data; // Send to your backend
}

// Backend — send a push
await fetch('https://exp.host/--/api/v2/push/send', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    to: expoPushToken,
    title: 'New arbitrage',
    body: 'USDC/WETH on Base → +$8.20',
    data: { deeplink: 'myapp://opportunity/42' },
  }),
});
```

## Deep Linking

```tsx
import { Linking } from 'react-native';
import { useURL } from 'expo-linking';

export default function App() {
  const url = useURL();   // e.g. myapp://opportunity/42
  useEffect(() => {
    if (!url) return;
    const { hostname, path } = Linking.parse(url);
    // route accordingly
  }, [url]);
}
```

iOS: configure `CFBundleURLSchemes` + Associated Domains. Android: `<intent-filter>` in `AndroidManifest.xml`. Expo auto-generates both from `app.json`.

## Secure Storage

Never use AsyncStorage for tokens — it's plaintext. Use expo-secure-store (Keychain on iOS, Keystore on Android).

```tsx
import * as SecureStore from 'expo-secure-store';

await SecureStore.setItemAsync('auth_token', jwt);
const token = await SecureStore.getItemAsync('auth_token');
```

## Gestures and Animations

react-native-reanimated v3 runs on the UI thread — 60fps even with heavy JS work.

```tsx
import Animated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

function Card() {
  const translateY = useSharedValue(0);
  const pan = Gesture.Pan()
    .onUpdate((e) => { translateY.value = e.translationY; })
    .onEnd(() => { translateY.value = withSpring(0); });
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.value }] }));
  return <GestureDetector gesture={pan}><Animated.View style={style}/></GestureDetector>;
}
```

## EAS Build — Native Binaries

```bash
npm i -g eas-cli
eas login
eas build:configure

# Build for both platforms
eas build --platform all --profile production

# Build just iOS for TestFlight
eas build --platform ios --profile preview
```

```json
// eas.json
{
  "build": {
    "preview": { "distribution": "internal", "channel": "preview" },
    "production": { "channel": "production", "autoIncrement": true }
  },
  "submit": {
    "production": {
      "ios": { "appleId": "you@example.com", "ascAppId": "1234567890" },
      "android": { "serviceAccountKeyPath": "./pc-api-key.json" }
    }
  }
}
```

## Over-the-Air Updates

Ship JS-only changes without a new App Store review.

```bash
eas update --branch production --message "fix login bug"
```

Breaking native changes (new dependency with native code, Expo SDK upgrade) still require a binary build + review.

## App Store Submission Gotchas

- **iOS privacy manifest** (`PrivacyInfo.xcprivacy`) required for any SDK using "required reason APIs" (UserDefaults, system time, file timestamps, etc.). Apple rejects without it since May 2024.
- **iTunes Connect test info** must include a working demo account if login is required.
- **Android target SDK** must be within 1 year of latest (target 34 through Aug 2025, 35 after).
- **Data safety form** on Play Console — required declarations for every type of collected data.

## Performance Checklist

- [ ] FlatList / FlashList for any list over ~30 items (never `ScrollView` + `.map`)
- [ ] Images via `expo-image` (memory-cached, prefetched), not stock `<Image>`
- [ ] Reanimated v3 worklets for animations — never `Animated.Value` for anything non-trivial
- [ ] Hermes engine enabled (default in new Expo SDKs)
- [ ] Sentry or Bugsnag for crash reporting — install before first TestFlight build
- [ ] `react-native-performance` measures TTI; keep cold start < 2s
