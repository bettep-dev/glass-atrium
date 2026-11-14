// Throwaway self-signed leaf for the remote listener tests, made by the macOS LibreSSL with a fixed argv (no shell).

import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { RemoteTls } from "../../src/server/remote/listener.js";

const OPENSSL = "/usr/bin/openssl";

/** Leaf for 127.0.0.1, the loopback stand-in for the Wi-Fi address; the cert doubles as the client's CA. */
export async function createStandInTls(): Promise<RemoteTls & { dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "remote-tls-"));
  const config = path.join(dir, "leaf.cnf");
  await writeFile(
    config,
    "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=127.0.0.1\n[v3]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\n",
  );
  const keyPath = path.join(dir, "leaf.key");
  const certPath = path.join(dir, "leaf.pem");
  await promisify(execFile)(OPENSSL, [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", "1", "-config", config,
  ]);
  return { dir, key: await readFile(keyPath), cert: await readFile(certPath) };
}
