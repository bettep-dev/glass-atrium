// Unit tests for the external-surface path resolvers in routes/model-config.ts
// (getDaemonConfigPath / getApplyLockPath). These are pure string builders — no DB, no
// filesystem read — so they carry no before()/DB setup, unlike model-config.route.test.ts.
// Guards the data-separation seam: the daemon-config + apply-lock stores default under
// ~/.glass-atrium/data, NOT the legacy ~/.claude/data the migration emptied.
//
// Runner: npx tsx --test test/model-config.paths.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";

import { getApplyLockPath, getDaemonConfigPath } from "../src/server/routes/model-config.js";

// undefined restores the "unset" state so a saved-absent seam is cleared, not blanked to "".
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

test("daemon-config + apply-lock default under ~/.glass-atrium/data, off the legacy ~/.claude", () => {
  const saved = {
    daemon: process.env.MODEL_CONFIG_DAEMON_CONFIG_PATH,
    lock: process.env.MODEL_CONFIG_APPLY_LOCK_PATH,
    root: process.env.GA_DATA_ROOT,
  };
  const legacy = `${path.sep}.claude${path.sep}`;
  try {
    delete process.env.MODEL_CONFIG_DAEMON_CONFIG_PATH;
    delete process.env.MODEL_CONFIG_APPLY_LOCK_PATH;
    delete process.env.GA_DATA_ROOT;

    assert.strictEqual(
      getDaemonConfigPath(),
      path.join(homedir(), ".glass-atrium", "data", "daemon-config.json"),
    );
    assert.strictEqual(
      getApplyLockPath(),
      path.join(homedir(), ".glass-atrium", "data", "daemon-reports", ".apply-lock"),
    );
    assert.ok(!getDaemonConfigPath().includes(legacy), "daemon-config default off ~/.claude");
    assert.ok(!getApplyLockPath().includes(legacy), "apply-lock default off ~/.claude");
  } finally {
    restoreEnv("MODEL_CONFIG_DAEMON_CONFIG_PATH", saved.daemon);
    restoreEnv("MODEL_CONFIG_APPLY_LOCK_PATH", saved.lock);
    restoreEnv("GA_DATA_ROOT", saved.root);
  }
});

test("GA_DATA_ROOT redirects the root (parity with the shell/py ga_paths seam)", () => {
  const saved = {
    daemon: process.env.MODEL_CONFIG_DAEMON_CONFIG_PATH,
    lock: process.env.MODEL_CONFIG_APPLY_LOCK_PATH,
    root: process.env.GA_DATA_ROOT,
  };
  try {
    delete process.env.MODEL_CONFIG_DAEMON_CONFIG_PATH;
    delete process.env.MODEL_CONFIG_APPLY_LOCK_PATH;
    process.env.GA_DATA_ROOT = "/tmp/ga-root-sentinel";

    assert.strictEqual(
      getDaemonConfigPath(),
      path.join("/tmp/ga-root-sentinel", "data", "daemon-config.json"),
    );
    assert.strictEqual(
      getApplyLockPath(),
      path.join("/tmp/ga-root-sentinel", "data", "daemon-reports", ".apply-lock"),
    );
  } finally {
    restoreEnv("MODEL_CONFIG_DAEMON_CONFIG_PATH", saved.daemon);
    restoreEnv("MODEL_CONFIG_APPLY_LOCK_PATH", saved.lock);
    restoreEnv("GA_DATA_ROOT", saved.root);
  }
});

test("a per-path override wins over both the default and GA_DATA_ROOT", () => {
  const saved = {
    daemon: process.env.MODEL_CONFIG_DAEMON_CONFIG_PATH,
    lock: process.env.MODEL_CONFIG_APPLY_LOCK_PATH,
    root: process.env.GA_DATA_ROOT,
  };
  try {
    process.env.GA_DATA_ROOT = "/tmp/ga-root-sentinel";
    process.env.MODEL_CONFIG_DAEMON_CONFIG_PATH = "/tmp/explicit-daemon-config.json";
    process.env.MODEL_CONFIG_APPLY_LOCK_PATH = "/tmp/explicit.apply-lock";

    assert.strictEqual(getDaemonConfigPath(), "/tmp/explicit-daemon-config.json");
    assert.strictEqual(getApplyLockPath(), "/tmp/explicit.apply-lock");
  } finally {
    restoreEnv("MODEL_CONFIG_DAEMON_CONFIG_PATH", saved.daemon);
    restoreEnv("MODEL_CONFIG_APPLY_LOCK_PATH", saved.lock);
    restoreEnv("GA_DATA_ROOT", saved.root);
  }
});
