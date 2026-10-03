import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import app, { connectEmulatorOnce, emulatorHosts } from './firebaseApp';

/** Calls an external SDK or API dependency. */
export const db = getFirestore(app);

connectEmulatorOnce('firestore', /** Handles the callback for this operation. */() => {
  /** Calls an external SDK or API dependency. */
  connectFirestoreEmulator(
    db,
    emulatorHosts.firestore.host,
    emulatorHosts.firestore.port
  );
});
