// Remote access settings from monitor/.env (rendered from config.toml [remote_access]): fail closed on anything unexpected.

import { isIPv4 } from "node:net";

import { type TrustedNetwork, getNormalizedHardwareAddress } from "./network.js";

export interface RemoteSettings {
  readonly enabled: boolean;
  readonly port: number;
  readonly trusted: readonly TrustedNetwork[];
}

/** Rendered env keys; the renderer writes every key, the explicit off value included, whenever the table is absent. */
export const REMOTE_ENV = {
  ACCESS: "ATRIUM_REMOTE_ACCESS",
  PORT: "ATRIUM_REMOTE_PORT",
  TRUSTED_NETWORKS: "ATRIUM_REMOTE_TRUSTED_NETWORKS",
} as const;

// the one value that turns it on → a stale, near-miss or boolean-looking value stays off
const ON_VALUE = "on";
const PORT_RANGE = { MIN: 1024, MAX: 65535 } as const;

export function getRemoteSettings(env: Readonly<Record<string, string | undefined>>, monitorPort: number): RemoteSettings {
  const port = getPort(env[REMOTE_ENV.PORT], monitorPort);
  const trusted = getTrustedNetworks(env[REMOTE_ENV.TRUSTED_NETWORKS] ?? "");
  return { enabled: env[REMOTE_ENV.ACCESS] === ON_VALUE && port !== null, port: port ?? 0, trusted };
}

function getPort(text: string | undefined, monitorPort: number): number | null {
  if (text === undefined || !/^\d+$/.test(text)) return null;
  const port = Number(text);
  return port >= PORT_RANGE.MIN && port <= PORT_RANGE.MAX && port !== monitorPort ? port : null;
}

// `<gateway IPv4>@<gateway hardware address>`, comma-separated → a malformed entry trusts nothing
function getTrustedNetworks(list: string): TrustedNetwork[] {
  return list.split(",").flatMap((entry) => {
    const [gateway = "", hardware = "", ...rest] = entry.trim().split("@");
    const hardwareAddress = getNormalizedHardwareAddress(hardware);
    return rest.length === 0 && isIPv4(gateway) && hardwareAddress !== null ? [{ gateway, hardwareAddress }] : [];
  });
}
