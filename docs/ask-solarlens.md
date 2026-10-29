# Ask SolarLens, and the agents

The **Ask** tab takes a question in plain words - *"Which month produced the
most this year?"*, *"How much did I export last week?"*, *"Compare my systems per
kWp last month"*, *"Why was yesterday low?"* - and answers it with the figures
it came from. Beside it are two things that run on their own every Monday: a
**weekly report**, and a **health check** that watches each system for slowly
making less. All of it runs inside the SolarLens Worker, on Cloudflare's
Workers AI.

## The model chooses; the Worker computes

A language model is good at understanding a question and bad at arithmetic, so
SolarLens uses it only for the first:

1. **Choosing.** The model is shown the question, today's date where the panels
   are, the systems by name, and a short list of read-only *tools* - and answers
   with the tool that fits and its arguments, as JSON. It never writes a query:
   the arguments are checked like any other input before anything runs.
2. **Computing.** The Worker runs the tool against its own database and works out
   every figure: the totals, the best and the lowest, the changes.
3. **Wording.** The model is given those figures and puts them in a sentence or
   two. Then the sentence is checked: **a number in it that is not one of the
   figures - a sum, a percentage or a date it worked out for itself - means the
   sentence is thrown away**, and the tool's own sentence is shown instead.

Every answer is shown with the table it came from, the period it covers, how
fresh the data was (and which systems are not reporting now), and who put it in
words - the model, or SolarLens itself.

### The tools

| Tool | Answers |
|---|---|
| `status_now` | what each system is doing right now: power, today so far, battery, whether it is reporting |
| `energy` | energy over any period - made, used by the house, bought and sold - in total or per day, week, month or year, for one system or all; the best and lowest period; with a tariff set, the money saved and CO₂ avoided |
| `compare_systems` | every system side by side per kWp of panels over a period, best first |
| `faults` | the faults the vendors recorded over a period, which are still active, and the most common |
| `day_report` | why a day was low: each system's energy against a usual day, the sunlight against usual, what that sunlight should have made, stretches with no readings, faults - and the likely cause |
| `performance_trend` | whether a system is slowly losing output: energy made against the sunlight on its panels, week by week |

A period is a named one - today, yesterday, this or last week, month or year,
the last 7 or 30 days, the last 12 months - or two dates. Weeks run Monday to
Sunday, and days are the plants' own. The same tools are served without a model
at `GET /api/tools` and `GET /api/tools/<name>?<arguments>`, and they are what
the MCP server (phase 12) offers to AI apps outside SolarLens.

## The agents

- **Why was this day low?** On Historical Data, a day well below its system's
  usual has a **Why?** beside it. It runs the `day_report` tool and shows the
  answer on the Ask tab. It works for anyone who can read the dashboard: someone
  not signed in gets the tool's own words, with no model.
- **The health check**, every Monday: for each system, the energy made against the
  sunlight on its panels (its performance ratio), week by week over twelve
  weeks, and the last four against the eight before. A fall of 8% or more -
  what dirt, new shade, a failing panel or a string down look like, and too slow
  for anyone to notice on the day - is flagged. It is decided by the figures
  alone, never the model, and a flagged system becomes an alert like any other:
  told once to the phones and the places under *Alerts elsewhere*. The ratio
  moves a little with the season, which is why it takes 8% to flag.
- **The weekly report**, every Monday after the health check: last week against
  the one before, the week's lowest day and its likely cause, and the health
  check, in three to five sentences by the model - held to the figures like any
  answer, and written by SolarLens itself when there is no model or no call
  left. It is shown on the Ask tab and goes out with the weekly summary.

## Who can ask, and what it costs

**Asking is for anyone signed in**: the owner, or someone with a share link. Not
an anonymous visitor, even while the dashboard is open to all: each question
spends model calls, and a stranger could spend them all. The report, the health
check and "Why?" are there for every reader.

**Workers AI's free allowance is 10,000 neurons a day**, and on the free plan a
request past it fails. SolarLens counts its own model calls - every feature
together, per UTC day as Cloudflare's allowance is - and stops at
`AI_DAILY_CALLS` (100 unless set). A question takes two calls, choosing and
wording, and each costs about 50 neurons with the default model, so a hundred
calls stays well inside the allowance. The Ask tab shows how many are left. Past
the cap, questions wait until midnight UTC; the weekly report is then written
by SolarLens.

## What the model sees

Workers AI runs on Cloudflare, in the same place as the Worker. The model is
sent the question, today's date, the systems' names and sizes, the list of
tools, and - to word an answer - the figures the tool worked out. Nothing else
from the database, no internal id, no position, no token.

## Setting it up

It is on by default: `wrangler.jsonc` has the binding,

```jsonc
"ai": { "binding": "AI" }
```

- **`AI_MODEL`** (optional) - another Workers AI chat model, taking `messages`.
  The default, `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, can answer in JSON
  when asked, which choosing relies on.
- **`AI_DAILY_CALLS`** (optional) - the daily cap, 0 to 10,000; 0 turns
  questions off.

Remove the binding and Ask says it needs Workers AI; "Why?", the health check
and the weekly report still work from the figures.

**`wrangler dev`** reaches Workers AI remotely - it cannot run on your computer -
so asking in local development needs you signed in to wrangler, and counts
against the same allowance. The integration tests leave the binding out.

**If a deploy fails on the `ai` binding** with an authentication error, the
Cloudflare API token the deploy uses needs the *Workers AI* permission added.
