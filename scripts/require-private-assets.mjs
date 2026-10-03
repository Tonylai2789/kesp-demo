// The public export is intentionally not a deployable analysis runtime.
console.error('Missing private evaluation assets: this partial-source release cannot build the analysis backend. Use the separately retained compatible private runtime and prompt bundle. No replacement scoring policy is supplied.');
process.exitCode = 1;
