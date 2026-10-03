import { connectAuthEmulator, getAuth } from 'firebase/auth';
import app, { connectEmulatorOnce, emulatorHosts } from './firebaseApp';

export const auth = getAuth(app);

connectEmulatorOnce('auth', /** Handles the callback for this operation. */() => {
  /** Calls an external SDK or API dependency. */
  connectAuthEmulator(
    auth,
    `http://${emulatorHosts.auth.host}:${emulatorHosts.auth.port}`
  );
});
