// Trusted-network guard for the remote listener: an accident guard against opening on a café Wi-Fi, not authentication.
// Identity = default gateway IP + its ARP hardware address (the Wi-Fi name is redacted without a Location grant).

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Runs a fixed binary with a fixed argv, no shell. Injected so tests never read the real network. */
export type CommandRunner = (file: string, args: readonly string[]) => Promise<string>;

export interface NetworkIdentity {
  readonly gateway: string;
  /** Lower-case, each octet zero-padded → the form the trusted list stores. */
  readonly hardwareAddress: string;
  readonly interface: string;
}

export interface TrustedNetwork {
  readonly gateway: string;
  readonly hardwareAddress: string;
}

export type ListenReason = "trusted" | "disabled" | "identity_unreadable" | "untrusted" | "address_not_private";

export interface ListenDecision {
  readonly open: boolean;
  readonly reason: ListenReason;
}

const COMMAND = {
  ROUTE: "/sbin/route",
  ARP: "/usr/sbin/arp",
  ENV: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
  TIMEOUT_MS: 2_000,
} as const;

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export const runCommand: CommandRunner = async (file, args) => {
  const { stdout } = await execFileAsync(file, [...args], { env: COMMAND.ENV, timeout: COMMAND.TIMEOUT_MS });
  return stdout;
};

/** @returns null when any part is unreadable → the caller keeps the listener closed */
export async function getNetworkIdentity(run: CommandRunner = runCommand): Promise<NetworkIdentity | null> {
  try {
    const route = await run(COMMAND.ROUTE, ["-n", "get", "default"]);
    const gateway = /^\s*gateway:\s*(\S+)\s*$/m.exec(route)?.[1];
    const networkInterface = /^\s*interface:\s*(\S+)\s*$/m.exec(route)?.[1];
    if (gateway === undefined || networkInterface === undefined || !IPV4_PATTERN.test(gateway)) return null;
    const arp = await run(COMMAND.ARP, ["-n", gateway]);
    const hardwareAddress = getArpHardwareAddress(arp, gateway, networkInterface);
    return hardwareAddress === null ? null : { gateway, hardwareAddress, interface: networkInterface };
  } catch {
    // a failed or timed-out read is "unreadable" by design → closed, never an error path
    return null;
  }
}

export function getListenDecision(input: {
  readonly enabled: boolean;
  readonly identity: NetworkIdentity | null;
  readonly trusted: readonly TrustedNetwork[];
  readonly address: string | null;
}): ListenDecision {
  if (!input.enabled) return { open: false, reason: "disabled" };
  if (input.identity === null) return { open: false, reason: "identity_unreadable" };
  const { gateway, hardwareAddress } = input.identity;
  const isTrusted = input.trusted.some(
    (network) => network.gateway === gateway && getNormalizedHardwareAddress(network.hardwareAddress) === hardwareAddress,
  );
  if (!isTrusted) return { open: false, reason: "untrusted" };
  if (input.address === null || !isPrivateIPv4(input.address)) return { open: false, reason: "address_not_private" };
  return { open: true, reason: "trusted" };
}

/** RFC 1918 only: 10/8, 172.16/12, 192.168/16. */
export function isPrivateIPv4(address: string): boolean {
  const match = IPV4_PATTERN.exec(address);
  if (match === null) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const [first, second] = octets as [number, number, number, number];
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

// `? (192.168.45.1) at 50:e:a5:7:1c:f2 on en1 ifscope [ethernet]` → the entry must name this gateway on this interface
function getArpHardwareAddress(output: string, gateway: string, networkInterface: string): string | null {
  for (const line of output.split("\n")) {
    const match = /\((\S+)\) at (\S+) on (\S+)/.exec(line);
    if (match === null || match[1] !== gateway || match[3] !== networkInterface) continue;
    const address = getNormalizedHardwareAddress(match[2] ?? "");
    if (address !== null) return address;
  }
  return null;
}

/** Lower-case, each octet zero-padded; null unless six hex octets. */
export function getNormalizedHardwareAddress(text: string): string | null {
  const octets = text.toLowerCase().split(":");
  if (octets.length !== 6 || octets.some((octet) => !/^[0-9a-f]{1,2}$/.test(octet))) return null;
  return octets.map((octet) => octet.padStart(2, "0")).join(":");
}
