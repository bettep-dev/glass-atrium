// E2E chromium harness for the Queue page (screens/queue.jsx): the page's real bundle on mockup v5's fixture data,
// and the frame-independent facts every page stream keeps.
//
// Runner: npx tsx --test test/queue.render-structure.e2e.test.ts
// Prereqs (unmet → RED, no skip guard): `npm run build:jsx`, installed chromium, CDN network (React and the fonts).
// Captures: QUEUE_SHOTS_DIR (absolute) names a folder that keeps them; unset → a fresh mktemp folder, removed when its test ends.
// Harness: test/lib/queue-render-harness.ts; a queue read with no fixture route answers 404 and is recorded.

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import type { Locator, Page } from "playwright";

import {
  DONE_IDS, EDGE_IDS, EDGE_LONG_SESSION_NAME, EDGE_LONG_TITLE, EDGE_SESSION_IDS, FIXTURE_IMAGES,
  FIXTURE_ORDER_TEXT, FIXTURE_SESSION_IDS, getArrivalFixture, getConfusableNameFixture, CONFUSABLE_SESSION_ID, getDoneFixture, getDoneOnlyFixture, getDoneRelaysFixture, getEdgeFixture, getManyDoneFixture, getEmptyFixture, getNameColumnFixture, getOffViewFixture,
  getNotListeningEdgeFixture, getNotListeningFixture, getNotReceivedFixture, getOrderFirstFixture, getProseFixture, getRailFixture, getRelayListFixture, getRelayRecordFixture, getRelayRowFixture, getRestFixture, getStoppedFixture,
  FORWARDED_RELAY, NOT_LISTENING_IDS, RELAY_ROW_IDS, NOT_LISTENING_SESSION_IDS,
  getScanApprovalFixture, SCAN_GONE_FACTS, SCAN_IDS, SCAN_MARK_POINTS,
} from "./lib/queue-render-fixtures.js";
import {
  addOrderFiles, ANSWER_STATES, arriveItem, arriveOffView, askRedaction, closeHarness, confirmRedaction, DESK_WIDTHS, focusByKeyboard, getButtonFacts, getComposerFacts, getDeskFacts, getFocusRing, getHeadEnd, getHeadHeights, getIconLooks, getImageFile, getListFacts, getPngSize, getRailColumnFacts, getRankLook, getRestReadyText, getRingToken, getSelfNamedFixture, getSettledLook, getSheetFacts, getShotsDir, getStartDirectoryFixture, getTintFills, getTokenPaint, type Harness, MARKUP_BODY, MARKUP_TITLE, MIN_WINDOW, openEdgePage, openEndedBand, openHarness, openQueuePage, ORDER_BOX_ID, ORDER_TO, ORDERS, OWNER_WINDOW, PARTLY_REDACTED_LINE, pickWithNote, type QueueState, readQueueState, READY_TIMEOUT_MS, refuseOneRedaction, selectProseRow, selectRow, setFiles, SHELL_INLINE, showAnswerImages, showMoreDone, showSheetEnd, showThreadText, tickOrdersTo, tickSessions, type Viewport, VIEWPORTS, waitForAllOrders, waitForDoneBands, waitForImages,
} from "./lib/queue-render-harness.js";

describe("queue page on the mockup fixtures", () => {
  let harness: Harness;

  before(async () => {
    harness = await openHarness();
  });

  after(() => closeHarness(harness));

  test("every queue read the page makes at rest is answered by a fixture route", async () => {
    harness.fixture = getRestFixture();
    harness.missedReads.length = 0;
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await page.close();

    assert.deepEqual(harness.missedReads, []);
  });

  test("text a session wrote renders as text: its markup shows literally and adds no element", async () => {
    const rest = getRestFixture();
    const [report] = rest.items;
    harness.fixture = { ...rest, items: [{ ...report!, title: MARKUP_TITLE, body: MARKUP_BODY }] };
    const page = await openQueuePage(harness, VIEWPORTS[0], MARKUP_TITLE);
    await selectRow(page, report!.id);
    const found = await page.evaluate(() => ({
      probes: document.querySelectorAll("[data-markup-probe]").length,
      hasRun: (window as unknown as { __markupRan?: boolean }).__markupRan === true,
      hasBodyText: document.body.innerText.includes("<img data-markup-probe"),
    }));
    await page.close();

    assert.deepEqual(found, { probes: 0, hasRun: false, hasBodyText: true });
  });

  // spec §5 → Where it renders: a fence over 20 lines folds on a report, never on an open decision (C-no-fold-on-decisions)
  test("a report's 30-line fence folds under Show all 30 lines; an open approval-class decision's shows every line", async () => {
    harness.fixture = getProseFixture();
    const read = async (id: number) => {
      const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture));
      await showSheetEnd(page, id, ".queue-sheet .prose-pre");
      const found = await page.evaluate(() => ({
        folds: [...document.querySelectorAll<HTMLElement>(".queue-sheet .prose-fold summary")].map((summary) => summary.innerText.trim()),
        lines: [...document.querySelectorAll<HTMLElement>(".queue-sheet .prose-pre")].map((pre) => pre.innerText.split("\n").length),
      }));
      await page.close();
      return found;
    };
    const report = await read(101);
    const decision = await read(103);

    assert.deepEqual({ report, decision }, { report: { folds: ["Show all 30 lines"], lines: [20] }, decision: { folds: [], lines: [30] } });
  });

  // spec §5 → As sent, §9.9: the sender's Markdown is its own characters, and the label says so before the text starts (C-relay-as-sent)
  test("a relay holding every block form is one pre-wrap text node on its sheet, in the sheet's 15 / 24 type, under the shown-as-sent cue", async () => {
    harness.fixture = getProseFixture();
    const relay = harness.fixture.items.find((item) => item.id === RELAY_ROW_IDS.one);
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture));
    await selectRow(page, RELAY_ROW_IDS.one);
    await page.locator(".queue-sheet .card-foot", { hasText: "Read-only." }).waitFor();
    const found = await page.evaluate(() => {
      const texts = [...document.querySelectorAll<HTMLElement>(".queue-sheet .prose-text--as-sent")];
      const style = getComputedStyle(texts[0] as HTMLElement);
      return {
        count: texts.length, nodes: [...(texts[0]?.childNodes ?? [])].map((node) => node.nodeName), text: texts[0]?.textContent,
        type: [style.whiteSpace, style.fontSize, style.lineHeight, texts[0]?.dir],
        parsed: document.querySelectorAll(".queue-sheet-body :is(h4, h5, table, blockquote, hr, pre, ul, ol, img)").length,
        label: [...document.querySelectorAll<HTMLElement>(".queue-sheet-body p")].find((line) => line.innerText.startsWith("What "))?.innerText,
      };
    });
    await page.close();

    assert.deepEqual(found, {
      count: 1, nodes: ["#text"], text: relay?.body, type: ["pre-wrap", "15px", "24px", "auto"], parsed: 0, label: "What aidl wrote · shown as sent",
    });
  });

  // spec §5 → One container (C-names-and-mimicry): the page's own parts never sit in, or dress as, the text a session wrote
  test("the Options legend, the Recommended badge, the approval line and Your answer stand outside the prose container and take no prose class", async () => {
    harness.fixture = getProseFixture();
    const read = async (id: number, parts: string[]) => {
      const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture));
      await selectProseRow(page, id);
      const found = await page.evaluate((names) => names.map((name) => {
        const part = name === "Approval" ? document.querySelector(".queue-sheet .queue-approval-line")
          : [...document.querySelectorAll(".queue-sheet *")].filter((node) => node.textContent?.trim() === name).at(-1);
        const classes = part ? [part, ...part.querySelectorAll("*")].flatMap((node) => [...node.classList]) : [];
        return { name, isFound: part !== undefined && part !== null, isInProse: part?.closest(".prose-text") != null, proseClasses: classes.filter((name) => name.startsWith("prose-")) };
      }), parts);
      await page.close();
      return found;
    };
    const decision = await read(103, ["Options", "Recommended", "Approval"]);
    const answered = await read(108, ["Your answer"]);

    assert.deepEqual([...decision, ...answered], ["Options", "Recommended", "Approval", "Your answer"].map((name) => ({ name, isFound: true, isInProse: false, proseClasses: [] })));
  });

  // layout §6 → Gone: a relay is a row and its sheet → no route serves the relay signal or a single item, so a read of either is a missed read
  test("no element reads Relay history, and the page reads neither the relay signal nor a single item at rest, on its tick or on a relay's sheet", async () => {
    harness.fixture = getRelayRecordFixture();
    harness.missedReads.length = 0;
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture), true);
    await page.clock.fastForward(15_000);
    await selectRow(page, FORWARDED_RELAY[0]!.id);
    await page.locator(".queue-sheet .card-foot .queue-note").waitFor();
    const named = await page.getByText(/Relay history/).count();
    await page.close();

    assert.deepEqual({ named, missedReads: harness.missedReads }, { named: 0, missedReads: [] });
  });

  // layout §6 → Gone: the rail foot holds one button, Automatic resumes
  test("the rail foot holds one button, Automatic resumes, its label on one line inside the foot at every window width, with relays on record", async () => {
    harness.fixture = getRelayRecordFixture();
    const found = [];
    for (const viewport of [MIN_WINDOW, ...VIEWPORTS]) {
      const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
      const buttons = await page.locator(".queue-sessions > .card-foot").evaluate((foot) => {
        const end = foot.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(foot).paddingRight);
        return [...foot.querySelectorAll("button")].map((button) => {
          const range = document.createRange();
          range.selectNodeContents(button);
          // each text box's vertical centre; a glyph and a word on one line sit within a few pixels of each other
          const centres = [...range.getClientRects()].map((rect) => rect.top + rect.height / 2).sort((a, b) => a - b);
          const lines = centres.filter((centre, index) => index === 0 || centre - centres[index - 1]! > 6).length;
          return { label: button.textContent?.trim(), lines, isInside: button.getBoundingClientRect().right <= end + 0.5 };
        });
      });
      await page.close();
      found.push({ width: viewport.width, buttons });
    }

    assert.deepEqual(found, [MIN_WINDOW, ...VIEWPORTS].map(({ width }) => ({
      width,
      buttons: [{ label: "Automatic resumes 2", lines: 1, isInside: true }],
    })));
  });

  // layout §2 → Who: a To line is one line ending in its whole outcome; the place gives way first, its full text in its title
  test("every To line on a relay sheet, on its way, Done or refused, is one line at 1280, 1440 and 1568, its state and outcome whole at its end and a cut place whole in its title", async () => {
    harness.fixture = getRelayListFixture();
    const sheets = [
      { row: `#queue-row-${RELAY_ROW_IDS.several}`, title: "to 3 sessions" },
      { row: `#queue-row-${FORWARDED_RELAY[0]!.id}`, title: "to 2 sessions" },
      { row: '.queue-row[aria-label^="Refused relay"]', title: "Refused relay from" },
    ];
    const found = [];
    for (const viewport of [MIN_WINDOW, VIEWPORTS[0], OWNER_WINDOW]) {
      // an open sheet takes the list's place at 1280 → each sheet from a fresh page
      for (const sheet of sheets) {
        const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
        await waitForDoneBands(page);
        await page.locator(sheet.row).click();
        await page.locator(".queue-sheet-title", { hasText: sheet.title }).waitFor();
        const lines = await page.locator(".queue-sheet .queue-relay-to").evaluateAll((tos) => tos.map((to) => {
          const lineHeight = Number.parseFloat(getComputedStyle(to).lineHeight);
          const place = to.querySelector<HTMLElement>(".queue-relay-place");
          // the line's last part: the recipient's state and its outcome, or a refused end's id
          const end = to.lastElementChild as HTMLElement;
          return {
            isOneLine: to.getBoundingClientRect().height <= lineHeight + 0.5,
            isEndWhole: end.scrollWidth <= end.getBoundingClientRect().width + 0.5 && end.getBoundingClientRect().right <= to.getBoundingClientRect().right + 0.5,
            isPlaceTitled: place === null || place.scrollWidth <= place.clientWidth + 0.5 || place.title === place.textContent,
          };
        }));
        await page.close();
        found.push({ width: viewport.width, title: sheet.title, lines });
      }
    }

    const counts = new Map([["to 3 sessions", 3], ["to 2 sessions", 2], ["Refused relay from", 1]]);
    assert.deepEqual(found, [MIN_WINDOW, VIEWPORTS[0], OWNER_WINDOW].flatMap(({ width }) => sheets.map(({ title }) => ({
      width, title, lines: Array.from({ length: counts.get(title)! }, () => ({ isOneLine: true, isEndWhole: true, isPlaceTitled: true })),
    }))));
  });

  // layout §6 → Order: In delivery reads newest first by its age key, a relay's send, the redacted relay from the relay read among them
  test("In delivery runs newest first by each row's age, the redacted relay from the relay read in its time's place", async () => {
    harness.fixture = getRelayListFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture));
    await waitForDoneBands(page);
    const rows = await page.locator('.queue-listbox [role="group"]', { has: page.locator(".queue-band", { hasText: "In delivery" }) })
      .evaluate((band) => [...band.querySelectorAll(".queue-row")].map((row) => ({
        at: row.querySelector(".queue-row-age")?.getAttribute("title") ?? "",
        isRedacted: row.querySelector(".queue-row-title")?.textContent?.includes("Text redacted") === true,
      })));
    await page.close();

    const ats = rows.map((row) => row.at);
    assert.deepEqual(ats, [...ats].sort().reverse());
    assert.deepEqual([rows.length > 2, rows.filter((row) => row.isRedacted).length], [true, 1]);
  });

  // layout §1 → Reads and Show more: Show more keeps one place at the list's end, a refusal cut's one short line after it
  test("Show more keeps its place and one line at the list's end beside a refusal cut's one short line, at 1280, 1440 and 1568", async () => {
    const found = [];
    for (const isRefusalListCut of [false, true]) {
      harness.fixture = getRelayListFixture(isRefusalListCut);
      for (const viewport of [MIN_WINDOW, VIEWPORTS[0], OWNER_WINDOW]) {
        const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
        await waitForDoneBands(page);
        const end = await page.locator(".queue-list-end").evaluate((line) => {
          const button = line.querySelector("button") as HTMLElement;
          return {
            text: line.textContent,
            height: Math.round(line.getBoundingClientRect().height),
            inset: Math.round(button.getBoundingClientRect().left - line.getBoundingClientRect().left),
            buttonHeight: Math.round(button.getBoundingClientRect().height),
          };
        });
        await page.close();
        found.push({ width: viewport.width, ...end });
      }
    }

    const widths = [MIN_WINDOW, VIEWPORTS[0], OWNER_WINDOW].map(({ width }) => width);
    assert.deepEqual(found, ["Show more", "Show more⚠ Refusals before Nov 13 12:00 not listed."].flatMap((text) => widths.map((width) => ({ width, text, height: 44, inset: 16, buttonHeight: 32 }))));
  });

  test("Redact text in a relay sheet's foot asks over the sheet, centred on its column, with the focus on Cancel; one copy refused keeps the dialog with its count line and the sheet its text and button", async () => {
    harness.fixture = getRelayRecordFixture();
    harness.refusals.clear();
    refuseOneRedaction(harness);
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture));
    await askRedaction(page);
    // the dialog is the sheet's own act → centred on the sheet's column, not on the viewport
    const asked = await page.evaluate(() => {
      const getCentre = (selector: string) => {
        const box = document.querySelector(selector)!.getBoundingClientRect();
        return Math.round(box.left + box.width / 2);
      };
      return { focused: document.activeElement?.textContent, offCentre: getCentre('[role="dialog"]') - getCentre(".queue-sheet") };
    });
    await confirmRedaction(page);
    await page.getByText(PARTLY_REDACTED_LINE).waitFor();
    const sheet = page.locator(".queue-sheet");
    const kept = { button: await sheet.locator(".card-foot .queue-note").getByRole("button", { name: "Redact text" }).count(), text: (await sheet.locator(".prose-text--as-sent").innerText()).includes("파트너 연동") };
    await page.close();
    harness.refusals.clear();

    assert.deepEqual({ ...asked, kept }, { focused: "Cancel", offCentre: 0, kept: { button: 1, text: true } });
  });

  test("a redaction done closes the dialog, puts the redaction line in the text's place and Text redacted on the foot, the focus on the sheet's title, and the row's title reads Text redacted", async () => {
    harness.fixture = getRelayRecordFixture();
    harness.refusals.clear();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture));
    await askRedaction(page);
    await confirmRedaction(page);
    await page.locator(".queue-sheet .card-foot", { hasText: "Text redacted." }).waitFor();
    await page.getByRole("dialog", { name: "Redact this relay's text?" }).waitFor({ state: "detached" });
    const found = await page.evaluate(() => ({
      focused: document.activeElement?.tagName === "H3" ? document.activeElement.textContent : null,
      foot: (document.querySelector<HTMLElement>(".queue-sheet .card-foot")?.innerText ?? "").trim(),
      texts: document.querySelectorAll(".queue-sheet .prose-text--as-sent").length,
      line: [...document.querySelectorAll<HTMLElement>(".queue-sheet-body p")].some((line) => /^Text redacted \S+ \S+ KST · it was [\d,]+ characters long$/.test(line.innerText)),
      marker: document.querySelector(".queue-sheet")?.textContent?.includes("relay text redacted by the owner") ?? true,
    }));
    await page.getByRole("button", { name: /^Back to the list/ }).click();
    const title = await page.locator(`#queue-row-${FORWARDED_RELAY[0]!.id} .queue-row-title`).innerText();
    await page.close();

    assert.deepEqual(
      { ...found, title: title.replace(/\s+/g, " ").trim() },
      { focused: "Message from aidl to 2 sessions", foot: "✓ Text redacted.", texts: 0, line: true, marker: false, title: "→ 2 sessions Text redacted" },
    );
  });

  test("the redaction dialog draws its body at the body size and Cancel then Redact text at the foot's end", async () => {
    harness.fixture = getRelayRecordFixture();
    harness.refusals.clear();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture));
    await askRedaction(page);
    const found = await page.getByRole("dialog", { name: "Redact this relay's text?" }).evaluate((surface) => {
      const foot = surface.querySelector(".detail-foot");
      const buttons = [...(foot?.querySelectorAll("button") ?? [])];
      const footEnd = foot === null ? 0 : foot.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(foot).paddingRight);
      const body = surface.querySelector(".detail-body p");
      return {
        buttons: buttons.map((button) => button.textContent),
        // the panel is centred on a fractional x → the button edge snaps within a pixel of the foot's content end
        isAtEnd: Math.abs(footEnd - (buttons.at(-1)?.getBoundingClientRect().right ?? 0)) < 1,
        bodySize: body === null ? "" : getComputedStyle(body).fontSize,
      };
    });
    await page.close();

    assert.deepEqual(found, { buttons: ["Cancel", "Redact text"], isAtEnd: true, bodySize: "15px" });
  });

  test("the history read pages by order and returns every copy of an order one ticked session received", async () => {
    harness.fixture = getRestFixture();
    const first = await harness.app.inject({ url: `/api/queue/owner/orders?sessionIds=${FIXTURE_SESSION_IDS.aidl}&limit=1` });
    const all = await harness.app.inject({ url: "/api/queue/owner/orders?limit=2" });
    const { nextCursor } = all.json<{ nextCursor: string }>();
    const rest = await harness.app.inject({ url: `/api/queue/owner/orders?limit=30&before=${nextCursor}` });
    const getSendIds = (body: { items: Array<{ sendId: string }> }) => [...new Set(body.items.map((item) => item.sendId))];

    assert.deepEqual(first.json<{ items: Array<{ session: { name: string } }> }>().items.map((item) => item.session.name), ["gersona", "aidl"], "both recipients of the order to aidl");
    const pages = [...getSendIds(all.json()), ...getSendIds(rest.json())];
    assert.equal(new Set(pages).size, pages.length, "no order on two pages");
    assert.equal(pages.length, new Set(getRestFixture().orders.map((order) => order.sendId)).size, "every order on some page");
  });

  test("the desk fills the window with no page scroll, the rail, the middle pane and Orders sized per width step, and an opened row's sheet takes the list's box", async () => {
    harness.fixture = getRestFixture();
    for (const row of DESK_WIDTHS) {
      const page = await openQueuePage(harness, row.viewport, getRestReadyText());
      const rest = await getDeskFacts(page);
      await selectRow(page, 101);
      const opened = await getDeskFacts(page);
      await page.close();
      const size = `${row.viewport.width}x${row.viewport.height}`;
      const middle = row.middle === "page" ? rest.page : row.middle;
      const orders = row.viewport.width - SHELL_INLINE - row.rail - middle - 32;
      assert.ok(orders >= (row.viewport.width < 1440 ? ORDERS.MIN.BELOW_1440 : ORDERS.MIN.FROM_1440), `${size}: Orders ${orders} keeps its minimum`);
      assert.deepEqual([rest.isScrolled, rest.rail?.[1], rest.list?.[1], rest.sheet, rest.orders?.[1]], [false, row.rail, middle, null, orders], `${size} at rest`);
      assert.deepEqual(opened, { ...rest, list: null, sheet: rest.list }, `${size} with a row opened`);
    }
  });

  test("the sheet's text is 15/24 within 66ch, its title 20/28, rows 44, bands 32 on the page ground, and its foot in view", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    const list = await getListFacts(page);
    await selectRow(page, 101);
    const sheet = await getSheetFacts(page);
    await page.close();
    assert.deepEqual({ isRowHeight: list.rowHeights.length > 0 && list.rowHeights.every((height) => height === 44), bands: list.bands }, { isRowHeight: true, bands: ["32 true"] }, String(list.rowHeights));
    assert.deepEqual({ text: sheet.text, title: sheet.title, isFootInView: sheet.isFootInView }, { text: ["15px", "24px", "true"], title: ["20px", "28px"], isFootInView: true });
  });

  // spec §3.2: one page column for head, body and foot, the pane's constant 32 inset on both sides at every width
  test("the sheet's head, date line, title, text, box and note start at one x and end at one x, on gutters of 32, at every desk width", async () => {
    harness.fixture = getRestFixture();
    const columns = [];
    for (const { viewport } of DESK_WIDTHS) {
      const page = await openQueuePage(harness, viewport, getRestReadyText());
      await selectRow(page, 101);
      const { starts, ends, gutters } = await getSheetFacts(page);
      await page.close();
      columns.push({ width: viewport.width, starts: starts.length, ends: ends.length, gutters });
    }

    assert.deepEqual(columns, columns.map(({ width }) => ({ width, starts: 1, ends: 1, gutters: [32, 32] })));
  });

  // spec §4.3 / §14.4: the stepping counts the rows that open on a sheet; an order's row is never on the sheet
  test("the sheet's head says n of m and the item's queue number before the letterhead, previous is off on the first sheet row, J steps over an order's row with item= following, and K comes back", async () => {
    harness.fixture = getOrderFirstFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture));
    const head = () => page.evaluate(() => ({
      hash: window.location.hash,
      position: document.querySelector(".queue-steps > .tabular-nums")?.textContent,
      disabled: [...document.querySelectorAll<HTMLButtonElement>(".queue-steps > .btn")].map((button) => button.disabled),
      tag: document.querySelector(".queue-sheet-head .pill--tag")?.textContent,
      number: document.querySelector(".queue-sheet-head .queue-sheet-id")?.textContent,
      isNumberBeforeLetterhead: (() => {
        const [back, number, letter] = [".queue-back", ".queue-sheet-id", ".queue-letter"].map((selector) => document.querySelector(`.queue-sheet-head ${selector}`)!.getBoundingClientRect());
        return number!.left >= back!.right && number!.right <= letter!.left && number!.top < letter!.bottom && letter!.top < number!.bottom;
      })(),
    }));
    const firstRow = await page.locator(".queue-row").first().getAttribute("id");
    await selectRow(page, 160);
    const first = await head();
    await page.keyboard.press("j");
    const second = await head();
    await page.keyboard.press("k");
    const back = await head();
    await page.close();

    assert.equal(firstRow, "queue-row-109", "the list's first row is an order");
    assert.deepEqual(first, { hash: "#queue?item=160", position: "1 of 2", disabled: [true, false], tag: "Answer", number: "#160", isNumberBeforeLetterhead: true });
    assert.deepEqual(second, { hash: "#queue?item=108", position: "2 of 2", disabled: [false, true], tag: "Answer", number: "#108", isNumberBeforeLetterhead: true });
    assert.equal(back.hash, "#queue?item=160");
  });

  // spec §7, §9.8 → On an answer → Afterwards: the images the session received, the thread's 96 squares under Your answer
  test("an answered decision's row names its images, and its sheet shows them as 96 thumbnails under Your answer that open the viewer", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture));
    const row = await page.locator("#queue-row-108").getAttribute("aria-label");
    await showAnswerImages(page, 108);
    const thumbs = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".queue-sheet .queue-bubble-image")].map((button) => {
      const rect = button.getBoundingClientRect();
      return { label: button.getAttribute("aria-label"), size: [Math.round(rect.width), Math.round(rect.height)] };
    }));
    await page.locator(".queue-sheet .queue-bubble-image").nth(1).click();
    const viewer = (await page.locator(".queue-viewer").innerText()).replace(/\s+/g, " ");
    await page.close();

    assert.match(row ?? "", /2 images/);
    assert.deepEqual(thumbs, [{ label: "Open image 1 of 2: queue-01.webp", size: [96, 96] }, { label: "Open image 2 of 2: queue-02.webp", size: [96, 96] }]);
    assert.match(viewer, /queue-02\.webp · .* · 2 of 2/);
  });

  // spec §3.3 / §14.4: the list keeps its place while a report is read
  test("Back to the list shows the list at the scroll it had, the row just read focused and current, and the hash without item", async () => {
    const page = await openEdgePage(harness);
    const top = await page.evaluate(() => {
      const body = document.querySelector(".queue-list > .card-body") as HTMLElement;
      body.scrollTop = 240;
      return body.scrollTop;
    });
    const row = page.locator(".queue-row").nth(6);
    const id = await row.getAttribute("id");
    await row.click();
    await page.getByRole("button", { name: "Back to the list" }).click();
    const back = await page.evaluate(() => ({
      top: (document.querySelector(".queue-list > .card-body") as HTMLElement).scrollTop,
      focus: document.activeElement?.id,
      current: [...document.querySelectorAll('[role="option"][aria-selected="true"]')].map((option) => option.id),
      hash: window.location.hash,
      isSheet: document.querySelector(".queue-sheet") !== null,
    }));
    await page.close();

    assert.ok(top > 0, "the edge list scrolls");
    assert.deepEqual(back, { top, focus: id, current: [id], hash: "#queue", isSheet: false });
  });

  // spec §3.2 / §4.2: the list shares the fixed middle pane → never wide enough for another row form
  test("list rows are 44 high at every desk width, 2560 included", async () => {
    harness.fixture = getRestFixture();
    const heights = [];
    for (const { viewport } of DESK_WIDTHS) {
      const page = await openQueuePage(harness, viewport, getRestReadyText());
      const { rowHeights } = await getListFacts(page);
      await page.close();
      heights.push({ width: viewport.width, isRowHeight: rowHeights.length > 0 && rowHeights.every((height) => height === 44), rowHeights });
    }

    assert.deepEqual(heights.filter((row) => !row.isRowHeight), []);
  });

  // one sender reads as one name on every row; a name the session wrote takes the mark whole beside it, outside the cut, its words in the tooltips;
  // the fixture's longest name, nine letters, self-named on relay 421 → name and mark still whole in the name column, every title on one x
  test("a sender's name paints the same on its decision, refused and relay rows at 1280, 1440 and 1568, and every self-named row of any kind adds the whole self mark, a nine-letter name whole beside it and every title on one x", async () => {
    harness.fixture = getStartDirectoryFixture(getSelfNamedFixture(getRelayListFixture(true), RELAY_ROW_IDS.one, "dashboard"), "aidl");
    const shown = [];
    for (const viewport of [MIN_WINDOW, VIEWPORTS[0], OWNER_WINDOW]) {
      const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
      await waitForDoneBands(page);
      const rows = await page.evaluate(() => [...document.querySelectorAll(".queue-row")].flatMap((row) => {
        const name = row.querySelector<HTMLElement>(".queue-row-name");
        if (name === null) return [];
        const mark = row.querySelector<HTMLElement>(".queue-row-mark");
        const who = row.querySelector(".queue-row-who")!.getBoundingClientRect();
        const isWhole = (cell: HTMLElement) => cell.scrollWidth <= cell.clientWidth && cell.getBoundingClientRect().right <= who.right + 0.5;
        return [{
          name: name.textContent, painted: isWhole(name) ? name.textContent : "cut", isSelfNamed: name.title.endsWith(" (self-named)"),
          mark: mark && { text: mark.textContent, tip: mark.title, isHidden: mark.getAttribute("aria-hidden") === "true", isWhole: isWhole(mark) && !name.contains(mark) },
          label: [" to ", ": "].some((end) => row.getAttribute("aria-label")?.includes(`from ${name.title}${end}`)),
          titleAt: Math.round(row.querySelector(".queue-row-title")!.getBoundingClientRect().left),
        }];
      }));
      await page.close();
      shown.push({ width: viewport.width, rows });
    }

    const byName = shown.flatMap(({ width, rows }) => [...new Set(rows.map((row) => row.name))].map((name) => ({ width, name, painted: [...new Set(rows.filter((row) => row.name === name).map((row) => row.painted))] })));
    assert.ok(shown.every(({ rows }) => rows.some((row) => row.name === "dashboard" && row.isSelfNamed) && rows.some((row) => row.name === "aidl" && !row.isSelfNamed)), "each width paints the self-named nine-letter name and a start-directory name");
    assert.deepEqual(shown.map(({ width, rows }) => ({ width, titleAts: new Set(rows.map((row) => row.titleAt)).size })), shown.map(({ width }) => ({ width, titleAts: 1 })), "every title on one x");
    assert.deepEqual(byName.filter(({ painted }) => painted.length > 1 || painted[0] === "cut"), [], "a sender's name paints whole and alike on every row");
    assert.deepEqual(
      shown.flatMap(({ width, rows }) => rows.map((row) => ({ width, mark: row.mark, label: row.label }))),
      shown.flatMap(({ width, rows }) => rows.map((row) => ({ width, mark: row.isSelfNamed ? { text: "self", tip: "self-named", isHidden: true, isWhole: true } : null, label: true }))),
    );
  });

  // spec §4.2: who, then what — the queue number, then the session name in one fixed column, the title and its meta line to its right
  test("with exactly one session ticked no row paints a name: every number starts where the band labels start, every title one 40 column and its 8 gap after it", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await tickSessions(page, ["gersona"]);
    const facts = await page.evaluate(() => {
      const band = document.querySelector(".queue-listbox .queue-band") as HTMLElement;
      const labelStart = Math.round(band.getBoundingClientRect().left + parseFloat(getComputedStyle(band).paddingLeft));
      const getStarts = (selector: string) => [...document.querySelectorAll(selector)].map((cell) => Math.round(cell.getBoundingClientRect().left));
      const titles = getStarts(".queue-row-title");
      return { names: document.querySelectorAll(".queue-row-who").length, numberStarts: [...new Set(getStarts(".queue-row-id"))], titleStarts: [...new Set(titles)], labelStart, rows: titles.length };
    });
    await page.close();

    assert.ok(facts.rows > 0, "the ticked session has rows");
    assert.deepEqual(
      { names: facts.names, numberStarts: facts.numberStarts, titleStarts: facts.titleStarts },
      { names: 0, numberStarts: [facts.labelStart], titleStarts: [facts.labelStart + 40 + 8] },
    );
  });

  // one session ticked → the sender rides the title cell; a long name the peer gave itself is cut there, never the page's mark beside it
  test("with one session ticked a relay's title cell at 1280 cuts a long self-declared sender name and keeps its self mark whole before the recipient", async () => {
    harness.fixture = getSelfNamedFixture(getRelayRowFixture(), RELAY_ROW_IDS.one, EDGE_LONG_SESSION_NAME);
    const page = await openQueuePage(harness, MIN_WINDOW, getRestReadyText(harness.fixture));
    await tickSessions(page, ["yoaida"]);
    await page.locator(".queue-row-title .queue-row-mark").first().waitFor();
    const cell = await page.evaluate((named) => {
      const name = [...document.querySelectorAll<HTMLElement>(".queue-row-title .queue-row-name")].find((one) => one.title === named)!;
      const title = name.closest(".queue-row-title")!.getBoundingClientRect();
      const mark = name.parentElement!.querySelector<HTMLElement>(".queue-row-mark")!;
      const [nameBox, markBox] = [name.getBoundingClientRect(), mark.getBoundingClientRect()];
      const ends = name.closest(".queue-row-title")!.querySelector<HTMLElement>(".queue-row-ends")!;
      return {
        isNameCut: getComputedStyle(name).textOverflow === "ellipsis" && name.scrollWidth > name.clientWidth,
        mark: { text: mark.textContent, isOutsideName: !name.contains(mark), isWhole: mark.scrollWidth <= mark.clientWidth && markBox.left >= nameBox.right - 0.5 && markBox.right <= title.right + 0.5 },
        ends: { text: ends.textContent?.startsWith("→ yoaida "), isAfterMark: ends.getBoundingClientRect().left >= markBox.right && ends.getBoundingClientRect().width > 0 },
        label: name.closest(".queue-row")!.getAttribute("aria-label")?.replace(/^#\d+, /, "").startsWith(`Relay from ${named} to yoaida: `),
      };
    }, `${EDGE_LONG_SESSION_NAME} (self-named)`);
    await page.close();

    assert.deepEqual(cell, { isNameCut: true, mark: { text: "self", isOutsideName: true, isWhole: true }, ends: { text: true, isAfterMark: true }, label: true });
  });

  // spec §11: the desk's keys on the real page, and the inset ring on the rows the cards clip
  test("J / K move the focus on the list, Enter opens the sheet, J steps it, a digit picks, Esc returns to the row, N puts the caret in Orders and Esc gives the focus back to the middle pane", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    const active = () => page.evaluate(() => {
      const element = document.activeElement as HTMLElement;
      return { id: element.id, tag: element.tagName, inSheet: Boolean(element.closest(".queue-sheet")), offset: getComputedStyle(element).outlineOffset, cls: element.className };
    });
    const rowIds = await page.evaluate(() => [...document.querySelectorAll(".queue-row")].map((row) => row.id));
    await page.focus(`#${rowIds[0]}`);
    await page.keyboard.press("j");
    const stepped = { ...(await active()), isSheet: await page.locator(".queue-sheet").count() };
    await page.keyboard.press("k");
    await page.keyboard.press("Enter");
    const entered = { ...(await active()), hash: await page.evaluate(() => window.location.hash) };
    await page.keyboard.press("2");
    const picked = await page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>(".queue-sheet input[type=radio]")].findIndex((radio) => radio.checked));
    await page.keyboard.press("j");
    const next = await page.evaluate(() => [window.location.hash, (document.activeElement as HTMLElement).className]);
    await page.keyboard.press("Escape");
    const back = await active();
    await page.focus(".queue-rail-row .ctl-checkbox");
    const rail = await page.evaluate(() => {
      const row = (document.activeElement as HTMLElement).closest(".queue-rail-row") as HTMLElement;
      return { offset: getComputedStyle(row).outlineOffset, style: getComputedStyle(row).outlineStyle };
    });
    await page.keyboard.press("n");
    const box = await active();
    await page.focus(".queue-order");
    await page.keyboard.press("Escape");
    const returned = await active();
    await page.close();

    assert.deepEqual([stepped.id, stepped.isSheet], [rowIds[1], 0], "J focuses the next row and opens nothing");
    assert.deepEqual([entered.inSheet, entered.cls, entered.hash], [true, "card-body", `#queue?item=${rowIds[0]!.slice("queue-row-".length)}`], "Enter opens the row's sheet, the focus on its body");
    assert.equal(picked, 1, "2 picks the second option");
    assert.deepEqual(next, [`#queue?item=${rowIds[1]!.slice("queue-row-".length)}`, "card-body"], "J on the sheet opens the next item, the focus on its body");
    assert.deepEqual([back.id, back.offset], [rowIds[1], "-2px"], "Esc gives the focus back to the row just read, its ring inset");
    assert.deepEqual([rail.style, rail.offset], ["solid", "-2px"], "a focused rail box rings its row, inset");
    assert.equal(box.id, "queue-order-text", "N puts the caret in the order box");
    assert.deepEqual([returned.id, returned.offset], [rowIds[1], "-2px"], "Esc in Orders gives the focus back to the middle pane: the list's current row");
  });

  test("rail rows are 44; Orders is rendered at rest beside the list, and an opened row hides the list alone", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await page.locator(".queue-order").first().waitFor();
    const shown = () => page.evaluate(() => [".queue-list", ".queue-sheet", ".queue-orders"].map((selector) => (document.querySelector(selector)?.getClientRects().length ?? 0) > 0));
    const rest = await shown();
    const railRows = await page.evaluate(() => [...new Set([...document.querySelectorAll(".queue-rail-row")].map((row) => Math.round(row.getBoundingClientRect().height)))]);
    await selectRow(page, 103);
    const opened = await shown();
    await page.close();

    assert.deepEqual(railRows, [44]);
    assert.deepEqual({ rest, opened }, { rest: [true, false, true], opened: [false, true, true] });
  });

  // spec §3.2: one content column from the card's 16 start inset, the whole pane up to 720, the free width at the far end beyond it
  test("Orders' title, day labels, box and note start 16 in, on one column that is the pane less its two 16 insets and never wider than 720, at every desk width", async () => {
    harness.fixture = getRestFixture();
    const columns = [];
    for (const { viewport } of DESK_WIDTHS) {
      const page = await openQueuePage(harness, viewport, getRestReadyText());
      await waitForAllOrders(page);
      const facts = await page.evaluate(() => {
        // offsets from the card's inner edge, inside its 1 px border
        const element = document.querySelector(".queue-orders-card") as HTMLElement;
        const start = element.getBoundingClientRect().left + element.clientLeft;
        const offset = (x: number) => Math.round(x - start);
        const rects = (selector: string) => [...document.querySelectorAll(selector)].map((node) => node.getBoundingClientRect());
        const orders = rects(".queue-order");
        return {
          inner: element.clientWidth,
          starts: [...new Set([".queue-orders-card > .card-head .card-title", ".queue-day", ".queue-orders .queue-compose-box", ".queue-orders .queue-note"].flatMap((selector) => rects(selector).map((rect) => offset(rect.left))))],
          ends: [...new Set([".queue-orders-card > .card-head > .card-head-text", ".queue-orders .queue-compose-row", ".queue-orders .queue-note"].flatMap((selector) => rects(selector).map((rect) => offset(rect.right))).concat(offset(orders[orders.length - 1]!.right)))],
        };
      });
      await page.close();
      columns.push({ width: viewport.width, starts: facts.starts, ends: facts.ends, column: 16 + Math.min(facts.inner - 32, ORDERS.COLUMN_MAX) });
    }

    assert.ok(columns.some(({ column }) => column === 16 + ORDERS.COLUMN_MAX), "a desk width wide enough for the 720 cap");
    assert.deepEqual(columns, columns.map(({ width, column }) => ({ width, starts: [16], ends: [column], column })));
  });

  // spec §9.1: one control per row — the row is its box's label
  test("a rail row holds one interactive element, its checkbox, and no button; a press on its name ticks it and a press on its state mark unticks it", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    const row = page.locator(`[data-session="${FIXTURE_SESSION_IDS.atrium}"]`);
    const controls = await row.evaluate((element) => [...element.querySelectorAll("button, input, a, [tabindex]")].map((control) => `${control.tagName}:${control.getAttribute("type")}`));
    await row.locator(".queue-rail-name").click();
    const ticked = await page.getByLabel("Select atrium").isChecked();
    await row.locator(".queue-rail-mark").click();
    const unticked = await page.getByLabel("Select atrium").isChecked();
    await page.close();

    assert.deepEqual({ controls, ticked, unticked }, { controls: ["INPUT:checkbox"], ticked: true, unticked: false });
  });

  // spec §9.1, §14.3: a department reads left to right on one set of columns — box · state mark · name · tag · count — both bands on them too
  test("every rail row and both bands share the box, mark, name, tag and count columns at 1280, 1440 and 1568, each slot inside its column, All sessions whole, rows one 44 line and bands 32", async (t) => {
    harness.fixture = getRailFixture();
    const shown = [];
    for (const viewport of [MIN_WINDOW, VIEWPORTS[0], OWNER_WINDOW]) {
      const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
      await openEndedBand(page);
      shown.push({ width: viewport.width, ...(await page.evaluate(getRailColumnFacts)) });
      await page.close();
    }

    t.diagnostic(`name column: ${shown.map((at) => `${at.width} → ${at.tracks[0]?.[2]}`).join(" | ")}`);
    assert.deepEqual(shown.map((at) => at.width), [1280, 1440, 1568]);
    for (const at of shown) {
      // the name column takes the rest of the rail (spec §9.1) → its width is the step's, never under the 1280 step's
      assert.deepEqual(
        { starts: at.starts, tracks: at.tracks.map(([box, mark, , tag, count]) => [box, mark, tag, count]), misplaced: at.misplaced, isAllWhole: at.isAllWhole, rows: at.rows, bands: at.bands },
        { starts: 1, tracks: [[24, 8, 16, 36]], misplaced: [], isAllWhole: true, rows: [44], bands: [32] },
        `at ${at.width}`,
      );
      assert.ok((at.tracks[0]?.[2] ?? 0) >= 56, `at ${at.width}: name column ${at.tracks[0]?.[2]}`);
      assert.ok(at.slots.tag > 0 && at.slots.count > 0 && at.lines >= 6, `at ${at.width}: ${JSON.stringify(at.slots)}`);
    }
  });

  // spec §9.1, §14.3: the state mark by shape and colour, the count spec 44084's atom, never solid; no row paints the word Live
  test("a live rail mark is the ok dot and any other a faint ring; every rail count is the tag-fill count atom; no rail row paints Live", async () => {
    harness.fixture = getRailFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture));
    await openEndedBand(page);
    const paints = await Promise.all(["--ok", "--faint"].map((token) => page.evaluate(getTokenPaint, { property: "color" as const, value: `rgb(var(${token}))` })));
    const facts = await page.evaluate(([ok, faint]) => {
      const rows = [...document.querySelectorAll<HTMLElement>(".queue-rail-row")];
      // painted text only: what a screen reader alone hears stays out
      const getPainted = (row: Element) => [...row.querySelectorAll("*")].filter((node) => !node.closest(".sr-only") && node.children.length === 0).map((node) => node.textContent).join(" ");
      return {
        marks: rows.map((row) => {
          const mark = getComputedStyle(row.querySelector(".queue-rail-mark") as Element);
          const isLive = /^(Live|Next turn)/.test(row.title);
          return isLive ? mark.backgroundColor === ok : mark.borderTopColor === faint && mark.backgroundColor === "rgba(0, 0, 0, 0)";
        }),
        kinds: new Set(rows.map((row) => row.querySelector(".queue-rail-mark")?.classList.contains("is-live"))).size,
        counts: [...document.querySelectorAll(".queue-sessions .queue-rail-count .pill")].map((pill) => pill.className),
        solid: document.querySelectorAll(".queue-sessions .pill--solid").length,
        live: rows.filter((row) => /\bLive\b/.test(getPainted(row))).map((row) => row.dataset.session),
      };
    }, paints);
    await page.close();

    assert.equal(facts.kinds, 2, "live and not-live rows are both on the rail");
    assert.ok(facts.counts.length > 0);
    assert.deepEqual(
      { marks: facts.marks.every(Boolean), counts: facts.counts.filter((name) => !/\bpill--tag\b/.test(name) || !/\bpill--num\b/.test(name)), solid: facts.solid, live: facts.live },
      { marks: true, counts: [], solid: 0, live: [] },
    );
  });

  // spec §4.3, §14.4: opening a report changes no tick → the composer's address holds across a press, a step, an order row and the way back
  test("pressing a row, stepping, pressing an order row and Back to the list leave every rail box as it was, and the Orders label line and send button unchanged", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await tickSessions(page, ORDER_TO);
    const read = () => page.evaluate(() => ({
      boxes: [...document.querySelectorAll<HTMLInputElement>(".queue-sessions .ctl-checkbox")].map((box) => `${box.getAttribute("aria-label")}=${box.checked}`),
      label: document.querySelector(".queue-orders .field-label")?.textContent,
      send: [...document.querySelectorAll(".queue-orders .queue-compose-buttons .btn")].map((button) => button.textContent),
    }));
    const before = await read();
    await selectRow(page, 103);
    const opened = await read();
    await page.keyboard.press("j");
    const stepped = await read();
    await page.getByRole("button", { name: "Back to the list" }).click();
    const back = await read();
    await selectRow(page, 109);
    const order = await read();
    await page.close();

    assert.deepEqual(before.boxes.filter((box) => box.endsWith("=true")), ["Select gersona=true", "Select yoaida=true"]);
    assert.equal(before.label, "New order to gersona, yoaida");
    assert.deepEqual({ opened, stepped, back, order }, { opened: before, stepped: before, back: before, order: before });
  });

  // spec §9.1, §14.4 (the fixture: gersona and yoaida ticked while atrium has a report; an order to gersona and the unticked aidl)
  test("with sessions ticked, the list holds their items alone, the thread their orders, the list head and the composer label name exactly them, and the hash holds them in to=", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await tickOrdersTo(page, ORDER_TO);
    await page.locator(".queue-order", { hasText: "aidl" }).first().waitFor();
    const shown = await page.evaluate(() => ({
      rowIds: [...document.querySelectorAll(".queue-row")].map((row) => Number(row.id.slice("queue-row-".length))),
      recipients: [...document.querySelectorAll(".queue-order")].map((entry) => [...entry.querySelectorAll(".queue-recipient-name")].map((name) => name.textContent)),
      head: document.querySelector(".queue-list > .card-head .card-title")?.textContent,
      label: document.querySelector(".queue-orders .field-label")?.textContent,
      hash: window.location.hash,
    }));
    await page.close();

    const sessionOf = (id: number) => harness.fixture.items.find((item) => item.id === id)?.session.name;
    assert.ok(shown.rowIds.length > 0 && shown.rowIds.every((id) => ORDER_TO.includes(sessionOf(id) ?? "")), JSON.stringify(shown.rowIds.map(sessionOf)));
    assert.ok(shown.recipients.every((names) => names.some((name) => ORDER_TO.includes(name ?? ""))), JSON.stringify(shown.recipients));
    assert.ok(shown.recipients.some((names) => names.includes("gersona") && names.includes("aidl")), "an order to a ticked and an unticked session is one entry with both");
    assert.deepEqual([shown.head, shown.label, shown.hash], ["gersona, yoaida", "New order to gersona, yoaida", `#queue?to=${FIXTURE_SESSION_IDS.gersona}%2C${FIXTURE_SESSION_IDS.yoaida}`]);
  });

  // spec §9.2: nothing ticked → everything shown, no one addressed: a send press makes no request
  test("with nothing ticked the list and the thread hold every session's, and a send press makes no request, says what is missing and focuses the rail's first box", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await waitForAllOrders(page);
    const posts: string[] = [];
    page.on("request", (request) => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
    await page.locator(`#${ORDER_BOX_ID}`).fill(FIXTURE_ORDER_TEXT);
    await page.locator(".queue-orders").getByRole("button", { name: "Send order" }).click();
    await page.locator(".queue-orders").getByText("Tick at least one session in the rail.").waitFor();
    const shown = await page.evaluate(() => ({
      rows: document.querySelectorAll(".queue-row").length,
      entries: document.querySelectorAll(".queue-order").length,
      label: document.querySelector(".queue-orders .field-label")?.textContent,
      alert: document.querySelector('.queue-orders [role="alert"]')?.textContent,
      focus: (document.activeElement as HTMLElement).getAttribute("aria-label"),
      first: document.querySelector(".queue-sessions .ctl-checkbox")?.getAttribute("aria-label"),
    }));
    await page.close();

    assert.deepEqual(posts, []);
    assert.deepEqual([shown.rows, shown.entries], [9, 4], "every item row (one per order) and every order");
    assert.equal(shown.label, "New order · no session ticked");
    assert.match(shown.alert ?? "", /Tick at least one session in the rail\./);
    assert.equal(shown.focus, shown.first);
  });

  // spec §9.1 → All sessions: one press from any selection is back at rest; "order everyone" is a second, deliberate press
  test("the master box ticks every live box from nothing ticked, and from one box ticked unticks them all", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    const checked = () => page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>(".queue-rail-row .ctl-checkbox")].filter((box) => box.checked).map((box) => box.getAttribute("aria-label")));
    const master = page.getByLabel("Select all live sessions");
    await master.click();
    const all = { boxes: await checked(), send: await page.locator(".queue-orders .queue-compose-buttons .btn").textContent() };
    await master.click();
    const cleared = await checked();
    await tickSessions(page, ["aidl"]);
    await master.click();
    const fromOne = await checked();
    await page.close();

    assert.deepEqual(all, { boxes: ["Select gersona", "Select atrium", "Select aidl", "Select yoaida"], send: "Send to 4 sessions" });
    assert.deepEqual({ cleared, fromOne }, { cleared: [], fromOne: [] });
  });

  // spec §9.2: the draft is what the owner wrote, the ticks who gets it
  test("an order typed with one image survives a tick, an untick of every box and a reload, and the tick's Recipients changed note is said once", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await tickSessions(page, ["gersona"]);
    await page.locator(`#${ORDER_BOX_ID}`).fill(FIXTURE_ORDER_TEXT);
    await addOrderFiles(page, [getImageFile(0)]);
    await waitForImages(page);
    const draft = () => page.evaluate((id) => [(document.getElementById(id) as HTMLTextAreaElement).value, document.querySelectorAll(".queue-orders .queue-thumb").length], ORDER_BOX_ID);
    const note = () => page.locator(".queue-orders .queue-note-text").textContent();
    await tickSessions(page, ["yoaida"]);
    // the note follows the tick's render → wait on it, and read what stands should it never come
    const changed = await page.locator(".queue-orders .queue-note-text", { hasText: "Recipients changed" }).textContent({ timeout: 3_000 }).catch(() => note());
    const ticked = { draft: await draft(), note: changed };
    await page.locator(`#${ORDER_BOX_ID}`).press("End");
    await page.locator(`#${ORDER_BOX_ID}`).pressSequentially(" ");
    const typed = await note();
    await page.getByLabel("Select all live sessions").click();
    const untickedAll = { draft: await draft(), label: await page.locator(".queue-orders .field-label").textContent() };
    await page.reload({ waitUntil: "load" });
    await page.getByText(getRestReadyText()).first().waitFor({ timeout: READY_TIMEOUT_MS });
    const reloaded = await draft();
    await page.close();

    assert.deepEqual(ticked, { draft: [FIXTURE_ORDER_TEXT, 1], note: "ℹ Recipients changed: now gersona and yoaida." });
    assert.doesNotMatch(typed ?? "", /Recipients changed/);
    assert.deepEqual(untickedAll, { draft: [`${FIXTURE_ORDER_TEXT} `, 1], label: "New order · no session ticked" });
    assert.deepEqual(reloaded, [`${FIXTURE_ORDER_TEXT} `, 1]);
  });

  // spec §4.5 → Cmd / Ctrl + Enter sends from the pane the focus is in and from no other
  test("with a decision open and an order typed, each pane holds one primary button, and Cmd+Enter posts only from the pane holding the focus", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    const posts: string[] = [];
    page.on("request", (request) => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
    await tickSessions(page, ["gersona"]);
    await page.locator(`#${ORDER_BOX_ID}`).fill(FIXTURE_ORDER_TEXT);
    await pickWithNote(page);
    const primaries = await page.evaluate(() => [".queue-sheet", ".queue-orders"].map((pane) => document.querySelectorAll(`${pane} .btn.primary`).length));
    await page.locator(`#${ORDER_BOX_ID}`).press("ControlOrMeta+Enter");
    await page.getByText("Order sent to gersona").first().waitFor({ state: "attached" });
    const fromOrders = [...posts];
    await page.locator("#queue-text-103").press("ControlOrMeta+Enter");
    await page.getByText("Answer sent to gersona").first().waitFor({ state: "attached" });
    await page.close();

    assert.deepEqual(primaries, [1, 1]);
    assert.deepEqual(fromOrders, ["/api/queue/owner/messages/send"]);
    assert.deepEqual(posts.slice(fromOrders.length), ["/api/queue/owner/items/103/answer"]);
  });

  // spec §9.1 → In the address, §10: a tick on a session that stops taking orders is dropped and said
  test("a ticked session that stops taking orders is unticked on the page's next read, and the status line says so", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(), true);
    try {
      await tickSessions(page, ["yoaida"]);
      harness.fixture = getStoppedFixture();
      await page.clock.fastForward(16_000);
      await page.getByText("yoaida no longer takes orders and was unticked.").waitFor({ state: "attached" });
      const shown = await page.evaluate(() => ({
        box: document.querySelector('[aria-label="Select yoaida"]') !== null,
        label: document.querySelector(".queue-orders .field-label")?.textContent,
        hash: window.location.hash,
      }));
      assert.deepEqual(shown, { box: false, label: "New order · no session ticked", hash: "#queue" });
    } finally {
      await page.close();
    }
  });

  // spec §10: the thread's empty state is text on the Orders column, never indented off it
  test("the empty thread's line starts on the Orders column, where the Orders title starts", async () => {
    harness.fixture = getEmptyFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(getEmptyFixture()));
    await tickOrdersTo(page, ["aidl"]);
    await page.getByText("No orders to aidl yet").waitFor();
    const lefts = await page.evaluate(() => [".queue-orders-card > .card-head .card-title", ".queue-thread > .placeholder > div"]
      .map((selector) => Math.round((document.querySelector(selector) as HTMLElement).getBoundingClientRect().left)));
    await page.close();

    assert.equal(lefts[1], lefts[0]);
  });

  // spec §18.4 row 20: the arrival reaches the row, the rail and the nav on the same tick, and moves nothing the owner holds
  test("the page's own 15 s read raises an arrival's session's and the nav's counts and paints New on no row; an open sheet stays and the way back counts it", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(), true);
    try {
      await selectRow(page, 101);
      harness.fixture = getArrivalFixture();
      await page.clock.fastForward(15_000);
      await page.locator("#queue-row-150").waitFor({ state: "attached", timeout: READY_TIMEOUT_MS });
      const rail = page.locator(`[data-session="${FIXTURE_SESSION_IDS.yoaida}"] .queue-rail-count .pill`);
      await assert.doesNotReject(rail.filter({ hasText: /^2$/ }).waitFor({ timeout: READY_TIMEOUT_MS }), "yoaida's rail count reads 2");
      await assert.doesNotReject(page.locator(".nav-item", { hasText: "Queue" }).locator(".nav-count").filter({ hasText: "8" }).waitFor({ timeout: READY_TIMEOUT_MS }), "the nav count reads 8");
      const back = page.getByRole("button", { name: "Back to the list, 1 new in the list" });
      assert.deepEqual([await back.count(), await page.evaluate(() => window.location.hash)], [1, "#queue?item=101"], "the sheet unmoved, the arrival counted on the way back");
      await back.click();
      await page.locator("#queue-row-150").waitFor({ state: "visible", timeout: READY_TIMEOUT_MS });
      assert.deepEqual(await page.locator('[role="option"] .pill').filter({ hasText: /^New$/ }).count(), 0, "no row paints New");
      assert.deepEqual(await page.locator('[role="option"][aria-selected="true"]').evaluateAll((rows) => rows.map((row) => row.id)), ["queue-row-101"]);
    } finally {
      await page.close();
    }
  });

  // spec §4.3: the count belongs to the way back → bound to the arrow by proximity, never read as part of the letterhead after it
  test("the arrival count on an open sheet stands at least twice as near the back arrow's glyph as the kind tag after it", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(), true);
    try {
      await selectRow(page, 101);
      await arriveItem(page, harness);
      await page.getByRole("button", { name: "Back to the list, 1 new in the list" }).waitFor();
      const gaps = await page.evaluate(() => {
        const head = document.querySelector(".queue-sheet-head") as HTMLElement;
        const box = (selector: string) => (head.querySelector(selector) as Element).getBoundingClientRect();
        const [glyph, count, tag] = [box("button svg"), box("[aria-hidden='true'] .pill"), box(".queue-letter .pill")];
        return { afterArrow: Math.round(count.left - glyph.right), beforeTag: Math.round(tag.left - count.right) };
      });

      assert.ok(gaps.afterArrow > 0 && gaps.beforeTag >= 2 * gaps.afterArrow, JSON.stringify(gaps));
    } finally {
      await page.close();
    }
  });

  // spec §4.4: an arrival is tracked until its row has been in the shown list's visible part — not only until it is focused
  test("an arrival whose row has shown in the list is no longer counted on the way back of the next sheet", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(), true);
    try {
      await selectRow(page, 101);
      await arriveItem(page, harness);
      await page.getByRole("button", { name: "Back to the list, 1 new in the list" }).click();
      await page.locator("#queue-row-150").waitFor({ state: "visible", timeout: READY_TIMEOUT_MS });
      await selectRow(page, 101);

      assert.deepEqual(await page.locator(".queue-sheet-head button").first().getAttribute("aria-label"), "Back to the list");
    } finally {
      await page.close();
    }
  });

  // spec §4.4: past the visible part the status line names the arrival's side, and its Show brings the row into view with the focus
  test("an arrival below the list's visible part is said as 1 new below with Show, and Show puts its row in view, focused, and ends the note", async () => {
    harness.fixture = getOffViewFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture), true);
    try {
      await arriveOffView(page, harness);
      const said = await page.locator(".queue-status-line").innerText();
      await page.getByRole("button", { name: "Show the new item below" }).click();
      await page.locator(".queue-status-new").waitFor({ state: "detached" });
      const row = await page.evaluate(() => {
        const [body, box] = [".queue-list > .card-body", "#queue-row-150"].map((selector) => (document.querySelector(selector) as HTMLElement).getBoundingClientRect());
        return { isFocused: document.activeElement?.id === "queue-row-150", isInView: box!.top >= body!.top && box!.bottom <= body!.bottom };
      });

      assert.match(said.replace(/\s+/g, " "), /1 new below Show$/);
      assert.deepEqual(row, { isFocused: true, isInView: true });
    } finally {
      await page.close();
    }
  });

  test("an order's images are 96 squares in its bubble, an added one is a 56 thumbnail in a 104 box, and the viewer spans the window, fits one in it and steps", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await page.locator(".queue-bubble-image img").first().waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll(".queue-bubble-image img")].every((img) => (img as HTMLImageElement).complete));
    const bubble = await page.evaluate(() => [...document.querySelectorAll(".queue-bubble-image")].map((button) => {
      const box = button.getBoundingClientRect();
      return [Math.round(box.width), Math.round(box.height), ((button.querySelector("img") as HTMLImageElement).naturalWidth > 0)];
    }));
    await page.locator("#queue-order-text-files").setInputFiles({ name: "shot-1.png", mimeType: "image/png", buffer: [...FIXTURE_IMAGES.values()][0]?.bytes ?? Buffer.alloc(0) });
    await page.locator(".queue-thumb:not(.is-busy) img").waitFor();
    const composer = await page.evaluate(() => ({
      thumb: [".queue-thumb"].map((selector) => { const box = (document.querySelector(selector) as HTMLElement).getBoundingClientRect(); return [Math.round(box.width), Math.round(box.height)]; })[0],
      box: Math.round((document.querySelector(".queue-orders .queue-compose-box") as HTMLElement).getBoundingClientRect().height),
      count: document.querySelector(".queue-thumbs-count")?.textContent,
    }));
    await page.locator(".queue-bubble-image").first().click();
    await page.locator(".queue-viewer img").waitFor();
    const fit = await page.evaluate(() => {
      const panel = (document.querySelector(".queue-viewer") as HTMLElement).getBoundingClientRect();
      const img = (document.querySelector(".queue-viewer img") as HTMLElement).getBoundingClientRect();
      return {
        panel: [Math.round(panel.left), Math.round(panel.width)],
        window: [0, window.innerWidth],
        isImageInside: img.top >= 0 && img.left >= 0 && img.bottom <= window.innerHeight && img.right <= window.innerWidth,
      };
    });
    await page.keyboard.press("ArrowRight");
    const stepped = await page.locator(".queue-viewer-name").textContent();
    await page.keyboard.press("Escape");
    const after = await page.evaluate(() => ({ isViewerOpen: document.querySelector(".queue-viewer") !== null, isModeOpen: document.querySelector(".queue-orders") !== null, focus: document.activeElement?.getAttribute("aria-label") }));
    await page.close();

    assert.ok(bubble.length > 0 && bubble.every(([width, height, isLoaded]) => width === 96 && height === 96 && isLoaded), JSON.stringify(bubble));
    assert.deepEqual({ thumb: composer.thumb, box: composer.box }, { thumb: [56, 56], box: 104 });
    assert.match(composer.count ?? "", /^1 image · \d+ KB$/);
    assert.deepEqual(fit.panel, fit.window, "the viewer panel spans the window width");
    assert.equal(fit.isImageInside, true);
    assert.match(stepped ?? "", / · 2 of \d+$/);
    assert.deepEqual({ isViewerOpen: after.isViewerOpen, isModeOpen: after.isModeOpen }, { isViewerOpen: false, isModeOpen: true });
    assert.match(after.focus ?? "", /^Open image 1 of \d+: /);
  });

  test("every pane head is 48 high, in both middle-pane states, at every desk width", async () => {
    harness.fixture = getRestFixture();
    const heads = [];
    for (const { viewport } of DESK_WIDTHS) {
      const page = await openQueuePage(harness, viewport, getRestReadyText());
      const list = await getHeadHeights(page, [".queue-sessions", ".queue-list", ".queue-orders-card"]);
      await selectRow(page, 101);
      const sheet = await getHeadHeights(page, [".queue-sessions", ".queue-sheet", ".queue-orders-card"]);
      await page.close();
      heads.push({ width: viewport.width, list, sheet });
    }

    assert.deepEqual(heads, heads.map(({ width }) => ({ width, list: [48, 48, 48], sheet: [48, 48, 48] })));
  });

  // spec §4.1: a scope title wider than the pane gives way on the head's one line → the list's head and first band stay level with Orders'
  test("the list head stays one 48 line under a scope title wider than the pane: the title cut with its whole text in the tooltip, the waiting count whole and the keys button inside the head, at every desk width", async () => {
    harness.fixture = getEdgeFixture();
    const heads = [];
    for (const { viewport } of DESK_WIDTHS) {
      const page = await openEdgePage(harness, viewport);
      await tickSessions(page, [EDGE_LONG_SESSION_NAME]);
      const heights = await getHeadHeights(page, [".queue-list", ".queue-orders-card"]);
      const facts = await page.evaluate(() => {
        const head = document.querySelector(".queue-list > .card-head") as HTMLElement;
        const title = head.querySelector(".card-title") as HTMLElement;
        const sub = head.querySelector(".card-sub") as HTMLElement;
        const keys = head.querySelector("button") as HTMLElement;
        return {
          isTitleCut: title.scrollWidth > title.clientWidth && getComputedStyle(title).textOverflow === "ellipsis",
          tooltip: (title.querySelector("[title]") as HTMLElement | null)?.title ?? title.title,
          sub: sub.textContent,
          isSubWhole: sub.clientWidth > 0 && sub.scrollWidth <= sub.clientWidth,
          isKeysInHead: keys.getBoundingClientRect().right <= head.getBoundingClientRect().right,
        };
      });
      await page.close();
      heads.push({ width: viewport.width, heights, ...facts });
    }

    assert.deepEqual(heads, heads.map(({ width, sub }) => ({
      width, heights: [48, 48], isTitleCut: true, tooltip: EDGE_LONG_SESSION_NAME, sub: /^\d+ waiting$/.test(sub ?? "") ? sub : "N waiting", isSubWhole: true, isKeysInHead: true,
    })));
  });

  // the page's one solid = an open sheet's arrival count → a sheet open and a report arrived; the warn = the not-received order's tag
  test("a badge is 20 high in every fill", async () => {
    harness.fixture = getNotReceivedFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture), true);
    try {
      await selectRow(page, 101);
      await arriveItem(page, harness, getNotReceivedFixture());
      await page.getByRole("button", { name: "Back to the list, 1 new in the list" }).waitFor();
      const fills = await page.evaluate(() => [...new Set([...document.querySelectorAll(".pill--solid, .pill--tag, .pill--warn")]
        .filter((pill) => pill.getClientRects().length > 0)
        .map((pill) => `${/pill--(solid|tag|warn)/.exec(pill.className)?.[1]} ${Math.round(pill.getBoundingClientRect().height)}`))].sort());

      assert.deepEqual(fills, ["solid 20", "tag 20", "warn 20"]);
    } finally {
      await page.close();
    }
  });

  test("the page header ends at the same x as on the Documents page, at every desk width", async () => {
    harness.fixture = getRestFixture();
    const ends = [];
    for (const { viewport } of DESK_WIDTHS) {
      const page = await openQueuePage(harness, viewport, getRestReadyText());
      const queue = await getHeadEnd(page);
      await page.evaluate(() => { window.location.hash = "#clauded-docs"; });
      await page.locator(".page-head-title", { hasText: "Documents" }).waitFor({ timeout: READY_TIMEOUT_MS });
      const docs = await getHeadEnd(page);
      await page.close();
      ends.push({ width: viewport.width, queue, docs });
    }

    assert.deepEqual(ends, ends.map((row) => ({ ...row, queue: row.docs })));
  });

  // an answer held in flight → its composer's other button disabled; the not-received order's Resend → a secondary on the same desk
  test("every word button of the open decision's desk has a 1 px edge at rest in its rank's colour, a quiet label is dim, and a disabled one keeps a faint label at full strength on the line edge", async () => {
    harness.fixture = getNotReceivedFixture();
    let release = () => {};
    harness.heldAct = new Promise((resolve) => { release = resolve; });
    try {
      const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
      await pickWithNote(page);
      await page.locator(".queue-sheet").getByRole("button", { name: "Send answer" }).click();
      await page.locator(".queue-sheet [aria-busy='true']").waitFor();
      await page.mouse.move(0, 0);
      // the 0.12 s edge transition into the disabled look settled first → never a mid-step colour
      await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)).then(() => undefined));
      const facts = await page.evaluate(getButtonFacts);
      release();
      await page.close();

      const looks = facts.buttons.map((button) => ({ name: button.name, look: button.look }));
      const expected = facts.buttons.map((button) => ({ name: button.name, look: getRankLook(facts.tokens, button) }));
      assert.deepEqual(looks, expected);
      assert.deepEqual([...new Set(facts.buttons.map((button) => button.rank))].sort(), ["disabled", "primary", "quiet", "secondary"], "the open sheet shows every rank");
    } finally {
      release();
      harness.heldAct = null;
    }
  });

  test("a quiet word button hovered takes the sunken fill and an ink label, and held down an ink edge", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await selectRow(page, 103);
    const button = page.getByRole("button", { name: "Answer later" });
    const read = () => getSettledLook(button);
    const tokens = await page.evaluate(getButtonFacts).then((facts) => facts.tokens);
    await button.hover();
    const hovered = await read();
    await page.mouse.down();
    const held = await read();
    await page.mouse.up();
    await page.keyboard.press("Escape");
    await page.close();

    assert.deepEqual([hovered.fill, hovered.label, held.edge], [tokens.sunken, tokens.ink, tokens.ink]);
  });

  test("a quiet button in progress keeps its rest look under the pointer: no fill, the control edge and a dim label", async () => {
    harness.fixture = getRestFixture();
    harness.moreCursor = "next-page";
    let release = () => {};
    try {
      const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
      const tokens = await page.evaluate(getButtonFacts).then((facts) => facts.tokens);
      harness.heldRead = new Promise((resolve) => { release = resolve; });
      await page.getByRole("button", { name: "Show more" }).click();
      const look = await getSettledLook(page.getByRole("button", { name: "Loading…" }));
      release();
      await page.close();

      assert.deepEqual(look, { fill: "rgba(0, 0, 0, 0)", edge: tokens.controlEdge, label: tokens.dim });
    } finally {
      release();
      harness.heldRead = null;
      harness.moreCursor = null;
    }
  });

  test("a word button reached by keyboard wears the focus ring outside its rest edge", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await selectRow(page, 103);
    const button = page.getByRole("button", { name: "Answer later" });
    await focusByKeyboard(page, button);
    const focused = await getFocusRing(button);
    const look = await getSettledLook(button);
    const ringToken = await getRingToken(page);
    const tokens = await page.evaluate(getButtonFacts).then((facts) => facts.tokens);
    await page.close();

    assert.deepEqual({ ...focused, edge: look.edge }, { isVisible: true, outline: `rgb(${ringToken}) solid 2px`, offset: "2px", edge: tokens.controlEdge });
  });

  // spec §12.5, §14.4: each icon button read where it is painted — the list head, the open sheet's head, a failed upload, the viewer's bar
  test("every icon button is a 32 square holding a drawn glyph, dim and with no edge or fill at rest, faint when disabled, named and with a tooltip; no button reads List", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    harness.refusals.set("upload", { status: 500, body: { error: "server" } });
    try {
      const tokens = await page.evaluate(getButtonFacts).then((facts) => facts.tokens);
      const atRest = await page.evaluate(getIconLooks);
      await page.locator(".queue-bubble-image img").first().waitFor();
      await page.locator(".queue-bubble-image").first().click();
      await page.locator(".queue-viewer img").waitFor();
      const inViewer = await page.evaluate(getIconLooks);
      await page.keyboard.press("Escape");
      await selectRow(page, 103);
      const onSheet = await page.evaluate(getIconLooks);
      await addOrderFiles(page, [getImageFile(0)]);
      await page.getByRole("button", { name: "Try again" }).waitFor();
      const onFailure = await page.evaluate(getIconLooks);
      const hasListText = await page.evaluate(() => [...document.querySelectorAll("button")].some((button) => /\bList\b/.test(button.textContent ?? "")));

      const byName = new Map([...atRest, ...onSheet, ...onFailure, ...inViewer].map((look) => [look.name, look]));
      assert.deepEqual([...byName.keys()].sort(), ["Add images", "Back to the list", "Close", "Keyboard shortcuts", "Next image", "Next item", "Previous image", "Previous item"]);
      const looks = [...byName.values()];
      const expected = looks.map((look) => ({
        ...look, size: [32, 32], text: "", isEdgeless: true, fill: "rgba(0, 0, 0, 0)", glyph: look.isDisabled ? tokens.faint : tokens.dim, isDrawn: true,
        title: look.title.startsWith(look.name) ? look.title : `${look.name} …`,
      }));
      assert.deepEqual(looks, expected);
      assert.ok(looks.some((look) => look.isDisabled), "a disabled icon button is read: Previous on the first sheet row");
      assert.equal(hasListText, false);
    } finally {
      harness.refusals.clear();
      await page.close();
    }
  });

  // the hover square is the pointer's only shape cue once the edge is gone → the selection tint a person can see, held one step stronger
  test("an icon button hovered takes the selection tint and an ink glyph, held the stronger tag fill, and by keyboard the ring, never an edge", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await selectRow(page, 103);
    const button = page.getByRole("button", { name: "Next item" });
    const read = async () => {
      const look = (await page.evaluate(getIconLooks)).find((icon) => icon.name === "Next item");
      return { fill: look?.fill, glyph: look?.glyph, isEdgeless: look?.isEdgeless };
    };
    const tokens = await page.evaluate(getButtonFacts).then((facts) => facts.tokens);
    const [tint, tintFill] = await getTintFills(page);
    await button.hover();
    const hovered = await read();
    await page.mouse.down();
    const held = await read();
    await page.mouse.move(0, 0);
    await page.mouse.up();
    const back = page.getByRole("button", { name: "Back to the list" });
    await focusByKeyboard(page, back);
    const focused = await getFocusRing(back);
    const ringToken = await getRingToken(page);
    await page.close();

    assert.deepEqual({ hovered, held, focused }, {
      hovered: { fill: tint, glyph: tokens.ink, isEdgeless: true },
      held: { fill: tintFill, glyph: tokens.ink, isEdgeless: true },
      focused: { isVisible: true, outline: `rgb(${ringToken}) solid 2px`, offset: "2px" },
    });
  });

  // spec §12.5 Reach: the system drawer opened on the Queue screen keeps its own close button → the system ghost's sunken fill, never the Queue tints
  test("the Automatic resumes drawer's close button hovered and held takes the system ghost's sunken fill and ink glyph, and the Queue's icon buttons keep their tints", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    const tokens = await page.evaluate(getButtonFacts).then((facts) => facts.tokens);
    const [tint, tintFill] = await getTintFills(page);
    const readFill = async (button: Locator) => {
      const look = await getSettledLook(button);
      return { fill: look.fill, glyph: look.label };
    };
    await page.getByRole("button", { name: /^Automatic resumes/ }).click();
    const close = page.getByRole("dialog", { name: "Recent automatic resumes" }).getByRole("button", { name: "Close details" });
    await close.hover();
    const closeHovered = await readFill(close);
    await page.mouse.down();
    const closeHeld = await readFill(close);
    await page.mouse.move(0, 0);
    await page.mouse.up();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Recent automatic resumes" }).waitFor({ state: "detached" });
    const keys = page.getByRole("button", { name: "Keyboard shortcuts" });
    await keys.hover();
    const keysHovered = await readFill(keys);
    await page.mouse.down();
    const keysHeld = await readFill(keys);
    await page.mouse.move(0, 0);
    await page.mouse.up();
    await page.close();

    assert.deepEqual({ closeHovered, closeHeld, keysHovered, keysHeld }, {
      closeHovered: { fill: tokens.sunken, glyph: tokens.ink },
      closeHeld: { fill: tokens.sunken, glyph: tokens.ink },
      keysHovered: { fill: tint, glyph: tokens.ink },
      keysHeld: { fill: tintFill, glyph: tokens.ink },
    });
  });

  test("the page header draws no button and one status line, Checks every 15s, and no Queue button is named New order, Clear or Refresh", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    const head = await page.evaluate(() => ({
      line: [...document.querySelectorAll(".page-head [role=status]")].map((node) => node.textContent?.trim()),
      // the phone's menu button stays in the DOM, undrawn above 640
      headButtons: [...document.querySelectorAll(".page-head button")].filter((node) => node.getClientRects().length > 0).length,
      named: [...document.querySelectorAll(".queue-screen button")].map((node) => (node.getAttribute("aria-label") ?? node.textContent ?? "").trim())
        .filter((name) => /^(New order|Clear|Refresh)/.test(name)),
    }));
    await page.close();

    assert.deepEqual(head, { line: ["Checks every 15s"], headButtons: 0, named: [] });
  });

  test("a failed check over loaded rows turns the header line to Not updated with the next check's interval, and the first good check restores it", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(), true);
    const line = page.locator(".page-head [role=status]");
    try {
      const loaded = await page.locator(".queue-row").count();
      harness.isListDown = true;
      await page.clock.fastForward(15_000);
      await line.filter({ hasText: "Not updated" }).waitFor({ timeout: READY_TIMEOUT_MS });
      const failed = (await line.textContent())?.trim();
      const kept = await page.locator(".queue-row").count();
      harness.isListDown = false;
      await page.clock.fastForward(15_000);
      await line.filter({ hasText: /^Checks every 15s$/ }).waitFor({ timeout: READY_TIMEOUT_MS });

      assert.match(failed ?? "", /^⚠ Not updated · last read \d{2}:\d{2} · trying again every 15s$/);
      assert.deepEqual([kept, loaded > 0], [loaded, true], "the loaded rows stay on screen");
    } finally {
      harness.isListDown = false;
      await page.close();
    }
  });

  test("the report's composer and the Orders composer, on one screen, share a 40 box, 40 buttons and one computed type, the Orders button under its box", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await selectRow(page, 101);
    const report = await getComposerFacts(page, ".queue-sheet");
    const order = await getComposerFacts(page, ".queue-orders");
    const isUnder = await page.evaluate(() => (document.querySelector(".queue-orders .queue-compose-buttons .btn") as HTMLElement).getBoundingClientRect().top >= (document.querySelector(".queue-orders .queue-compose-box") as HTMLElement).getBoundingClientRect().bottom);
    await page.close();

    assert.deepEqual({ box: report.box, buttons: report.buttons }, { box: 40, buttons: [40] }, "the report's composer");
    assert.deepEqual(order, report, "the Orders composer against the report's");
    assert.equal(isUnder, true, "the Orders button falls under its box");
  });

  // spec §3.2 / §4.5 / §18.5: the pane's width decides the form — beside from a 420 pane, under below it — never the button's label,
  // so a tick that lengthens the label moves nothing
  test("the Orders send button stands beside its box from a 420 pane and under it below, the same with nothing ticked and with two sessions ticked", async () => {
    harness.fixture = getRestFixture();
    const rows: Array<{ width: number; ticked: number; label: string | null | undefined; isBeside: boolean; isWide: boolean }> = [];
    for (const { viewport } of DESK_WIDTHS) {
      for (const ticked of [[], ORDER_TO]) {
        const page = await openQueuePage(harness, viewport, getRestReadyText());
        await tickSessions(page, ticked);
        const facts = await page.evaluate(() => {
          const rect = (selector: string) => (document.querySelector(`.queue-orders ${selector}`) as HTMLElement).getBoundingClientRect();
          const pane = document.querySelector(".queue-orders-card") as HTMLElement;
          return { label: document.querySelector(".queue-orders .queue-compose-buttons .btn")?.textContent, isBeside: rect(".queue-compose-buttons").top < rect(".queue-compose-box").bottom, pane: pane.clientWidth };
        });
        await page.close();
        rows.push({ width: viewport.width, ticked: ticked.length, label: facts.label, isBeside: facts.isBeside, isWide: facts.pane >= 420 });
      }
    }
    const at = (width: number) => rows.filter((row) => row.width === width).map((row) => row.isBeside);

    assert.deepEqual(rows.filter((row) => row.isBeside !== row.isWide), [], JSON.stringify(rows));
    assert.deepEqual(new Set(rows.map((row) => `${row.ticked}:${row.label}`)), new Set(["0:Send order", "2:Send to 2 sessions"]));
    assert.deepEqual([at(1440), at(1568), at(1728), at(2560)], [[false, false], [false, false], [true, true], [true, true]]);
  });

  // spec §3.2 / §4.5: the label gives way, never the box — beside the button the box keeps its 220, under it the whole row;
  // a 100-character name is cut inside the button, the whole label in its title. 1605 and 1645 put the pane at about 420 and 460
  test("the Orders send label stays inside its row and leaves the box 220 beside it or the whole row under it, a 100-character name cut with the whole label in the title, from 1440 to 1920", async () => {
    const ticks = [
      { names: [EDGE_LONG_SESSION_NAME], label: `Send to ${EDGE_LONG_SESSION_NAME}`, isCut: true },
      { names: ["gersona", "portfolio"], label: "Send to 2 sessions · resumes 1 ended", isCut: false },
    ];
    const rows = [];
    for (const width of [1440, 1568, 1605, 1645, 1728, 1920]) {
      for (const tick of ticks) {
        const page = await openEdgePage(harness, { width, height: 900 });
        await openEndedBand(page);
        await tickSessions(page, tick.names);
        const facts = await page.evaluate(() => {
          const rect = (selector: string) => (document.querySelector(`.queue-orders ${selector}`) as HTMLElement).getBoundingClientRect();
          const [row, box, button] = [rect(".queue-compose-row"), rect(".queue-compose-box"), rect(".queue-compose-buttons .btn")];
          const send = document.querySelector(".queue-orders .queue-compose-buttons .btn") as HTMLElement;
          const name = document.querySelector(".queue-orders .queue-send-name") as HTMLElement | null;
          const isBeside = button.top < box.bottom;
          return {
            isWide: (document.querySelector(".queue-orders-card") as HTMLElement).clientWidth >= 420,
            isBeside,
            isBoxKept: isBeside ? box.width >= 220 : Math.abs(box.width - row.width) < 1,
            isInRow: button.left >= row.left - 0.5 && button.right <= row.right + 0.5,
            label: send.textContent,
            title: send.title,
            isCut: name !== null && getComputedStyle(name).textOverflow === "ellipsis" && name.scrollWidth > name.clientWidth,
          };
        });
        await page.close();
        rows.push({ width, ...facts });
      }
    }

    const expected = rows.map(({ width, isWide }, index) => {
      const tick = ticks[index % ticks.length]!;
      return { width, isWide, isBeside: isWide, isBoxKept: true, isInRow: true, label: tick.label, title: tick.label, isCut: tick.isCut };
    });
    assert.deepEqual(new Set(rows.map((row) => row.isWide)), new Set([false, true]), "the sweep crosses the 420 pane");
    assert.deepEqual(rows, expected);
  });

  // a commit button never ends in a broken word nor in blank: the resume tail stays whole where the button's room (the row less
  // the 220 box beside it, the whole row under it) holds it beside the head and the name at its 3ch floor, and a dropped tail
  // leaves no width behind → the button ends where its shown label ends. portfolio is the edge fixture's ended session
  test("the Orders send button holds the label it shows: the resume tail whole where the button's room holds it beside the name at its floor, else dropped with no blank left, and the head whole, from 1440 to 1920", async () => {
    const ticks = [["portfolio"], ["gersona", "portfolio"]];
    const rows = [];
    for (const width of [1440, 1568, 1605, 1645, 1690, 1728, 1920]) {
      for (const names of ticks) {
        const page = await openEdgePage(harness, { width, height: 900 });
        await openEndedBand(page);
        await tickSessions(page, names);
        const facts = await page.evaluate(() => {
          const element = (selector: string) => document.querySelector(`.queue-orders ${selector}`) as HTMLElement;
          const [row, box, button, label] = [element(".queue-compose-row"), element(".queue-compose-box"), element(".queue-compose-buttons .btn"), element(".queue-send-label")];
          const [head, tail] = [label.firstElementChild as HTMLElement, label.querySelector(".queue-send-tail") as HTMLElement];
          const name = label.querySelector(".queue-send-name") as HTMLElement | null;
          const [rowBox, boxBox, buttonBox, labelBox] = [row, box, button, label].map((node) => node.getBoundingClientRect());
          const [headBox, tailBox, nameBox] = [head.getBoundingClientRect(), tail.getBoundingClientRect(), name?.getBoundingClientRect()];
          const floor = name === null ? 0 : parseFloat(getComputedStyle(name).minWidth);
          const style = getComputedStyle(button);
          const [padStart, padEnd, edgeStart, edgeEnd] = [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth].map(parseFloat);
          const room = rowBox.width - (buttonBox.top < boxBox.bottom ? 220 + parseFloat(getComputedStyle(row).columnGap) : 0);
          const isOnLine = tailBox.top < labelBox.bottom - 0.5 && tailBox.right <= labelBox.right + 0.5;
          const isWhole = isOnLine && tail.scrollWidth <= tail.clientWidth;
          const shownEnd = Math.max(headBox.right, nameBox?.right ?? 0, isWhole ? tailBox.right : 0);
          return {
            hasRoom: padStart + padEnd + edgeStart + edgeEnd + headBox.width + Math.min(name?.scrollWidth ?? 0, floor) + tailBox.width <= room + 0.5,
            tail: isWhole ? "whole" : isOnLine ? "cut" : "dropped",
            blankEnd: Math.round(buttonBox.right - edgeEnd - padEnd - shownEnd),
            isHeadWhole: headBox.right <= labelBox.right + 0.5,
          };
        });
        await page.close();
        rows.push({ width, names: names.join(","), ...facts });
      }
    }

    assert.deepEqual(new Set(rows.map((row) => row.hasRoom)), new Set([false, true]), "the sweep crosses the width where the tail fits");
    assert.deepEqual(rows, rows.map((row) => ({ ...row, tail: row.hasRoom ? "whole" : "dropped", blankEnd: 0, isHeadWhole: true })));
  });

  // spec §4.5 / §12.5: Add images is a glyph inside the one bordered field → no edge of its own, at rest, hovered or held;
  // under the pointer it takes the icon button's fills: the selection tint, held the stronger tag fill
  test("Add images draws no edge of its own inside the order box, at rest or under the pointer, and takes the selection tint hovered and the tag fill held", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    const add = page.locator(".queue-orders .queue-compose-add");
    const [tint, tintFill] = await getTintFills(page);
    const tokenByFill = new Map([[tint, "--tint-select"], [tintFill, "--tint-fill"]]);
    // the button's colour transition settled first → the look the state ends on, never a mid-fade blend
    const getLook = async () => {
      const look = await add.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
        const style = getComputedStyle(element);
        const alpha = style.borderTopColor.startsWith("rgba") ? Number(style.borderTopColor.split(",").at(-1)?.replace(")", "")) : 1;
        return { isEdgeless: parseFloat(style.borderTopWidth) === 0 || alpha === 0, fill: style.backgroundColor };
      });
      return { ...look, fill: tokenByFill.get(look.fill) ?? null };
    };
    const rest = await getLook();
    await add.hover();
    const hovered = await getLook();
    await page.mouse.down();
    const held = await getLook();
    await page.close();

    assert.deepEqual({ rest, hovered, held }, {
      rest: { isEdgeless: true, fill: null },
      hovered: { isEdgeless: true, fill: "--tint-select" },
      held: { isEdgeless: true, fill: "--tint-fill" },
    });
  });

  // spec §9.2: a focused entry's ring stands clear of its time line and its Resend, and the thread's column does not clip it
  test("a focused thread entry's ring stands outside the entry, inside the thread", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await waitForAllOrders(page);
    const facts = await page.evaluate(() => {
      const entry = document.querySelector(".queue-order") as HTMLElement;
      entry.focus();
      const style = getComputedStyle(entry);
      const outset = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
      const ring = entry.getBoundingClientRect();
      const log = (entry.closest(".queue-thread") as HTMLElement).getBoundingClientRect();
      return { isClear: parseFloat(style.outlineOffset) > 0, isInside: ring.left - outset >= log.left && ring.right + outset <= log.right };
    });
    await page.close();

    assert.deepEqual(facts, { isClear: true, isInside: true });
  });

  // spec §12.2: the thread's last bubble and what stands under it stay in view while the composer grows under a draft
  test("a thread at its end stays at its end when a longer draft grows the composer", async () => {
    const page = await openEdgePage(harness, { width: 1568, height: 759 });
    await waitForAllOrders(page);
    await page.locator(`#${ORDER_BOX_ID}`).fill("first line of the order\nsecond line\nthird line\nfourth line");
    const facts = await page.evaluate(() => new Promise<{ isShrunk: boolean; isAtEnd: boolean }>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const log = document.querySelector(".queue-thread") as HTMLElement;
        const composer = document.querySelector(".queue-orders .queue-composer") as HTMLElement;
        resolve({ isShrunk: composer.getBoundingClientRect().height > 174, isAtEnd: log.scrollHeight - log.scrollTop - log.clientHeight < 2 });
      }));
    }));
    await page.close();

    assert.deepEqual(facts, { isShrunk: true, isAtEnd: true });
  });

  // spec §9.8 → Upload failed, §12.5: the note takes the wrap; Try again keeps its word, whole on one line beside it, on the quiet edge
  test("a failed upload's Try again is a quiet word button with its edge, on one line beside a wrapping note", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    harness.refusals.set("upload", { status: 500, body: { error: "server" } });
    try {
      await addOrderFiles(page, [{ ...getImageFile(0), name: "a-screenshot-named-long-enough-to-wrap-the-note.png" }]);
      await page.locator(".queue-thumb-failed").first().waitFor();
      const tokens = await page.evaluate(getButtonFacts).then((facts) => facts.tokens);
      const facts = await page.getByRole("button", { name: "Try again" }).evaluate((button) => {
        const [box, style] = [button.getBoundingClientRect(), getComputedStyle(button)];
        const note = (button.previousElementSibling as HTMLElement).getBoundingClientRect();
        const lineHeight = parseFloat(getComputedStyle(button.previousElementSibling as HTMLElement).lineHeight);
        return {
          id: button.id, text: button.textContent?.trim(), isOneLine: box.height < lineHeight * 2, edge: `${style.borderTopWidth} ${style.borderTopColor}`,
          isBeside: box.left >= note.right, isNoteWrapped: note.height > lineHeight * 1.5,
        };
      });
      assert.deepEqual(facts, { id: `${ORDER_BOX_ID}-retry`, text: "Try again", isOneLine: true, edge: `1px ${tokens.controlEdge}`, isBeside: true, isNoteWrapped: true });
    } finally {
      harness.refusals.clear();
      await page.close();
    }
  });

  test("the thread opens at its end, and its composer stays in view at every scroll position of the thread", async () => {
    const page = await openEdgePage(harness, { width: 1568, height: 759 });
    await waitForAllOrders(page);
    const facts = await page.evaluate(() => {
      const log = document.querySelector(".queue-thread") as HTMLElement;
      const composer = document.querySelector(".queue-orders .queue-composer") as HTMLElement;
      const end = log.scrollHeight - log.clientHeight;
      const isAtEnd = end - log.scrollTop < 2;
      const isComposerInView = [0, end / 2, end].map((top) => {
        log.scrollTop = top;
        const box = composer.getBoundingClientRect();
        return box.top >= 0 && box.bottom <= window.innerHeight;
      });
      return { isOverflowing: end > 0, isAtEnd, isComposerInView };
    });
    await page.close();

    assert.deepEqual(facts, { isOverflowing: true, isAtEnd: true, isComposerInView: [true, true, true] });
  });

  test("an order bubble is no wider than 85% of the thread's column and no wider than 66ch of its own text", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await waitForAllOrders(page);
    const bubbles = await page.evaluate(() => {
      const log = document.querySelector(".queue-thread") as HTMLElement;
      const pad = getComputedStyle(log);
      const column = log.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
      return [...document.querySelectorAll(".queue-bubble")].map((bubble) => {
        const text = bubble.querySelector(".prose-text") as HTMLElement;
        const probe = text.appendChild(Object.assign(document.createElement("span"), { style: "display: block; width: 66ch" }));
        const measure = probe.getBoundingClientRect().width;
        probe.remove();
        return { width: bubble.getBoundingClientRect().width, limit: Math.min(0.85 * column, measure) };
      });
    });
    await page.close();

    assert.ok(bubbles.length > 0 && bubbles.every(({ width, limit }) => width <= limit + 0.5), JSON.stringify(bubbles));
  });

  // spec 44063 §9.1–§9.4 and §14.4 (Next turn stream only): Next turn and Not yet side by side on every surface
  // spec §4.6, §14.3 (One list): the history read with kind item under the open bands, scoped on the server by the ticks; Done day bands; a read-only sheet
  describe("on the done fixtures", () => {
    const openDonePage = async (fixture = getDoneFixture(), hash = ""): Promise<{ page: Page; reads: URLSearchParams[] }> => {
      harness.fixture = fixture;
      const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture));
      const reads: URLSearchParams[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname === "/api/queue/owner/orders" && url.searchParams.get("kind") === "item") reads.push(url.searchParams);
      });
      // the first reads after the listener → every done read is recorded; a hash → the page opens on it
      if (hash !== "") await page.evaluate((next) => { location.hash = next; }, hash);
      await page.reload({ waitUntil: "load" });
      await waitForDoneBands(page);
      return { page, reads };
    };
    // every band and row in list order: a band's text and count badges, a row's part (open or done), its tag and fact, its title's weight and colour; whether the list draws its bar
    const getListRows = (page: Page) => page.evaluate(() => ({
      hash: location.hash,
      bands: [...document.querySelectorAll(".queue-listbox .queue-band")].map((band) => [band.textContent, band.querySelectorAll(".pill").length]),
      rows: [...document.querySelectorAll(".queue-listbox .queue-row")].map((row) => [row.id, row.closest('[role="group"]')?.getAttribute("aria-label")?.startsWith("Done") === true]),
      done: [...document.querySelectorAll(".queue-row--done")].map((row) => [row.id, row.querySelector(".queue-row-tag")?.textContent, row.querySelector(".queue-row-fact")?.textContent]),
      looks: [...new Set([...document.querySelectorAll(".queue-row")].map((row) => {
        const title = getComputedStyle(row.querySelector(".queue-row-title") as Element);
        const band = getComputedStyle(row.closest('[role="group"]')?.querySelector(".queue-band") as Element);
        return `${row.classList.contains("queue-row--done")}:${title.fontWeight}:${title.color === band.color ? "dim" : "ink"}`;
      }))],
      // drawn, not present: the bar always holds the phone's names note, hidden above 640 when it stands alone
      bar: (document.querySelector(".queue-list > .card-bar")?.getClientRects().length ?? 0) > 0,
    }));

    test("the one list draws the open bands, then the done items newest end first under Done day bands with no count, each row dim 400 with how it ended in the tag column and its kind in the fact column; no bar with one account", async () => {
      const { page, reads } = await openDonePage();
      const shown = await getListRows(page);
      await page.close();

      const firstDone = shown.rows.findIndex(([, isDone]) => isDone);
      const firstDoneBand = shown.bands.findIndex(([text]) => String(text).startsWith("Done"));
      assert.ok(firstDone > 0 && firstDoneBand > 0, "open rows and bands on top");
      assert.deepEqual(shown.rows.slice(firstDone).filter(([, isDone]) => !isDone), [], "every open row above every done row");
      assert.deepEqual({ ...shown, rows: undefined, bands: shown.bands.slice(firstDoneBand), openBands: shown.bands.slice(0, firstDoneBand).every(([, counts]) => counts === 1) }, {
        hash: "#queue",
        bands: [["DoneToday", 0], ["DoneYesterday", 0], ["DoneNov 9", 0]],
        rows: undefined,
        openBands: true,
        done: [
          ["queue-row-801", "Answer R1", "Decision"], ["queue-row-802", "Read", "Report"],
          ["queue-row-803", "Withdrawn", "Decision"], ["queue-row-804", "Replied", "Report"], ["queue-row-805", "Answered", "Decision"],
        ],
        looks: ["false:600:ink", "true:400:dim"],
        bar: false,
      });
      assert.deepEqual(reads.map((query) => Object.fromEntries(query)), [{ limit: "30", kind: "item" }]);
    });

    // layout §1, §6 → Mark: a relay row's title leads with `→` and its recipient; a Done relay says how it ended in plain words with no badge,
    // among the day's decisions and reports by the time of its send; a relay on its way holds no element but its receipt counts
    test("Done and refused relays stand among the day's decisions and reports, titled from the arrow and the recipient, how they ended in plain words and no badge; the redacted relay on its way stands under In delivery", async () => {
      const { page } = await openDonePage(getDoneRelaysFixture());
      const shown = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".queue-listbox [role='group']")].map((band) => ({
        band: band.getAttribute("aria-label") ?? band.querySelector(".queue-band")?.firstChild?.textContent,
        kinds: [...band.querySelectorAll(".queue-row")].map((row) => row.querySelector(".queue-row-fact")?.textContent),
        relays: [...band.querySelectorAll(".queue-row")].filter((row) => /^(Refused relay|#\d+, Relay) from/.test(row.getAttribute("aria-label") ?? "")).map((row) => ({
          to: row.querySelector(".queue-row-title")?.textContent?.match(/^→ (\d+ sessions|\d+ unknown recipients?|\S+) /)?.[1] ?? null,
          tag: row.classList.contains("queue-row--done") ? row.querySelector(".queue-row-tag")?.textContent : "on its way",
          // a Done row's every pill · a row on its way, the pills outside its receipt counts
          pills: [...row.querySelectorAll(".pill")].filter((pill) => row.classList.contains("queue-row--done") || pill.closest(".queue-row-tag") === null).length,
        })),
      })));
      const redacted = await page.locator(".queue-row", { hasText: "Text redacted" }).evaluate((row) => [row.closest("[role='group']")?.querySelector(".queue-band")?.firstChild?.textContent, row.querySelector(".queue-row-title")?.textContent]);
      await page.close();

      // an open band's kinds are the open list's; a Done band's run newest last act first
      const bands = shown.filter((band) => band.relays.length > 0 || String(band.band).startsWith("Done"))
        .map(({ band, kinds, relays }) => (String(band).startsWith("Done") ? { band, kinds, relays } : { band, relays }));
      assert.deepEqual(bands, [
        { band: "In delivery", relays: [{ to: "atrium", tag: "on its way", pills: 0 }] },
        { band: "Done, Today", kinds: ["Decision", "Report", "Relay", "Relay"], relays: [{ to: "yoaida", tag: "Refused", pills: 0 }, { to: "2 sessions", tag: "1 lapsed", pills: 0 }] },
        { band: "Done, Yesterday", kinds: ["Decision", "Relay", "Report"], relays: [{ to: "gersona", tag: "Received", pills: 0 }] },
        { band: "Done, Nov 9", kinds: ["Decision"], relays: [] },
      ]);
      assert.deepEqual(redacted, ["In delivery", "→ atrium Text redacted"]);
    });

    test("ticking a session scopes the done read on the server, and both parts hold that session alone", async () => {
      const { page, reads } = await openDonePage();
      await tickSessions(page, ["atrium"]);
      await page.waitForFunction(() => document.querySelectorAll(".queue-row--done").length === 1);
      const shown = await getListRows(page);
      const names = await page.evaluate(() => [...new Set([...document.querySelectorAll(".queue-row")].map((row) => row.getAttribute("aria-label")?.match(/ from (\S+):/)?.[1] ?? "atrium"))]);
      await page.close();

      assert.deepEqual([shown.done, names], [[["queue-row-802", "Read", "Report"]], ["atrium"]]);
      assert.deepEqual(reads.at(-1)?.get("sessionIds"), FIXTURE_SESSION_IDS.atrium);
    });

    test("with nothing open the Done bands start at the top and the head reads 0 waiting", async () => {
      const { page } = await openDonePage(getDoneOnlyFixture());
      const shown = await page.evaluate(() => ({
        first: document.querySelector(".queue-listbox .queue-band")?.textContent,
        isWaiting: document.querySelector(".queue-list")?.textContent?.includes("0 waiting"),
      }));
      await page.close();

      assert.deepEqual([shown.first, shown.isWaiting], ["DoneToday", true]);
    });

    test("Show more stands one 44 line after the last row inside the list's scroll, start-aligned, and reads the next done page", async () => {
      const { page, reads } = await openDonePage(getManyDoneFixture());
      const before = await page.evaluate(() => {
        const end = document.querySelector(".queue-list-end") as HTMLElement;
        const button = end.querySelector("button") as HTMLElement;
        const listbox = document.querySelector(".queue-listbox") as HTMLElement;
        return {
          parent: end.parentElement?.matches(".queue-list > .card-body"),
          height: Math.round(end.getBoundingClientRect().height),
          afterRows: Math.round(end.getBoundingClientRect().top - listbox.getBoundingClientRect().bottom),
          inset: Math.round(button.getBoundingClientRect().left - end.getBoundingClientRect().left),
          rows: document.querySelectorAll(".queue-row--done").length,
          isFootFree: document.querySelector(".queue-list > .card-foot")?.textContent?.includes("Show more") === false,
        };
      });
      await showMoreDone(page);
      const after = await page.evaluate(() => ({ rows: document.querySelectorAll(".queue-row--done").length, hasEnd: document.querySelector(".queue-list-end") !== null }));
      await page.close();

      assert.deepEqual(before, { parent: true, height: 44, afterRows: 0, inset: 16, rows: 30, isFootFree: true });
      assert.deepEqual(after, { rows: 40, hasEnd: false });
      assert.ok(reads.at(-1)?.has("before"), "the second read pages back by cursor");
    });

    test("Down from the last open row focuses the first done row and Up returns, one tab stop across the boundary", async () => {
      const { page } = await openDonePage();
      const ids = await page.evaluate(() => {
        const rows = [...document.querySelectorAll(".queue-listbox .queue-row")];
        const first = rows.findIndex((row) => row.classList.contains("queue-row--done"));
        return { last: rows[first - 1]?.id, first: rows[first]?.id, stops: rows.filter((row) => row.getAttribute("tabindex") === "0").length };
      });
      await page.locator(`#${ids.last}`).focus();
      await page.keyboard.press("ArrowDown");
      const down = await page.evaluate(() => document.activeElement?.id);
      await page.keyboard.press("ArrowUp");
      const up = await page.evaluate(() => document.activeElement?.id);
      await page.close();

      assert.deepEqual([down, up, ids.stops], [ids.first, ids.last, 1]);
    });

    test("an applied account draws the bar, and its Reset filters is quiet: no edge at rest, a faint fill on hover", async () => {
      const { page } = await openDonePage(getDoneFixture(), "#queue?profile=.claude-work");
      const reset = page.locator(".filter-bar-reset");
      // the button's colour transition settled first → the look read is the state's, not a frame of the fade
      const getLook = () => reset.evaluate(async (node) => {
        await Promise.all(node.getAnimations().map((animation) => animation.finished));
        return { edge: getComputedStyle(node).borderTopColor, fill: getComputedStyle(node).backgroundColor };
      });
      const rest = await getLook();
      await reset.hover();
      const hovered = await getLook();
      await page.close();
      const CLEAR = "rgba(0, 0, 0, 0)";
      assert.deepEqual([rest, hovered.edge, hovered.fill !== CLEAR], [{ edge: CLEAR, fill: CLEAR }, CLEAR, true]);
    });

    test("a done row opens its read-only sheet: the answer shown, no composer, its foot how and when it ended; J steps to the next done item", async () => {
      const { page } = await openDonePage();
      await selectRow(page, DONE_IDS.answered);
      const getSheet = () => page.evaluate(() => ({
        kind: document.querySelector(".queue-sheet-head .pill")?.textContent,
        foot: document.querySelector(".queue-sheet .card-foot")?.textContent,
        controls: document.querySelectorAll(".queue-sheet .card-foot :is(button, textarea, input)").length,
        hasAnswer: document.querySelector(".queue-sheet-body")?.textContent?.includes("Your answer"),
        position: document.querySelector(".queue-steps")?.textContent,
      }));
      await page.locator(".queue-sheet .card-foot", { hasText: "Answer R1 ·" }).waitFor();
      const answered = await getSheet();
      await page.keyboard.press("j");
      await page.locator(".queue-sheet .card-foot", { hasText: "Read ·" }).waitFor();
      const read = { ...(await getSheet()), hash: await page.evaluate(() => location.hash) };
      await page.close();

      const [at, of] = String(answered.position).split(" of ").map(Number);
      assert.deepEqual({ ...answered, position: undefined }, { kind: "Decision", foot: "Answer R1 · Nov 13 14:57", controls: 0, hasAnswer: true, position: undefined });
      assert.deepEqual(read, { kind: "Report", foot: "Read · Nov 13 14:00", controls: 0, hasAnswer: false, position: `${at! + 1} of ${of}`, hash: "#queue?item=802" });
      assert.ok(at! > 1, "the done rows step on from the open ones");
    });
  });

  describe("on the not-listening fixtures", () => {
    const SENTENCE = "Next turn — delivers at its next turn end or restart";
    const openNotListeningPage = (): Promise<Page> => {
      harness.fixture = getNotListeningFixture();
      return openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture));
    };

    test("under one order a listening recipient holds the tag Not yet and a not-listening one the tag Next turn: the same fill, told apart by its glyph and words, its sentence only in the title", async () => {
      const page = await openNotListeningPage();
      await page.locator(`#queue-order-${NOT_LISTENING_IDS.mixedOrder}`).scrollIntoViewIfNeeded();
      const rows = await page.evaluate((id) => [...document.querySelectorAll(`#queue-order-${id} .queue-recipient`)].map((row) => {
        const badge = row.querySelector(".pill--tag") as HTMLElement;
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        const painted: string[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) if (!node.parentElement?.closest(".sr-only")) painted.push(node.textContent ?? "");
        const glyph = badge.firstElementChild;
        const shapes = glyph?.tagName === "svg" ? [...glyph.children] : [];
        return {
          name: row.querySelector(".queue-recipient-name")?.textContent,
          word: [...badge.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join(""),
          isGlyphDrawn: glyph?.tagName === "svg" && glyph.childElementCount > 0,
          // solid in the badge's ink: every shape filled in the word's colour, none drawn as a hairline
          isGlyphSolid: shapes.length > 0 && shapes.every((shape) => getComputedStyle(shape).fill === getComputedStyle(badge).color && getComputedStyle(shape).stroke === "none"),
          title: badge.getAttribute("title"),
          background: getComputedStyle(badge).backgroundColor,
          isSentencePainted: painted.join("").includes("delivers at"),
        };
      }), NOT_LISTENING_IDS.mixedOrder);
      await page.close();

      assert.deepEqual(rows.map(({ background: _background, ...row }) => row), [
        { name: "gersona", word: "Not yet", isGlyphDrawn: false, isGlyphSolid: false, title: null, isSentencePainted: false },
        { name: "sixmon", word: "Next turn", isGlyphDrawn: true, isGlyphSolid: true, title: SENTENCE, isSentencePainted: false },
      ]);
      assert.equal(rows[0]?.background, rows[1]?.background, "one tag fill for both");
    });

    test("a live session that does not listen draws the bare pause mark in its tag column, named Next turn, its hover line the title and the box's description by keyboard; a listening one draws no tag", async () => {
      const page = await openNotListeningPage();
      const tagOf = (id: string) => page.locator(`.queue-rail-row[data-session="${id}"] .queue-rail-tag`);
      const mark = await tagOf(NOT_LISTENING_SESSION_IDS.nightly).getByRole("img", { name: "Next turn" }).evaluate((node) => ({
        glyph: node.querySelectorAll("svg rect").length, shell: getComputedStyle(node).borderTopWidth, width: Math.round(node.getBoundingClientRect().width),
      }));
      const listening = await tagOf(FIXTURE_SESSION_IDS.gersona).count();
      await page.keyboard.press("Tab");
      await page.getByLabel("Select nightly", { exact: true }).focus();
      const focused = await page.evaluate(() => {
        const box = document.activeElement as HTMLElement;
        const row = box.closest(".queue-rail-row") as HTMLElement;
        const description = (box.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
        return { name: box.getAttribute("aria-label"), title: row.title.split("\n")[0], description, isRing: getComputedStyle(row).outlineStyle !== "none" };
      });
      await page.close();

      const HOVER = "Next turn: orders reach it then. Restart it to deliver now.";
      assert.deepEqual({ mark, listening }, { mark: { glyph: 2, shell: "0px", width: 12 }, listening: 0 });
      assert.deepEqual([focused.name, focused.title, focused.description.startsWith(HOVER), focused.isRing], ["Select nightly", HOVER, true, true], JSON.stringify(focused));
    });

    test("with a not-listening session ticked the composer's label paints the bare pause mark after its name and the note the sentence, and a send still posts the order", async () => {
      const page = await openNotListeningPage();
      await tickOrdersTo(page, ["nightly"]);
      const posts: string[] = [];
      page.on("request", (request) => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
      const shown = await page.evaluate(() => ({
        tagged: [...document.querySelectorAll(".queue-orders .queue-order-to")].map((to) => [to.firstChild?.textContent, to.querySelector(".queue-state-mark.is-pause")?.getAttribute("title"), to.querySelectorAll(".pill").length]),
        note: [...document.querySelectorAll(".queue-orders .card-foot p")].map((line) => line.textContent).find((text) => text?.includes("next turn")),
      }));
      await page.locator(`#${ORDER_BOX_ID}`).fill(FIXTURE_ORDER_TEXT);
      // armed before the click → a reply landing before the click resolves is still seen
      const sent = page.waitForResponse((response) => response.url().endsWith("/api/queue/owner/messages/send"));
      await page.locator(".queue-orders").getByRole("button", { name: /^Send to nightly/ }).click();
      await sent;
      await page.close();

      assert.deepEqual(shown, { tagged: [["nightly", "Next turn", 0]], note: "nightly gets this at its next turn. Restart it to deliver now." });
      assert.deepEqual(posts, ["/api/queue/owner/messages/send"]);
    });

    test("in the composer's label each ticked name stays on one line with its mark, and the comma between names follows the mark, at 1280 and 1440", async () => {
      const shown: Array<{ at: number; text: string; lines: number }> = [];
      for (const viewport of [MIN_WINDOW, VIEWPORTS[0]]) {
        for (const names of [["gersona", "nightly"], ["sixmon", "nightly"]]) {
          harness.fixture = getNotListeningFixture();
          const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
          await tickOrdersTo(page, names);
          const tos = await page.evaluate(() => [...document.querySelectorAll(".queue-orders .queue-order-to")].map((to) => {
            const range = document.createRange();
            range.selectNodeContents(to);
            // the mark and the name sit a few px apart on one line → a new line is a step of more than 10 in the boxes' middles
            const middles = [...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => (rect.top + rect.bottom) / 2).sort((a, b) => a - b);
            const lines = 1 + middles.filter((middle, index) => index > 0 && middle - (middles[index - 1] ?? middle) > 10).length;
            const marks = [...to.querySelectorAll("[role=img]")].map((mark) => `[${mark.getAttribute("aria-label")}]`);
            return { text: `${to.firstChild?.textContent}${marks.map((mark) => ` ${mark}`).join("")}${to.textContent?.trim().endsWith(",") ? "," : ""}`, lines };
          }));
          await page.close();
          shown.push(...tos.map((to) => ({ at: viewport.width, ...to })));
        }
      }

      assert.deepEqual(shown.filter((to) => to.lines !== 1), [], "one line per name and its mark");
      assert.deepEqual(shown.filter((to) => to.at === MIN_WINDOW.width).map((to) => to.text).slice(2), ["sixmon [Next turn],", "nightly [Next turn]"]);
    });

    test("an order to two sessions that do not listen reads 0 of 2 and ⏸ 2 in its tag column; the ended session's resume copy reads Not yet; nothing of the state is amber", async () => {
      const page = await openNotListeningPage();
      const shown = await page.evaluate((ids) => {
        const textOf = (selector: string) => (document.querySelector(selector)?.textContent ?? "").replace(/\s+/g, " ").trim();
        const cellsOf = (id: number) => ({ fact: textOf(`#queue-row-${id} .queue-row-fact`), tags: [...document.querySelectorAll(`#queue-row-${id} .queue-row-tag .pill`)].map((tag) => tag.getAttribute("title")) });
        const amber = [ids.mixedOrder, ids.deafOrder, ids.resumeOrder].flatMap((id) => [...document.querySelectorAll(`#queue-row-${id} .pill--warn, #queue-order-${id} .pill--warn`)]);
        return {
          deaf: cellsOf(ids.deafOrder),
          mixed: cellsOf(ids.mixedOrder),
          resume: textOf(`#queue-order-${ids.resumeOrder} .queue-recipient .pill`),
          amber: amber.length,
        };
      }, { mixedOrder: NOT_LISTENING_IDS.mixedOrder, deafOrder: NOT_LISTENING_IDS.deafOrder, resumeOrder: NOT_LISTENING_IDS.resumeOrder });
      await page.close();

      assert.deepEqual([shown.deaf, shown.mixed], [{ fact: "0 of 2", tags: ["2 next turn"] }, { fact: "0 of 2", tags: ["1 next turn"] }]);
      assert.deepEqual([shown.resume, shown.amber], ["Not yet", 0]);
    });

    test("an answered decision whose session does not listen says so in its date line and under the answer, before the pull line; its listening twin reads Not yet and that its session picks it up", async () => {
      const page = await openNotListeningPage();
      const sheetOf = async (id: number) => {
        await selectRow(page, id);
        await page.locator(`.queue-sheet .queue-date-line`).waitFor();
        const shown = await page.evaluate(() => ({
          receipt: document.querySelector(".queue-sheet .queue-date-line .pill--tag")?.firstChild?.nodeName === "svg"
            ? `⏸ ${[...(document.querySelector(".queue-sheet .queue-date-line .pill--tag")?.childNodes ?? [])].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join("")}`
            : document.querySelector(".queue-sheet .queue-date-line .pill--tag")?.textContent,
          lines: [...document.querySelectorAll(".queue-sheet p.fs-meta")].map((line) => line.textContent ?? ""),
        }));
        await page.getByRole("button", { name: "Back to the list" }).click();
        return shown;
      };
      const deaf = await sheetOf(NOT_LISTENING_IDS.answeredDecision);
      const listening = await sheetOf(108);
      await page.close();

      const deafLine = deaf.lines.findIndex((line) => line === "sixmon gets this answer at its next turn. Restart it to deliver now.");
      const pullLine = deaf.lines.findIndex((line) => line.startsWith("Run in that session:"));
      assert.deepEqual([deaf.receipt, deafLine >= 0, pullLine > deafLine], ["⏸ Next turn", true, true], JSON.stringify(deaf));
      assert.deepEqual([listening.receipt, listening.lines.includes("The session is listening: it picks up this answer on its own.")], ["Not yet", true], JSON.stringify(listening));
    });
  });

  // spec 44063 §14.4's edge cases: what the page shows for each, beside the rest state
  // the owner judges the hook's own capture on the Mac and the phone: every line whole, every hidden character a whole tile
  describe("on the secret-approval fixtures", () => {
    const PHONE: Viewport = { width: 360, height: 740, isMobile: true };
    const openScanPage = async (viewport: Viewport) => {
      harness.fixture = getScanApprovalFixture();
      harness.scanReadIds.length = 0;
      return openQueuePage(harness, viewport, getScanApprovalFixture().items[0]!.title);
    };
    const openScanSheet = async (page: Page, id: number, ready: string) => {
      await selectRow(page, id);
      await page.locator(".queue-sheet").getByText(ready).first().waitFor();
    };
    const GONE_ANSWER = "Not approved: the request is gone. Nothing will pass.";
    // the server drops the request after the lines are read → R1 answers its 409 and the list then reads gone; the wait stays under the 15 s check
    const sendDroppedApproval = async (page: Page) => {
      await openScanSheet(page, SCAN_IDS.one, "The line assigns a literal value.");
      await page.locator(`#queue-option-${SCAN_IDS.one}-R1`).check();
      harness.refusals.set("action", { status: 409, body: { error: "secret_request_gone" } });
      harness.fixture = { ...harness.fixture, items: harness.fixture.items.map((item) => (item.id === SCAN_IDS.one ? { ...item, scanApproval: SCAN_GONE_FACTS } : item)) };
      await page.locator(".queue-sheet").getByRole("button", { name: "Send answer" }).click();
      await page.locator(".queue-sheet").getByText("Gone: the monitor restarted.").waitFor({ timeout: 5_000 });
    };

    // the phone's width: queue.phone.e2e.test.ts
    test("at 1280 wide the long line wraps whole, each mark a whole tile, and the sheet scrolls nothing sideways", async () => {
      const page = await openScanPage(MIN_WINDOW);
      await openScanSheet(page, SCAN_IDS.long, "2 of 3 lines assign a literal value.");
      const shown = await page.evaluate((points) => {
        const plates = [...document.querySelectorAll<HTMLElement>(".queue-sheet .scan-plate")];
        const marks = [...document.querySelectorAll<HTMLElement>(".queue-sheet .scan-mark")];
        const texts = plates.flatMap((plate) => [...plate.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? ""));
        const body = document.querySelector<HTMLElement>(".queue-sheet > .card-body")!;
        const getRgb = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        const getLuminance = (rgb: number[]) => {
          const [r, g, b] = rgb.map((channel) => { const c = channel / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
          return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
        };
        const getRatio = (one: string, two: string) => {
          const [high, low] = [getLuminance(getRgb(one)), getLuminance(getRgb(two))].sort((a, b) => b - a);
          return (high! + 0.05) / (low! + 0.05);
        };
        const tile = getComputedStyle(marks[0]!);
        return {
          plates: plates.length,
          isBodyScrolledSideways: body.scrollWidth > body.clientWidth,
          isEveryPlateWhole: plates.every((plate) => plate.scrollWidth === plate.clientWidth && plate.scrollHeight === plate.clientHeight),
          isEveryPlateUncut: plates.every((plate) => { const style = getComputedStyle(plate); return style.textOverflow !== "ellipsis" && style.maxHeight === "none" && style.overflowX !== "auto"; }),
          isLongWrapped: plates[1]!.getBoundingClientRect().height > 20 * parseFloat(getComputedStyle(plates[1]!).lineHeight),
          isEveryTileWhole: marks.every((mark) => mark.getClientRects().length === 1),
          labels: marks.map((mark) => mark.textContent),
          hasRawMark: texts.some((text) => points.some((point) => text.includes(String.fromCodePoint(point)))),
          contrast: { tileText: getRatio(tile.color, tile.backgroundColor) >= 4.5, tilePlate: getRatio(tile.backgroundColor, getComputedStyle(plates[1]!).backgroundColor) >= 3 },
        };
      }, [...SCAN_MARK_POINTS]);
      await page.close();

      const labels = [...SCAN_MARK_POINTS.map((point) => `U+${point.toString(16).toUpperCase().padStart(4, "0")}`), "U+0020"];
      assert.deepEqual(shown, {
        plates: 3, isBodyScrolledSideways: false, isEveryPlateWhole: true, isEveryPlateUncut: true, isLongWrapped: true,
        isEveryTileWhole: true, labels, hasRawMark: false, contrast: { tileText: true, tilePlate: true },
      });
    });

    test("each line head keeps its columns at 1280: the length whole in 128 after a 12 gap, the line count never split", async () => {
      const page = await openScanPage(MIN_WINDOW);
      await openScanSheet(page, SCAN_IDS.long, "2 of 3 lines assign a literal value.");
      const heads = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".queue-sheet .scan-line-head")].map((head) => {
        const [, length, classes] = [...head.children] as HTMLElement[];
        const count = classes!.querySelector<HTMLElement>("span")!;
        const text = document.createRange();
        text.selectNodeContents(length!);
        return {
          columns: getComputedStyle(head).gridTemplateColumns.split(" ").slice(0, 2), gap: getComputedStyle(head).columnGap,
          isLengthWhole: length!.scrollWidth <= length!.clientWidth && text.getClientRects().length === 1,
          isCountWhole: count.getClientRects().length === 1,
        };
      }));
      await page.close();

      assert.deepEqual(heads, Array.from({ length: 3 }, () => ({ columns: ["112px", "128px"], gap: "12px", isLengthWhole: true, isCountWhole: true })));
    });

    test("a closed Approve is drawn closed: code, label and sides dim at 400, the radio disabled-looking with no hover, its reason line in ink", async () => {
      const page = await openScanPage(MIN_WINDOW);
      await openScanSheet(page, SCAN_IDS.expired, "Expired: no answer within 24 hours.");
      const radio = page.locator(`#queue-option-${SCAN_IDS.expired}-R1`);
      const readLook = () => page.evaluate((id) => {
        const option = document.getElementById(id)!.closest<HTMLElement>(".queue-option")!;
        const style = (selector: string) => getComputedStyle(option.querySelector(selector)!);
        const tone = (name: string) => `rgb(${getComputedStyle(document.documentElement).getPropertyValue(name).trim().split(/\s+/).join(", ")})`;
        const radioStyle = getComputedStyle(document.getElementById(id)!);
        return {
          code: style(".queue-option-head .text-dim").color === tone("--dim"),
          label: [style(".queue-option-head").color === tone("--dim"), style(".queue-option-head").fontWeight],
          sides: [...option.querySelectorAll(".queue-option-sides > span")].every((side) => getComputedStyle(side).color === tone("--dim")),
          reason: style(".queue-option-reason").color === tone("--ink"),
          radio: [radioStyle.opacity, radioStyle.cursor, radioStyle.borderColor, getComputedStyle(option).cursor, getComputedStyle(option).backgroundColor],
        };
      }, `queue-option-${SCAN_IDS.expired}-R1`);
      const rest = await readLook();
      await radio.hover();
      const hovered = await readLook();
      await page.close();

      assert.deepEqual({ ...rest, radio: rest.radio.slice(0, 2), option: rest.radio[3] }, { code: true, label: [true, "400"], sides: true, reason: true, radio: ["0.5", "default"], option: "default" });
      assert.deepEqual(hovered.radio, rest.radio, "hover changes nothing on a closed option");
    });

    test("at 1440 the Session fact holds the whole session id, then the name, on one line", async () => {
      const page = await openScanPage(VIEWPORTS[0]);
      const { session } = harness.fixture.items.find((item) => item.id === SCAN_IDS.one)!;
      await openScanSheet(page, SCAN_IDS.one, "The line assigns a literal value.");
      const fact = await page.evaluate(() => {
        const label = [...document.querySelectorAll(".queue-sheet .scan-facts > dt")].find((dt) => dt.textContent === "Session")!;
        const value = label.nextElementSibling as HTMLElement;
        return { first: value.firstElementChild?.textContent, text: value.textContent, isOneLine: value.getBoundingClientRect().height <= parseFloat(getComputedStyle(value).lineHeight) + 0.5 };
      });
      await page.close();

      assert.deepEqual(fact, { first: session.id, text: `${session.id} ${session.name}`, isOneLine: true });
    });

    test("the warning line sits 24 under the facts and 12 above the Options heading", async () => {
      const page = await openScanPage(MIN_WINDOW);
      await openScanSheet(page, SCAN_IDS.one, "The line assigns a literal value.");
      const gaps = await page.evaluate(() => {
        const facts = document.querySelector(".queue-sheet .scan-facts")!.getBoundingClientRect();
        const warning = document.querySelector(".queue-sheet .scan-warning")!.getBoundingClientRect();
        const legend = document.querySelector(".queue-sheet .queue-options > legend")!.getBoundingClientRect();
        return { facts: Math.round(warning.top - facts.bottom), options: Math.round(legend.top - warning.bottom) };
      });
      await page.close();

      assert.deepEqual(gaps, { facts: 24, options: 12 });
    });

    // [tag, fact] per row; a fact cell left out reads null
    const ENDED_TAG_ROWS = [
      {
        name: "at 1280, with the fact cell left out, an ended request's tag says Expired or Gone and a waiting one Approval", viewport: MIN_WINDOW,
        expected: { [SCAN_IDS.one]: ["Approval", null], [SCAN_IDS.expired]: ["Expired", null], [SCAN_IDS.gone]: ["Gone", null] },
      },
      {
        name: "at 1440, beside the fact cell, every request's tag says Approval and an ended one's fact Expired or Gone", viewport: VIEWPORTS[0],
        expected: { [SCAN_IDS.one]: ["Approval", "1 line"], [SCAN_IDS.expired]: ["Approval", "Expired"], [SCAN_IDS.gone]: ["Approval", "Gone"] },
      },
    ];
    for (const row of ENDED_TAG_ROWS) {
      test(row.name, async () => {
        const page = await openScanPage(row.viewport);
        const shown = await page.evaluate((ids) => Object.fromEntries(ids.map((id) => {
          const item = document.getElementById(`queue-row-${id}`)!;
          const fact = item.querySelector<HTMLElement>(".queue-row-fact")!;
          return [id, [item.querySelector<HTMLElement>(".queue-row-tag")!.innerText.trim(), getComputedStyle(fact).display === "none" ? null : fact.innerText.trim()]];
        })), [SCAN_IDS.one, SCAN_IDS.expired, SCAN_IDS.gone]);
        await page.close();

        assert.deepEqual(shown, row.expected);
      });
    }

    test("Send answer on a request the server dropped re-reads at once: the Gone line, no plate or read fact, Approve closed and unpicked, the alert kept", async (t) => {
      t.after(() => harness.refusals.delete("action"));
      const page = await openScanPage(MIN_WINDOW);
      await sendDroppedApproval(page);
      const shown = await page.evaluate((id) => {
        const sheet = document.querySelector<HTMLElement>(".queue-sheet")!;
        const approve = document.getElementById(`queue-option-${id}-R1`) as HTMLInputElement;
        const send = [...sheet.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Send answer")!;
        return {
          plates: sheet.querySelectorAll(".scan-plate").length,
          facts: [...sheet.querySelectorAll(".scan-facts dt")].map((label) => label.textContent),
          approve: [approve.disabled, approve.checked],
          isSendInk: send.classList.contains("primary"),
          alerts: [...sheet.querySelectorAll("[role=alert]")].map((alert) => alert.textContent?.trim()),
        };
      }, SCAN_IDS.one);
      await page.close();

      assert.deepEqual(shown, { plates: 0, facts: [], approve: [true, false], isSendInk: false, alerts: [`✕ ${GONE_ANSWER}`] });
    });

    test("the approved sheet keeps what the approval binds from the list, with no read of the lines after the yes", async () => {
      const page = await openScanPage(MIN_WINDOW);
      await openScanSheet(page, SCAN_IDS.approved, "The line was dropped; its hash remains.");
      const labels = await page.locator(".queue-sheet .scan-facts dt").allTextContents();
      const request = await page.locator(".queue-sheet .scan-facts dd").nth(labels.indexOf("Request")).textContent();
      await page.close();

      const { requestId } = getScanApprovalFixture().items.find((item) => item.id === SCAN_IDS.approved)!.scanApproval!;
      assert.deepEqual({ labels, request, reads: harness.scanReadIds }, { labels: ["File", "Rule", "Session", "Agent", "Request", "Approval"], request: requestId, reads: [] });
    });

    // the list still reads pending when the sheet opens, the store has dropped it → the read's 409 re-reads the list under the 15 s check
    test("a scan read the server answers 409 re-reads the list at once: the Gone line, no read fact", async () => {
      const page = await openScanPage(MIN_WINDOW);
      harness.fixture = { ...harness.fixture, items: harness.fixture.items.map((item) => (item.id === SCAN_IDS.unread ? { ...item, scanApproval: SCAN_GONE_FACTS } : item)) };
      await selectRow(page, SCAN_IDS.unread);
      await page.locator(".queue-sheet").getByText("Gone: the monitor restarted.").waitFor({ timeout: 5_000 });
      const facts = await page.locator(".queue-sheet .scan-facts dt").count();
      await page.close();

      assert.deepEqual({ facts, reads: harness.scanReadIds }, { facts: 0, reads: [SCAN_IDS.unread] });
    });

    test("the captured lines are read only when a waiting item's sheet opens, and its row says only how many lines", async () => {
      const page = await openScanPage(MIN_WINDOW);
      const before = [...harness.scanReadIds];
      const row = await page.locator(`#queue-row-${SCAN_IDS.one}`).getAttribute("aria-label");
      await openScanSheet(page, SCAN_IDS.one, "The line assigns a literal value.");
      await page.close();

      assert.deepEqual({ before, after: harness.scanReadIds, isRowFactOnly: /, Approval, 1 line, posted /.test(row ?? "") && !/hello|world|U\+/.test(row ?? "") }, { before: [], after: [SCAN_IDS.one], isRowFactOnly: true });
    });

    test("the named states are captured: the list, each sheet state at 1280, the phone at 360 beside an ordinary decision", async (t) => {
      const dir = await getShotsDir(t);
      t.diagnostic(`secret-approval card: ${dir}`);
      const sheet = (id: number, ready: string) => (page: Page) => openScanSheet(page, id, ready);
      const showEnd = (id: number, ready: string, selector: string) => async (page: Page) => {
        await openScanSheet(page, id, ready);
        await page.locator(selector).evaluate((node) => node.scrollIntoView({ block: "end" }));
      };
      const shots: Array<{ name: string; viewport: Viewport; setUp?: (page: Page) => Promise<void> }> = [
        { name: "1280-list", viewport: MIN_WINDOW },
        { name: "1280-list-delivery", viewport: MIN_WINDOW, setUp: (page) => page.locator(`#queue-row-${SCAN_IDS.approved}`).scrollIntoViewIfNeeded() },
        { name: "1280-sheet-pending", viewport: MIN_WINDOW, setUp: sheet(SCAN_IDS.one, "The line assigns a literal value.") },
        { name: "360-sheet-pending", viewport: PHONE, setUp: sheet(SCAN_IDS.one, "The line assigns a literal value.") },
        { name: "360-sheet-options-foot", viewport: PHONE, setUp: showEnd(SCAN_IDS.long, "2 of 3 lines assign a literal value.", ".queue-sheet .queue-options") },
        { name: "360-decision-sheet", viewport: PHONE, setUp: sheet(103, "Options") },
        {
          name: "1280-sheet-reading", viewport: MIN_WINDOW,
          setUp: async (page) => {
            await page.route("**/scan-approval", () => undefined);
            await openScanSheet(page, SCAN_IDS.one, "Reading the captured lines…");
          },
        },
        { name: "1280-sheet-read-failed", viewport: MIN_WINDOW, setUp: sheet(SCAN_IDS.unread, "The captured lines could not be read.") },
        { name: "1280-sheet-marks-long-line", viewport: MIN_WINDOW, setUp: sheet(SCAN_IDS.long, "2 of 3 lines assign a literal value.") },
        { name: "1280-sheet-long-line-tail", viewport: MIN_WINDOW, setUp: showEnd(SCAN_IDS.long, "2 of 3 lines assign a literal value.", ".queue-sheet .scan-plate >> nth=1") },
        { name: "1280-sheet-third-plate", viewport: MIN_WINDOW, setUp: showEnd(SCAN_IDS.long, "2 of 3 lines assign a literal value.", ".queue-sheet .scan-line >> nth=2") },
        { name: "360-sheet-marks-long-line", viewport: PHONE, setUp: sheet(SCAN_IDS.long, "2 of 3 lines assign a literal value.") },
        { name: "1280-sheet-approved", viewport: MIN_WINDOW, setUp: sheet(SCAN_IDS.approved, "The line was dropped; its hash remains.") },
        { name: "1280-sheet-ended", viewport: MIN_WINDOW, setUp: sheet(SCAN_IDS.ended, "Approval ended: used, expired or lost in a monitor restart.") },
        { name: "1280-sheet-declined", viewport: MIN_WINDOW, setUp: sheet(SCAN_IDS.declined, "The line was dropped; nothing was written.") },
        { name: "1280-sheet-withdrawn", viewport: MIN_WINDOW, setUp: sheet(SCAN_IDS.withdrawn, "The session withdrew the request. The line was dropped.") },
        { name: "1280-sheet-expired", viewport: MIN_WINDOW, setUp: sheet(SCAN_IDS.expired, "Expired: no answer within 24 hours.") },
        { name: "1280-sheet-gone", viewport: MIN_WINDOW, setUp: sheet(SCAN_IDS.gone, "Gone: the monitor restarted.") },
        { name: "1280-sheet-conflict", viewport: MIN_WINDOW, setUp: sendDroppedApproval },
      ];
      t.after(() => harness.refusals.delete("action"));
      for (const shot of shots) {
        const page = await openScanPage(shot.viewport);
        await shot.setUp?.(page);
        await page.screenshot({ path: join(dir, `card-${shot.name}.png`), animations: "disabled" });
        await page.close();
      }
      const sizes = await Promise.all(shots.map((shot) => getPngSize(join(dir, `card-${shot.name}.png`))));
      assert.deepEqual(sizes, shots.map((shot) => ({ width: shot.viewport.width, height: shot.viewport.height })));
    });
  });

  describe("on the edge-case fixtures", () => {
    test("a 9-option decision lists its nine options in the author's order with none picked, and its row reads 9 options", async () => {
      const page = await openEdgePage(harness);
      await selectRow(page, EDGE_IDS.nineOptions);
      const shown = await page.evaluate((id) => ({
        codes: [...document.querySelectorAll(".queue-sheet .queue-option-head .text-dim")].map((code) => code.textContent),
        picked: [...document.querySelectorAll<HTMLInputElement>(".queue-sheet .ctl-radio")].filter((radio) => radio.checked).length,
        hasCount: document.querySelector(`#queue-row-${id} .queue-row-fact`)?.textContent === "9 options",
      }), EDGE_IDS.nineOptions);
      await page.close();

      assert.deepEqual(shown, { codes: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9"], picked: 0, hasCount: true });
    });

    test("an approval-class decision carries the Approval tag on its row and its date line, and its approval line says in ink after an info glyph that an approving answer approves the stated action once", async () => {
      const page = await openEdgePage(harness);
      // the space between `2 options` and the Approval tag on the date line
      const getGap = (selector: string) => page.evaluate((within) => {
        const facts = document.querySelector(within);
        const tag = facts?.querySelector(".pill--tag");
        const count = [...(facts?.querySelectorAll("span") ?? [])].find((span) => /^\d+ options$/.test(span.textContent ?? ""));
        return tag && count ? Math.round(tag.getBoundingClientRect().left - count.getBoundingClientRect().right) : null;
      }, selector);
      // the open sheet takes the list's box → the row is read first
      const row = await page.evaluate((id) => [...document.querySelectorAll(`#queue-row-${id} .queue-row-tag .pill--tag`)].map((badge) => badge.textContent), EDGE_IDS.approval);
      await selectRow(page, EDGE_IDS.approval);
      const dateGap = await getGap(".queue-sheet .queue-date-facts");
      const shown = await page.evaluate(() => ({
        letterhead: [...document.querySelectorAll(".queue-sheet > .card-head .pill--tag, .queue-date-line .pill--tag")].map((badge) => badge.textContent),
        note: document.querySelector(".queue-sheet .queue-approval-line")?.textContent ?? "",
        // the sentence's own colour against the ink and the glyph's against the info token
        tones: (() => {
          const line = document.querySelector(".queue-sheet .queue-approval-line") as HTMLElement;
          const getToken = (name: string) => `rgb(${getComputedStyle(line).getPropertyValue(name).trim().split(/\s+/).join(", ")})`;
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          let sentence: Node | null = walker.nextNode();
          while (sentence !== null && !sentence.textContent?.startsWith("Approval:")) sentence = walker.nextNode();
          return {
            text: sentence?.parentElement ? getComputedStyle(sentence.parentElement).color === getToken("--ink") : false,
            glyph: getComputedStyle(line.querySelector("[aria-hidden]") as Element).color === getToken("--info"),
          };
        })(),
      }));
      await page.close();

      assert.deepEqual({ row, letterhead: shown.letterhead }, { row: ["Approval"], letterhead: ["Decision", "Approval"] });
      assert.equal(dateGap, 6, "the date line keeps 6 between the count and the tag");
      assert.match(shown.note, /Approval: approving here approves the action once\. aidl does not ask again in its terminal\./);
      assert.deepEqual(shown.tones, { text: true, glyph: true }, "the sentence in ink, its glyph in info");
    });

    // spec §6 → Foot lines, §9.8 → On an answer: at the 1280 minimum eight images and a several-refused line leave the options their room
    test("at the 1280 minimum an approval with eight images and refused files keeps its thumbnails on one row, its tray line one line and both options in view", async () => {
      const state = ANSWER_STATES.find((one) => one.nn === "40i") as QueueState;
      const shown = await readQueueState(harness, MIN_WINDOW, state, (page) => page.evaluate(() => {
        const sheet = document.querySelector(".queue-sheet") as HTMLElement;
        const body = (sheet.querySelector(".card-body") as HTMLElement).getBoundingClientRect();
        return {
          thumbRows: new Set([...sheet.querySelectorAll(".queue-thumb")].map((thumb) => Math.round(thumb.getBoundingClientRect().top))).size,
          trayHeight: Math.round((sheet.querySelector(".queue-tray-line") as HTMLElement).getBoundingClientRect().height),
          optionsOutOfView: [...sheet.querySelectorAll(".queue-option")].filter((option) => option.getBoundingClientRect().bottom > body.bottom).length,
        };
      }));

      assert.deepEqual(shown, { thumbRows: 1, trayHeight: 20, optionsOutOfView: 0 });
    });

    // C-approval-line: a failed upload and a press with nothing picked land on their own lines, the approval line in view above them
    test("an approval-class decision keeps its approval line in view, one 20 line a sentence, through a failed upload on the tray line and a missing answer on the note line", async () => {
      const page = await openEdgePage(harness);
      harness.refusals.set("upload", { status: 500, body: { error: "server" } });
      await selectRow(page, EDGE_IDS.approval);
      await setFiles(page, `queue-text-${EDGE_IDS.approval}`, [getImageFile(0)]);
      await page.locator(".queue-sheet .queue-thumb-failed").waitFor();
      await page.locator(".queue-sheet").getByRole("button", { name: "Send answer" }).click();
      const shown = await page.evaluate(() => {
        const sheet = document.querySelector(".queue-sheet") as HTMLElement;
        const line = sheet.querySelector(".queue-approval-line") as HTMLElement;
        const rect = line.getBoundingClientRect();
        const text = (selector: string) => (sheet.querySelector(selector)?.textContent ?? "").replace(/\s+/g, " ").trim();
        return {
          isInView: rect.top >= 0 && rect.bottom <= window.innerHeight,
          height: Math.round(rect.height),
          tray: text(".queue-tray-line"),
          note: text(".queue-note-text"),
          description: sheet.querySelector(`#${CSS.escape(sheet.querySelector('[data-key="send"]')?.getAttribute("aria-describedby") ?? "")}`) === line,
        };
      });
      harness.refusals.clear();
      await page.close();

      assert.deepEqual(shown, {
        isInView: true, height: 40,
        tray: "✕ queue-01.webp could not be uploaded: the monitor answered 500.Try again",
        note: "✕ Pick an option or write an answer, then send.",
        description: true,
      });
    });

    test("a 200-character title takes one cut line on its 44 row with the whole title in its tooltip, and wraps in full at 20/28 on the sheet", async () => {
      const page = await openEdgePage(harness, DESK_WIDTHS[0].viewport);
      // the row is measured before its press: an opened row puts the list away
      const row = await page.evaluate((id) => {
        const element = document.querySelector(`#queue-row-${id}`) as HTMLElement;
        const title = element.querySelector(".queue-row-title") as HTMLElement;
        return [Math.round(element.getBoundingClientRect().height), title.getAttribute("title"), getComputedStyle(title).textOverflow === "ellipsis" && title.scrollWidth > title.clientWidth];
      }, EDGE_IDS.longTitle);
      await selectRow(page, EDGE_IDS.longTitle);
      const sheet = await page.evaluate(() => {
        const title = document.querySelector(".queue-sheet-title") as HTMLElement;
        const style = getComputedStyle(title);
        return [title.textContent, title.scrollHeight <= title.clientHeight, `${style.fontSize}/${style.lineHeight}`];
      });
      await page.close();

      assert.deepEqual({ row, sheet }, { row: [44, EDGE_LONG_TITLE, true], sheet: [EDGE_LONG_TITLE, true, "20px/28px"] });
    });

    test("a report whose text names its linked document links the id in its text and adds no Documents line", async () => {
      const page = await openEdgePage(harness);
      await selectRow(page, EDGE_IDS.linkedReport);
      const shown = await page.evaluate(() => ({
        links: [...document.querySelectorAll(".queue-sheet-body .prose-link")].map((link) => `${link.textContent} ${link.getAttribute("href")}`),
        hasDocumentsLine: document.querySelector(".queue-sheet-body")?.textContent?.includes("Documents:") === true,
      }));
      await page.close();

      assert.deepEqual(shown, { links: ["44061 #clauded-docs?doc=44061"], hasDocumentsLine: false });
    });

    test("a declared document the text does not name gets a Documents line linking its id", async () => {
      const page = await openEdgePage(harness);
      await selectRow(page, EDGE_IDS.declaredReport);
      const line = await page.evaluate(() => {
        const block = [...document.querySelectorAll(".queue-sheet-body .prose-text")].find((text) => text.textContent?.startsWith("Documents:"));
        return block === undefined ? null : [block.textContent, block.querySelector(".prose-link")?.getAttribute("href")];
      });
      await page.close();

      assert.deepEqual(line, ["Documents: 44071", "#clauded-docs?doc=44071"]);
    });

    test("two sessions with one name each show their 8-character id on the rail, and a session with its own name shows none", async () => {
      const page = await openEdgePage(harness);
      const names = await page.evaluate(() => [...document.querySelectorAll(".queue-rail-name")].map((name) => [...name.children].map((part) => part.textContent).join(" · ")));
      await page.close();

      assert.deepEqual(
        { atrium: names.filter((name) => name?.startsWith("atrium")), gersona: names.filter((name) => name?.startsWith("gersona")) },
        { atrium: [`atrium · ${FIXTURE_SESSION_IDS.atrium.slice(0, 8)}`, `atrium · ${EDGE_SESSION_IDS.twin.slice(0, 8)}`], gersona: ["gersona"] },
      );
    });

    // the page cannot check a name → it says so where the names are listed, read in place by eye and by a reader
    // the phone's short form (SR-3b) is the phone's alone → at 1280 neither the list, Orders nor a relay's sheet draws it
    test("at 1280 the rail's head shows the statement on names in full, in view, and in the accessibility tree, and the short form is nowhere", async () => {
      const statement = "Session names are written by the sessions themselves and are not checked. Only the id identifies a session.";
      const short = "Names are self-written and unchecked. Only the id identifies a session.";
      harness.fixture = getRelayRowFixture();
      const page = await openQueuePage(harness, MIN_WINDOW, getRestReadyText(harness.fixture));
      const shown = await page.locator(".queue-sessions > .card-bar").evaluate((bar) => {
        const box = bar.getBoundingClientRect();
        return { text: bar.textContent, isWhole: bar.scrollHeight <= bar.clientHeight && box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight, isConcealed: bar.closest("[aria-hidden='true'], [hidden]") !== null };
      });
      const tree = await page.locator(".queue-sessions").ariaSnapshot();
      const getShortShown = async () => [(await page.locator(".queue-screen").ariaSnapshot()).includes(short), await page.getByText(short, { exact: true }).evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length > 0).length)];
      const atRest = await getShortShown();
      await selectRow(page, RELAY_ROW_IDS.one);
      await page.locator(".queue-sheet").getByText("응답 예시").first().waitFor({ timeout: READY_TIMEOUT_MS });
      const inRelay = await getShortShown();
      await page.close();

      assert.deepEqual([shown, tree.includes(statement), atRest, inRelay], [{ text: statement, isWhole: true, isConcealed: false }, true, [false, 0], [false, 0]]);
    });

    test("at 1280 two rail entries whose names differ only in case and a trailing space each show their 8-character id whole", async () => {
      harness.fixture = getConfusableNameFixture();
      const page = await openQueuePage(harness, MIN_WINDOW, getRestReadyText(harness.fixture));
      const ids = await page.evaluate((sessionIds) => sessionIds.map((id) => {
        const shown = document.querySelector<HTMLElement>(`.queue-rail-row[data-session="${id}"] .queue-rail-id`);
        return shown === null ? null : [shown.textContent, shown.scrollWidth <= shown.clientWidth && shown.getBoundingClientRect().right <= shown.closest(".queue-rail-row")!.getBoundingClientRect().right];
      }), [FIXTURE_SESSION_IDS.gersona, CONFUSABLE_SESSION_ID]);
      await page.close();

      assert.deepEqual(ids, [[FIXTURE_SESSION_IDS.gersona.slice(0, 8), true], [CONFUSABLE_SESSION_ID.slice(0, 8), true]]);
    });

    // the id is what tells the two apart → at the owner's narrowest desk it stays whole while the name is cut
    test("at 1280 an item from one of two sessions with one name shows that session's 8-character id whole after the name in its letterhead", async () => {
      const page = await openEdgePage(harness, MIN_WINDOW);
      await selectRow(page, EDGE_IDS.declaredReport);
      const id = await page.evaluate(() => {
        const shown = document.querySelector<HTMLElement>(".queue-sheet .queue-letter-name code");
        const head = document.querySelector<HTMLElement>(".queue-sheet .queue-letter-name")!.getBoundingClientRect();
        return shown === null ? null : { text: shown.textContent, isWhole: shown.scrollWidth <= shown.clientWidth && shown.getBoundingClientRect().right <= head.right + 0.5 };
      });
      await page.close();

      assert.deepEqual(id, { text: EDGE_SESSION_IDS.twin.slice(0, 8), isWhole: true });
    });

    // the twin session's report and a decision moved to it, both numbered at four digits → the widest number beside a letterhead's
    // kind, (self-named) and 8-character id, the parts that tell the two sessions apart; at 1280 the position text yields for them
    test("at 1280 a report and a decision from one of two same-named self-named sessions keep the four-digit number and the 8-character id whole in the row and the sheet head, the position out of sight and still read; at 1440 the position shows", async () => {
      const ids = { report: 9000 + EDGE_IDS.declaredReport, decision: 9000 + EDGE_IDS.nineOptions };
      const edge = getEdgeFixture();
      const twin = edge.items.find((item) => item.id === EDGE_IDS.declaredReport)!.session;
      const moved = new Map<number, { id: number; session?: typeof twin }>([[EDGE_IDS.declaredReport, { id: ids.report }], [EDGE_IDS.nineOptions, { id: ids.decision, session: twin }]]);
      const fixture = { ...edge, items: edge.items.map((item) => ({ ...item, ...moved.get(item.id) })) };
      const shown = [];
      for (const viewport of [MIN_WINDOW, VIEWPORTS[0]]) {
        for (const id of [ids.report, ids.decision]) {
          harness.fixture = fixture;
          const page = await openQueuePage(harness, viewport, getRestReadyText(fixture));
          const row = await page.evaluate((rowId) => {
            const cells = ["#queue-row-" + rowId + " > .queue-row-id", "#queue-row-" + rowId + " > .queue-row-title code"].map((selector) => document.querySelector<HTMLElement>(selector)!);
            const title = cells[1]!.closest(".queue-row-title")!.getBoundingClientRect();
            return { number: cells[0]!.textContent, isNumberWhole: cells[0]!.scrollWidth <= cells[0]!.clientWidth, isIdWhole: cells[1]!.getBoundingClientRect().right <= title.right + 0.5 };
          }, id);
          await selectRow(page, id);
          const head = await page.evaluate(() => {
            const get = (selector: string) => document.querySelector<HTMLElement>(`.queue-sheet-head ${selector}`)!;
            const title = get(".card-title").getBoundingClientRect();
            const isWhole = (selector: string) => get(selector).scrollWidth <= get(selector).clientWidth && get(selector).getBoundingClientRect().right <= title.right + 0.5;
            return {
              number: get(".queue-sheet-id").textContent, isNumberWhole: get(".queue-sheet-id").scrollWidth <= get(".queue-sheet-id").clientWidth,
              letter: { id: get(".queue-letter-id").textContent?.trim(), isIdWhole: isWhole(".queue-letter-id"), isSelfWhole: isWhole(".queue-letter-self"), isTitleInside: title.right <= get(".queue-steps").getBoundingClientRect().left },
              isPositionShown: get(".queue-steps > .tabular-nums").getBoundingClientRect().width > 1,
            };
          });
          const tree = await page.locator(".queue-sheet-head").ariaSnapshot();
          await page.close();
          shown.push({ width: viewport.width, row, head: { ...head, isPositionRead: / \d+ of \d+/.test(tree) } });
        }
      }

      const letter = { id: EDGE_SESSION_IDS.twin.slice(0, 8), isIdWhole: true, isSelfWhole: true, isTitleInside: true };
      assert.deepEqual(shown, [MIN_WINDOW, VIEWPORTS[0]].flatMap((viewport) => [ids.report, ids.decision].map((id) => ({
        width: viewport.width,
        row: { number: `#${id}`, isNumberWhole: true, isIdWhole: true },
        head: { number: `#${id}`, isNumberWhole: true, letter, isPositionShown: viewport.width !== MIN_WINDOW.width, isPositionRead: true },
      }))));
    });

    // the registered 100-character name cut in the 104 column, the page's mark whole beside it; a start directory's name never marked
    test("at 1280 a decision or report row from a registered name cuts the name and paints its self mark whole, and a start-directory row paints none", async () => {
      harness.fixture = getNameColumnFixture();
      const page = await openQueuePage(harness, MIN_WINDOW, getRestReadyText(harness.fixture));
      const shown = await page.evaluate((longName) => [longName, "atrium-hooks"].map((named) => {
        const name = [...document.querySelectorAll<HTMLElement>(".queue-row-who .queue-row-name")].find((one) => one.title.startsWith(named))!;
        const who = name.closest(".queue-row-who")!.getBoundingClientRect();
        const mark = name.parentElement!.querySelector<HTMLElement>(".queue-row-mark");
        const markBox = mark?.getBoundingClientRect();
        const label = name.closest(".queue-row")!.getAttribute("aria-label")!;
        return {
          isNameCut: name.scrollWidth > name.clientWidth,
          mark: mark === null ? null : { text: mark.textContent, isWhole: mark.scrollWidth <= mark.clientWidth && markBox!.left >= name.getBoundingClientRect().right - 0.5 && markBox!.right <= who.right + 0.5 },
          label: [label.includes(`from ${named} (self-named): `), label.includes(", start directory")],
        };
      }), EDGE_LONG_SESSION_NAME);
      await page.close();

      assert.deepEqual(shown, [
        { isNameCut: true, mark: { text: "self", isWhole: true }, label: [true, false] },
        { isNameCut: false, mark: null, label: [false, true] },
      ]);
    });

    // the head is where the owner answers → a registered name's (self-named) is the page's own element, whole while the name is cut
    test("at 1280 the sheet head of a registered 100-character name cuts the name and keeps its (self-named) whole, and a start-directory head reads start directory with none", async () => {
      harness.fixture = getNameColumnFixture();
      const heads = [];
      for (const named of [EDGE_LONG_SESSION_NAME, "atrium-hooks"]) {
        const page = await openQueuePage(harness, MIN_WINDOW, getRestReadyText(harness.fixture));
        await page.locator(".queue-row-who .queue-row-name", { hasText: named.slice(0, 12) }).first().click();
        await page.locator(".queue-sheet .queue-letter-text", { hasText: named.slice(0, 12) }).waitFor();
        heads.push(await page.evaluate(() => {
          const head = document.querySelector<HTMLElement>(".queue-sheet .queue-letter-name")!.getBoundingClientRect();
          const name = document.querySelector<HTMLElement>(".queue-sheet .queue-letter-text")!;
          const self = document.querySelector<HTMLElement>(".queue-sheet .queue-letter-self");
          const selfBox = self?.getBoundingClientRect();
                    return {
            isNameCut: name.scrollWidth > name.clientWidth,
            isStartDirectory: name.textContent!.endsWith(" start directory"),
            self: self === null ? null : { text: self.textContent, isOutsideName: !name.contains(self), isWhole: self.scrollWidth <= self.clientWidth && selfBox!.right <= head.right + 0.5 && selfBox!.width > 0 },
          };
        }));
        await page.close();
      }

      const [registered, startDirectory] = heads;
      assert.deepEqual(
        [registered, { isStartDirectory: startDirectory?.isStartDirectory, self: startDirectory?.self }],
        [{ isNameCut: true, isStartDirectory: false, self: { text: " (self-named)", isOutsideName: true, isWhole: true } }, { isStartDirectory: true, self: null }],
      );
    });

    test("a 100-character session name stays on one cut line, its rail row 44 high and inside the rail", async () => {
      const page = await openEdgePage(harness);
      const shown = await page.evaluate((id) => {
        const row = document.querySelector(`.queue-rail-row[data-session="${id}"]`) as HTMLElement;
        const name = row.querySelector(".queue-rail-name-text") as HTMLElement;
        const rail = (document.querySelector(".queue-sessions") as HTMLElement).getBoundingClientRect();
        return {
          text: name.textContent,
          height: Math.round(row.getBoundingClientRect().height),
          isCut: getComputedStyle(name).textOverflow === "ellipsis" && name.scrollWidth > name.clientWidth,
          isInsideRail: row.getBoundingClientRect().right <= rail.right,
        };
      }, EDGE_SESSION_IDS.longName);
      await page.close();

      assert.deepEqual(shown, { text: EDGE_LONG_SESSION_NAME, height: 44, isCut: true, isInsideRail: true });
    });

    // spec §4.2 → Column rule, §14.3: one 44 line — number 40 · name 104 · title · tag 80 · fact 64 · age 32 · chevron 16, 8 between them and 12 on
    // either side of the title; a band draws the tag and the fact column only while one of its rows fills it, then on every row, an empty
    // cell keeping its width; a column a band leaves out gives the title its width (tag 88, fact 72); a list under 584 (1280) draws no
    // chevron, and with names shown and the tag drawn leaves the fact column out → a drawn title holds 160 from 1440 and 154 at 1280.
    // The edge fixture's 100-character session is one recipient of a seven-session order → the name fixture sends one open item from it;
    // the Done bands (spec §4.6), relays on their way (spec §9.9) and Done and refused relays beside decisions and reports (layout §6 → Shared x) follow the same rule
    test("with nothing ticked every list row, open, done, a relay on its way, a Done relay or a refused one, is one 44 line on its band's columns at 1280, 1440 and 1568: the number first, tag and fact drawn only in a band whose rows fill them, each drawn column at one x in every band, the title taking a left-out column's width, at least 160 of it from 1440 and 154 at 1280 where no chevron is drawn, a 100-character name cut inside its 104", async () => {
      // each cell's x from the row's start and its width; a cell the band does not draw → `-`
      const getLayout = (width: number, cols: string) => {
        const isTagShown = cols.split(" ").includes("tag");
        const isFactShown = cols.split(" ").includes("fact") && !(isTagShown && width < 584);
        const trailing = [isTagShown ? 80 : 0, isFactShown ? 64 : 0, 32, width < 584 ? 0 : 16];
        const drawn = trailing.filter((cell) => cell > 0);
        const title = width - 32 - 40 - 8 - 104 - drawn.reduce((sum, one) => sum + one) - 8 * (1 + drawn.length) - 8;
        let x = 16;
        return [[40, 8], [104, 12], [title, 12], ...trailing.map((cell) => [cell, cell === 0 ? 0 : 8])].map(([cell, after]) => {
          const at = cell === 0 ? "-" : `${x}+${cell}`;
          x += cell! + after!;
          return at;
        }).join(" ");
      };
      const shown = [];
      for (const { viewport } of DESK_WIDTHS.slice(0, 3)) {
        for (const [fixture, isDone] of [[getNameColumnFixture(), false], [getEdgeFixture(), false], [getDoneRelaysFixture(), true], [getRelayRowFixture(), false]] as const) {
          harness.fixture = fixture;
          const page = await openQueuePage(harness, viewport, getRestReadyText(fixture));
          if (isDone) await waitForDoneBands(page);
          const facts = await page.evaluate((longName) => {
            const rows = [...document.querySelectorAll(".queue-row")];
            const cells = [".queue-row-id", ".queue-row-who", ".queue-row-title", ".queue-row-tag", ".queue-row-fact", ".queue-row-age", ".queue-row-chevron"];
            const getCells = (row: Element) => cells.map((selector) => {
              const box = row.querySelector(selector)?.getBoundingClientRect();
              return box !== undefined && box.width > 0 ? `${Math.round(box.left - row.getBoundingClientRect().left)}+${Math.round(box.width)}` : "-";
            }).join(" ");
            const long = [...document.querySelectorAll<HTMLElement>(".queue-row-name")].find((name) => name.title === longName);
            const longBox = long?.closest(".queue-row-who")?.getBoundingClientRect();
            return {
              rowWidths: [...new Set(rows.map((row) => Math.round(row.getBoundingClientRect().width)))],
              bands: [...document.querySelectorAll<HTMLElement>(".queue-listbox [role='group']")]
                .map((band) => ({ cols: band.dataset.cols ?? "unset", layouts: [...new Set([...band.querySelectorAll(".queue-row")].map(getCells))] })),
              heights: [...new Set(rows.map((row) => Math.round(row.getBoundingClientRect().height)))],
              emptyTags: rows.filter((row) => row.querySelector(".queue-row-tag")?.childElementCount === 0).length,
              isLongCut: long === undefined || (longBox !== undefined && getComputedStyle(long).textOverflow === "ellipsis" && long.scrollWidth > long.clientWidth && long.getBoundingClientRect().right <= longBox.right + 0.5),
            };
          }, EDGE_LONG_SESSION_NAME);
          await page.close();
          shown.push({ width: viewport.width, isDone, ...facts });
        }
      }

      assert.ok(shown.every((one) => one.rowWidths.length === 1), "rows of one width");
      assert.ok(shown.some((one) => one.emptyTags > 0), "a drawn tag column keeps an empty cell's width");
      assert.deepEqual([...new Set(shown.flatMap((one) => one.bands.map((band) => band.cols)))].sort(), ["", "fact", "tag fact"], "bands that draw neither, the fact alone, and both");
      assert.deepEqual(
        shown.map(({ width, rowWidths, bands, heights, isLongCut }) => ({ width, bands, heights, isLongCut, pane: rowWidths[0] })),
        shown.map(({ width, rowWidths, bands }) => ({ width, bands: bands.map(({ cols }) => ({ cols, layouts: [getLayout(rowWidths[0]!, cols)] })), heights: [44], isLongCut: true, pane: rowWidths[0] })),
      );
      assert.deepEqual(shown.filter((one) => one.width < 1568).map((one) => one.rowWidths[0]), [482, 482, 482, 482, 586, 586, 586, 586], "the panes of DESK_WIDTHS, less the card's two 1 px borders");
      const titlesByWidth = shown.map((one) => ({ width: one.width, titles: one.bands.map((band) => Number(band.layouts[0]?.split(" ")[2]?.split("+")[1])) }));
      const [titles, titles1280] = [titlesByWidth.filter((one) => one.width >= 1440), titlesByWidth.filter((one) => one.width === 1280)].map((set) => set.flatMap((one) => one.titles));
      assert.ok(titles.every((title) => title >= 160), `the title from 1440 holds 160: ${titles}`);
      assert.ok(titles1280.length > 0 && titles1280.every((title) => title >= 154), `the 1280 title holds 154: ${titles1280}`);
    });

    // spec §9.3 / §18.4 27: the thread's recipient row holds the long name the rail holds — one cut line, the receipt and Resend whole beside it
    test("a 100-character session name stays on one cut line in its thread recipient row, its full name in the title, its receipt and Resend whole", async () => {
      const page = await openEdgePage(harness);
      await showThreadText(page, "7 sessions · 5 received · 1 not yet");
      const shown = await page.evaluate((longName) => {
        const name = [...document.querySelectorAll(".queue-recipient-name")].find((node) => node.textContent === longName) as HTMLElement;
        const row = name.closest(".queue-recipient") as HTMLElement;
        const thread = (row.closest(".queue-thread") as HTMLElement).getBoundingClientRect();
        const others = [...row.children].filter((child) => child !== name) as HTMLElement[];
        return {
          title: name.getAttribute("title"),
          isOneLine: name.getBoundingClientRect().height < 2 * parseFloat(getComputedStyle(name).lineHeight),
          isCut: getComputedStyle(name).textOverflow === "ellipsis" && name.scrollWidth > name.clientWidth,
          areOthersWhole: others.length === 2 && others.every((child) => child.scrollWidth <= child.clientWidth && child.getClientRects().length === 1 && child.getBoundingClientRect().height < 40),
          isInsideThread: row.getBoundingClientRect().left >= thread.left && row.getBoundingClientRect().right <= thread.right,
        };
      }, EDGE_LONG_SESSION_NAME);
      await page.close();

      assert.deepEqual(shown, { title: EDGE_LONG_SESSION_NAME, isOneLine: true, isCut: true, areOthersWhole: true, isInsideThread: true });
    });

    // spec §9.3 Bubble: the clamp clips at the text's box → a numbered list's widest marker (two digits past 9) stays inside it
    test("a clamped order bubble's numbered list holds its widest marker inside the clipped text box", async () => {
      const page = await openEdgePage(harness, VIEWPORTS[2]);
      await showThreadText(page, "Show all 31 lines");
      const lists = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".queue-bubble.is-clamped > .prose-text")].flatMap((prose) => {
        const clipLeft = prose.getBoundingClientRect().left + prose.clientLeft;
        return [...prose.querySelectorAll("ol")].map((list) => {
          const items = [...list.children] as HTMLElement[];
          const widest = `${list.start + items.length - 1}. `;
          const context = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;
          const marker = getComputedStyle(items.at(-1) as Element, "::marker");
          context.font = `${marker.fontWeight} ${marker.fontSize} ${marker.fontFamily}`;
          return { widest, overhang: Math.round(clipLeft - ((items.at(-1) as HTMLElement).getBoundingClientRect().left - context.measureText(widest).width)) };
        });
      }));
      await page.close();

      assert.ok(lists.some((list) => list.widest.length > 3), `a clamped list numbers past 9: ${JSON.stringify(lists)}`);
      assert.deepEqual(lists.filter((list) => list.overhang > 0), [], JSON.stringify(lists));
    });

    // spec §9.3 Bubble: a long order shows 12 whole lines under its clamp, block gaps between paragraphs and list items included
    test("a 31-line order's clamped bubble shows 12 whole lines and no line cut through", async () => {
      const page = await openEdgePage(harness);
      await showThreadText(page, "Show all 31 lines");
      const shown = await page.evaluate(() => {
        const prose = document.querySelector(".queue-bubble.is-clamped > .prose-text") as HTMLElement;
        const bottom = prose.getBoundingClientRect().bottom;
        const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
        const lines: DOMRect[] = [];
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const range = document.createRange();
          range.selectNodeContents(node);
          lines.push(...[...range.getClientRects()].filter((rect) => rect.height > 0));
        }
        const tops = new Set(lines.filter((rect) => rect.bottom <= bottom + 0.5).map((rect) => Math.round(rect.top)));
        return { shown: tops.size, isAnyCut: lines.some((rect) => rect.top < bottom - 0.5 && rect.bottom > bottom + 0.5) };
      });
      await page.close();

      assert.deepEqual(shown, { shown: 12, isAnyCut: false });
    });

    // spec §9.3 `Five recipients or more`: one roll-up, the chevron right before its counts; the amber badge may take its own line.
    // Counts wider than the order's column wrap between their segments, each `n word` whole, every line flush with the column's end
    const rollUps = [
      { name: "seven sessions in three segments", getFixture: getEdgeFixture, counts: "7 sessions · 5 received · 1 not yet" },
      { name: "seven sessions in four segments", getFixture: getNotListeningEdgeFixture, counts: "7 sessions · 5 received · 1 not yet · 1 next turn" },
      { name: "twelve sessions in four segments", getFixture: getNotListeningEdgeFixture, counts: "12 sessions · 10 received · 1 not yet · 1 next turn" },
    ];
    for (const viewport of [MIN_WINDOW, VIEWPORTS[0]]) {
      for (const rollUp of rollUps) {
        test(`at ${viewport.width}, ${rollUp.name}: the roll-up's counts stay inside the order's column, breaking only between whole segments, end-aligned, the chevron right before the first`, async () => {
          harness.fixture = rollUp.getFixture();
          const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
          await showThreadText(page, rollUp.counts);
          const shown = await page.evaluate((text) => {
            const counts = [...document.querySelectorAll(".queue-roll-up > summary *")].find((node) => node.textContent?.replace(/\s+/g, " ").trim() === text) as HTMLElement;
            const column = (counts.closest(".queue-order") as HTMLElement).getBoundingClientRect();
            const box = counts.getBoundingClientRect();
            const chevron = (counts.closest("summary") as HTMLElement).querySelector(".disclosure-chevron")?.getBoundingClientRect();
            const segments: DOMRect[][] = [];
            const walker = document.createTreeWalker(counts, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
              if (!node.textContent?.trim()) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              segments.push([...range.getClientRects()].filter((rect) => rect.width > 0));
            }
            const rects = segments.flat().sort((a, b) => a.top - b.top || a.left - b.left);
            const lines: DOMRect[][] = [];
            for (const rect of rects) {
              const line = lines.at(-1);
              if (line !== undefined && rect.top < line[0].bottom - 1) line.push(rect);
              else lines.push([rect]);
            }
            const first = [...(lines[0] ?? [])].sort((a, b) => a.left - b.left)[0];
            const gap = parseFloat(getComputedStyle(counts.closest("summary") as HTMLElement).columnGap) || 0;
            return {
              isInColumn: box.left >= column.left - 0.5 && box.right <= column.right + 0.5 && (chevron?.left ?? -1) >= column.left - 0.5,
              isEachSegmentWhole: segments.every((parts) => parts.length === 1),
              isEachLineEndAligned: lines.every((line) => Math.abs(Math.max(...line.map((rect) => rect.right)) - box.right) <= 1),
              isEachLineOneBaseline: lines.every((line) => line.every((rect) => Math.abs(rect.bottom - line[0].bottom) <= 0.5)),
              isChevronBeside: chevron !== undefined && first !== undefined && first.left - chevron.right >= 0 && first.left - chevron.right <= gap + 1 && chevron.top < first.bottom && chevron.bottom > first.top,
            };
          }, rollUp.counts);
          await page.close();

          assert.deepEqual(shown, { isInColumn: true, isEachSegmentWhole: true, isEachLineEndAligned: true, isEachLineOneBaseline: true, isChevronBeside: true });
        });
      }
    }

    test("a session with 128 items waiting shows 99+ in its 20 high count badge", async () => {
      const page = await openEdgePage(harness);
      const badge = await page.evaluate((id) => {
        const count = document.querySelector(`.queue-rail-row[data-session="${id}"] .queue-rail-count .pill`) as HTMLElement | null;
        return count === null ? null : [count.textContent, Math.round(count.getBoundingClientRect().height)];
      }, EDGE_SESSION_IDS.busy);
      await page.close();

      assert.deepEqual(badge, ["99+", 20]);
    });

    test("the thread holds order entries only, and an order to three sessions shows each recipient's one receipt and no other text", async () => {
      const page = await openEdgePage(harness);
      await waitForAllOrders(page);
      const shown = await page.evaluate(() => {
        const isOrdersOnly = [...document.querySelectorAll(".queue-day-group > *")].every((entry) => entry.matches(".queue-day, article.queue-order"));
        const entry = [...document.querySelectorAll("article.queue-order")].find((order) => order.querySelectorAll(".queue-recipient").length === 3);
        const recipients = [...(entry?.querySelectorAll(".queue-recipient") ?? [])].map((row) => {
          const copy = row.cloneNode(true) as HTMLElement;
          for (const button of copy.querySelectorAll("button")) button.remove();
          const name = row.querySelector(".queue-recipient-name")?.textContent ?? "";
          const receipts = copy.textContent?.match(/Received|Not yet|Not received/g) ?? [];
          const residue = (copy.textContent ?? "").replace(name, "").replace(/Received|Not yet|Not received/, "").replace(/[✓⚠·\s]|\d\d:\d\d/g, "");
          return { name, receipts, residue };
        });
        return { isOrdersOnly, recipients };
      });
      await page.close();

      assert.deepEqual(shown, {
        isOrdersOnly: true,
        recipients: [
          { name: "gersona", receipts: ["Received"], residue: "" },
          { name: "aidl", receipts: ["Not yet"], residue: "" },
          { name: "yoaida", receipts: ["Not received"], residue: "" },
        ],
      });
    });

    test("an order with eight images reads Order on its row, 8 images in the row's title, and shows eight 96 squares in its bubble, each named n of 8", async () => {
      const page = await openEdgePage(harness);
      const row = await page.evaluate((id) => [document.querySelector(`#queue-row-${id} .queue-row-fact`)?.textContent, document.querySelector(`#queue-row-${id}`)?.getAttribute("title")], EDGE_IDS.eightImages);
      await waitForAllOrders(page);
      const images = await page.evaluate(() => {
        const entry = [...document.querySelectorAll("article.queue-order")].find((order) => order.querySelectorAll(".queue-bubble-image").length > 3);
        return [...(entry?.querySelectorAll(".queue-bubble-image") ?? [])].map((button) => {
          const box = button.getBoundingClientRect();
          return `${Math.round(box.width)}x${Math.round(box.height)} ${button.getAttribute("aria-label")}`;
        });
      });
      await page.close();

      assert.deepEqual(row, ["Order", "Order · 8 images"]);
      assert.deepEqual(images, Array.from({ length: 8 }, (_, index) => `96x96 Open image ${index + 1} of 8: queue-edge-0${index + 1}.webp`));
    });

    // spec §4.2, §14.3: receipts in the tag column, worst first — `⚠ n` before `⏸ n` — each a count atom, both whole inside its 80
    test("a list row's receipt counts stand in its tag column, not received before next turn, both whole inside its 80, at 1280", async () => {
      harness.fixture = getNotListeningEdgeFixture();
      const page = await openQueuePage(harness, MIN_WINDOW, getRestReadyText(harness.fixture));
      const tags = await page.evaluate(() => [...document.querySelectorAll(".queue-row-tag")].filter((tag) => tag.childElementCount > 1).map((tag) => {
        const box = tag.getBoundingClientRect();
        const badges = [...tag.children];
        return {
          words: badges.map((badge) => (badge.getAttribute("title") ?? "").replace(/^\d+ /, "")),
          isCountAtom: badges.every((badge) => badge.matches(".pill--tag.pill--num")),
          isWhole: badges.every((badge) => badge.getBoundingClientRect().right <= box.right + 0.5 && badge.scrollWidth <= badge.clientWidth),
          width: Math.round(box.width),
        };
      }));
      await page.close();

      assert.ok(tags.length > 0, "a row counts both");
      assert.deepEqual(tags, tags.map(() => ({ words: ["not received", "next turn"], isCountAtom: true, isWhole: true, width: 80 })));
    });
  });
});
