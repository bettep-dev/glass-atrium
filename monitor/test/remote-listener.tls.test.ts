// Remote listener transport: HTTPS only on the address it is given, and a silent leaf reissue on the open listener.
// Binds only 127.0.0.1 on an ephemeral port — the stand-in for the Wi-Fi address.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate, randomBytes } from "node:crypto";
import http from "node:http";
import { createServer } from "node:net";
import https from "node:https";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { type PeerCertificate, type TLSSocket, checkServerIdentity as checkTlsIdentity } from "node:tls";

import type { FastifyInstance } from "fastify";

import { buildRemoteApp } from "../src/server/app.js";
import { disconnectPrisma } from "../src/server/db.js";
import { DeviceConnections } from "../src/server/remote/connections.js";
import type { DeviceSummary } from "../src/server/remote/devices.js";
import { type RemoteTls, setRemoteCertificate } from "../src/server/remote/listener.js";
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
    hostName: "owner-mac.local",
    gate: {
      findDevice: async () => null,
      audit: { insertIntent: async () => 1n, setResult: async () => undefined, insertEvent: async () => undefined },
      connections: new DeviceConnections(),
    },
    registration: { codes: new RegistrationCodes(), createDevice: async () => ({ outcome: "cap_reached" }) },
  });
  const first = await open(STAND_IN, tls);
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
  const reopened = await open(STAND_IN, tls);
  await reopened.close();
});
