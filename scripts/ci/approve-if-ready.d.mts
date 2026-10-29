// Types for approve-if-ready.mjs, which the approval workflow runs as plain
// JavaScript and the unit tests import from TypeScript.
export const OWNER: string;
export interface PullRequestState {
  author: string;
  draft: boolean;
  title: string;
  body: string | null;
  head: string;
  checks: { name: string; status: string; conclusion: string | null }[];
  reviews: { author: string; state: string; commit: string | undefined }[];
  openThreads: number;
  approvedAtHead: boolean;
}
export function readiness(pr: PullRequestState): { ready: boolean; why: string[] };
