// Shared number and date forms in public/src/ui.jsx — one way to write a percentage, a decimal, a day and a day + time.
import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { buildUiSandbox } from "./client-sandbox.js";

interface UiSurface {
  formatPct: (value: number | null, fixedDigits?: number) => string;
  formatDecimal: (value: number | null, fixedDigits?: number) => string;
  formatKstDay: (iso: string | null) => string;
  formatKstDateTime: (iso: string | null) => string;
  formatUsdCompact: (value: number) => string;
  setDisplayTimezone: (tz: string) => void;
}

const UI = await buildUiSandbox<UiSurface>();

describe("percentage form", () => {
  const rows = [
    { name: "a whole value drops its .0", value: 100, text: "100%" },
    { name: "a fraction keeps one decimal", value: 3.14, text: "3.1%" },
    { name: "a value rounding to a whole drops its .0", value: 11.96, text: "12%" },
    { name: "an exact zero reads 0%", value: 0, text: "0%" },
    { name: "a non-zero value rounding to 0.0 never reads as zero", value: 0.04, text: "<0.1%" },
    { name: "a value under 100 rounding to 100.0 never reads as whole", value: 99.97, text: ">99.9%" },
  ];
  for (const row of rows) {
    test(`a stat percentage carries at most one decimal: ${row.name}`, () => {
      assert.equal(UI.formatPct(row.value), row.text);
    });
  }

  test("a table column fixes its decimals, so every cell of the column has the same precision", () => {
    assert.deepEqual([100, 98.4, 0].map((value) => UI.formatPct(value, 1)), ["100.0%", "98.4%", "0.0%"]);
  });
});

describe("decimal form", () => {
  const rows = [
    { name: "a whole average drops its .0", value: 4.0, text: "4" },
    { name: "a fractional average keeps one decimal", value: 12.46, text: "12.5" },
    { name: "a large average takes thousands separators", value: 1234.56, text: "1,234.6" },
  ];
  for (const row of rows) {
    test(`an average carries at most one decimal: ${row.name}`, () => {
      assert.equal(UI.formatDecimal(row.value), row.text);
    });
  }

  test("a table column fixes its decimals", () => {
    assert.deepEqual([4, 12.46].map((value) => UI.formatDecimal(value, 1)), ["4.0", "12.5"]);
  });
});

describe("money form", () => {
  const rows = [
    { name: "under $100 keeps cents", value: 35.06, text: "$35.06" },
    { name: "$100 and over drops cents", value: 1103.69, text: "$1,104" },
  ];
  for (const row of rows) {
    test(`a compact amount: ${row.name}`, () => {
      assert.equal(UI.formatUsdCompact(row.value), row.text);
    });
  }
});

describe("day and day + time forms in the display zone", () => {
  // 2026-11-14T15:20Z is 11-15 00:20 in Asia/Seoul — the day turns over in the zone, not in UTC
  const iso = "2026-11-14T15:20:00Z";

  test("a timestamp's day is MM-DD in the display zone", () => {
    UI.setDisplayTimezone("Asia/Seoul");
    assert.equal(UI.formatKstDay(iso), "11-15");
  });

  test("a server day key is already a display-zone day and keeps its own month and day", () => {
    UI.setDisplayTimezone("America/Los_Angeles");
    assert.equal(UI.formatKstDay("2026-11-14"), "11-14");
    UI.setDisplayTimezone("Asia/Seoul");
  });

  test("day + time is MM-DD HH:mm, 24-hour, with the day form's separator", () => {
    UI.setDisplayTimezone("Asia/Seoul");
    assert.equal(UI.formatKstDateTime(iso), "11-15 00:20");
    assert.equal(UI.formatKstDateTime(iso).slice(0, 5), UI.formatKstDay(iso));
  });
});
