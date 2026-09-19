# Handover

Everything needed to run, change and repair SolarLens, in the order someone
taking it over needs it. `README.md` explains how the code works; this explains
how the *system* is kept alive, what breaks, and what only a person can do.

Nothing here names an address, an id or an account. Where a value is needed,
this says which file or secret holds it.

---

## 1. What it is, in a paragraph

Two solar systems, two vendor clouds, one page. A Cloudflare Worker collects
readings into a D1 database every five minutes and serves a public dashboard
with every vendor identifier stripped out. One system's data arrives cloud to
cloud. The other vendor signs its own requests in the browser, so a relay agent
drives a real Chrome session on a Windows laptop and pushes what the portal
returns. That laptop is the only part of this that needs a person: its login
lasts seven days.

## 2. The parts, and what fails when each stops

| Part | Where it runs | If it stops |
|---|---|---|
| **Worker + cron** | Cloudflare, every 5 minutes | Everything stops. The dashboard keeps serving stored readings, growing stale |
| **D1 database** | Cloudflare | Same; the free tier's daily read limit is the thing to watch, not disk |
| **Dashboard** | Static files served by the same Worker | Readings still collect; nobody can see them |
| **SolarMan feed** | Cloud to cloud, from the Worker | That system's readings stop; the other continues |
| **SolisCloud relay** | Chrome on a Windows laptop | That system's readings stop. The dashboard says so on the Alerts tab |

The dashboard's own **Alerts** tab is the first place to look, and it explains
each condition in words rather than codes. The **Devices** tab lists each relay
laptop, its state and when its login expires.

## 3. Credentials: what exists, and where each lives

Nothing sensitive is in this repository, and nothing here should ever be.

| Credential | Lives in | If lost |
|---|---|---|
| Cloudflare account login | The owner's password manager | Only the owner can recover it |
| Cloudflare API token, for deploying | GitHub → environment `production` → secret `CLOUDFLARE_API_TOKEN` | Roll it in the Cloudflare dashboard and update the secret; it is shown once |
| `API_TOKEN`, guards the poll route | Cloudflare secret + local `.dev.vars` | `scripts/rotate-tokens.ps1 -Api` |
| `INGEST_TOKEN`, lets a relay push | Cloudflare secret + `.dev.vars` on each relay laptop | `scripts/rotate-tokens.ps1 -Ingest`, then re-run the installer on each laptop |
| SolarMan session tokens | `.dev.vars`, refreshed automatically | Re-capture from the portal; see `README.md` |
| SolisCloud portal login | The browser profile beside the relay, `.relay-profile` | Log in again: double-click `renew-solis-login.cmd` |
| Plant ids, the database id, the deployment address | `.dev.vars` only, and the `production` environment's secrets | They are in the Cloudflare dashboard |

**`.dev.vars` on the main machine is the single most valuable file here.** It is
gitignored and Cloudflare will not hand secrets back, so keep a copy somewhere
safe. Everything else can be rebuilt from the repository.

## 4. The weekly job, and the rest of the routine

**Once a week, someone logs in to SolisCloud.** Its web login lasts exactly
seven days, using it does not extend it, and the login page carries a captcha,
so no script can renew it. The dashboard warns two days ahead, naming the
laptop. On that laptop, double-click `renew-solis-login.cmd`; a window opens
only if a login is actually needed.

Everything else is occasional:

- **Keep a relay laptop awake** — a relay only runs while its machine is on.
  Set sleep to *Never* when plugged in.
- **After a release that changes relay code**, double-click
  `setup-solarlens-relay.cmd` on each relay laptop. The deploy's summary says
  when this is needed.
- **Watch the D1 read budget** if the dashboard is left open on many screens.
  `npx wrangler d1 insights solar-lens --sort-by reads` names the expensive
  query exactly; guessing has been wrong twice.

## 5. How a change reaches production

1. Branch, commit, open a pull request.
2. **Twelve checks run and must pass** - types, unit, end-to-end, build, four
   guards, and the security scans. Nothing merges otherwise.
3. Merge to `main`. The checks run again, on the merged result.
4. **The deploy waits for a person to approve it** on GitHub.
5. Migrations, deploy, then a smoke test against the live site. **If the smoke
   test fails, the previous version is restored automatically.**
6. To publish a release: set the version in `package.json`, write the changelog
   section, merge, then run **Actions → Release**. It refuses unless the
   version, the changelog and the tags all agree.

Two guards catch people out, and both are deliberate: an identifier in **any**
commit of a branch fails even if a later commit removes it (a pull request's
commits are kept by GitHub for good), and every commit must be authored by the
repository's own account with no co-author trailer.

## 6. When something is wrong

| Symptom | Almost always | Fix |
|---|---|---|
| One system reads **offline** while the sun is up | The relay laptop is asleep, off, or its login expired | Devices tab tells you which; `renew-solis-login.cmd` on that laptop |
| Both feeds stale | The Worker's cron, or Cloudflare itself | Cloudflare dashboard → Workers → the Worker's logs |
| A deploy failed | The smoke test refused it, and the old version is already back | Read the run's log; the failing check is named in words |
| A deploy failed at the *first* step | The Cloudflare token expired or was rolled | Create a new one and update the `production` secret |
| The dashboard shows a plant that should not be there | A plant shared into the account by someone else | `INCLUDE_PLANTS` in `.dev.vars` |
| Rolling back by hand | | `npm run cf -- rollback <version-id> -y -m "why"`; list versions with `npm run cf -- deployments list` |

## 7. Where the reports are

Coverage and end-to-end artifacts hang off each workflow run; CodeQL findings,
dependency alerts and secret scanning live in the repository's **Security** tab;
`npm audit` and the deploy's outcome are printed in each run's summary.
`README.md` has the full table, with the local command for each.

## 8. What was decided, and should not be undone by accident

- **The dashboard is public on purpose.** What protects it is that every
  response is stripped of vendor identifiers - station and plant ids become
  positional aliases, serials are masked, and the stored raw payload is never
  served. Do not "fix" this by adding an id back for convenience.
- **Never commit an identifier.** History has been rewritten twice to remove
  them, and a pull request's commits cannot be rewritten at all. This is what
  the privacy guard exists for.
- **Migrations are additive.** That is what makes a rollback of the Worker safe
  while the database has already moved on.
- **Dependencies are updated by hand**, in one pull request, rather than by a
  queue of automatic ones. `npm audit` and dependency review still fail the
  build on a vulnerable package.
- **Two plants are monitored; a third, shared into the account by someone else,
  is deliberately excluded.**

## 9. What is still missing

`docs/feature-gaps.md` is the honest list, kept current: SolisCloud's official
API key would remove the weekly login and the laptop entirely, and the Worker's
own routes still have no automated test that runs them before a merge. Neither
is urgent; both are written down so they are not rediscovered.

## 10. If everything were lost tomorrow

With the repository and `.dev.vars`, rebuilding is: create a Cloudflare account,
`npm run cf -- d1 create`, set the secrets, `npm run deploy`, apply migrations,
then run the relay installer on a Windows laptop and log in once. `README.md`'s
quick start is that path, in order, and takes about ten minutes plus the vendor
logins. History older than the new database's first poll would not come back.
