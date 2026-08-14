# Android APK — MMM School ERP

## Answers
| Question | Answer |
|---|---|
| Can we make an APK? | **Yes.** Built release APK: `MMM-School-ERP.apk` (see artifacts / local build below). |
| Sync with website? | **Yes.** App + website + NFC use the **same ERP database/API**. App auto-refreshes every **12s**; website has live sync too. |
| Better UI? | Updated teal school brand UI for student / parent / staff. |

## Sync flow
```
NFC gate / Website admin / Staff app
            │
            ▼
     Flask ERP (SQLite)
            │
   ┌────────┴────────┐
Website dashboard   Mobile app (live sync)
```

## Install this APK
1. Copy `MMM-School-ERP.apk` to an Android phone.
2. Allow install from unknown sources.
3. Open the app and log in (demo admissions `2211`–`2215`, staff `admin123`).

> Point the app at your live server when rebuilding:
> `EXPO_PUBLIC_API_URL=https://YOUR-RENDER-URL`

## Rebuild APK
```bash
cd mobile
npm install
export ANDROID_HOME=$HOME/android-sdk   # or your SDK path
export EXPO_PUBLIC_API_URL=https://YOUR-RENDER-URL
npx expo prebuild --platform android
cd android && ./gradlew assembleRelease
# output: android/app/build/outputs/apk/release/app-release.apk
```

Or with Expo EAS:
```bash
npx eas-cli build -p android --profile preview
```
