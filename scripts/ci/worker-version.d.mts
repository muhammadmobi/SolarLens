// Types for worker-version.mjs, which the deploy workflow runs as plain
// JavaScript and the unit tests import from TypeScript.
export function messageFor(sha: string): string;
export function jsonIn(raw: string, open?: string, close?: string): unknown;
export function liveVersion(deployments: { versions?: { version_id?: string; percentage?: number }[] }[]): string | null;
export function commitOf(view: { annotations?: Record<string, unknown> } | null | undefined): string | null;
