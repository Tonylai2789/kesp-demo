import { getApp, getApps, initializeApp } from 'firebase/app';
import { assertDemoFirebaseConfig } from '@/lib/demoPolicy';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

assertDemoFirebaseConfig(firebaseConfig);

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

assertDemoFirebaseConfig(app.options);

export const isDemoFirebaseProject = true;
export const firebaseProjectId = firebaseConfig.projectId;
export const isTestingFirebaseProject = false;
export const isProductionFirebaseProject = false;

export const isUsingEmulators =
  import.meta.env.DEV && import.meta.env.VITE_USE_EMULATORS === 'true';

export const emulatorHosts = {
  firestore: { host: 'localhost', port: 8080 },
  storage: { host: 'localhost', port: 9199 },
  functions: { host: 'localhost', port: 5001 },
  auth: { host: 'localhost', port: 9099 },
} as const;

const connectedEmulators = new Set<keyof typeof emulatorHosts>();

if (isUsingEmulators) {
  console.info('Connecting to Firebase emulators', {
    firestore: `${emulatorHosts.firestore.host}:${emulatorHosts.firestore.port}`,
    storage: `${emulatorHosts.storage.host}:${emulatorHosts.storage.port}`,
    functions: `${emulatorHosts.functions.host}:${emulatorHosts.functions.port}`,
    auth: `${emulatorHosts.auth.host}:${emulatorHosts.auth.port}`,
  });
} else if (import.meta.env.DEV) {
  console.info('Firebase production services are active (emulators disabled)');
}

/** Documents the connectEmulatorOnce behavior. */
export function connectEmulatorOnce(
  service: keyof typeof emulatorHosts,
  connect: () => void
) {
  if (!isUsingEmulators || connectedEmulators.has(service)) {
    return;
  }

  connect();
  connectedEmulators.add(service);
}

export default app;
