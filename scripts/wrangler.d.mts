// Types for wrangler.mjs, which npm runs as plain JavaScript and the unit tests
// import from TypeScript.
export const WRANGLER_CLI: string;
export function wranglerArgs(args: string[], config: string): string[];
