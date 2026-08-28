import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'co.aiclient.risu',
  appName: 'Risuai',
  webDir: 'dist',
  // Large NativeSqlite results are expensive enough without duplicating them
  // into Android logcat as giant JSON strings in debug builds.
  loggingBehavior: 'none',
  server: {
    androidScheme: 'https'
  },
  plugins: {
    CapacitorHttp: {
      enabled: true
    }
  }
};

export default config;
