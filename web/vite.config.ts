import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { assertDemoFirebaseConfig } from './src/lib/demoPolicy'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env };
  assertDemoFirebaseConfig({ projectId: env.VITE_FIREBASE_PROJECT_ID, authDomain: env.VITE_FIREBASE_AUTH_DOMAIN, storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET, apiKey: env.VITE_FIREBASE_API_KEY, appId: env.VITE_FIREBASE_APP_ID, messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID });
  return ({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  define: {
    __APP_ENV__: JSON.stringify(
      mode === 'test' ? 'test' : mode === 'production' ? 'production' : 'development'
    ),
  },
})
})
