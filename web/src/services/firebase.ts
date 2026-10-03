// Deprecated compatibility shim. Prefer product-specific modules so startup
// code can import only the Firebase SDK it actually needs.
export { default, isUsingEmulators } from './firebaseApp';
export { auth } from './firebaseAuth';
export { db } from './firebaseFirestore';
export { storage } from './firebaseStorage';
export { functions } from './firebaseFunctions';
