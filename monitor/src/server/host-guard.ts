// Loopback-only bind guard for the monitor's unauthenticated API. A non-loopback bind would expose
// the entire API on a network interface, so main.ts fatally refuses any HOST that is not loopback.
// Recognizes IPv4 127.0.0.0/8, IPv6 ::1 (expanded / bracketed / zoned / IPv4-mapped), and localhost.

const LOOPBACK_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

/** True when host binds a loopback interface only. false = a non-loopback bind → main.ts must refuse. */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  if (value.length === 0) return false;
  if (LOOPBACK_HOSTNAMES.has(value)) return true;
  return value.includes(":") ? isV6Loopback(value) : isV4Loopback(value);
}

/** IPv4 loopback = a valid dotted-quad whose first octet is 127 (the 127.0.0.0/8 block). */
function isV4Loopback(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  return octets[0] === 127;
}

/** IPv6 loopback = ::1 (any textual form) or an IPv4-mapped/-compatible address whose embedded IPv4 is loopback. */
function isV6Loopback(host: string): boolean {
  let value = host;
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  if (value === "::1" || value === "0:0:0:0:0:0:0:1") return true;
  // IPv4-mapped/-compatible loopback (e.g. ::ffff:127.0.0.1) — the embedded IPv4 tail decides.
  if (value.startsWith("::") && value.includes(".")) {
    return isV4Loopback(value.slice(value.lastIndexOf(":") + 1));
  }
  return false;
}
