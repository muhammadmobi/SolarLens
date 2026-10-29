# Alerts elsewhere: ntfy, Telegram, Discord and webhooks

SolarLens can post its alerts, and a summary every Monday morning, to the
places you already look: a notification app, a chat, or any webhook - a Home
Assistant automation, for one. There is no email: each of these does the job
without a mail service to sign up for.

Set them up under **Settings** (the gear) → **Alerts elsewhere**, signed in as
the owner. Each place gets a test message the moment it is added, so you see
the whole path work.

## What is posted

- **Alerts** - the same ones a phone gets from the Alerts tab: a system that
  stops while it was producing, a new vendor fault, a SolisCloud login about to
  run out or already out, a vendor that has stopped answering. Each is told
  once, however long it lasts, and again only if it clears and comes back.
  Several at once arrive as one post that lists them.
- **The weekly summary** - every Monday from 08:00 on the first system's clock:
  last week's energy against the week before, each system's share, its best
  day and how many days it reported, the money saved and CO₂ avoided if the
  tariff is set, and how many faults were recorded. *Send last week's summary
  now* in Settings sends one straight away, to see what it looks like.

Each place takes alerts, the summary, or both; the ticks in Settings change it.
At most five places.

## Setting each one up

### ntfy

A notification on a phone or a computer, through [ntfy.sh](https://ntfy.sh) or a
server of your own.

1. Install the ntfy app on your phone.
2. Choose a topic - **long and hard to guess**, such as
   `solar-7f3kq9-house`. On ntfy.sh anyone who knows a topic can read it, and
   subscribe to it, so treat the topic as a password.
3. In the app, subscribe to that topic.
4. In SolarLens, choose **ntfy**, keep `https://ntfy.sh` (or give your own
   server), and enter the topic. An access token is only needed for a topic
   that has been locked to one.

Alerts arrive at high priority; the summary and the test at the default one.
Tapping a notification opens the dashboard at the right page.

### Telegram

A message from a bot of your own, to you or to a group.

1. In Telegram, talk to **@BotFather**, send `/newbot`, and follow the steps.
   It answers with the bot's token, which looks like `123456:ABC-def…`.
2. Send your new bot any message - or add it to the group it should post in.
3. Find the chat's id: open
   `https://api.telegram.org/bot<the token>/getUpdates` in a browser and look
   for `"chat":{"id":…}`. A person's id is a plain number; a group's starts
   with a minus. A public channel can be given by its `@name` instead.
4. In SolarLens, choose **Telegram**, and enter the token and the chat id.

### Discord

A post in a channel.

1. In Discord, open the channel's settings → **Integrations** → **Webhooks** →
   **New Webhook**, and **Copy Webhook URL**.
2. In SolarLens, choose **Discord** and paste it.

The posts never mention anyone: whatever a fault message or a plant name says,
Discord is told to ping nobody.

### Any webhook, and Home Assistant

JSON, posted to any `https://` address you give:

```text
{
  "source": "solarlens",
  "kind": "alert",
  "title": "South roof: stopped reporting",
  "message": "Nothing since 14:05, when it was producing 2.4 kW.",
  "url": "https://solarlens.example.com/#/alerts",
  "ts": <when it was sent, in seconds since 1970>
}
```

`kind` is `alert`, `summary` or `test`.
For Home Assistant, see [home-assistant.md](home-assistant.md#alerts-into-home-assistant):
an automation with a webhook trigger receives it as `trigger.json`.

## When a post fails

Settings shows each place's state: *delivered 2 h ago*, or *failing 3 times in
a row: HTTP 401: Invalid Webhook Token* - the service's own words where it gives
them, or a few of ours. A failed post is not tried again; the next alert or
summary goes as normal, and *Send a test* tells you when it works again.

## How the secrets are kept

A bot token, a webhook address, a topic on a public server: each lets anyone who
has it post to you. So:

- **They are encrypted before they are stored**, with AES-GCM under a key
  derived from `API_TOKEN` - which lives in the Worker's secrets, not in the
  database. A copy of the database holds nothing that can post. This is also
  why places need `API_TOKEN` to be set, and why **changing `API_TOKEN` means
  adding each place again**: Settings then says a place "cannot be read".
- **They are never shown again.** Settings lists each place by a hint - `ntfy.sh
  · topic …ab`, `Discord webhook …wxyz`, `hooks.example.net webhook` - never the
  token, the topic or the path of an address.
- **A failure is recorded without the address.** It is a status and a few
  words; an error from the network is recorded only as "could not connect",
  since its own text can carry the address.
- **Only `https://`, to a named host.** No plain http, no user name or password
  in the address, no address given by its number, nothing like `localhost` or
  `.local`: the Worker posts where it is told, so it is held to what a webhook
  on the internet can be.
- **Only the owner** can list, add, change, test or remove a place. A share
  link cannot even see the list.

**What each service sees**: the messages name your systems and their faults,
and the services you choose - ntfy, Telegram, Discord, or wherever a webhook
points - see that text. Nothing else about the dashboard is sent to them.
