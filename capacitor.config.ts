import type { CapacitorConfig } from "@capacitor/cli";

// Android app wrapper around the same Vite build (webDir: dist).
// The app ships the web files inside the APK, so it opens instantly and
// talks to Supabase over HTTPS just like the website.
const config: CapacitorConfig = {
  appId: "com.waterdrop.app",
  appName: "Waterdrop",
  webDir: "dist",
  android: {
    allowMixedContent: false,
  },
  plugins: {
    // Show order alerts even while the app is open.
    PushNotifications: { presentationOptions: ["badge", "sound", "alert"] },
    SplashScreen: {
      launchShowDuration: 1200,
      launchAutoHide: true,
      backgroundColor: "#0b6bcb",
      showSpinner: false,
    },
  },
};

export default config;
