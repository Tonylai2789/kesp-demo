import { connectStorageEmulator, getStorage } from 'firebase/storage';
import app, { connectEmulatorOnce, emulatorHosts } from './firebaseApp';

/** Calls an external SDK or API dependency. */
export const storage = getStorage(app);

connectEmulatorOnce('storage', /** Handles the callback for this operation. */() => {
  /** Calls an external SDK or API dependency. */
  connectStorageEmulator(
    storage,
    emulatorHosts.storage.host,
    emulatorHosts.storage.port
  );
});
