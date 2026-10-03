/** Legacy Storage category used by older AI-agent test uploads. */
export const LEGACY_TEST_CALL_CATEGORY = 'test';

/** Documents the isLegacyTestCallCategory behavior. */
export function isLegacyTestCallCategory(callCategory: unknown): boolean {
  return callCategory === LEGACY_TEST_CALL_CATEGORY;
}
