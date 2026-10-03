import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import app, { connectEmulatorOnce, emulatorHosts } from './firebaseApp';

/** Calls an external SDK or API dependency. */
export const functions = getFunctions(app);

connectEmulatorOnce('functions', /** Handles the callback for this operation. */() => {
  /** Calls an external SDK or API dependency. */
  connectFunctionsEmulator(
    functions,
    emulatorHosts.functions.host,
    emulatorHosts.functions.port
  );
});
