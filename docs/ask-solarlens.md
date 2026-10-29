# Ask SolarLens: the assistant, and the agents

The **Ask** tab is a conversation with SolarLens. Ask in plain words, and follow
up:

- *"How much did I export last week?"* … *"and the week before?"*
- *"Which month produced the most this year?"*
- *"How much did I make between 2pm and 4pm today?"*, *"How steady was the power today?"*
- *"Since when has Solis been offline?"*, *"When did it last generate?"*
- *"Compare my systems per kWp last month"*
- *"Statistics for the last 30 days"* - the average and median day, the best and
  worst, how much days vary, capacity factor, low days
- *"A report on last month"* - a full report, to read or to download and print
- *"Why was yesterday low?"*, *"Is any system slowly making less?"*
- *"How do I get alerts on Telegram?"* - how to do something in the app, and where

Every answer comes with the figures it came from. Beside the conversation are
two things that run on their own every Monday: a **weekly report**, and a
**health check** that watches each system for slowly making less.

All of it runs inside the SolarLens Worker. The model is Cloudflare's Workers
AI by default, with nothing to host. It can instead be any server that speaks
OpenAI's chat API - OpenAI, Groq, OpenRouter, or a model on your own computer.
Without any model, SolarLens reads each question itself and answers from the
figures. AI apps outside SolarLens, Claude among them, can ask the same
questions through the [MCP server](mcp.md).

## The model chooses; the Worker computes

A language model is good at understanding a question and bad at arithmetic, so
SolarLens uses it only for the understanding and the words:

1. **Understanding.** The model is shown the conversation so far, today's date
   where the panels are, the systems by name, and a short list of read-only
   *tools*. It answers with up to three tool calls and their arguments, as
   JSON. *"Compare this month with last"* is two calls. It never writes a query:
   the arguments are checked like any other input before anything runs. A
   follow-up - *"and the month before?"*, *"what about the garage?"* - takes the
   tools of the answer before and changes only what the follow-up changes. For
   a greeting, or a question it must ask back, it may reply in a sentence of its
   own, which may state no figure.
2. **Computing.** The Worker runs each tool against its own database and works
   out every figure: the totals, the averages, the best and the lowest, the
   changes.
3. **Wording.** The model is given those figures and puts them in words: a
   sentence or two, or a short report. Then the words are checked: **a number
   in them that is not one of the figures - a sum, a percentage or a date it
   worked out for itself - means the words are thrown away**, and the tools' own
   sentences are shown instead.

Every answer shows each table it came from, the period it covers, a small chart
where one helps, how fresh the data was (and which systems are not reporting
now), and who did the reading and the wording - the model, or SolarLens itself.

### Without a model

With no model set up, or no calls left today, or for someone not signed in,
SolarLens reads the question itself. It works out:

- the kind of question from its words: a report, statistics, a comparison,
  faults, why a day was low, a slow decline, right now, energy made, sold,
  bought or used, how steady the power was, whether a system is offline and
  since when, or how to use the app;
- the period: *last week*, *this year*, *in May*, *21 September*, *2025*, a
  date;
- a time of day: *between 2pm and 4pm*, *2-4pm*, *from 14:00 to 16:30*,
  *after 3pm*, *this afternoon*;
- the system, by its name, its short name, or a word only its name has -
  *orchard* for a system called *Orchard Hybrid*.

It forgives typing slips in the words it routes on - *genration*,
*fluctarion*, *septmber*, *yesterady* - and a time of day needs no
"between" at all: *2pm aand 4pm* is enough. The words it mends were chosen
because nothing common in English sits near them, so *expected* is never read
as *exported*, nor *warning* as *morning*.

A follow-up works the same way. *"And the one before?"* steps back a whole
month, year or week - or as many days again. *"For the garage?"* keeps the
period and changes the system. The answer is the figures' own sentences.

### The tools

| Tool | Answers |
|---|---|
| `status_now` | what each system is doing right now: power, today so far, battery, whether it is reporting |
| `outages` | whether each system is reporting now and, if not, since when; the last time it made power; and each stretch of daylight with no readings over a period - silence at night, when an inverter without a battery switches off, is not counted. A relay-fed system that went quiet is pointed at its relay |
| `energy` | energy over any period - made, used by the house, bought and sold - in total or per day, week, month or year, for one system or all; the best and lowest period - day by day, from days wholly recorded for every system; with a tariff set, the money saved and CO₂ avoided |
| `power_day` | a day's power, from every reading: what each system made between two times of that day (from its own day counter), its average and highest power and when, when it was making power, and how steady it was - sharp drops (a fall of a quarter of the day's highest or more from one reading to the next), the biggest fall, and how much it went up and down against one smooth rise and fall - with the day hour by hour |
| `compare_systems` | every system side by side per kWp of panels over a period, best first |
| `stats` | each system's days over a period: how many were recorded, the total, the average and median day, the best and worst, the spread (standard deviation), kWh per kWp, capacity factor, low days (under half the median), and the average day against as many days just before. Whole days only: today is left out, and so is a day with too few readings to be whole (under 60) - a system's first evening, or a relay off for most of the day - which the answer names |
| `faults` | the faults the vendors recorded over a period, which are still active, and the most common |
| `day_report` | why a day was low: each system's energy against a usual day, the sunlight against usual, what that sunlight should have made, stretches with no readings, faults - and the likely cause |
| `performance_trend` | whether a system is slowly losing output: energy made against the sunlight on its panels, week by week |
| `report` | a full report on a period, in one: the headline figures, then energy, the systems side by side (with more than one), the statistics, the faults and the health check, each as its own part |
| `app_help` | how to do something in SolarLens, and on which tab - from the guide written into the Worker (`src/help.ts`), never made up by a model |

A period is a named one - today, yesterday, this or last week, month or year,
the last 7 or 30 days, the last 12 months - or two dates. Weeks run Monday to
Sunday, and days are the plants' own. With no period named, `energy` and
`compare_systems` cover this month, `faults` and `stats` the last 30 days,
`outages` the last 7 days, and a `report` last month; `power_day` takes one
day, today unless named, and times of day as HH:MM on the plant's clock. The same tools are served without a model at
`GET /api/tools` and `GET /api/tools/<name>?<arguments>`. The MCP server offers
the same tools to AI apps outside SolarLens.

### Reports

*"A report on last month"*, *"summarise this year"*, *"write me a report on the
garage for August"* each run the `report` tool. It covers the whole period and
opens with the headline figures: made, used, bought, sold, saved and CO₂ with a
tariff set, the best and worst day, the best system per kWp, the faults and
each system's health. Each part follows with its own table. The model writes
it up in a few short paragraphs, held to the figures like any answer.

**Download report** saves it as a page of its own - the words, then every table
with its period, how fresh the data was, and who wrote it. It has no script,
opens in any browser, and prints cleanly, so *Print → Save as PDF* makes a PDF.
Any other answer has a **Download** button too.

### The conversation

The conversation lives in the browser tab. It survives a reload and goes when
the tab closes; **New conversation** clears it. Each message is sent with the
last four exchanges, so a follow-up knows what came before. The Worker keeps
none of it. A message is at most 500 characters.

## The agents

- **Why was this day low?** On Historical Data, a day well below its system's
  usual has a **Why?** beside it. It runs the `day_report` tool and shows the
  answer in the conversation on the Ask tab. It works for anyone who can read
  the dashboard.
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

**Anyone who can see the dashboard can ask.** On a private dashboard that means
the owner and anyone with a share link; on an open one, anyone. **Only someone
signed in - the owner, or a share link - gets the model**: each message spends
model calls, and a stranger could spend them all. Anyone else gets SolarLens's
own reading of the question and the figures' own words.

SolarLens counts its model calls - every feature together, per UTC day - and
stops at `AI_DAILY_CALLS` (100 unless set). A message takes two calls,
understanding and wording; a greeting takes one. The Ask tab shows how many
are left. Past the cap, SolarLens reads each question itself until midnight
UTC, and the weekly report is written from the figures.

**Workers AI's free allowance is 10,000 neurons a day**, and on the free plan a
request past it fails. Each call costs about 50 neurons with the default model,
so a hundred calls stay well inside it. A server of your own counts against the
same cap, since it may charge by the call.

## Where the model runs

| Setting | Where the model runs |
|---|---|
| nothing set (the default) | **Workers AI**, on Cloudflare, beside the Worker. Nothing to host or pay for within the free allowance. |
| `AI_BASE_URL` and `AI_MODEL` | **Any server that speaks OpenAI's chat completions API**, with `AI_API_KEY` as its key. |
| neither, and no `ai` binding | **No model**: SolarLens reads each question itself. |

Servers that work with `AI_BASE_URL`:

- **OpenAI** - `https://api.openai.com/v1`, a model such as `gpt-4o-mini`.
- **Groq** - `https://api.groq.com/openai/v1`, a model such as
  `llama-3.3-70b-versatile`.
- **OpenRouter** - `https://openrouter.ai/api/v1`, any model it lists.
- **A model on your own computer or server** - Ollama, LM Studio, llama.cpp's
  server, vLLM - each serves the same API. The Worker runs on Cloudflare, so the
  server must be reachable from the internet over https: put it behind a
  Cloudflare Tunnel (or any https reverse proxy with a key in front), and set
  `AI_BASE_URL` to the tunnel's address, such as
  `https://llm.example.com/v1`. A model that can answer in JSON works best: the
  understanding asks for JSON.

The address must be https, so a key never crosses a network in the clear. The
one exception is a model on the same computer as the Worker - for trying a
local model with `wrangler dev`, `AI_BASE_URL=http://localhost:11434/v1` in
`.dev.vars` reaches Ollama directly. An `AI_BASE_URL` that is set but not
usable (http to another computer, or no `AI_MODEL`) means no model, rather than
quietly falling back to Workers AI: you asked for your data to go there and
nowhere else. Errors from the server are logged by their status only, never
with the key.

## What the model sees

The model is sent the message, the last four exchanges of the conversation,
today's date, the systems' names and sizes, the list of tools, and - to word an
answer - the figures the tools worked out. Nothing else from the database: no
internal id, no position, no token. Workers AI runs on Cloudflare, in the same
place as the Worker. A server set with `AI_BASE_URL` is sent the same, and
nothing more.

## Setting it up

Workers AI is on by default: `wrangler.jsonc` has the binding,

```jsonc
"ai": { "binding": "AI" }
```

- **`AI_MODEL`** (optional) - another Workers AI chat model, taking `messages`.
  The default, `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, can answer in JSON
  when asked, which the understanding relies on. With `AI_BASE_URL` set, it is
  the model name that server knows.
- **`AI_DAILY_CALLS`** (optional) - the daily cap, 0 to 10,000; 0 turns the
  model off, and SolarLens reads every question itself.
- **`AI_BASE_URL`** (optional) - an OpenAI-compatible server to use instead of
  Workers AI, as above.
- **`AI_API_KEY`** (with `AI_BASE_URL`) - that server's key. A server of your own
  that takes no key can go without, though a tunnel open to the internet should
  have one.

Set each with `npm run cf -- secret put NAME`, like the Worker's other settings:
a secret stays through every deploy, and keeps the address and the key out of
git. For example, Groq:

```sh
npm run cf -- secret put AI_BASE_URL     # https://api.groq.com/openai/v1
npm run cf -- secret put AI_MODEL        # llama-3.3-70b-versatile
npm run cf -- secret put AI_API_KEY      # the key from Groq's console
```

To go back to Workers AI, delete `AI_BASE_URL` (`npm run cf -- secret delete
AI_BASE_URL`) and `AI_MODEL`.

Remove the binding, and set no `AI_BASE_URL`, and SolarLens reads each question
itself; "Why?", the health check and the weekly report still work from the
figures.

**`wrangler dev`** reaches Workers AI remotely - it cannot run on your computer -
so the model in local development needs you signed in to wrangler, and counts
against the same allowance. The integration tests leave the binding out.

**If a deploy fails on the `ai` binding** with an authentication error, the
Cloudflare API token the deploy uses needs the *Workers AI* permission added.

## The API

`POST /api/chat` takes the conversation, the latest message last:

```json
{ "messages": [
  { "role": "user", "content": "How much did I make last week?" },
  { "role": "assistant", "content": "Your systems made 224 kWh last week.", "calls": [{ "tool": "energy", "args": { "range": "last_week" } }] },
  { "role": "user", "content": "And the week before?" }
] }
```

An answer's `calls` go back with it in the next message: they are how a
follow-up knows what the answer before looked up. The reply:

| Field | |
|---|---|
| `answer` | the words: lines, and lines starting `- ` as a list |
| `kind` | `figures`, `report`, `help`, or `chat` (a reply with no figures) |
| `calls`, `results` | each tool run, with its arguments, and its result - title, period, columns and rows, facts, notes, summary, freshness; a report's parts under `sections` |
| `errors` | calls that could not run, and why |
| `worded`, `understood` | `model` or `solarlens` |
| `used`, `limit`, `model`, `provider` | today's model calls, and which model, where |

`POST /api/ask` answers one question - `{"question": "…"}` - or runs one tool
directly - `{"tool": "day_report", "args": {"date": "2026-09-21"}}` - with the
same rules. `GET /api/ask/status` says whether there is a model (`available`),
which one and where (`model`, `provider`), whether this caller gets it
(`can_ask`), and the day's calls. On a private dashboard, all three need a
signed-in device or a share link.
