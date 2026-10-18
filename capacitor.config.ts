import { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "co.aiclient.risu",
  appName: "Risuai",
  webDir: "dist",
  // Large NativeSqlite results are expensive enough without duplicating them
  // into Android logcat as giant JSON strings in debug builds.
  loggingBehavior: "none",
  server: {
    androidScheme: "https",
    cleartext: Boolean(process.env.VITE_ANDROID_E2E_REMOTE_URL),
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
