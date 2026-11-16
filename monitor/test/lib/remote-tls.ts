// Throwaway self-signed leaf for the remote listener tests, made by the macOS LibreSSL with a fixed argv (no shell).

import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { RemoteTls } from "../../src/server/remote/listener.js";

const OPENSSL = "/usr/bin/openssl";

/**
 * Leaf for 127.0.0.1 by default, the loopback stand-in for the Wi-Fi address; the cert doubles as the client's CA.
 * @param names.hostName - adds a DNS name beside the address
 */
export async function createStandInTls(names: { address?: string; hostName?: string; days?: number } = {}): Promise<RemoteTls & { dir: string }> {
  const { address = "127.0.0.1", hostName, days = 1 } = names;
  const dir = await mkdtemp(path.join(tmpdir(), "remote-tls-"));
  const config = path.join(dir, "leaf.cnf");
  const altNames = hostName === undefined ? `IP:${address}` : `DNS:${hostName},IP:${address}`;
  await writeFile(
    config,
    `[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=${address}\n[v3]\nsubjectAltName=${altNames}\nbasicConstraints=critical,CA:FALSE\n`,
  );
  const keyPath = path.join(dir, "leaf.key");
  const certPath = path.join(dir, "leaf.pem");
  await promisify(execFile)(OPENSSL, [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", String(days), "-config", config,
  ]);
  return { dir, key: await readFile(keyPath), cert: await readFile(certPath) };
}
