/**
 * The release the guide describes is the release that ships.
 *
 * The dashboard has no build step, so nothing copies package.json's version into
 * the page; the guide carries its own. This holds the two together, and holds
 * the changelog to having a section for that version - so the "What is new"
 * card can never describe a release other than the one it is part of.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string;

describe('the release the guide describes', () => {
  it('is the version in package.json', () => {
    const page = readFileSync('public/index.html', 'utf8');
    const m = /const RELEASE = '([^']+)';/.exec(page);
    expect(m?.[1]).toBe(version);
  });

  it('has its own section in the changelog', () => {
    const changelog = readFileSync('CHANGELOG.md', 'utf8');
    expect(changelog).toContain(`## [${version}]`);
  });
});
