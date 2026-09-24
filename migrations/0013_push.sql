-- Notifications that reach a browser which is closed.
--
-- A device that turns them on hands over its push endpoint: an address at its
-- browser's own push service (Google, Mozilla, Apple, Microsoft) that wakes the
-- device's service worker. The endpoint is itself the secret - whoever holds it
-- can wake that device - so it stays in this table and is never served.
--
-- Nothing is sent to it but an empty wake-up. The worker then reads what there
-- is to say from push_messages, which is what keeps the notification's text out
-- of the push services entirely, and spares this project the payload
-- encryption a message carried inside the push would need.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint    TEXT PRIMARY KEY,
  -- The dashboard's own origin, as the device saw it when it subscribed. The
  -- push service is told this is who is sending, and it needs no setting.
  origin      TEXT NOT NULL,
  -- A short hash of the endpoint, so a message meant for one device - the test
  -- a device asks for - can be addressed without the endpoint leaving here.
  audience    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_ok_at  INTEGER,
  failures    INTEGER NOT NULL DEFAULT 0
);

-- What the woken worker shows. `audience` is empty for a message for every
-- device, or a device's hash for one meant only for it. Kept a week.
CREATE TABLE IF NOT EXISTS push_messages (
  id        TEXT PRIMARY KEY,
  ts        INTEGER NOT NULL,
  audience  TEXT NOT NULL DEFAULT '',
  title     TEXT NOT NULL,
  body      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS push_messages_ts ON push_messages (ts);
