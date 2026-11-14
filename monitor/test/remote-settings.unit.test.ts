// Remote access settings from the rendered env: only the exact on value turns it on; anything missing or malformed is off.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { getRemoteSettings } from "../src/server/remote/settings.js";

const MONITOR_PORT = 16145;
const ON = { ATRIUM_REMOTE_ACCESS: "on", ATRIUM_REMOTE_PORT: "16146", ATRIUM_REMOTE_TRUSTED_NETWORKS: "192.168.0.1@50:0e:a5:07:1c:f2" };

describe("turning remote access on", () => {
  const rows = [
    { name: "exact on value with a valid port", env: ON, enabled: true },
    { name: "table removed: no keys at all", env: {}, enabled: false },
    { name: "explicit off value", env: { ...ON, ATRIUM_REMOTE_ACCESS: "off" }, enabled: false },
    { name: "near-miss on value", env: { ...ON, ATRIUM_REMOTE_ACCESS: "ON " }, enabled: false },
    { name: "boolean-looking value", env: { ...ON, ATRIUM_REMOTE_ACCESS: "true" }, enabled: false },
    { name: "port missing", env: { ...ON, ATRIUM_REMOTE_PORT: undefined }, enabled: false },
    { name: "port not an integer", env: { ...ON, ATRIUM_REMOTE_PORT: "16146.5" }, enabled: false },
    { name: "privileged port", env: { ...ON, ATRIUM_REMOTE_PORT: "443" }, enabled: false },
    { name: "port out of range", env: { ...ON, ATRIUM_REMOTE_PORT: "70000" }, enabled: false },
    { name: "the loopback monitor's own port", env: { ...ON, ATRIUM_REMOTE_PORT: String(MONITOR_PORT) }, enabled: false },
  ];
  for (const row of rows) {
    test(row.name, () => {
      assert.equal(getRemoteSettings(row.env, MONITOR_PORT).enabled, row.enabled);
    });
  }

  test("an on setting carries its port", () => {
    assert.equal(getRemoteSettings(ON, MONITOR_PORT).port, 16146);
  });
});

describe("trusted networks", () => {
  const rows = [
    {
      name: "every well-formed gateway@hardware entry, hardware address normalized",
      list: "192.168.0.1@50:E:A5:7:1C:F2, 10.20.0.1@a4:5e:60:11:22:33",
      expected: [
        { gateway: "192.168.0.1", hardwareAddress: "50:0e:a5:07:1c:f2" },
        { gateway: "10.20.0.1", hardwareAddress: "a4:5e:60:11:22:33" },
      ],
    },
    {
      name: "a malformed entry is dropped and the rest kept",
      list: "192.168.0.1@50:0e:a5:07:1c:f2,router@50:0e:a5:07:1c:f2,10.0.0.1@zz:00:00:00:00:00,10.0.0.1",
      expected: [{ gateway: "192.168.0.1", hardwareAddress: "50:0e:a5:07:1c:f2" }],
    },
    { name: "an empty list trusts nothing", list: "", expected: [] },
  ];
  for (const row of rows) {
    test(row.name, () => {
      assert.deepEqual(getRemoteSettings({ ...ON, ATRIUM_REMOTE_TRUSTED_NETWORKS: row.list }, MONITOR_PORT).trusted, row.expected);
    });
  }
});
