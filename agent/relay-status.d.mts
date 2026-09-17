// Types for relay-status.mjs, which the relay runs as plain JavaScript and the
// unit tests import from TypeScript.
export interface CookieLike { name: string; domain?: string; expires?: number }
export function loginExpiryFromCookies(cookies: readonly CookieLike[] | undefined | null): number | null;
export function stateForError(err: unknown): 'login-expired' | 'error';
export function relayId(profileDir: string): string;
export function relayName(raw: unknown): string | null;
