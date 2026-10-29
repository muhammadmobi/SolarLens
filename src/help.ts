/**
 * What the assistant knows about SolarLens itself: how to do things in the app,
 * and where. "How do I get alerts on Telegram?", "Where is the tariff set?",
 * "Why does a system say offline?" are answered from these entries - written
 * here, from the app as it is, and never guessed by a model - through the
 * app_help tool (./tools).
 *
 * Each entry has the words a question about it is likely to use, a short answer
 * in the dashboard's own names for things, and the tab it happens on. Keep them
 * in step with the page: when a feature moves, its entry moves with it.
 */

export interface HelpEntry {
  topic: string;
  /** Words a question about this is likely to contain, lower case. */
  words: string[];
  answer: string;
  /** The page it happens on, as the dashboard's own address: '#/settings'. */
  where: string;
  /** A word SolarLens uses, explained: "what is kWp?" asks for this rather than how to do something. */
  term?: true;
}

export const HELP: readonly HelpEntry[] = [
  {
    topic: 'Signing in, and passkeys',
    words: ['sign', 'signin', 'login', 'log', 'password', 'passkey', 'fingerprint', 'face', 'setup', 'code', 'forgot', 'locked'],
    answer: 'Settings (the gear) → Set up sign-in, with the setup code (the API_TOKEN SolarLens was deployed with) and a password of at least 12 characters. Add a passkey under Passkeys on each phone or computer: it signs in with a fingerprint, a face or the device PIN. A device stays signed in: you sign in once per device. Forgot your password? on the sign-in page takes the setup code again.',
    where: '#/settings',
  },
  {
    topic: 'Making the dashboard private',
    words: ['private', 'privacy', 'require', 'hide', 'public', 'lock', 'strangers', 'who', 'see'],
    answer: 'Settings → turn on Require sign-in to view. From then on only you, and anyone you share a link with, can see the readings. It needs a password or a passkey first, so you cannot lock yourself out.',
    where: '#/settings',
  },
  {
    topic: 'Sharing the dashboard',
    words: ['share', 'sharing', 'family', 'link', 'someone', 'view', 'viewer', 'others'],
    answer: 'Settings → Share to view: make a link for a day, a week, a month or until you take it back. It lets someone see the dashboard and change nothing; taking it back signs out everyone who used it.',
    where: '#/settings',
  },
  {
    topic: 'Notifications on a phone',
    words: ['notification', 'notifications', 'notify', 'push', 'phone', 'alert', 'alerts', 'iphone', 'android'],
    answer: 'Alerts tab → Turn on for this device (and Send a test). On an iPhone or iPad, add the dashboard to the home screen first. The server needs its VAPID_KEY, which scripts/make-vapid-key.mjs sets once.',
    where: '#/alerts',
  },
  {
    topic: 'Alerts on ntfy, Telegram, Discord or a webhook',
    words: ['telegram', 'discord', 'ntfy', 'webhook', 'chat', 'bot', 'elsewhere', 'message', 'channel', 'slack'],
    answer: 'Settings → Alerts elsewhere → Add a place: choose ntfy, Telegram, Discord or a webhook, fill in what it asks, and tick Alerts, the Weekly summary, or both. A test is sent at once. Tokens are kept encrypted and never shown again. docs/alerts-elsewhere.md says how to get a Telegram bot token or a Discord webhook.',
    where: '#/settings',
  },
  {
    topic: 'The weekly summary',
    words: ['weekly', 'summary', 'monday', 'week', 'digest', 'email'],
    answer: 'Every Monday morning, once the week\'s report is written (from 08:00), the places under Settings → Alerts elsewhere that take the weekly summary get last week against the week before, each system, the savings and the faults, with the weekly report. Send last week\'s summary now sends one straight away. There is no email.',
    where: '#/settings',
  },
  {
    topic: 'Home Assistant',
    words: ['home', 'assistant', 'hass', 'homeassistant', 'sensor', 'sensors', 'yaml', 'automation'],
    answer: 'Settings → Home Assistant: copy the configuration.yaml block into Home Assistant and restart it. When the dashboard is private, Make a token for Home Assistant first. For alerts inside Home Assistant, add a Webhook under Alerts elsewhere.',
    where: '#/settings',
  },
  {
    topic: 'Money saved and CO2',
    words: ['tariff', 'money', 'price', 'cost', 'save', 'saved', 'saving', 'savings', 'currency', 'net', 'metering', 'co2', 'carbon'],
    answer: 'Settings → Tariff: the currency, what a kWh bought costs, what one sold earns, net metering, and the grid\'s CO₂ per kWh. The savings then show on each system\'s page (Money and carbon) and under Historical Data.',
    where: '#/settings',
  },
  {
    topic: 'Favourites and groups',
    words: ['favourite', 'favorite', 'star', 'group', 'groups', 'order', 'sort', 'first'],
    answer: 'A star on a system\'s page puts it first on the Overview, in that browser. Groups ("House", "Garage") are set in Settings → Groups, and the Overview shows each under its own heading with a filter.',
    where: '#/settings',
  },
  {
    topic: 'A day hour by hour',
    words: ['hour', 'hourly', 'analysis', 'peak', 'peaks', 'self', 'consumption', 'load', 'house'],
    answer: 'Analysis tab: any of the last seven days, one system or all - what was made against what the house used, hour by hour, the peaks, and how much of the sun\'s output the house used itself.',
    where: '#/analysis',
  },
  {
    topic: 'Comparing systems',
    words: ['compare', 'comparison', 'kwp', 'better', 'best', 'worst', 'side'],
    answer: 'Compare tab (with two systems or more): every system per kWp of panels, today and this month, so different sizes compare fairly. Or ask "compare my systems last month".',
    where: '#/compare',
  },
  {
    topic: 'History, and exporting it',
    words: ['history', 'historical', 'csv', 'export', 'download', 'excel', 'month', 'year', 'data', 'past'],
    answer: 'Historical Data: by day, month or year, one system or all. Download CSV saves the rows shown. A low day has a Why? button that explains it.',
    where: '#/history',
  },
  {
    topic: 'Why a day was low',
    words: ['why', 'low', 'bad', 'poor', 'dropped', 'drop', 'less'],
    answer: 'Historical Data → Why? beside a low day, or ask "why was yesterday low?". It sets the day against a usual one: the sunlight, stretches with no readings, faults, and whether the system made less than its sunlight allowed.',
    where: '#/history',
  },
  {
    topic: 'The site map',
    words: ['map', 'where', 'location', 'position', 'address'],
    answer: 'Map tab, for the signed-in owner only: where each system is, on OpenStreetMap. Nobody else is ever sent a position.',
    where: '#/map',
  },
  {
    topic: 'Output against the weather',
    words: ['weather', 'sun', 'sunlight', 'cloud', 'expected', 'dashed', 'irradiance'],
    answer: 'The dashed line on a day curve is what the sunlight allowed; a system\'s page has an Against the weather card; and an alert says when a system makes far less than its sunlight allowed. The sunlight is from Open-Meteo.',
    where: '#/',
  },
  {
    topic: 'A system reads offline',
    words: ['offline', 'stale', 'missing', 'stopped', 'reporting', 'relay', 'laptop', 'solis', 'soliscloud', 'renew', 'login'],
    answer: 'A system reads offline when its vendor says so or nothing has arrived for 25 minutes; its live figures then read zero. For SolisCloud, check the relay laptop is on and its login is current: the Devices tab shows each relay and when its login runs out, and renew-solis-login.cmd on that computer renews it.',
    where: '#/devices',
  },
  {
    topic: 'TV mode',
    words: ['tv', 'wall', 'display', 'screen', 'fullscreen', 'kiosk'],
    answer: 'The TV button in the header: a full-screen view for a wall display, taking turns through the systems when there are many, and refreshing every five minutes.',
    where: '#/tv',
  },
  {
    topic: 'Using SolarLens from Claude or another AI app',
    words: ['mcp', 'claude', 'cursor', 'ai', 'app', 'apps', 'connect', 'connected', 'chatgpt', 'agent'],
    answer: 'Settings → Connected apps: copy the MCP address into the app (in Claude: Settings → Connectors → Add custom connector). The app opens SolarLens\'s approval page; press Allow, once. Disconnect it there any time.',
    where: '#/settings',
  },
  {
    topic: 'The assistant, and reports',
    words: ['ask', 'question', 'assistant', 'report', 'reports', 'chat', 'generate', 'pdf', 'print'],
    answer: 'Ask tab: any question about your systems, in your own words, with follow-ups - the questions shown there are only examples. Every figure is worked out by SolarLens and shown with the answer. Ask for "a report on last month" and Download report saves it as a page you can print or keep.',
    where: '#/ask',
  },
  {
    topic: 'An analysis of your systems',
    words: ['analyse', 'analyze', 'analysis', 'analytics', 'insight', 'insights', 'improve', 'recommend', 'recommendation', 'recommendations', 'advice', 'optimise', 'optimize'],
    answer: 'Ask tab: ask "analyse the last 30 days" or "how is my system doing?". SolarLens reads the figures together - production against the days before and the sunlight, the systems per kWp, the lowest day, the power used at home and bought at night, the always-on load, the battery, faults and strings - and says what needs a look, and what to do. The weekly report does the same for each week.',
    where: '#/ask',
  },
  {
    topic: 'Graphs and charts',
    words: ['graph', 'graphs', 'chart', 'charts', 'plot', 'draw', 'visualise', 'visualize', 'timeframe', 'pattern'],
    answer: 'Ask tab: ask for a graph in plain words - "graph PV against load today", "plot the battery charge this week", "which hours do I buy from the grid?" - and the answer draws it, over up to three months, with Download to keep it. The Power tab has each day\'s curve, and Historical Data each day\'s energy.',
    where: '#/ask',
  },
  {
    topic: 'PV strings and voltages',
    words: ['string', 'pv1', 'pv2', 'pv3', 'pv4', 'mppt', 'voltage', 'volts', 'amps', 'frequency', 'phase', 'phases', 'bms', 'factor'],
    answer: 'Each system\'s own page (tap it on the Overview): its PV strings - voltage, current and power - the AC side with its phases, frequency and power factor, the temperature, the DC bus, and the battery\'s own readings, as the inverter last reported them. Or ask "what is the PV1 voltage?" or "is a string down?".',
    where: '#/',
  },
  {
    topic: 'The health check',
    words: ['health', 'decline', 'degrade', 'degrading', 'dirty', 'clean', 'cleaning', 'trend', 'slowly', 'worse'],
    answer: 'Every Monday each system\'s output is set against the sunlight on its panels over twelve weeks. A fall of 8% or more - dirt, shade, a failing panel or a string down - is flagged on the Ask tab and told like any other alert.',
    where: '#/ask',
  },
  {
    topic: 'Faults',
    words: ['fault', 'faults', 'alarm', 'alarms', 'error', 'errors', 'warning', 'code'],
    answer: 'Alerts tab: what is wrong now, and the fault history each vendor has on record, with its advice. Or ask "any faults last month?".',
    where: '#/alerts',
  },
  {
    topic: 'The theme, and installing it',
    words: ['theme', 'dark', 'light', 'install', 'home', 'screen', 'pwa'],
    answer: 'The theme button in the top right cycles automatic, light and dark. To install SolarLens like an app, use the browser\'s Add to home screen or Install.',
    where: '#/',
  },

  // --- the words SolarLens uses, explained
  {
    topic: 'kW and kWh', term: true, where: '#/guide',
    words: ['kw', 'kwh', 'kilowatt', 'kilowatts', 'unit', 'units', 'watt', 'watts', 'difference'],
    answer: 'kW is power - how fast energy flows at a moment, what the panels are making now. kWh is energy - power over time: 1 kW for an hour is 1 kWh, the "unit" on an electricity bill. A day\'s production and a bill are in kWh; the curve through a day is in kW.',
  },
  {
    topic: 'kWp, the size of a system', term: true, where: '#/compare',
    words: ['kwp', 'peak', 'size', 'capacity', 'rated', 'nameplate', 'kilowatt-peak'],
    answer: 'kWp - kilowatt-peak - is the size of the panels: what they make in full sun under test conditions. A 5 kWp system rarely makes 5 kW; energy per kWp (kWh/kWp) is how systems of different sizes are compared fairly, as on the Compare tab.',
  },
  {
    topic: 'Performance ratio', term: true, where: '#/ask',
    words: ['performance', 'ratio', 'pr', 'efficiency', 'efficient'],
    answer: 'The performance ratio is the energy made against the sunlight on the panels and their size: how much of what the sun offered the system turned into power. It moves a little with the season; a fall of 8% or more over weeks - dirt, shade, a string down - is what the Monday health check flags.',
  },
  {
    topic: 'Capacity factor and specific yield', term: true, where: '#/ask',
    words: ['capacity', 'factor', 'specific', 'yield', 'kwh/kwp'],
    answer: 'Specific yield is the energy made per kWp of panels - kWh/kWp - for a day, a month or a year. Capacity factor is the energy made against the panels running at their full size all day, every day: 15 to 20% is usual for solar, as the sun sets and clouds pass.',
  },
  {
    topic: 'Using your own power: self-consumption and self-sufficiency', term: true, where: '#/analysis',
    words: ['self', 'consumption', 'sufficiency', 'self-consumption', 'self-sufficiency', 'autarky', 'own'],
    answer: 'Self-consumption is the share of what the panels made that the house used itself, rather than sold. Self-sufficiency is the share of what the house used that the sun covered, rather than the grid. Both are in an analysis and on the Analysis tab.',
  },
  {
    topic: 'Import and export, net metering and feed-in', term: true, where: '#/settings',
    words: ['import', 'export', 'net', 'metering', 'feed', 'feed-in', 'tariff', 'buy', 'sell', 'bought', 'sold'],
    answer: 'Import is power bought from the grid; export is power sold to it. With net metering, each kWh sold offsets one bought, so it is worth the import price; without it, a kWh sold earns the feed-in rate, usually less. Set yours under Settings → Tariff.',
  },
  {
    topic: 'Battery charge (SOC) and the BMS', term: true, where: '#/',
    words: ['soc', 'state', 'charge', 'bms', 'battery', 'percentage', 'percent', 'lithium'],
    answer: 'SOC - state of charge - is how full the battery is, in %. The BMS - battery management system - is the battery\'s own electronics: it measures its cells, keeps them within their limits and reports the charge, voltage, current and temperature the inverter shows.',
  },
  {
    topic: 'Inverter battery modes: self-use, backup, grid first', term: true, where: '#/',
    words: ['mode', 'modes', 'self-use', 'backup', 'sbu', 'sub', 'uti', 'utility', 'priority', 'solar-first', 'grid-first', 'setting'],
    answer: 'A hybrid inverter\'s battery mode says what the battery is for. In self-use (solar first, SBU) it runs the house when the sun cannot, and fills again by day, so less is bought. In backup or grid-first (SUB, UTI) it is kept full for power cuts, and the house runs from the grid at night. The mode is set on the inverter or in the vendor\'s app.',
  },
  {
    topic: 'PV strings and MPPT', term: true, where: '#/',
    words: ['string', 'strings', 'mppt', 'pv1', 'pv2', 'tracker', 'panel', 'panels', 'array'],
    answer: 'A string is a row of panels wired together into one input of the inverter - PV1, PV2. An MPPT - maximum power point tracker - is the part of the inverter that gets the most from each input. A string making far less than the others is usually shade, dirt or a fault on it.',
  },
  {
    topic: 'Power factor, grid frequency and the DC bus', term: true, where: '#/',
    words: ['power', 'factor', 'frequency', 'hz', 'hertz', 'dc', 'bus', 'phase', 'phases', 'voltage'],
    answer: 'Grid frequency is how fast the mains alternates - 50 Hz, or 60 in some countries - and drifts a little with the grid\'s load. Power factor is how well the current keeps in step with the voltage: 1 is perfect, and an inverter at rest may read 0. The DC bus is the voltage inside the inverter between the panels and the output.',
  },
  {
    topic: 'Peak, base and always-on load', term: true, where: '#/analysis',
    words: ['base', 'baseload', 'always-on', 'standby', 'phantom', 'peak', 'load', 'demand'],
    answer: 'The load is what the house draws at a moment. The always-on (base) load is what it never goes below - fridges, routers, pumps and devices on standby; every 100 W of it is 2.4 kWh a day. The peak is its highest, often in the evening when the sun is gone.',
  },
  {
    topic: 'Irradiance and sunlight', term: true, where: '#/',
    words: ['irradiance', 'sunlight', 'ghi', 'radiation', 'kwh/m2', 'sun', 'insolation'],
    answer: 'Irradiance is the sunlight reaching the ground, in W/m²; over a day it adds up to kWh/m² - 5 or 6 on a clear summer day, much less when cloudy. SolarLens takes it from Open-Meteo at each system\'s position, to tell the weather from a fault.',
  },
  {
    topic: 'Degradation', term: true, where: '#/ask',
    words: ['degradation', 'degrade', 'degrading', 'ageing', 'aging', 'wear'],
    answer: 'Panels lose a little output each year - about 0.5% - as they age. A fall of several percent within weeks is not ageing but dirt, shade, or a fault; the Monday health check watches for it against the sunlight.',
  },
  {
    topic: 'Datalogger and relay', term: true, where: '#/devices',
    words: ['datalogger', 'logger', 'dongle', 'wifi', 'wi-fi', 'relay', 'stick'],
    answer: 'The datalogger is the small Wi-Fi unit on the inverter that sends its readings to the vendor\'s cloud; when it is offline, the vendor - and SolarLens - get nothing new. The relay is the small program that fetches SolisCloud\'s figures for SolarLens, where the cloud will not be asked directly. Both are on the Devices tab.',
  },
];

/** The words of a question, lower case, without the ones every question has. */
const STOP = new Set(['the', 'a', 'an', 'i', 'my', 'me', 'do', 'does', 'is', 'are', 'was', 'to', 'of', 'in', 'on', 'how', 'why', 'can', 'what', 'where', 'it', 'and', 'or', 'for', 'with', 'get', 'set']);
const wordsOf = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));

/**
 * The entries a question is about, best first: each word of the question that
 * an entry lists counts, a word in its topic counts double, and a word that only
 * begins one of the entry's (notif… for notifications) counts too.
 */
/** A question asking what a word means, rather than how to do something. */
export const DEFINING = /\b(what (is|are|does|do)|what's|whats|meaning|means?|define|definition|explain|stands? for)\b/;

export function findHelp(question: string, limit = 3): HelpEntry[] {
  const q = wordsOf(question);
  const defining = DEFINING.test(question.toLowerCase());
  const scored = HELP.map((e) => {
    const topic = new Set(wordsOf(e.topic));
    let score = 0;
    for (const w of q) {
      if (topic.has(w)) score += 2;
      if (e.words.includes(w)) score += 2;
      else if (w.length >= 4 && e.words.some((k) => k.startsWith(w) || w.startsWith(k))) score += 1;
    }
    return { e, score };
  }).filter((x) => x.score > 0);
  // A word explained for "what is...", how to do something for the rest; the other kind only when nothing else fits.
  const wanted = scored.filter((x) => !!x.e.term === defining);
  return (wanted.length ? wanted : scored).sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.e);
}
