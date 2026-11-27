// Remote listener transport: HTTPS only on the address it is given, and a silent leaf reissue on the open listener.
// Binds only 127.0.0.1 on an ephemeral port — the stand-in for the Wi-Fi address.

import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { X509Certificate, randomBytes } from "node:crypto";
import http from "node:http";
import { connect as connectTcp, createServer } from "node:net";
import https from "node:https";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type PeerCertificate, type TLSSocket, checkServerIdentity as checkTlsIdentity, connect as connectTls } from "node:tls";

import type { FastifyInstance } from "fastify";

import { buildRemoteApp } from "../src/server/app.js";
import { disconnectPrisma } from "../src/server/db.js";
import { logger } from "../src/server/logger.js";
import { DeviceConnections } from "../src/server/remote/connections.js";
import type { DeviceSummary } from "../src/server/remote/devices.js";
import { LEAF_REISSUE_AHEAD_MS, type RemoteTls, isLeafDue, setRemoteCertificate } from "../src/server/remote/listener.js";
import { RegistrationCodes } from "../src/server/remote/registration-code.js";
import { getRouteClass } from "../src/server/remote/route-classes.js";
import { buildRemoteOpener } from "../src/server/remote/start.js";
import { DEVICE_COOKIE } from "../src/server/remote/session.js";
import { createStandInTls } from "./lib/remote-tls.js";
import { deleteDirectory } from "./lib/remove-dir.js";

const STAND_IN = "127.0.0.1";
const fixtureDirs: string[] = [];

after(async () => {
  await disconnectPrisma();
  for (const dir of fixtureDirs) deleteDirectory(dir);
});

async function getTls(): Promise<RemoteTls> {
  const tls = await createStandInTls();
  fixtureDirs.push(tls.dir);
  return tls;
}

/** Remote app listening on the stand-in address, an ephemeral port; the caller closes it. */
async function openStandIn(
  tls: RemoteTls,
  devices: ReadonlyMap<string, DeviceSummary> = new Map(),
  connections = new DeviceConnections(),
): Promise<{ app: FastifyInstance; port: number }> {
  let port = 0;
  const getHosts = () => new Set([`${STAND_IN}:${port}`]);
  const getPageOrigins = () => new Set([`https://${STAND_IN}:${port}`]);
  const app = await buildRemoteApp({
    tls,
    listener: { kind: "remote", getHosts, getPageOrigins },
    gate: {
      getHosts,
      getPageOrigins,
      findDevice: async (presented) => devices.get(presented) ?? null,
      getRouteClass,
      connections,
      preAuthRoutes: new Set(),
      audit: { insertIntent: async () => 1n, setResult: async () => undefined, insertEvent: async () => undefined },
    },
    registration: { codes: new RegistrationCodes(), createDevice: async () => ({ outcome: "cap_reached" }) },
    device: { revoke: async () => false, revokeAll: async () => [], turnOff: () => undefined },
  });
  await app.listen({ host: STAND_IN, port: 0 });
  port = (app.server.address() as AddressInfo).port;
  return { app, port };
}

function getOverTls(port: number, ca: Buffer): Promise<{ status: number; protocol: string; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const request = https.get({ host: STAND_IN, port, path: "/api/health", ca, agent: false }, (response) => {
      const socket = response.socket as TLSSocket;
      const result = { status: response.statusCode ?? 0, protocol: socket.getProtocol() ?? "", fingerprint: socket.getPeerCertificate().fingerprint256 };
      response.resume();
      response.on("end", () => resolve(result));
    });
    request.on("error", reject);
  });
}

test("a client trusting the leaf reaches the gate over TLS 1.3, and plain HTTP gets no HTTP answer", async () => {
  const tls = await getTls();
  const { app, port } = await openStandIn(tls);
  try {
    const served = await getOverTls(port, tls.cert);
    assert.deepEqual({ status: served.status, protocol: served.protocol }, { status: 401, protocol: "TLSv1.3" });
    await assert.rejects(
      new Promise((resolve, reject) => {
        http.get({ host: STAND_IN, port, path: "/api/health", agent: false }, resolve).on("error", reject);
      }),
    );
  } finally {
    await app.close();
  }
});

test("a reissued leaf is served to the next connection without reopening the listener", async () => {
  const { app, port } = await openStandIn(await getTls());
  try {
    const next = await getTls();
    setRemoteCertificate(app, next);
    const served = await getOverTls(port, next.cert);
    assert.equal(served.fingerprint, new X509Certificate(next.cert).fingerprint256);
  } finally {
    await app.close();
  }
});

/** Raw bytes over TLS → the whole answer, read until the server closes the connection. */
function sendRawOverTls(port: number, ca: Buffer, bytes: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connectTls({ host: STAND_IN, port, ca }, () => socket.end(bytes));
    let answer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (answer += chunk));
    socket.on("close", () => resolve(answer));
    socket.on("error", reject);
  });
}

test("a request the framework rejects before any route is answered with the one opaque reply", async () => {
  const tls = await getTls();
  const { app, port } = await openStandIn(tls);
  const host = `Host: ${STAND_IN}:${port}\r\nConnection: close\r\n\r\n`;
  const rows = [
    { name: "malformed request line", bytes: "\u0001NOT-HTTP\r\n\r\n", echo: "NOT-HTTP" },
    { name: "undecodable url", bytes: `GET /%E0%A4%A HTTP/1.1\r\n${host}`, echo: "%E0%A4%A" },
    { name: "undecodable url under a route prefix", bytes: `GET /api/remote/%zz HTTP/1.1\r\n${host}`, echo: "%zz" },
  ];
  try {
    for (const row of rows) {
      const answer = await sendRawOverTls(port, tls.cert, row.bytes);
      const [head = "", body] = answer.split("\r\n\r\n");
      assert.match(head, /^HTTP\/1\.1 400 /, row.name);
      assert.equal(body, '{"error":"bad_request"}', row.name);
      assert.ok(!answer.includes(row.echo) && !answer.includes("FST_"), `${row.name}: no echo, no framework code`);
    }
  } finally {
    await app.close();
  }
});

/** Plain bytes to the TLS port → resolves once the server closes the connection. */
function sendPlainBytes(port: number, bytes: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = connectTcp(port, STAND_IN, () => socket.write(bytes));
    socket.on("error", () => undefined);
    socket.on("close", () => resolve());
    socket.resume();
  });
}

test("a TLS client error leaves one info line with its code and the peer address, and none of the client's bytes", async () => {
  const { app, port } = await openStandIn(await getTls());
  const marker = "galaxy-probe-7f3a";
  const info = mock.method(logger, "info", () => undefined);
  try {
    await sendPlainBytes(port, `GET /${marker} HTTP/1.1\r\nHost: ${STAND_IN}:${port}\r\nX-Probe: ${marker}\r\n\r\n`);
  } finally {
    info.mock.restore();
    await app.close();
  }
  const refusals = info.mock.calls
    .map((call) => call.arguments)
    .filter(([fields]) => typeof fields === "object" && fields !== null && "reason" in fields);
  assert.equal(refusals.length, 1);
  const [fields] = refusals[0] ?? [];
  assert.match(JSON.stringify(fields), /^\{"reason":"client_error","code":"ERR_SSL_[A-Z0-9_]+","address":"127\.0\.0\.1"\}$/);
  assert.ok(!JSON.stringify(refusals).includes(marker), "no request bytes in the line");
});

/** One keep-alive request as a registered device → the socket it leaves open, still pooled by its agent. */
function openDeviceSocket(port: number, ca: Buffer, presented: string): Promise<Socket> {
  const agent = new https.Agent({ keepAlive: true, ca });
  return new Promise((resolve, reject) => {
    const headers = { cookie: `${DEVICE_COOKIE.NAME}=${presented}` };
    const request = https.get({ host: STAND_IN, port, path: "/", agent, headers }, (response) => {
      assert.equal(response.statusCode, 200);
      // read before end → the agent detaches the socket from the response once it returns to the pool
      const socket = response.socket;
      response.resume();
      response.on("end", () => resolve(socket));
    });
    request.on("error", reject);
  });
}

test("cutting off one device closes its open connections and leaves another device's open", async () => {
  const tls = await getTls();
  const devices = new Map<string, DeviceSummary>();
  const presented = { phone: randomBytes(32).toString("base64url"), tablet: randomBytes(32).toString("base64url") };
  devices.set(presented.phone, { id: 1n, label: "Owner phone" });
  devices.set(presented.tablet, { id: 2n, label: "Owner tablet" });
  const connections = new DeviceConnections();
  const { app, port } = await openStandIn(tls, devices, connections);
  try {
    const phone = await openDeviceSocket(port, tls.cert, presented.phone);
    const tablet = await openDeviceSocket(port, tls.cert, presented.tablet);
    const phoneClosed = new Promise((resolve) => phone.once("close", resolve));
    assert.equal(connections.close(1n), 1);
    await phoneClosed;
    assert.equal(tablet.destroyed, false);
    tablet.destroy();
  } finally {
    await app.close();
  }
});

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer().listen(0, STAND_IN, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

function getStatusForHost(port: number, ca: Buffer, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    // the client takes its TLS name from the Host header → identity is checked against the stand-in leaf's address instead
    const checkServerIdentity = (_name: string, cert: PeerCertificate) => checkTlsIdentity(STAND_IN, cert);
    const options = { host: STAND_IN, port, path: "/api/health", ca, agent: false, headers: { host }, checkServerIdentity };
    const request = https.get(options, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
  });
}

test("the opener admits only the bound address and the .local name at the remote port, and reopens on a fresh instance", async () => {
  const tls = await getTls();
  const port = await getFreePort();
  const open = buildRemoteOpener({
    port,
    gate: {
      findDevice: async () => null,
      audit: { insertIntent: async () => 1n, setResult: async () => undefined, insertEvent: async () => undefined },
      connections: new DeviceConnections(),
    },
    registration: { codes: new RegistrationCodes(), createDevice: async () => ({ outcome: "cap_reached" }) },
    device: { revoke: async () => false, revokeAll: async () => [], turnOff: () => undefined },
  });
  const first = await open(STAND_IN, "owner-mac.local", tls);
  const rows = [
    { name: "bound address at the remote port", host: `${STAND_IN}:${port}`, status: 401 },
    { name: ".local name at the remote port", host: `owner-mac.local:${port}`, status: 401 },
    { name: "rebound name", host: `attacker.example:${port}`, status: 403 },
    { name: "bound address at the loopback monitor port", host: `${STAND_IN}:16145`, status: 403 },
  ];
  try {
    for (const row of rows) assert.equal(await getStatusForHost(port, tls.cert, row.host), row.status, row.name);
  } finally {
    await first.close();
  }
  const reopened = await open(STAND_IN, "owner-mac.local", tls);
  await reopened.close();
});

test("a leaf is due when it expires within 30 days or no longer names the current host and address", async () => {
  const current = await createStandInTls({ address: "192.168.0.10", hostName: "studio-mac.local", days: 400 });
  const expiring = await createStandInTls({ address: "192.168.0.10", hostName: "studio-mac.local", days: 20 });
  fixtureDirs.push(current.dir, expiring.dir);
  const here = { hostName: "studio-mac.local", address: "192.168.0.10" };
  const rows = [
    { name: "current names, more than 30 days left", cert: current.cert, names: here, isDue: false },
    { name: "host name unreadable → only the address is checked", cert: current.cert, names: { ...here, hostName: null }, isDue: false },
    { name: "expires within 30 days", cert: expiring.cert, names: here, isDue: true },
    { name: "the Wi-Fi address changed", cert: current.cert, names: { ...here, address: "192.168.0.23" }, isDue: true },
    { name: "Bonjour renamed the Mac", cert: current.cert, names: { ...here, hostName: "studio-mac-2.local" }, isDue: true },
    { name: "an unparseable leaf", cert: Buffer.from("not a certificate"), names: here, isDue: true },
  ];
  for (const row of rows) assert.equal(isLeafDue(row.cert, row.names, Date.now()), row.isDue, row.name);
});

test("the monitor reissues a leaf as far ahead of expiry as the CLI and the updater do", async () => {
  const library = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "lib", "ga-remote.sh");
  const { stdout } = await promisify(execFile)("/bin/bash", ["-c", 'source "$1" && printf "%s" "${GA_REMOTE_REISSUE_AHEAD_SECONDS}"', "_", library]);
  assert.equal(Number(stdout) * 1000, LEAF_REISSUE_AHEAD_MS);
});
