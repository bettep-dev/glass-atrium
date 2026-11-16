// Trusted-network guard for the remote listener: an accident guard against opening on a café Wi-Fi, not authentication.
// Identity = default gateway IP + its ARP hardware address, from arp or configd (the Wi-Fi name is redacted without a Location grant).

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { logger } from "../logger.js";

const execFileAsync = promisify(execFile);

/** Runs a fixed binary with a fixed argv and optional stdin, no shell. Injected so tests never read the real network. */
export type CommandRunner = (file: string, args: readonly string[], input?: string) => Promise<string>;

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
  SCUTIL: "/usr/sbin/scutil",
  ENV: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
  TIMEOUT_MS: 2_000,
} as const;

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export const runCommand: CommandRunner = async (file, args, input) => {
  const pending = execFileAsync(file, [...args], { env: COMMAND.ENV, timeout: COMMAND.TIMEOUT_MS });
  // child gone before the write lands → EPIPE on stdin; unheard, it is an uncaughtException that exits the monitor.
  // Exit code and stdout still decide the result → an unread input parses to nothing → closed.
  pending.child.stdin?.on("error", (error) => {
    logger.debug({ err: error, file }, "command stdin not written: child closed its input");
  });
  pending.child.stdin?.end(input ?? "");
  const { stdout } = await pending;
  return stdout;
};

/** @returns null when any part is unreadable → the caller keeps the listener closed */
export async function getNetworkIdentity(run: CommandRunner = runCommand): Promise<NetworkIdentity | null> {
  try {
    const route = await run(COMMAND.ROUTE, ["-n", "get", "default"]);
    const gateway = /^\s*gateway:\s*(\S+)\s*$/m.exec(route)?.[1];
    const networkInterface = /^\s*interface:\s*(\S+)\s*$/m.exec(route)?.[1];
    if (gateway === undefined || networkInterface === undefined || !IPV4_PATTERN.test(gateway)) return null;
    const arp = await run(COMMAND.ARP, ["-n", gateway]).catch(() => "");
    const hardwareAddress =
      getArpHardwareAddress(arp, gateway, networkInterface) ??
      (await getConfigdHardwareAddress(run, gateway, networkInterface));
    return hardwareAddress === null ? null : { gateway, hardwareAddress, interface: networkInterface };
  } catch {
    // a failed or timed-out read is "unreadable" by design → closed, never an error path
    return null;
  }
}

/** The Mac's Bonjour name (`<LocalHostName>.local`, lower-case) → the name a device types; null when unreadable. */
export async function getLocalHostName(run: CommandRunner = runCommand): Promise<string | null> {
  try {
    const name = (await run(COMMAND.SCUTIL, ["--get", "LocalHostName"])).trim().toLowerCase();
    // a DNS label only → the value lands in the Host allowlist and the page origin
    return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) ? `${name}.local` : null;
  } catch {
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

/**
 * configd's record of the primary service's router → the same ARP-resolved address, kept by the system.
 * - Homebrew node (the LaunchAgent's binary) → arp "no entry" for a gateway platform binaries see
 * - configd over IPC, not the network → readable there
 * - Match required: this gateway on this interface
 */
async function getConfigdHardwareAddress(run: CommandRunner, gateway: string, networkInterface: string): Promise<string | null> {
  const global = await run(COMMAND.SCUTIL, [], "show State:/Network/Global/IPv4\nquit\n");
  const serviceId = /^\s*PrimaryService : ([0-9A-Fa-f-]{1,64})\s*$/m.exec(global)?.[1];
  if (serviceId === undefined) return null;
  const service = await run(COMMAND.SCUTIL, [], `show State:/Network/Service/${serviceId}/IPv4\nquit\n`);
  if (/^\s*InterfaceName : (\S+)\s*$/m.exec(service)?.[1] !== networkInterface) return null;
  const signature = /IPv4\.Router=([^;\s]+);IPv4\.RouterHardwareAddress=([0-9A-Fa-f:]+)/.exec(service);
  return signature?.[1] === gateway ? getNormalizedHardwareAddress(signature[2] ?? "") : null;
}

/** Lower-case, each octet zero-padded; null unless six hex octets. */
export function getNormalizedHardwareAddress(text: string): string | null {
  const octets = text.toLowerCase().split(":");
  if (octets.length !== 6 || octets.some((octet) => !/^[0-9a-f]{1,2}$/.test(octet))) return null;
  return octets.map((octet) => octet.padStart(2, "0")).join(":");
}
