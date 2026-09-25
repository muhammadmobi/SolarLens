/**
 * The parts of a datalogger record that both vendors describe differently.
 *
 * Neither vendor says in a field how its logger reaches the internet, but
 * both name the product for it: SolisCloud's "S3-WIFI-ST", SolarMan's "LSW-3"
 * (W for Wi-Fi) and "LSE-3" (E for Ethernet), the "4G" and "GPRS" sticks. SolarMan
 * names a logger only by its firmware, whose first segment is the family: the
 * LSW-3 Wi-Fi stick runs "LSW3_..." or, on newer builds, "MW3_...". So
 * the link is read from the model name, and left null for a name that does
 * not say - better than a guess shown as fact.
 */
import type { LoggerDetail, LoggerNetwork } from './types';

/** 'Wi-Fi', 'Ethernet' or 'Cellular' from a logger's model name, or null. */
export function linkOf(model: string | null | undefined): string | null {
  if (!model) return null;
  const m = model.toUpperCase();
  if (/WI-?FI|WLAN|^LSW|^MW3/.test(m)) return 'Wi-Fi';
  if (/LAN|ETH|^LSE/.test(m)) return 'Ethernet';
  if (/4G|LTE|GPRS|GSM|NB-?IOT|^LSG|^LS4G/.test(m)) return 'Cellular';
  return null;
}

/** An object whose every field is null says nothing, and is stored as null. */
function orNull<T extends object>(o: T): T | null {
  return Object.values(o).some((v) => v !== null) ? o : null;
}

/** A non-empty string, trimmed, or null. */
function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

export const loggerDetail = (d: Partial<LoggerDetail>): LoggerDetail | null => orNull({
  link: d.link ?? null,
  signalLevel: d.signalLevel ?? null,
  uptimeS: d.uptimeS ?? null,
  workingS: d.workingS ?? null,
  manufacturedAt: d.manufacturedAt ?? null,
});

export const loggerNetwork = (d: { operator?: unknown; cellArea?: unknown; cellId?: unknown; mac?: unknown }): LoggerNetwork | null => orNull({
  operator: text(d.operator),
  cellArea: text(d.cellArea),
  cellId: text(d.cellId),
  mac: text(d.mac),
});
