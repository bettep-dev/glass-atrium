// Remote listener transport: HTTPS only on the address it is given, and a silent leaf reissue on the open listener.
// Binds only 127.0.0.1 on an ephemeral port — the stand-in for the Wi-Fi address.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";

import type { FastifyInstance } from "fastify";

import { buildRemoteApp } from "../src/server/app.js";
import { disconnectPrisma } from "../src/server/db.js";
import { type RemoteTls, setRemoteCertificate } from "../src/server/remote/listener.js";
import { getRouteClass } from "../src/server/remote/route-classes.js";
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
async function openStandIn(tls: RemoteTls): Promise<{ app: FastifyInstance; port: number }> {
  let port = 0;
  const getHosts = () => new Set([`${STAND_IN}:${port}`]);
  const getPageOrigins = () => new Set([`https://${STAND_IN}:${port}`]);
  const app = await buildRemoteApp({
    tls,
    listener: { kind: "remote", getHosts, getPageOrigins },
    gate: {
      getHosts,
      getPageOrigins,
      findDevice: async () => null,
      getRouteClass,
      preAuthRoutes: new Set(),
      audit: { insertIntent: async () => 1n, setResult: async () => undefined, insertEvent: async () => undefined },
    },
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
