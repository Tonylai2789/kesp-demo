/** Private evaluation policy is intentionally absent from the public source release. */
export const PRIVATE_POLICY_REDACTED = true;

export function privatePolicyUnavailable(): never {
  throw new Error("Missing private evaluation assets: restore the compatible private policy and prompt bundle before building or analyzing.");
}

/** Preserve data contracts without supplying fabricated policy values. */
export function redactedPrivatePolicy<T extends object>(): T {
  return new Proxy({} as T, {
    get: privatePolicyUnavailable,
    ownKeys: privatePolicyUnavailable,
    getOwnPropertyDescriptor: privatePolicyUnavailable,
  });
}
