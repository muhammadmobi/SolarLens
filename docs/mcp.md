# SolarLens as an MCP server

SolarLens answers AI apps outside it - Claude, an IDE, anything that speaks the
**Model Context Protocol** - at one address:

```text
https://<your SolarLens>/mcp
```

Settings (the gear) → **Connected apps** shows it, with a Copy button.

The app gets the same eleven read-only tools as the assistant on the Ask tab
(see [ask-solarlens.md](ask-solarlens.md#the-tools)): what each system is doing
now, whether it is offline and since when, energy over any period, a day's power
hour by hour and between two times, systems compared per kWp, statistics,
faults, why a day was low, whether a system is slowly making less, a full report
on a period, and how to do something in SolarLens. SolarLens works out every figure, and each
answer says the period it covers and how fresh its data is. An app like Claude
then works as a chatbot over your systems: it holds the conversation, and asks
SolarLens for the figures.

It runs inside the SolarLens Worker on Cloudflare, so it answers whether the
relay laptops are on or off. With them off, the SolisCloud figures simply stop
at the last reading, and the answers say so.

## Connecting an app

Give the app the address. The first time it connects, it opens SolarLens's own
approval page in your browser:

1. If you are not signed in to SolarLens on that browser, it asks you to; you
   come back to the page afterwards.
2. The page says which app is asking, **where its answer will be sent**, and
   what it may do. The name is whatever the app calls itself, so the address is
   the thing to check.
3. **Allow**, and the app is connected - until you disconnect it.

In the apps people use most (their menus change from version to version):

- **Claude** (claude.ai, or the desktop app): *Settings → Connectors → Add custom
  connector*, name it SolarLens, paste the address, and *Connect*.
- **Claude Code**: `claude mcp add --transport http solarlens https://<your SolarLens>/mcp`,
  then `/mcp` inside Claude Code to sign in.
- **Other apps** (Cursor, VS Code, …): add a remote MCP server - "HTTP" or
  "Streamable HTTP" - with the address. An app that supports OAuth opens the
  approval page by itself.

## Approved once, connected until you say

An approved app holds an access token good for an hour and a refresh token it
renews with. The refresh token changes every time it is used, and a year of not
being used is what it takes to expire - so an app used now and then stays
connected. **Settings → Connected apps** lists every app, where its answers
go, when it was connected and last used, and **Disconnect** stops it at once.
An app can also disconnect itself.

Changing `API_TOKEN` does not disconnect apps: their tokens are their own.

## What an app can do - and cannot

It can read, through the eleven tools, and nothing more. It cannot change a
setting, sign anyone out, poll a vendor, or read a password, a token, a
channel's secret or where the systems are. Its token opens `/mcp` and nothing
else - not the dashboard's own `/api` routes.

## How it is protected

The MCP authorization spec, with SolarLens as both the resource and the
authorization server:

- **Discovery.** `/mcp` answers a request without a token with `401` and a
  `WWW-Authenticate` header pointing at `/.well-known/oauth-protected-resource`
  (RFC 9728), which names SolarLens's own authorization server; its endpoints
  are at `/.well-known/oauth-authorization-server` (RFC 8414).
- **Registration** (RFC 7591) at `/oauth/register`: public clients only, with
  PKCE instead of a secret - a desktop app cannot keep one. Answers go only to
  `https://` addresses, to `http://localhost`-style addresses on the same
  computer, or to a native app's own scheme; never `javascript:`, `data:` or a
  `#fragment`. At most 100 registrations; one never approved is cleared after a
  week.
- **Approval** at `/oauth/authorize`: only the owner, signed in on that
  browser, can allow an app - not a share link, not `API_TOKEN`. A link naming
  an unknown app, or an address the app did not register, is answered on the
  page and never followed. The choice is posted from the page itself, which
  another site cannot do: the session cookie is `SameSite=Strict`, and the
  route answers no cross-site script.
- **Tokens** at `/oauth/token`: a code is good once, for ten minutes, bound to
  the app, its address and its PKCE challenge (S256 only). A code that comes
  back a second time, or a refresh token that turns up again after the app has
  moved on, means a copy exists - and the app is disconnected.
- **Only hashes** of codes and tokens are stored, so a copy of the database
  connects nobody.
- `/oauth/revoke` (RFC 7009) lets an app disconnect itself, and answers the same
  whatever it is given.

The endpoints an MCP client talks to - `/mcp`, the discovery documents,
registration, tokens and revocation - answer scripts from any site (CORS),
since they rely on a bearer token or a PKCE verifier and never on a cookie. The
approval page does not.

## The protocol, for the curious

Streamable HTTP in its simplest form: each JSON-RPC message is POSTed to `/mcp`
and answered with JSON. There is no event stream and no session, since the
server never speaks first; `GET` and `DELETE` answer `405`. It speaks protocol
versions `2025-06-18`, `2025-03-26` and `2024-11-05`, and answers `initialize`,
`ping`, `tools/list` - each tool with its arguments as JSON Schema and marked
read-only - and `tools/call`, whose result is text for the model and the
tool's full result as `structuredContent`. A question a tool's arguments cannot
answer comes back as a tool error the model can read and correct.

| Endpoint | Who | What |
|---|---|---|
| `POST /mcp` | an approved app's access token | the MCP server |
| `GET /.well-known/oauth-protected-resource`, `…/mcp` | open | where the tokens come from |
| `GET /.well-known/oauth-authorization-server` | open | the authorization server's endpoints |
| `POST /oauth/register` | open | an app registers itself |
| `GET`, `POST /oauth/authorize` | the owner's own browser | the approval page, and the choice |
| `POST /oauth/token` | the app, with its code or refresh token | tokens |
| `POST /oauth/revoke` | the app | disconnect itself |
