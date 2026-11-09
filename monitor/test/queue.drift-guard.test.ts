// Owner queue format-drift guard: the keyed streaming bundle-literal check that switches socket delivery on and off.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/queue.drift-guard.test.ts
// Every fixture install carries its own version → drift-check rows other files write are never read or touched.

import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import "dotenv/config";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { BUNDLE_LITERALS, createDriftGuard } from "../src/server/queue/drift-guard.js";
import { type BundleFixture, createBundleFixture, hasRun, writeBundle, writePackageVersion } from "./lib/claude-bundle-fixture.js";
import { deleteDirectory } from "./lib/remove-dir.js";

const fixtureRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "queue-drift-")));
const versions: string[] = [];

after(async () => {
  await getPrisma().queueDriftCheck.deleteMany({ where: { version: { in: versions } } });
  await disconnectPrisma();
  deleteDirectory(fixtureRoot);
});

function newVersion(): string {
  const version = `9.9.9-test.${randomUUID().slice(0, 8)}`;
  versions.push(version);
  return version;
}

function setupInstall(parts: string[] = [...BUNDLE_LITERALS]): BundleFixture {
  const fixture = createBundleFixture(path.join(fixtureRoot, randomUUID().slice(0, 8)), newVersion());
  writeBundle(fixture, parts);
  return fixture;
}

/** A guard over the fixture whose switch writes go to `history`, so each check's transitions are visible. */
function buildGuard(fixture: BundleFixture, chunkBytes?: number): { check: () => Promise<void>; history: boolean[] } {
  const history: boolean[] = [];
  const guard = createDriftGuard({ claudePath: fixture.claudePath, now: () => new Date(), setDeliveryOn: (isOn) => history.push(isOn), chunkBytes });
  return { check: () => guard.check(), history };
}

function getLatest(history: boolean[]): boolean | undefined {
  return history.at(-1);
}

// Same size, same mtime, every literal broken → only a scan could notice
function breakLiteralsInPlace(fixture: BundleFixture): void {
  const { mtime } = statSync(fixture.binaryPath);
  let content = readFileSync(fixture.binaryPath, "utf8");
  for (const literal of BUNDLE_LITERALS) content = content.replaceAll(literal, "#".repeat(literal.length));
  writeFileSync(fixture.binaryPath, content);
  utimesSync(fixture.binaryPath, mtime, mtime);
}

describe("bundle-literal check", () => {
  const rows = [
    { name: "every literal present", parts: [...BUNDLE_LITERALS], isOn: true, result: "pass" },
    ...BUNDLE_LITERALS.map((missing) => ({ name: `missing ${missing}`, parts: BUNDLE_LITERALS.filter((literal) => literal !== missing), isOn: false, result: "fail" })),
  ];
  for (const row of rows) {
    test(`socket delivery follows the scan and the stored row records it: ${row.name}`, async () => {
      const fixture = setupInstall(row.parts);
      const { check, history } = buildGuard(fixture);

      await check();

      assert.equal(getLatest(history), row.isOn, row.name);
      const version = JSON.parse(readFileSync(fixture.packageJsonPath, "utf8")).version;
      const stored = await getPrisma().queueDriftCheck.findUniqueOrThrow({ where: { version } });
      const stats = statSync(fixture.binaryPath);
      assert.deepEqual(
        [stored.binaryRealpath, stored.binarySize, stored.binaryModifiedAt.getTime(), stored.bundleResult, stored.canaryResult],
        [fixture.binaryPath, BigInt(stats.size), stats.mtime.getTime(), row.result, null],
        row.name,
      );
      assert.equal(hasRun(fixture), false, "the guard never runs the claude binary");
    });
  }

  test("a literal split across a chunk boundary is found", async () => {
    const fixture = setupInstall();
    const content = readFileSync(fixture.binaryPath);
    const literal = Buffer.from("peer_message_status");
    const chunkBytes = content.indexOf(literal) + Math.floor(literal.length / 2);

    const { check, history } = buildGuard(fixture, chunkBytes);
    await check();

    assert.equal(getLatest(history), true);
  });

  test("an unreadable key turns socket delivery off", async () => {
    const rows = [
      { name: "no package.json version", breakInstall: (fixture: BundleFixture) => writeFileSync(fixture.packageJsonPath, "{}") },
      { name: "binary removed", breakInstall: (fixture: BundleFixture) => rmSync(fixture.binaryPath) },
    ];
    for (const row of rows) {
      const fixture = setupInstall();
      row.breakInstall(fixture);
      const { check, history } = buildGuard(fixture);

      await check();

      assert.deepEqual(history, [false], row.name);
    }
  });
});

describe("bundle key", () => {
  test("an unchanged key skips the scan, within a run and after a restart", async () => {
    const fixture = setupInstall();
    const first = buildGuard(fixture);
    await first.check();
    breakLiteralsInPlace(fixture);

    await first.check();
    const restarted = buildGuard(fixture);
    await restarted.check();

    assert.equal(getLatest(first.history), true, "same run: the stored pass stands");
    assert.equal(getLatest(restarted.history), true, "restart: the stored row for the key is reused");
  });

  test("the version from the package.json two levels above the binary's realpath re-keys the check", async () => {
    const fixture = setupInstall();
    const { check, history } = buildGuard(fixture);
    await check();
    breakLiteralsInPlace(fixture);
    const nextVersion = newVersion();
    writePackageVersion(fixture, nextVersion);

    await check();

    assert.equal(getLatest(history), false, "the new version's scan sees the broken literals");
    const stored = await getPrisma().queueDriftCheck.findUniqueOrThrow({ where: { version: nextVersion } });
    assert.equal(stored.bundleResult, "fail");
  });

  test("a key change mid-run turns delivery off at once and back on only after the new key's scan passes", async () => {
    const fixture = setupInstall();
    const { check, history } = buildGuard(fixture);
    await check();

    writeBundle(fixture, BUNDLE_LITERALS.slice(1));
    await check();
    await check();
    const whileFailing = [...history];
    writeBundle(fixture, [...BUNDLE_LITERALS, "-- updated in place"]);
    await check();

    assert.deepEqual(whileFailing, [false, true, false, false], "first scan, then the failing key: off at once and kept off");
    assert.deepEqual(history.slice(whileFailing.length), [false, true], "the passing key: off until its scan passes");
  });
});
