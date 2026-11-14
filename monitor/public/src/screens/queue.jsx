// Queue screen — the desk: the Sessions pane, the list of decisions, reports and items in delivery under their bands,
// and the sheet showing the selected item as a one-page report with its composer (answer / order / Mark as read / later / Resend).
// Every server field renders as React text, never as HTML.
// "spec §N" in this file = the Queue desk design spec, clauded-docs 44063 (Atrium Monitor documents, outside the repo).
const {
	useState: useStateQ,
	useEffect: useEffectQ,
	useCallback: useCallbackQ,
	useRef: useRefQ,
	useLayoutEffect: useLayoutEffectQ,
} = React;

const OWNER_API_Q = "/api/queue/owner";
// MAX = the items read's own cap (schemas.ts → MAX_LIST_LIMIT)
const LIST_Q = { LIMIT: 100, MAX: 200, SOURCE: "the queue" };
const EMPTY_LIST_Q = Object.freeze({ status: "loading", data: null, error: null, readAt: null, newIds: [] });
// the page's own re-read (spec §4.4): 15 s after the last read settles, 60 s once three in a row have failed
const POLL_Q = { MS: 15_000, SLOW_MS: 60_000, SLOW_AFTER: 3 };
const QUEUE_TITLE_Q = "Queue";
const SESSION_PREFIX_LENGTH_Q = 8;
const ROW_ID_PREFIX_Q = "queue-row-";
const ORDER_ID_PREFIX_Q = "queue-order-";
// characters a POSIX shell never treats as syntax in an unquoted word
const SHELL_SAFE_Q = /^[A-Za-z0-9_@%+=:,./-]+$/;
const FILTER_AXES_Q = ["profile"];
const DEFAULT_FILTER_Q = Object.freeze({ profile: "" });
// every key the page keeps in its hash → one writer merges them all; an old link's session= or view= is left out at the first write
const HASH_KEYS_Q = ["profile", "item", "to"];
const LIST_GROUPS_Q = {
	decisions: { key: "decisions", label: "Decisions" },
	reports: { key: "reports", label: "Reports" },
	inDelivery: { key: "inDelivery", label: "In delivery" },
};

// one vocabulary on every surface (spec §9.4): whether a recipient has the order, never why it waits
const RECEIPT_Q = { received: "Received", notYet: "Not yet", notReceived: "Not received" };

function getNotReceivedFactQ(count) {
	return { text: `${count} not received`, badge: "warn" };
}

function getReceiptCountQ(receipts, receipt) {
	return receipts.filter((one) => one === receipt).length;
}

const RESUME_RESULT_LABEL_Q = {
	sent: "spawned",
	acked: "spawned · acknowledged",
	expired: "spawned · not acknowledged",
	held: "spawned · held",
	dead_socket: "failed",
	failed: "failed",
};
const ABORT_REASON_LABEL_Q = {
	session_returned: "not spawned: session came back",
	shared_worktree: "not spawned: another session in this worktree",
};

const SKIP_TEXT_Q = {
	approval: "approval needs your terminal: resume the session yourself",
	resume_used: "automatic resume used — Resend to try again",
	shared_worktree: "another session is live or resuming in this worktree: this one resumes automatically once that one has ended",
};
// outage words come from the shared copy owner (ui.jsx → getErrorCopy) → one outage reads one way across card, region and actions
const OUTAGE_KINDS_Q = new Set(["network", "database", "server"]);

// answer record: the route that answered, and the request signal the page-origin gate saw
const ANSWER_ROUTE_LABEL_Q = { answer: "Answered", reply: "Replied", message: "Sent as a message" };
// the gate proves a same-origin request, not which monitor page sent it → the line claims only that
const ANSWER_SIGNAL_LABEL_Q = {
	fetch_metadata: "through the monitor (same-origin request)",
	origin: "through the monitor (same-origin by its Origin header)",
	before_record: "before answers were recorded",
};
const OUTSIDE_ANSWER_LABEL_Q = "Answered outside the Queue page: the monitor holds no record of this answer";

// targets per send: the send route refuses more (schemas.ts → messageBodySchema; the page test binds the two)
const MESSAGE_Q = { MAX_TARGETS: 20 };
const SESSIONS_Q = { STACK_BELOW_PX: 640, SOURCE: "the session list" };
// one description every box of the rail shares (spec §9.1 → What says so before the first press)
const RAIL_HINT_Q = {
	ID: "queue-rail-hint",
	TEXT: "Ticked sessions set whose reports and orders are shown and who receives the next order. With none ticked, every session is shown and no order can be sent.",
};
const EMPTY_COMPOSER_Q = Object.freeze({ text: "", isBusy: false, error: null });
// per tab: each item's draft by id, and the order view's draft under its own key
const DRAFT_STORE_Q = { ITEMS: "queue.drafts", ORDER: "queue.orderDraft" };
const KEYS_Q = { STORE: "queue.keys" };
// the single letters of the desk (spec §11); 1 – 9 pick an option
const DESK_LETTERS_Q = { j: "next", k: "prev", r: "field", e: "read", l: "later", n: "new", o: "order" };
const DESK_KEY_LIST_Q = [
	{ keys: "J / K", does: "Next / previous row; the sheet follows" },
	{ keys: "↓ / ↑", does: "Next / previous row, in the list" },
	{ keys: "Home / End", does: "First / last row, in the list" },
	{ keys: "Enter", does: "From a row into the sheet; on an order, into the thread" },
	{ keys: "Esc", does: "From the sheet back to the row; from Orders back to the middle pane" },
	{ keys: "1 – 9", does: "Pick the option at that position" },
	{ keys: "R", does: "The sheet's field" },
	{ keys: "E", does: "Mark as read" },
	{ keys: "L", does: "Answer later / Read later" },
	{ keys: "N", does: "The Orders box" },
	{ keys: "O", does: "Tick the item's session, then the Orders box" },
	{ keys: "Cmd / Ctrl + Enter", does: "Send from the pane in focus" },
];
// PAGE, MAX = schemas.ts → ORDER_PAGE_LIMIT DEFAULT, MAX · a page test fails when the two part
const ORDERS_Q = { PAGE: 30, MAX: 100, CLAMP_LINES: 12, ROLL_UP_FROM: 5, DAY_MS: 24 * 60 * 60 * 1000, BOX_ID: "queue-order-text" };
// the middle pane's parts: the list body whose scroll the sheet keeps (a hidden box does not keep its own), the sheet body, the list's tab stop
const PANE_Q = { LIST_BODY: ".queue-list > .card-body", SHEET_BODY: ".queue-sheet > .card-body", TAB_STOP: '.queue-listbox [tabindex="0"]' };
const EMPTY_THREAD_Q = Object.freeze({ status: "loading", items: [], nextCursor: null, error: null });
const SESSION_STATE_LABEL_Q = { live: "Live" };
const EXIT_REASON_LABEL_Q = { ended: "Ended", dead: "Ended · process gone", replaced: "Replaced" };

const COMPOSER_ERROR_Q = {
	noAnswer: "Pick an option or write an answer, then send.",
	noOrder: "Write the order, then send.",
	noTick: "Tick at least one session in the rail.",
	unsentOrder: "Unsent order in the field. Send it, or clear it first.",
};
// the upload route's limits (queue/schemas.ts, queue/images.ts): the page checks before it uploads, the server stays the judge
const IMAGES_Q = {
	MAX: 8,
	BYTES_MAX: 10 * 1024 * 1024,
	NAME_MAX: 255,
	MB: 1024 * 1024,
	ACCEPT: "image/png,image/jpeg,image/webp,image/gif",
	TYPES_LINE: "only PNG, JPEG, WebP or GIF images",
	PASTED: "Pasted image",
	EXTENSION: { png: "png", jpeg: "jpg", webp: "webp", gif: "gif" },
};
const PNG_SIGNATURE_Q = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// shot key → its upload's promise, so a send waits for the uploads still running
const UPLOADS_Q = new Map();

/**
 * Queue nav slot: awaiting count plus a deviation glyph when any deviation is open.
 * Never read → no key (no zero that was not loaded) · read failed → "?" so the badge never goes blank.
 * @param countState - shell store of /api/queue/count
 */
function getQueueNavBadge(countState) {
	const count = getCountBadgeQ(countState);
	return count === null ? {} : { queue: { badges: [count] } };
}

/**
 * The document title while the Queue page is open → a background tab shows what waits.
 * Nothing awaiting, or a count not read → no count.
 * @param appTitle - the monitor's own title, which the page's name leads
 */
function getQueueTitle(countState, appTitle) {
	const awaiting = countState?.status === "ready" ? countState.data?.awaiting : null;
	const title = `${QUEUE_TITLE_Q} · ${appTitle}`;
	return Number.isInteger(awaiting) && awaiting > 0 ? `(${awaiting}) ${title}` : title;
}

// count slot alone: never read, or nothing awaiting and nothing deviating → null · failed or numberless read → "?"
function getCountBadgeQ(countState) {
	if (countState?.status !== "ready" && countState?.status !== "error") return null;
	const { awaiting, deviations } = countState.data ?? {};
	if (countState.status === "error" || !Number.isInteger(awaiting) || !Number.isInteger(deviations)) {
		return { badge: "?", title: "Queue count unavailable", description: "queue count unavailable" };
	}
	if (awaiting === 0 && deviations === 0) return null;
	const parts = [`${awaiting} awaiting you`, deviations > 0 && `${deviations} ${deviations === 1 ? "deviation" : "deviations"}`];
	const title = parts.filter(Boolean).join(", ");
	const glyph = deviations > 0 ? window.UI.TONE_GLYPH.warn : undefined;
	return { badge: String(awaiting), badgeTone: "warn", glyph, source: "queue", title, description: title };
}

/**
 * One owner request; never rejects on an HTTP status.
 * @returns status, parsed body (null when none) and the network error when the request never answered
 */
async function sendOwnerRequestQ(path, body) {
	const init = body === undefined
		? { headers: { Accept: "application/json" } }
		: { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) };
	try {
		const response = await fetch(`${OWNER_API_Q}${path}`, init);
		const data = await response.json().catch(() => null);
		return { status: response.status, data, error: null };
	} catch (error) {
		return { status: 0, data: null, error };
	}
}

function isOkAnswerQ(answer) {
	return answer.status >= 200 && answer.status < 300;
}

/** Failed list read → the shared failure copy `{ sentence, next, detail, kind }`, classified from the same detail the resume region stores. */
function getReadFailureQ(answer) {
	return window.UI.getErrorCopy(getAnswerDetailQ(answer), LIST_Q.SOURCE);
}

// no answer in any browser wording → the network step (these lines carry no Details) · a database outage or a server error → the shared next step · any other answer → null (the caller words it)
function getOutageStepQ(answer) {
	if (answer.status === 0) return window.UI.FETCH_ERROR_NEXT_STEP.network;
	const { kind, next } = getReadFailureQ(answer);
	return OUTAGE_KINDS_Q.has(kind) ? next : null;
}

// the status and the server's code, or the network error
function getAnswerDetailQ({ status, data, error }) {
	if (status === 0) return error?.message ?? String(error);
	return typeof data?.error === "string" ? `HTTP ${status} ${data.error}` : `HTTP ${status}`;
}

// Later → the item goes to the queue's end at once; the server's order replaces this on the next read
function putLaterQ(items, id) {
	const moved = items.find((item) => item.id === id);
	return moved === undefined ? items : [...items.filter((item) => item.id !== id), moved];
}

// next awaiting (open) card after the one just answered, wrapping to the first; none → null
function getNextAwaitingIdQ(items, id) {
	const index = items.findIndex((item) => item.id === id);
	const rest = [...items.slice(index + 1), ...items.slice(0, Math.max(index, 0))];
	return rest.find((item) => item.status === "open" && item.id !== id)?.id ?? null;
}

function getResumeResultLabelQ(resume) {
	if (resume.result === "aborted") return ABORT_REASON_LABEL_Q[resume.abortReason] ?? "not spawned";
	return RESUME_RESULT_LABEL_Q[resume.result] ?? resume.result;
}

/**
 * POSIX single-quote form → the shell reads the value as one literal word: a path the owner pastes never expands or splits.
 * A value inside the plain-path set stays bare, so a common path reads as typed.
 */
function getShellWordQ(value) {
	const text = String(value);
	return SHELL_SAFE_Q.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

function getConfigPrefixQ(session) {
	return session.configDir ? `CLAUDE_CONFIG_DIR=${getShellWordQ(session.configDir)} ` : "";
}

/** Marker note: captured-id form when the spawn recorded a bg id, else the listing form; `{ machine }` parts render mono. */
function getMarkerNoteQ(session) {
	const prefix = getConfigPrefixQ(session);
	const lead = `the resumed session may still be running in the background: under profile ${session.profileLabel}, `;
	const bgId = session.marker?.bgId;
	if (bgId) {
		const id = getShellWordQ(bgId);
		return [`${lead}check it with `, { machine: `${prefix}claude logs ${id}` }, ", and resume it yourself in a terminal only after ", { machine: `${prefix}claude stop ${id}` }];
	}
	return [
		`${lead}check `, { machine: `${prefix}claude agents --json --cwd ${getShellWordQ(session.cwd)}` }, " for the entry of session ", { machine: session.id },
		", and resume it yourself in a terminal only once that entry is no longer listed, or after ", { machine: `${prefix}claude stop <id>` }, " with that entry's id",
	];
}

function getMarkedOccupantNoteQ(occupant) {
	return [
		`waiting on ${occupant.profileLabel} · ${occupant.cwdTail} · `, { machine: occupant.sessionIdPrefix },
		", whose automatic resume has not registered: this one waits until that session registers or is resumed in a terminal (see its card), " +
			"and resumes automatically once that session has then ended",
	];
}

/**
 * Notes shown in place of (or beside) Resend, by card precedence: the marker on every card of a marked session,
 * then the server's sweep skip reason; a resume in flight shows nothing.
 * @returns one array of parts per note — a string is prose, `{ machine }` a command or id
 */
function getCardNotesQ(item) {
	if (item.session.marker) return [getMarkerNoteQ(item.session)];
	const skip = item.skipReason;
	if (!skip || skip.kind === "in_flight" || skip.kind === "marker") return [];
	if (skip.kind !== "shared_worktree") return [[SKIP_TEXT_Q[skip.kind]]];
	const marked = skip.markedOccupants.map(getMarkedOccupantNoteQ);
	const hasGeneric = skip.hasUnmarkedOccupant || marked.length === 0;
	return hasGeneric ? [...marked, [SKIP_TEXT_Q.shared_worktree]] : marked;
}

/**
 * Account filter choices from the loaded items; "" = All.
 * A chosen value no loaded item carries (a hash link) stays an option → the trigger still names it.
 */
function getFilterOptionsQ(items, filter = DEFAULT_FILTER_Q) {
	const profiles = [...new Set(items.map((item) => item.session.profileLabel))].sort();
	if (filter.profile && !profiles.includes(filter.profile)) profiles.unshift(filter.profile);
	return { profile: [{ key: "", label: "All" }, ...profiles.map((label) => ({ key: label, label }))] };
}

// #queue?profile=… → the filter survives a reload; an absent query → defaults
function getFilterFromHashQ() {
	const state = getHashStateQ();
	return Object.fromEntries(FILTER_AXES_Q.map((axis) => [axis, state[axis]]));
}

function setFilterHashQ(filter) {
	setHashStateQ(Object.fromEntries(FILTER_AXES_Q.map((axis) => [axis, filter[axis]])));
}

/** Every page key of the hash query, "" when absent. */
function getHashStateQ() {
	const { query } = getHashPartsQ();
	return Object.fromEntries(HASH_KEYS_Q.map((key) => [key, query.get(key) ?? ""]));
}

/**
 * The one hash writer: the patch merges over the keys already there → a write of one key never erases another.
 * replaceState → no history entry; an emptied key leaves the hash; no key left → a bare #queue.
 */
function setHashStateQ(patch) {
	const { screenId } = getHashPartsQ();
	const state = { ...getHashStateQ(), ...patch };
	const search = new URLSearchParams(HASH_KEYS_Q.filter((key) => state[key]).map((key) => [key, state[key]])).toString();
	const next = `#${search ? `${screenId}?${search}` : screenId}`;
	if (window.location.hash !== next) window.history.replaceState(null, "", next);
}

function getHashPartsQ() {
	const hash = window.location.hash.slice(1);
	const queryIndex = hash.indexOf("?");
	if (queryIndex < 0) return { screenId: hash, query: new URLSearchParams() };
	return { screenId: hash.slice(0, queryIndex), query: new URLSearchParams(hash.slice(queryIndex + 1)) };
}

/**
 * The list's bands in their fixed order — open decisions, open reports, everything else — each in server order; an empty band is left out.
 * A row is `{ id, item, copies }`: the copies of one owner send fold into one row under the lowest id (send id, else equal time and text).
 */
function getGroupsQ(items) {
	const isOpen = (kind) => (item) => item.kind === kind && item.status === "open";
	const rest = items.filter((item) => item.status !== "open" || (item.kind !== "decision" && item.kind !== "report"));
	const groups = [
		{ ...LIST_GROUPS_Q.decisions, rows: items.filter(isOpen("decision")).map(getSingleRowQ) },
		{ ...LIST_GROUPS_Q.reports, rows: items.filter(isOpen("report")).map(getSingleRowQ) },
		{ ...LIST_GROUPS_Q.inDelivery, rows: getFoldedRowsQ(rest) },
	];
	return groups.filter((group) => group.rows.length > 0);
}

function getSingleRowQ(item) {
	return { id: item.id, item, copies: [item] };
}

// first copy's position keeps the row in server order
function getFoldedRowsQ(items) {
	const byKey = new Map();
	for (const item of items) {
		const key = item.kind === "message" ? `send:${item.sendId ?? `${item.answeredAt}|${item.body}`}` : `item:${item.id}`;
		byKey.set(key, [...(byKey.get(key) ?? []), item]);
	}
	return [...byKey.values()].map((copies) => {
		const sorted = [...copies].sort((left, right) => left.id - right.id);
		return { id: sorted[0].id, item: sorted[0], copies: sorted };
	});
}

/** The row the hash's item opens on the sheet: a loaded row of the list as it stands that has a sheet; none, or an order's row → null. */
function getSelectedIdQ(groups, hashItemId) {
	return getSheetRowsQ(groups).find((row) => String(row.id) === hashItemId)?.id ?? null;
}

// every row but an order's opens on a sheet (spec §4.2) → the rows stepping and the position count
function getSheetRowsQ(groups) {
	return getRowsQ(groups).filter((row) => getKindWordQ(row.item) !== "Order");
}

// the bands' rows in list order
function getRowsQ(groups) {
	return groups.flatMap((group) => group.rows);
}

function getRowQ(groups, id) {
	return getRowsQ(groups).find((row) => row.id === id);
}

/**
 * What the middle pane shows, `{ kind, id, item? }`: `item` the opened row's sheet · `left` the opened open item the read no longer has open ·
 * `none` → the list (spec §4.3: nothing is opened for the owner; a session ticked out of scope takes its item's sheet with it).
 * @param held - the open item last shown on the sheet, null when none
 * @param ids - the ticks; none → every session in scope
 */
function getSheetStateQ(groups, hashItemId, held, ids = []) {
	if (!hashItemId) return { kind: "none", id: null };
	if (held?.session && ids.length > 0 && !ids.includes(held.session.id)) return { kind: "none", id: null };
	if (held !== null && hashItemId === String(held.id) && getRowQ(groups, held.id)?.item.status !== "open") {
		return { kind: "left", id: held.id, item: held };
	}
	const id = getSelectedIdQ(groups, hashItemId);
	return id === null ? { kind: "none", id: null } : { kind: "item", id, item: getRowQ(groups, id).item };
}

/**
 * The sheet's place among the rows that open on one: `index` -1 while its item is gone from the list.
 * @param lastIndex - the index the item last had → a gone item steps to the rows that stood beside it
 */
function getStepsQ(groups, id, lastIndex) {
	const rows = getSheetRowsQ(groups);
	const index = rows.findIndex((row) => row.id === id);
	const at = index >= 0 ? index : lastIndex;
	const prev = at > 0 ? rows[at - 1] : undefined;
	const next = at >= 0 ? rows[index >= 0 ? at + 1 : at] : undefined;
	return { index, count: rows.length, prevId: prev?.id ?? null, nextId: next?.id ?? null };
}

/** The list's scope: the Account filter and the ticks (spec §9.1); nothing ticked → every session's items. */
function getVisibleItemsQ(items, filter, ids = []) {
	return items.filter((item) => (!filter.profile || item.session.profileLabel === filter.profile) && (ids.length === 0 || ids.includes(item.session.id)));
}

/**
 * @param onReadQueueCount - the shell's count read (app.jsx) → the nav badge follows the page's own tick
 */
function ScreenQueue({ onRetryHarness, onReadQueueCount }) {
	const { TypeScaleStyle } = window.UI;
	const queue = useQueueStateQ({ onRetryHarness, onReadQueueCount });
	return (
		<div className="queue-screen">
			<TypeScaleStyle />
			<QueueHeaderQ queue={queue} />
			<QueueDeskQ queue={queue} />
		</div>
	);
}

/** DOM order Sessions → the middle pane → Orders: three fixed-role columns that never stack, and none is put away for another (spec §3.1). */
function QueueDeskQ({ queue }) {
	usePageDropGuardQ();
	const onKeyDown = (event) => {
		const action = getDeskKeyQ(event, { isKeysOn: queue.keys?.isOn ?? true });
		if (action === null) return;
		event.preventDefault();
		putDeskKeyQ(action, { queue, target: event.target, root: window.document });
	};
	return (
		<div className="queue-desk" onKeyDown={onKeyDown}>
			<SessionsRegionQ queue={queue} />
			<MiddlePaneQ queue={queue} />
			<OrdersViewQ queue={queue} />
		</div>
	);
}

/**
 * The desk's key (spec §11) as `{ name, index? }`, null when the key is not the desk's.
 * An open dialog (the key list, the viewer, the drawer) takes every key first; Enter, Esc and Cmd / Ctrl + Enter work in a field and with the switch off,
 * the single letters and digits (WCAG 2.1.4) only outside a text field and with it on.
 */
function getDeskKeyQ(event, { isKeysOn }) {
	const { key, target } = event;
	if (event.defaultPrevented || target?.closest?.('[role="dialog"]')) return null;
	const isInOrders = Boolean(target?.closest?.(".queue-orders"));
	if (key === "Escape") return getEscKeyQ(target, isInOrders);
	if (key === "Enter" && (event.metaKey || event.ctrlKey)) return target?.closest?.(".queue-sheet, .queue-orders") ? { name: "send" } : null;
	if (event.metaKey || event.ctrlKey || event.altKey) return null;
	if (key === "Enter") return target?.closest?.('[role="option"]') ? { name: "enter" } : null;
	if (!isKeysOn || isTextFieldQ(target)) return null;
	return getSingleKeyQ(key.toLowerCase(), isInOrders);
}

/**
 * The list, or the opened row's sheet in its place (spec §4.3): the list stays mounted under `hidden`, so its rows and state survive.
 * The status line's words reach a screen reader through this region while the list is put away.
 */
function MiddlePaneQ({ queue }) {
	const isSheetOpen = queue.sheet.kind !== "none";
	const { text } = getStatusLineQ(queue.status);
	return (
		<>
			<div className="queue-list-slot" hidden={isSheetOpen || undefined}>
				<QueueListQ queue={queue} />
			</div>
			<QueueSheetQ queue={queue} />
			<span role="status" className="sr-only">{isSheetOpen ? text : ""}</span>
		</>
	);
}

// in Orders Esc gives the focus back to the middle pane; in the sheet it leaves the sheet for the selected row
function getEscKeyQ(target, isInOrders) {
	if (isInOrders) return { name: "leave" };
	return target?.closest?.(".queue-sheet") ? { name: "back" } : null;
}

// the letters and digits belong to the list and the sheet → only N of the single keys is live in Orders (spec §11)
function getSingleKeyQ(letter, isInOrders) {
	if (isInOrders) return letter === "n" ? { name: "new" } : null;
	if (/^[1-9]$/.test(letter)) return { name: "pick", index: Number(letter) - 1 };
	const name = DESK_LETTERS_Q[letter];
	return name ? { name } : null;
}

// a checkbox, a radio or a button takes a letter as a key; a field the owner types in takes it as text
function isTextFieldQ(target) {
	if (!target) return false;
	if (target.isContentEditable || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return true;
	return target.tagName === "INPUT" && !["checkbox", "radio", "button", "submit", "reset", "file"].includes(target.type);
}

/**
 * Carries out a desk key's action (getDeskKeyQ).
 * @param target - the focused element the key was pressed on
 * @param root - the document the sheet's controls are looked up in
 */
function putDeskKeyQ(action, { queue, target, root }) {
	DESK_KEY_ACTS_Q[action.name]?.({ queue, target, root, index: action.index });
}

// each act presses or focuses what the owner would, so a busy or refusing control answers the key as it answers a press
const DESK_KEY_ACTS_Q = {
	leave: putLeftOrdersQ,
	new: ({ queue }) => queue.orders.focus(),
	next: (context) => putSteppedRowQ(context, "ArrowDown"),
	prev: (context) => putSteppedRowQ(context, "ArrowUp"),
	back: ({ queue }) => queue.back(),
	enter: putSheetEntryQ,
	pick: putPickedOptionQ,
	field: ({ root }) => root?.querySelector(".queue-sheet .queue-compose-text")?.focus(),
	read: ({ root }) => root?.querySelector('.queue-sheet [data-key="e"]')?.click(),
	later: ({ root }) => root?.querySelector('.queue-sheet [data-key="l"]')?.click(),
	send: putSendKeyQ,
	order: putOrderKeyQ,
};

// Cmd / Ctrl + Enter: in Orders its send button, inked or not, so a send with something missing says what as a press does · on the sheet its ink button
function putSendKeyQ({ target }) {
	const selector = target?.closest?.(".queue-orders") ? '.queue-composer [data-key="send"]' : ".queue-composer .btn.primary";
	target?.closest?.(".queue-sheet, .queue-orders")?.querySelector(selector)?.click();
}

// on a sheet → the neighbouring item's sheet; on the list → the focus to the row beside the focused one, opening nothing (spec §11)
function putSteppedRowQ({ queue, target, root }, key) {
	if (queue.sheet.kind !== "none") {
		const id = key === "ArrowDown" ? queue.steps.nextId : queue.steps.prevId;
		return void (id !== null && queue.selectRow(id));
	}
	const id = getKeyedRowIdQ(getRowsQ(queue.groups), getRowIdQ(target), key);
	if (id !== null) root?.getElementById(`${ROW_ID_PREFIX_Q}${id}`)?.focus();
}

// the list row holding the element, null off the list
function getRowIdQ(target) {
	const id = target?.closest?.('[role="option"]')?.id;
	return id?.startsWith(ROW_ID_PREFIX_Q) ? Number(id.slice(ROW_ID_PREFIX_Q.length)) : null;
}

// Enter on a row: its sheet in the list's place · an order's row → its entry in Orders, the list staying
function putSheetEntryQ({ queue, target }) {
	const row = getRowQ(queue.groups, getRowIdQ(target));
	if (!row) return;
	if (getKindWordQ(row.item) === "Order") return queue.openOrderRow(row);
	queue.selectRow(row.id);
}

function putPickedOptionQ({ queue, index }) {
	const item = getSheetOpenItemQ(queue.sheet);
	const option = item?.kind === "decision" ? (item.options ?? [])[index] : undefined;
	if (option) queue.setDraft(item.id, { code: option.code, error: null });
}

function getSheetOpenItemQ(sheet) {
	return sheet.kind === "item" && sheet.item.status === "open" ? sheet.item : null;
}

// a rail row's own session, else the focused list row's, else the open item's → added to the ticks there are, then the caret in the Orders box (spec §9.2)
function putOrderKeyQ({ queue, target }) {
	const railId = target?.closest?.("[data-session]")?.getAttribute("data-session");
	const row = getRowQ(queue.groups, getRowIdQ(target));
	const item = row?.item ?? (queue.sheet.kind === "item" ? queue.sheet.item : null);
	const id = railId || item?.session.id;
	const isTakingOrders = (queue.sessions.region.data?.sessions ?? []).some((row) => row.id === id && row.isSelectable);
	if (isTakingOrders) queue.sessions.setSelectedIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
	queue.orders.focus();
}

function putLeftOrdersQ({ queue, root }) {
	getPaneFocusQ(root, queue.selectedId)?.focus();
}

// the open sheet's body (mounted only while a sheet is open), else the list's current row, else its tab stop
function getPaneFocusQ(root, currentId) {
	return root?.querySelector(PANE_Q.SHEET_BODY) ?? root?.getElementById(`${ROW_ID_PREFIX_Q}${currentId}`) ?? root?.querySelector(PANE_Q.TAB_STOP);
}

// one status line and no button: the page checks on its own cadence (POLL_Q) and after each owner act (spec §3.1) · a failed resume or session read shows in its own region
function QueueHeaderQ({ queue }) {
	const { PageHeader } = window.UI;
	return <PageHeader title={QUEUE_TITLE_Q} freshness={<QueueFreshnessQ list={queue.list} failedChecks={queue.failedChecks} />} />;
}

/**
 * The page's own cadence · a failed read with rows on screen → since when they stand and when the next check runs (spec §4.4);
 * nothing loaded → the list card says it. One status region in both forms, so each turn is said once.
 * @param failedChecks - the page's checks failed in a row → the interval the line names
 */
function QueueFreshnessQ({ list, failedChecks = 0 }) {
	const { TONE_GLYPH, formatKstTime, formatKstFull } = window.UI;
	const title = list.readAt ? `Last read ${formatKstFull(list.readAt)}` : undefined;
	if (list.data === null || list.error === null) return <span className="fs-meta text-dim" role="status" title={title}>{`Checks every ${POLL_Q.MS / 1000}s`}</span>;
	return (
		<span className="fs-meta" role="status" title={title}>
			<span aria-hidden="true" className="text-warn">{`${TONE_GLYPH.warn} `}</span>
			{`Not updated · last read ${formatKstTime(list.readAt)} · trying again every ${getPollDelayQ(failedChecks) / 1000}s`}
		</span>
	);
}

/** Page state: the loaded list, its bands and selection, per-item drafts kept across re-reads, and the owner actions. */
function useQueueStateQ({ onRetryHarness, onReadQueueCount }) {
	const [list, setList] = useStateQ(EMPTY_LIST_Q);
	const [resumes, readResumes] = useRecentResumesQ();
	const [drafts, setDrafts] = useStoredStateQ(DRAFT_STORE_Q.ITEMS, {}, getKeptDraftsQ);
	const [filter, setFilter] = useFilterQ();
	const [status, setStatus] = useStateQ("");
	const sessions = useSessionsStateQ(filter.profile, setStatus);
	const groups = getGroupsQ(getVisibleItemsQ(list.data?.items ?? [], filter, sessions.selectedIds));
	const { sheet, steps, currentId, setCurrentId, openItem, closeSheet } = useSheetQ(groups, sessions.selectedIds);
	const keys = useKeysSwitchQ();
	const readList = useListReadQ(list, setList);
	// sessions.read changes with the Account filter → a filter change re-reads the page; an owner act's read runs after any read in flight
	const reload = useCallbackQ(() => {
		readList({ isFresh: true });
		readResumes();
		sessions.read();
		onReadQueueCount?.();
	}, [readList, readResumes, sessions.read, onReadQueueCount]);
	const loadMore = useCallbackQ(() => getMoreQ({ list, setList }), [list]);
	useEffectQ(() => { reload(); }, [reload]);
	const actions = useQueueActionsQ({ groups, setList, setDrafts, setStatus, openItem, closeSheet, reload, onRetryHarness });
	const orders = useOrdersQ({ selectedIds: sessions.selectedIds, sendAction: actions.send, setStatus, reload });
	const ticks = usePageTickQ({ readList, readResumes, sessions, orders, setStatus, onReadQueueCount });
	const setDraft = useCallbackQ((id, patch) => setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } })), []);
	const setImages = useCallbackQ((id, update) => setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], images: update(prev[id]?.images ?? []) } })), []);
	// opening a row, focusing it or its row showing in the list is the owner seeing it → the arrival ends (spec §4.4)
	const setSeen = useCallbackQ((id) => setList((prev) => (prev.newIds.includes(id) ? { ...prev, newIds: prev.newIds.filter((other) => other !== id) } : prev)), []);
	const selectRow = useCallbackQ((id) => { openItem(id); setSeen(id); }, [openItem, setSeen]);
	const openOrderRow = useOrderRowQ({ list, setCurrentId, sessions, orders });
	return {
		list, resumes, readResumes, sessions, orders, drafts, setDraft, setImages, filter, setFilter, reload, loadMore, groups, sheet, steps,
		selectedId: currentId, selectRow, setSeen, back: closeSheet, openOrderRow, status, keys, ...actions, ...ticks,
	};
}

/**
 * State seeded from the tab's session store and written back on each change, so a reload loses no draft (spec §4.3, §4.5).
 * @param getKept - the part of the state a reload can resume
 */
function useStoredStateQ(key, fallback, getKept) {
	const [value, setValue] = useStateQ(() => ({ ...fallback, ...getStoredQ(getWebStoreQ(), key, {}) }));
	useEffectQ(() => { setStoredQ(getWebStoreQ(), key, getKept(value)); }, [key, value, getKept]);
	return [value, setValue];
}

// every item's kept draft; an empty one leaves the store
function getKeptDraftsQ(drafts) {
	const kept = Object.entries(drafts).map(([id, draft]) => [id, getKeptDraftQ(draft)]);
	return Object.fromEntries(kept.filter(([, draft]) => draft.code !== undefined || draft.text || draft.images.length > 0));
}

// the picked option, the text, the images the server holds · an upload in flight or failed lives only in this page's memory
function getKeptDraftQ(draft) {
	const images = (draft?.images ?? []).filter((shot) => shot.status === "stored").map(({ file, ...shot }) => shot);
	return { ...(draft?.code === undefined ? {} : { code: draft.code }), ...(draft?.text ? { text: draft.text } : {}), images };
}

// a blocked store throws on the property read itself
function getWebStoreQ(name = "sessionStorage") {
	try {
		return window[name];
	} catch {
		return undefined;
	}
}

/** The single-key switch (spec §11, WCAG 2.1.4): on unless the owner turned it off, kept in the browser's local store across tabs. */
function useKeysSwitchQ() {
	const [isOn, setOn] = useStateQ(() => getKeysOnQ(getWebStoreQ("localStorage")));
	useEffectQ(() => { setStoredQ(getWebStoreQ("localStorage"), KEYS_Q.STORE, isOn); }, [isOn]);
	const toggle = useCallbackQ(() => setOn((prev) => !prev), []);
	return { isOn, toggle };
}

function getKeysOnQ(storage) {
	return getStoredQ(storage, KEYS_Q.STORE, true) !== false;
}

// absent, blocked or unreadable → the fallback: a draft is a convenience, never a reason for the page to fail
function getStoredQ(storage, key, fallback) {
	try {
		const raw = storage.getItem(key);
		return raw === null ? fallback : JSON.parse(raw);
	} catch {
		return fallback;
	}
}

function setStoredQ(storage, key, value) {
	try {
		storage.setItem(key, JSON.stringify(value));
	} catch {
		// a full or blocked store → the draft stays in page state only, until the tab closes
	}
}

// one list read at a time (getJoinedReadQ), merged into the list as it stands when the answer lands
function useListReadQ(list, setList) {
	const latestList = useRefQ(list);
	latestList.current = list;
	const flight = useRefQ(null);
	return useCallbackQ(({ isFresh = false } = {}) => {
		const start = () => getListQ({ setList, getList: () => latestList.current });
		return getJoinedReadQ(flight, start, isFresh);
	}, [setList]);
}

/** The page's own tick (getPageReadQ) on its cadence, and the checks failed in a row the header line words its interval from. */
function usePageTickQ({ readList, readResumes, sessions, orders, setStatus, onReadQueueCount }) {
	const [failedChecks, setFailedChecks] = useStateQ(0);
	const tick = useCallbackQ(
		() => getPageReadQ({ readList, readResumes, sessions, orders, setStatus, onReadQueueCount }),
		[readList, readResumes, sessions, orders, setStatus, onReadQueueCount],
	);
	useAutoReadQ(tick, setFailedChecks);
	return { failedChecks };
}

/**
 * One tick (spec §4.4): the items, the sessions, the nav count, the thread (always on screen) and the resume record, whose foot
 * count has no other read to keep it current. An arrival is said on the list's status line.
 * @returns true when the list read landed
 */
async function getPageReadQ({ readList, readResumes, sessions, orders, setStatus, onReadQueueCount }) {
	const [read] = await Promise.all([readList(), sessions.read(), onReadQueueCount?.(), orders.reread(), readResumes()]);
	setReadStatusQ(read, setStatus);
	return read.isGood;
}

// a turn to Not received outranks an arrival: it asks for an act, and the arrival stays tracked for the off-view note and the way back
function setReadStatusQ(read, setStatus) {
	if (read.turned.length > 0) setStatus({ text: getNotReceivedNoteQ(read.turned), orderId: read.turned[0].id });
	else if (read.arrived.length > 0) setStatus(getArrivalNoteQ(read.arrived));
}

// `⚠ yoaida has not received an order` · several sessions named together
function getNotReceivedNoteQ(turned) {
	const names = [...new Set(turned.map((item) => item.session.name))];
	const what = getKindWordQ(turned[0]) === "Answer" ? "an answer" : "an order";
	return `${window.UI.TONE_GLYPH.warn} ${getNameListQ(names)} ${names.length === 1 ? "has" : "have"} not received ${what}`;
}

/**
 * Re-runs `tick` on the page's cadence while the page is mounted; a hidden tab keeps its timer at the browser's own throttle,
 * and a tab shown again ticks at once when its last read is older than the step.
 * @param tick - resolves true when the list read landed
 */
function useAutoReadQ(tick, onSettle) {
	const latestTick = useRefQ(tick);
	latestTick.current = tick;
	useEffectQ(() => {
		const clock = createReadClockQ(() => latestTick.current(), onSettle);
		const onShow = () => { if (document.visibilityState === "visible") clock.runIfStale(); };
		document.addEventListener("visibilitychange", onShow);
		return () => {
			clock.stop();
			document.removeEventListener("visibilitychange", onShow);
		};
	}, []);
}

/**
 * A timer chain → each tick schedules the next once it settles, and never two run at once.
 * @param onSettle - told the failures in a row after each tick
 */
function createReadClockQ(tick, onSettle) {
	const clock = { timer: null, settledAt: Date.now(), fails: 0, isBusy: false, isLive: true };
	const run = async () => {
		if (clock.isBusy) return;
		clearTimeout(clock.timer);
		clock.isBusy = true;
		let isGood = false;
		// a throw → a failed read for the backoff, the chain kept; the error still reaches the browser as an unhandled rejection
		try {
			isGood = await tick();
		} finally {
			Object.assign(clock, { isBusy: false, settledAt: Date.now(), fails: isGood ? 0 : clock.fails + 1 });
			onSettle?.(clock.fails);
			if (clock.isLive) clock.timer = setTimeout(run, getPollDelayQ(clock.fails));
		}
	};
	clock.timer = setTimeout(run, POLL_Q.MS);
	return {
		runIfStale: () => { if (isReadStaleQ(clock.settledAt, Date.now())) run(); },
		stop: () => {
			clock.isLive = false;
			clearTimeout(clock.timer);
		},
	};
}

function getPollDelayQ(fails) {
	return fails >= POLL_Q.SLOW_AFTER ? POLL_Q.SLOW_MS : POLL_Q.MS;
}

function isReadStaleQ(settledAt, now) {
	return now - settledAt > POLL_Q.MS;
}

/**
 * One read in flight: a read asked for meanwhile joins it; a fresh one — after an owner act the read in flight may predate — runs after it.
 * @param flight - ref holding the read in flight, null when none
 */
function getJoinedReadQ(flight, start, isFresh = false) {
	if (flight.current !== null && !isFresh) return flight.current;
	const read = (flight.current ?? Promise.resolve()).then(() => start());
	flight.current = read;
	read.finally(() => {
		if (flight.current === read) flight.current = null;
	});
	return read;
}

// one arrival by kind, session and title · several by count
function getArrivalNoteQ(arrived) {
	if (arrived.length !== 1) return `${arrived.length} new items`;
	const [item] = arrived;
	return `New ${item.kind} from ${item.session.name}: ${item.title}`;
}

// an order's row or Show → the current row for the return, never a sheet (an order has none); its entry aimed at in the thread
function useOrderRowQ({ list, setCurrentId, sessions, orders }) {
	const { setSelectedIds } = sessions;
	const { aimAt } = orders;
	return useCallbackQ((row) => {
		setCurrentId(row.id);
		setSelectedIds((ids) => getShowTicksQ(ids, list.data?.items ?? [], row.id));
		aimAt(row.id);
	}, [list, setCurrentId, setSelectedIds, aimAt]);
}

/**
 * The ticks that show an order's entry in the thread (spec §9.2): they only grow, by the shown copy's session, when they leave every recipient out.
 * Nothing ticked → kept: the thread holds every order.
 */
function getShowTicksQ(ids, items, copyId) {
	const row = getFoldedRowsQ(items).find((one) => one.copies.some((copy) => copy.id === copyId));
	const copy = row?.copies.find((one) => one.id === copyId);
	if (!copy || ids.length === 0 || row.copies.some((one) => ids.includes(one.session.id))) return ids;
	return [...ids, copy.session.id];
}

/**
 * The middle pane's state: the opened item (`item=` in the hash), the current row (the one last opened), the open item held while it is on the sheet.
 * openItem(id) → its sheet in the list's place · closeSheet() → the list again (spec §4.3) · a tick change that leaves the item out → the list, the focus kept on the box.
 */
function useSheetQ(groups, ids) {
	const [openId, setOpenId] = useStateQ(() => getHashStateQ().item);
	const [currentId, setCurrentId] = useStateQ(() => Number(getHashStateQ().item) || null);
	const [held, setHeld] = useStateQ(null);
	const lastIndex = useRefQ(-1);
	const lastKind = useRefQ("none");
	const sheet = getSheetStateQ(groups, openId, held, ids);
	const wasShown = lastKind.current !== "none";
	lastKind.current = sheet.kind;
	const steps = getStepsQ(groups, sheet.id, lastIndex.current);
	if (steps.index >= 0) lastIndex.current = steps.index;
	const shown = getSheetOpenItemQ(sheet);
	useEffectQ(() => { if (shown !== null) setHeld((prev) => (prev === shown ? prev : shown)); }, [shown]);
	const setMove = useSheetMovesQ(currentId);
	const putOpenId = useCallbackQ((value) => { setOpenId(value); setHashStateQ({ item: value }); setHeld(null); }, []);
	const openItem = useCallbackQ((id) => { setMove("sheet"); putOpenId(String(id)); setCurrentId(id); }, [setMove, putOpenId]);
	const closeSheet = useCallbackQ(() => { setMove("list"); putOpenId(""); }, [setMove, putOpenId]);
	useLayoutEffectQ(() => {
		if (wasShown && sheet.kind === "none" && openId !== "") { setMove("scroll"); putOpenId(""); }
	}, [ids.join(",")]);
	return { sheet, steps, currentId, setCurrentId, openItem, closeSheet };
}

/**
 * Focus and the list's scroll across the pane's two states (spec §3.3, §11): an opened sheet → its body ·
 * the list again → the scroll it had when the first sheet opened, the focus on the current row (`scroll`: the focus stays where it is).
 * @returns setMove(to) — "sheet", "list" or "scroll", called before the state change it follows
 */
function useSheetMovesQ(currentId) {
	const [move, setMoveState] = useStateQ(null);
	const listTop = useRefQ(0);
	useLayoutEffectQ(() => {
		if (move === null) return;
		if (move.to === "sheet") return void document.querySelector(PANE_Q.SHEET_BODY)?.focus();
		const body = document.querySelector(PANE_Q.LIST_BODY);
		if (body) body.scrollTop = listTop.current;
		if (move.to === "list") getPaneFocusQ(document, currentId)?.focus({ preventScroll: true });
	}, [move]);
	return useCallbackQ((to) => {
		// the list's own box keeps no scroll while hidden in every browser → read while it is still on screen
		if (to === "sheet" && document.querySelector(".queue-sheet") === null) listTop.current = document.querySelector(PANE_Q.LIST_BODY)?.scrollTop ?? 0;
		setMoveState({ to });
	}, []);
}

/**
 * Session list region, the ticks and Show ended; the list follows the Account filter.
 * The ticks are the one selection (spec §9.1): the list's scope, the thread's filter and the recipients.
 * @param onDropped - the status line, told of a tick dropped because its session no longer takes orders
 */
function useSessionsStateQ(profile, onDropped) {
	const [region, setRegion] = useStateQ(window.UI.INITIAL_REGION_STATE);
	const [selectedIds, setSelectedIds] = useStateQ(getTicksFromHashQ);
	const latestIds = useRefQ(selectedIds);
	latestIds.current = selectedIds;
	useEffectQ(() => { setHashStateQ({ to: selectedIds.join(",") }); }, [selectedIds]);
	const [isEndedShown, setEndedShown] = useStateQ(false);
	const read = useCallbackQ(() => getSessionsQ({ profile, setRegion, getIds: () => latestIds.current, setSelectedIds, onDropped }), [profile, onDropped]);
	const toggle = useCallbackQ((id) => setSelectedIds((ids) => putToggledIdQ(ids, id)), []);
	const clear = useCallbackQ(() => setSelectedIds([]), []);
	return { region, read, selectedIds, setSelectedIds, toggle, clear, isEndedShown, setEndedShown };
}

// #queue?to=<ids> → the recipients survive a reload; a read then drops the ones no longer taking a message (getKeptSelectionQ)
function getTicksFromHashQ() {
	return getHashStateQ().to.split(",").filter(Boolean);
}

// a read drops the ticks on rows it no longer lists or that turned unselectable; a listed one that stopped taking orders is said
async function getSessionsQ({ profile, setRegion, getIds, setSelectedIds, onDropped }) {
	const { putRegionRequest, putRegionData, putRegionFailure } = window.UI;
	const request = {};
	setRegion((state) => putRegionRequest(state, profile, request));
	const query = profile ? `?${new URLSearchParams({ profile })}` : "";
	const answer = await sendOwnerRequestQ(`/sessions${query}`);
	if (isOkAnswerQ(answer) && Array.isArray(answer.data?.sessions)) {
		const dropped = getDroppedNoteQ(getIds(), answer.data.sessions);
		if (dropped !== null) onDropped(dropped);
		setSelectedIds((ids) => getKeptSelectionQ(ids, answer.data.sessions));
		return setRegion((state) => putRegionData(state, request, answer.data));
	}
	setRegion((state) => putRegionFailure(state, request, answer.status === 0 ? answer.error : new Error(getAnswerDetailQ(answer))));
}

function getKeptSelectionQ(ids, sessions) {
	const selectable = new Set(sessions.filter((row) => row.isSelectable).map((row) => row.id));
	return ids.filter((id) => selectable.has(id));
}

// ticks on listed sessions that no longer take a message → `⚠ yoaida no longer takes orders and was unticked.`; none → null
function getDroppedNoteQ(ids, sessions) {
	const names = sessions.filter((row) => !row.isSelectable && ids.includes(row.id)).map((row) => row.name);
	if (names.length === 0) return null;
	const verb = names.length === 1 ? "no longer takes orders and was unticked" : "no longer take orders and were unticked";
	return `${window.UI.TONE_GLYPH.warn} ${getNameListQ(names)} ${verb}.`;
}

// the note under a draft whose recipients changed (spec §9.2); the info glyph is the tone line's
function getRecipientsNoteQ(names) {
	return names.length === 0 ? "No session ticked now: this order has no recipient." : `Recipients changed: now ${getNameListQ(names)}.`;
}

function putToggledIdQ(ids, id) {
	return ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id];
}

function getShownSessionsQ(sessions, isEndedShown) {
	return isEndedShown ? sessions : sessions.filter((row) => row.state !== "exited");
}

/**
 * Send targets `{ ids, names, endedCount }`: every ticked row that takes a message, a folded ended row included → the list's scope,
 * the thread and the recipients read one tick set; a replaced row is never sent to.
 */
function getSendTargetsQ(rows, selectedIds) {
	const targets = rows.filter((row) => row.isSelectable && selectedIds.includes(row.id));
	return { ids: targets.map((row) => row.id), names: targets.map((row) => row.name), endedCount: targets.filter((row) => row.state === "exited").length };
}

function getSendLabelQ(targets) {
	const parts = getSendPartsQ(targets);
	return parts ? `${parts.head}${parts.name}${parts.tail}` : "Send order";
}

/**
 * The send label as the pieces the button cuts `{ head, name, tail }`; nothing ticked → null.
 * One target by name, several by count · an ended target is resumed to take the order → `tail` says how many before the owner sends.
 * Too narrow a row → `name` gives way first, then `tail`; `head` (the verb and a count) stays whole.
 */
function getSendPartsQ({ ids, names, endedCount }) {
	if (ids.length === 0) return null;
	const tail = endedCount > 0 ? ` · resumes ${endedCount} ended` : "";
	return ids.length === 1 ? { head: "Send to ", name: names[0], tail } : { head: `Send to ${ids.length} sessions`, name: "", tail };
}

/** What a send press lacks `{ message, focus }` — `focus` names the control that fixes it (`rail` / `box`); nothing missing → null. */
function getOrderInvalidQ(targets, text) {
	const count = targets.ids.length;
	if (count === 0) return { message: COMPOSER_ERROR_Q.noTick, focus: "rail" };
	if (!text.trim()) return { message: COMPOSER_ERROR_Q.noOrder, focus: "box" };
	if (count > MESSAGE_Q.MAX_TARGETS) return { message: `Up to ${MESSAGE_Q.MAX_TARGETS} sessions per order: untick ${count - MESSAGE_Q.MAX_TARGETS}.`, focus: "rail" };
	return null;
}

/** The composer's note at rest · `rows` null → the rail not read yet, so no claim that nobody takes an order (spec §10). */
function getOrderNoteQ({ ids, names }, rows = null) {
	if (ids.length === 1) return `Goes to ${names[0]}.`;
	if (ids.length > 1) return "Each ticked session gets its own copy.";
	return rows?.some((row) => row.isSelectable) === false ? "No session can take an order right now." : "Tick a session in the rail to address this order.";
}

function getOrderSentStatusQ(names) {
	return `${window.UI.TONE_GLYPH.ok} Order sent to ${getNameListQ(names)}`;
}

// `a` · `a and b` · `a, b and c`
function getNameListQ(names) {
	return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function getSessionStateLabelQ(row) {
	if (row.state !== "exited") return SESSION_STATE_LABEL_Q[row.state] ?? row.state;
	return EXIT_REASON_LABEL_Q[row.exitReason] ?? EXIT_REASON_LABEL_Q.ended;
}

/**
 * One order to every target, all or nothing: a taken send empties the box and keeps the ticks, so the next line goes to the same sessions;
 * a refusal keeps the text and shows in the note slot.
 * @param names - the targets' names, for the list's status line
 * @param onSent - re-reads the list and the thread, so the new order shows
 * @param onRefused - re-reads the page, so the refusal line meets the state it names (spec §4.4)
 * @returns true once the server took the send
 */
async function sendMessageQ({ body, names, shots = [], setComposer, setStatus, onSent, onRefused }) {
	setComposer((prev) => ({ ...prev, isBusy: true, error: null }));
	const ids = await getStoredIdsQ(shots);
	if (ids === null) {
		setComposer((prev) => ({ ...prev, isBusy: false }));
		return false;
	}
	const answer = await sendOwnerRequestQ("/messages/send", getImageBodyQ(body, ids));
	if (isOkAnswerQ(answer)) {
		setComposer(() => EMPTY_COMPOSER_Q);
		setStatus({ text: getOrderSentStatusQ(names), orderId: answer.data?.items?.[0]?.id ?? null });
		window.document?.getElementById(ORDERS_Q.BOX_ID)?.focus();
		onSent();
		return true;
	}
	setComposer((prev) => ({ ...prev, isBusy: false, error: getSendErrorQ(answer) }));
	onRefused?.();
	return false;
}

function getSendErrorQ(answer) {
	return getOutageStepQ(answer) ?? getRefusalReasonQ(answer) ?? "The monitor refused this order. Try again.";
}

/**
 * Orders (spec §9.2), always on screen: the thread of the ticked sessions' orders and the order composer.
 * focus() puts the caret in its box · aimAt(id) scrolls the thread to the order holding that copy (useThreadAimQ).
 */
function useOrdersQ({ selectedIds, sendAction, setStatus, reload }) {
	const [aim, setAim] = useStateQ(null);
	const [composer, setComposer] = useStoredStateQ(DRAFT_STORE_Q.ORDER, EMPTY_COMPOSER_Q, getKeptDraftQ);
	const { thread, read, showEarlier, reread } = useThreadQ(selectedIds);
	const setText = useCallbackQ((text) => setComposer((prev) => ({ ...prev, text, error: null })), []);
	const putError = useCallbackQ((error) => setComposer((prev) => ({ ...prev, error })), []);
	const setImages = useCallbackQ((update) => setComposer((prev) => ({ ...prev, images: update(prev.images ?? []) })), []);
	const onSent = useCallbackQ(() => { reload(); read(); }, [reload, read]);
	const send = useCallbackQ((body, names, shots) => sendMessageQ({ body, names, shots, setComposer, setStatus, onSent, onRefused: reload }), [setStatus, onSent, reload]);
	const resend = useCallbackQ((ids) => putResendsQ(ids, sendAction, read), [sendAction, read]);
	const focus = useCallbackQ(() => document.getElementById(ORDERS_Q.BOX_ID)?.focus(), []);
	// a fresh object per press → the same order shown twice is aimed at twice
	const aimAt = useCallbackQ((id) => setAim({ id }), []);
	const clearAim = useCallbackQ(() => setAim(null), []);
	return { aim, aimAt, clearAim, focus, thread, read, reread, showEarlier, composer, setText, putError, setImages, send, resend };
}

// one after another → one busy state and one refusal line at a time; the thread re-reads once
async function putResendsQ(ids, sendAction, read) {
	let isAnyTaken = false;
	for (const id of ids) isAnyTaken = (await sendAction(id, "resend")) || isAnyTaken;
	if (isAnyTaken) read();
}

// first page on mount and on every tick change; a read for ticks since changed is dropped
// ponytail: a send, a resend or a tick change reads the first page again → loaded earlier pages go; the page's tick (reread) keeps them
function useThreadQ(selectedIds) {
	const [thread, setThread] = useStateQ(EMPTY_THREAD_Q);
	const key = selectedIds.join(",");
	const latest = useRefQ(key);
	latest.current = key;
	const latestThread = useRefQ(thread);
	latestThread.current = thread;
	const ids = key ? key.split(",") : [];
	const isCurrent = () => latest.current === key;
	const read = useCallbackQ(() => getThreadQ({ ids, before: null, setThread, isCurrent }), [key]);
	useEffectQ(() => { read(); }, [read]);
	const showEarlier = useCallbackQ(() => getThreadQ({ ids, before: thread.nextCursor, setThread, isCurrent }), [key, thread.nextCursor]);
	const reread = useCallbackQ(() => getThreadQ({ ids, before: null, setThread, isCurrent, limit: getReadLimitQ(getFoldedRowsQ(latestThread.current.items).length, ORDERS_Q.PAGE, ORDERS_Q.MAX), isQuiet: true }), [key]);
	return { thread, read, showEarlier, reread };
}

/**
 * One page of the history read (getReadThreadQ says how it joins the thread).
 * @param isQuiet - the page's own re-read: no loading state, a failure keeps the thread as it stands, and no loaded order leaves
 */
async function getThreadQ({ ids, before, setThread, isCurrent = () => true, limit = ORDERS_Q.PAGE, isQuiet = false }) {
	if (!isQuiet) setThread((prev) => ({ ...prev, status: "loading" }));
	const answer = await sendOwnerRequestQ(`/orders?${getOrdersQueryQ(ids, before, limit)}`);
	if (!isCurrent()) return;
	if (isOkAnswerQ(answer) && Array.isArray(answer.data?.items)) {
		return setThread((prev) => ({ status: "ready", ...getReadThreadQ(prev, answer.data, before, isQuiet), error: null }));
	}
	if (!isQuiet) setThread((prev) => ({ ...prev, status: "error", error: getReadFailureQ(answer) }));
}

// an earlier page joins the thread, the page's own re-read merges into it, any other first page replaces it
function getReadThreadQ(prev, page, before, isQuiet) {
	if (before !== null) return { items: putEarlierPageQ(prev.items, page.items), nextCursor: page.nextCursor ?? null };
	if (isQuiet) return getKeptBeyondQ(prev, page, () => true);
	return { items: page.items, nextCursor: page.nextCursor ?? null };
}

/**
 * A re-read merged into what is loaded (spec §4.4): rows the read covers take its state; loaded rows past its end stay, and while any stay the loaded cursor stays.
 * @param isPast - a loaded row the read did not return lies past its end
 */
function getKeptBeyondQ(prev, read, isPast) {
	const ids = new Set(read.items.map((item) => item.id));
	const beyond = prev.items.filter((item) => !ids.has(item.id) && isPast(item));
	return { items: [...read.items, ...beyond], nextCursor: beyond.length > 0 ? prev.nextCursor : read.nextCursor ?? null };
}

// every loaded row, so a list or thread extended by Show more / Show earlier is not cut back, up to the read's cap
function getReadLimitQ(loaded, page, max) {
	return Math.min(Math.max(page, loaded), max);
}

// no tick → the orders to every session
function getOrdersQueryQ(ids, before, limit = ORDERS_Q.PAGE) {
	const query = new URLSearchParams({ limit: String(limit) });
	if (ids.length > 0) query.set("sessionIds", ids.join(","));
	if (before) query.set("before", before);
	return query.toString();
}

function putEarlierPageQ(items, page) {
	const ids = new Set(items.map((item) => item.id));
	return [...items, ...page.filter((item) => !ids.has(item.id))];
}

// the read comes newest order first, each order's copies together → folded as the list folds them, then read oldest first
function getThreadEntriesQ(items) {
	return getFoldedRowsQ(items).reverse();
}

// page-level resume record in its own region → a failed read leaves the list in place
function useRecentResumesQ() {
	const [resumes, setResumes] = useStateQ(window.UI.INITIAL_REGION_STATE);
	const readResumes = useCallbackQ(() => getResumesQ({ setResumes }), []);
	return [resumes, readResumes];
}

// newest resume Delivery rows from the server, terminal items included → a delivered item's resume stays listed
async function getResumesQ({ setResumes }) {
	const { putRegionRequest, putRegionData, putRegionFailure } = window.UI;
	const request = {};
	setResumes((state) => putRegionRequest(state, "resumes", request));
	const answer = await sendOwnerRequestQ("/resumes");
	if (isOkAnswerQ(answer) && Array.isArray(answer.data?.resumes)) {
		return setResumes((state) => putRegionData(state, request, answer.data.resumes));
	}
	setResumes((state) => putRegionFailure(state, request, answer.status === 0 ? answer.error : new Error(getAnswerDetailQ(answer))));
}

function useFilterQ() {
	const [filter, setFilter] = useStateQ(getFilterFromHashQ);
	useEffectQ(() => { setFilterHashQ(filter); }, [filter]);
	return [filter, setFilter];
}

/**
 * One read of the list, merged by item id into the list as it stands when the answer lands (getMergedDataQ).
 * A failure with rows loaded keeps them and their read time; with none loaded it is the list's error state.
 * @param getList - the list now; absent → nothing loaded
 * @returns `{ isGood, arrived, turned }` — `arrived` the items this read tracks as arrivals, in server order; `turned` as getMergedDataQ
 */
async function getListQ({ setList, getList = () => EMPTY_LIST_Q }) {
	if (getList().data === null) setList((prev) => ({ ...prev, status: "loading" }));
	const answer = await sendOwnerRequestQ(`/items?limit=${getReadLimitQ(getList().data?.items.length ?? 0, LIST_Q.LIMIT, LIST_Q.MAX)}`);
	const prev = getList();
	if (isOkAnswerQ(answer) && Array.isArray(answer.data?.items)) {
		const { data, arrived, turned } = getMergedDataQ(prev.data, answer.data);
		const kept = (prev.newIds ?? []).filter((id) => data.items.some((item) => item.id === id));
		setList({ status: "ready", data, error: null, readAt: new Date().toISOString(), newIds: [...kept, ...arrived.map((item) => item.id)] });
		return { isGood: true, arrived, turned };
	}
	const error = getReadFailureQ(answer);
	setList(prev.data === null ? { ...prev, status: "error", error } : { ...prev, status: "ready", error });
	return { isGood: false, arrived: [], turned: [] };
}

/**
 * The read merged by item id: a known row takes the read's state, a row the read no longer has leaves, a new one stands at its server position.
 * Rows loaded past the read's last position (beyond its cap) stay with their cursor until a read reaches them.
 * @returns `{ data, arrived, turned }` — `arrived` the new open decisions and reports, `turned` the known copies whose receipt
 * turned to Not received (spec §4.4); the page's first read has neither
 */
function getMergedDataQ(prev, answer) {
	if (prev === null) return { data: answer, arrived: [], turned: [] };
	const receipts = new Map(prev.items.map((item) => [item.id, getReceiptQ(item)]));
	const arrived = answer.items.filter((item) => !receipts.has(item.id) && item.status === "open" && (item.kind === "decision" || item.kind === "report"));
	const turned = answer.items.filter((item) => receipts.has(item.id) && receipts.get(item.id) !== "notReceived" && getReceiptQ(item) === "notReceived");
	const isPast = (item) => answer.nextCursor !== null && item.queuePosition > answer.nextCursor;
	return { data: { ...answer, ...getKeptBeyondQ(prev, answer, isPast) }, arrived, turned };
}

// Show more → the next page after the cursor joins the loaded list; a refused read → the page failure card with Retry
// ponytail: a re-read covers the loaded rows up to the read's cap (getReadLimitQ), rows past it keep their last state until reached; upgrade = server-side filters
async function getMoreQ({ list, setList }) {
	const cursor = list.data?.nextCursor;
	if (cursor === null || cursor === undefined) return;
	setList((prev) => ({ ...prev, status: "loading" }));
	const answer = await sendOwnerRequestQ(`/items?limit=${LIST_Q.LIMIT}&after=${cursor}`);
	if (isOkAnswerQ(answer) && Array.isArray(answer.data?.items)) {
		const append = (prev) => ({ ...prev.data, items: [...prev.data.items, ...answer.data.items], nextCursor: answer.data.nextCursor });
		return setList((prev) => ({ ...prev, status: "ready", data: append(prev), error: null, readAt: new Date().toISOString() }));
	}
	setList((prev) => ({ ...prev, status: "error", error: getReadFailureQ(answer) }));
}

/**
 * Owner acts on the sheet: a taken act opens the next open item in list order on the sheet and says what happened on the list's status line.
 * @param groups - the list's bands as shown → the next sheet is never a row the filter or the ticks hide
 */
function useQueueActionsQ({ groups, setList, setDrafts, setStatus, openItem, closeSheet, reload, onRetryHarness }) {
	const { busy, send } = useSendQ({ setDrafts, reload, onRetryHarness });
	const items = getRowsQ(groups).map((row) => row.item);
	const settle = useCallbackQ(async (id, action, body) => {
		const nextId = getNextAwaitingIdQ(items, id);
		if (!(await send(id, action, body))) return false;
		setStatus(getActionStatusQ(items.find((item) => item.id === id), action));
		// a later item is still open → it stays on the sheet; any other act with nothing open left → the list returns
		if (nextId !== null) openItem(nextId);
		else if (action !== "later") closeSheet();
		return true;
	}, [send, items, setStatus, openItem, closeSheet]);
	const later = useCallbackQ((id) => {
		setList((prev) => (prev.data ? { ...prev, data: { ...prev.data, items: putLaterQ(prev.data.items, id) } } : prev));
		return settle(id, "later");
	}, [settle, setList]);
	const answerItem = useCallbackQ((id, body) => settle(id, "answer", body), [settle]);
	return { busy, send, settle, later, answerItem };
}

// the list's status line after a taken act; an unknown item (gone from the list) → the act alone · a reply's order is the report itself → its id backs Show
function getActionStatusQ(item, action) {
	const name = item ? item.session.name : "the session";
	if (action === "seen") return "Marked as read";
	if (action === "reply") return { text: `${window.UI.TONE_GLYPH.ok} Order sent to ${name}`, orderId: item?.id ?? null };
	if (action === "answer") return `${window.UI.TONE_GLYPH.ok} Answer sent to ${name}`;
	if (action === "later") return `Moved to the end of ${item?.kind === "report" ? "Reports" : "Decisions"}`;
	return "";
}

function useSendQ({ setDrafts, reload, onRetryHarness }) {
	const [busy, setBusy] = useStateQ({ id: null, error: null });
	const send = useCallbackQ(
		(id, action, body) => sendActionQ({ id, action, body, setBusy, setDrafts, reload, onRetryHarness }),
		[setDrafts, reload, onRetryHarness],
	);
	return { busy, send };
}

/**
 * One owner action: a refusal shows on the card and keeps its draft. Taken or refused, the page re-reads at once (spec §4.4).
 * @returns true once the server took the action
 */
async function sendActionQ({ id, action, body, setBusy, setDrafts, reload, onRetryHarness }) {
	setBusy({ id, error: null });
	const answer = await sendOwnerRequestQ(`/items/${id}/${action}`, body ?? {});
	const isDone = isOkAnswerQ(answer);
	setBusy({ id: null, error: isDone ? null : { id, message: getActionErrorQ(answer) } });
	reload();
	if (!isDone) return false;
	setDrafts((prev) => ({ ...prev, [id]: undefined }));
	onRetryHarness?.();
	return true;
}

// the server's refusal body is `{ error, reason }`: `reason` is its worded cause, `error` a machine code never shown
function getActionErrorQ(answer) {
	const outage = getOutageStepQ(answer);
	if (outage !== null) return outage;
	if (answer.status === 409) return "Refused: the item changed state. The list shows where it is now.";
	return getRefusalReasonQ(answer) ?? "The monitor refused this action. Try again.";
}

// the server's worded cause → one refusal sentence · none → null (the caller words it)
function getRefusalReasonQ(answer) {
	const reason = answer.data?.reason;
	return typeof reason === "string" && reason !== "" ? `Refused: ${reason.replace(/\.+$/, "")}.` : null;
}

function QueueFailureQ({ failure, onRetry }) {
	const { AlertCard, RetryButton } = window.UI;
	return <AlertCard tone="crit" title={failure.sentence} body={failure.next} details={failure.detail} actions={<RetryButton onRetry={onRetry} />} />;
}

/** The list card: head = the scope and its open count, bar = the filters while they tell items apart, body = the bands, foot = the status line and Show more. */
function QueueListQ({ queue }) {
	const { Card } = window.UI;
	const items = queue.list.data?.items ?? [];
	const ids = queue.sessions.selectedIds;
	const visible = getVisibleItemsQ(items, queue.filter, ids);
	const offView = useOffViewNewQ(queue.list.newIds, queue.sheet.kind !== "none", queue.setSeen);
	return (
		<Card className="queue-pane queue-list" title={getScopeTitleQ(queue.sessions.region.data?.sessions ?? [], ids)} sub={queue.list.data === null ? null : `${visible.filter((item) => item.status === "open").length} waiting`}
			info={<DeskKeysQ keys={queue.keys} />} infoLabel="Keyboard shortcuts" infoTitle="Keyboard shortcuts"
			bar={isListBarShownQ(items, queue.filter) ? <QueueFilterBarQ items={items} filter={queue.filter} onFilter={queue.setFilter} /> : null}
			foot={<ListFootQ queue={queue} offView={offView} onShowNew={putNewRowInViewQ} />} isFlush>
			<ListBodyQ queue={queue} items={items} visible={visible} />
		</Card>
	);
}

/**
 * The arrivals outside the list body's visible part (spec §4.4), measured when they change, on scroll and when the list returns from a sheet.
 * An arrival whose row shows has been seen → `onSeen` ends it.
 * @returns `{ count, direction, id }` as getOffViewQ, null while every arrival shows
 */
function useOffViewNewQ(newIds, isHidden, onSeen) {
	const [offView, setOffView] = useStateQ(null);
	useEffectQ(() => {
		const body = document.querySelector(PANE_Q.LIST_BODY);
		if (!body || isHidden || newIds.length === 0) return void setOffView(null);
		const measure = () => {
			const [view, rows] = [body.getBoundingClientRect(), getRowBoxesQ(newIds)];
			for (const id of getInViewIdsQ(view, rows)) onSeen(id);
			const next = getOffViewQ(view, rows);
			setOffView((prev) => (prev?.count === next?.count && prev?.direction === next?.direction && prev?.id === next?.id ? prev : next));
		};
		measure();
		body.addEventListener("scroll", measure, { passive: true });
		return () => body.removeEventListener("scroll", measure);
	}, [newIds, isHidden, onSeen]);
	return offView;
}

function getRowBoxesQ(ids) {
	return ids.flatMap((id) => {
		const box = document.getElementById(`${ROW_ID_PREFIX_Q}${id}`)?.getBoundingClientRect();
		return box ? [{ id, top: box.top, bottom: box.bottom }] : [];
	});
}

/**
 * The arrivals whose row does not show (isRowShownQ), by side. Both sides → the side below, where arrivals land.
 * @param view - the list body's box; zero high while an open sheet puts the list away
 * @returns `{ count, direction, id }` — `id` the off-view arrival nearest the visible part · null when none
 */
function getOffViewQ(view, rows) {
	if (isListAwayQ(view)) return null;
	const hidden = rows.filter((row) => !isRowShownQ(view, row));
	const below = hidden.filter((row) => row.top >= view.bottom).sort((a, b) => a.top - b.top);
	const above = hidden.filter((row) => row.top < view.bottom).sort((a, b) => b.bottom - a.bottom);
	const [side, direction] = below.length > 0 ? [below, "below"] : [above, "above"];
	return side.length === 0 ? null : { count: side.length, direction, id: side[0].id };
}

// the arrivals whose row shows → seen · none while an open sheet puts the list away
function getInViewIdsQ(view, rows) {
	if (isListAwayQ(view)) return [];
	return rows.filter((row) => isRowShownQ(view, row)).map((row) => row.id);
}

// an open sheet puts the list away: its body is zero high
function isListAwayQ(view) {
	return view.bottom <= view.top;
}

// a row cut by an edge still shows; only one wholly past an edge does not
function isRowShownQ(view, row) {
	return row.top < view.bottom && row.bottom > view.top;
}

// Show on the off-view note → the row in view and focused; the selection stays where it is
function putNewRowInViewQ(id) {
	const row = document.getElementById(`${ROW_ID_PREFIX_Q}${id}`);
	row?.scrollIntoView({ block: "nearest" });
	row?.focus({ preventScroll: true });
}

/** The key list behind the list head's ⓘ (spec §11) and the switch that turns the single keys off (WCAG 2.1.4). */
function DeskKeysQ({ keys }) {
	return (
		<div className="flex flex-col gap-2">
			<label className="inline-flex items-center gap-2 font-medium">
				<span className="inline-target"><CheckboxBoxQ isChecked={keys.isOn} onChange={keys.toggle} ariaLabel="Single-key shortcuts" /></span>
				Single-key shortcuts
			</label>
			<p className="fs-meta text-dim">Letters and digits act while the focus is on the desk and not in a text field. Enter, Esc and Cmd / Ctrl + Enter work either way.</p>
			<dl className="queue-keys">{DESK_KEY_LIST_Q.map((row) => <React.Fragment key={row.keys}><dt>{row.keys}</dt><dd>{row.does}</dd></React.Fragment>)}</dl>
		</div>
	);
}

// the scope the ticks set: All sessions with none, else every ticked name; a tick the rail has not listed yet → its id prefix
function getScopeTitleQ(rows, ids) {
	if (ids.length === 0) return "All sessions";
	return ids.map((id) => rows.find((row) => row.id === id)?.name ?? id.slice(0, SESSION_PREFIX_LENGTH_Q)).join(", ");
}

// the rail's ticks are the session scope → the bar holds the Account axis, shown while it tells items apart
function isListBarShownQ(items, filter) {
	return Boolean(filter.profile) || new Set(items.map((item) => item.session.profileLabel)).size > 1;
}

function ListBodyQ({ queue, items, visible }) {
	const { EmptyState, LoadingPlaceholder } = window.UI;
	if (queue.list.status === "error") return <QueueFailureQ failure={queue.list.error} onRetry={queue.reload} />;
	if (queue.list.data === null) return <div className="queue-loading"><LoadingPlaceholder label="the queue" /></div>;
	if (items.length === 0) return <EmptyState message="Nothing is waiting for you" hint={`Sessions post reports and decisions here. The page checks every ${POLL_Q.MS / 1000} seconds.`} />;
	if (visible.length > 0) return <QueueListboxQ queue={queue} items={items} />;
	if (queue.filter.profile) return <EmptyState kind="no-results" message="No items match these filters." onReset={() => queue.setFilter(DEFAULT_FILTER_Q)} />;
	return <EmptyState message={getTickedEmptyQ(queue.sessions)} action={<button type="button" className="btn ghost sm" onClick={queue.sessions.clear}>Show all sessions</button>} />;
}

// spec §10 → List, sessions ticked and nothing from them
function getTickedEmptyQ({ region, selectedIds }) {
	if (selectedIds.length > 1) return "Nothing from the ticked sessions in the queue.";
	return `Nothing from ${getScopeTitleQ(region.data?.sessions ?? [], selectedIds)} in the queue.`;
}

// one tab stop: the current row holds tabindex 0, else the first row; Up / Down / Home / End move the focus and open nothing (spec §11)
function QueueListboxQ({ queue, items }) {
	const rows = getRowsQ(queue.groups);
	const tabStopId = rows.some((row) => row.id === queue.selectedId) ? queue.selectedId : rows[0]?.id;
	const view = { isNameShown: queue.sessions.selectedIds.length !== 1, isAccountShown: new Set(items.map((item) => item.session.profileLabel)).size > 1, tabStopId };
	const onKeyDown = (event) => {
		const nextId = getKeyedRowIdQ(rows, getRowIdQ(event.target), event.key);
		if (nextId === null) return;
		event.preventDefault();
		document.getElementById(`${ROW_ID_PREFIX_Q}${nextId}`)?.focus();
	};
	return (
		<div role="listbox" aria-label="Queue items" className="queue-listbox" onKeyDown={onKeyDown}>
			{queue.groups.map((group) => <QueueGroupQ key={group.key} group={group} queue={queue} view={view} />)}
		</div>
	);
}

/** The row a list key moves to from `fromId` (null → before the first row): Up / Down step (held at the ends), Home / End jump; any other key → null. */
function getKeyedRowIdQ(rows, fromId, key) {
	const index = rows.findIndex((row) => row.id === fromId);
	const target = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: rows.length - 1 }[key];
	if (target === undefined || rows.length === 0) return null;
	return rows[Math.min(Math.max(target, 0), rows.length - 1)].id;
}

function QueueGroupQ({ group, queue, view }) {
	const { Badge } = window.UI;
	const bandId = `queue-band-${group.key}`;
	const hasMore = queue.list.data.nextCursor !== null;
	const count = group.rows.length;
	return (
		<div role="group" aria-labelledby={bandId}>
			<div id={bandId} className="queue-band">
				{group.label}
				<Badge role="count" fill="tag" title={hasMore ? `${count} loaded, more not loaded yet` : undefined}>{hasMore ? `${count}+` : count}</Badge>
			</div>
			{group.rows.map((row) => (
				<QueueRowQ key={row.id} row={row} isSelected={row.id === queue.selectedId} isNew={queue.list.newIds.includes(row.id)} view={view} onSelect={queue.selectRow} onOrder={queue.openOrderRow} onSeen={queue.setSeen} />
			))}
		</div>
	);
}

// an order's row shows its entry in Orders, the list staying (spec §9.2); every other row opens its sheet in the list's place
// who, then what (spec §4.2): the name column first, left out with one session ticked; an arrival paints no mark (§4.4), focusing it ends it
function QueueRowQ({ row, isSelected, isNew = false, view, onSelect, onOrder, onSeen }) {
	const { Icon, formatRelativeTime, formatKstDateTime } = window.UI;
	const { item } = row;
	const facts = getRowFactsQ(row, view.isAccountShown);
	return (
		<div id={`${ROW_ID_PREFIX_Q}${row.id}`} role="option" aria-selected={isSelected} tabIndex={row.id === view.tabStopId ? 0 : -1}
			aria-label={getRowLabelQ(row, facts, view.isNameShown)} className="queue-row"
			onFocus={isNew ? () => onSeen?.(row.id) : undefined} onClick={() => (getKindWordQ(item) === "Order" ? onOrder(row) : onSelect(row.id))}>
			{view.isNameShown && <span className="queue-row-who"><RowWhoQ row={row} /></span>}
			<span className="queue-row-title" title={item.title}>{item.title}</span>
			<span className="queue-row-meta">
				<span className="queue-row-facts"><RowFactsLineQ facts={facts} /></span>
				<span className="queue-row-age" title={formatKstDateTime(item.askedAt)}>{formatRelativeTime(item.askedAt)}</span>
			</span>
			<Icon name="chevR" size={16} className="queue-row-chevron" />
		</div>
	);
}

// one cut line, the whole name in its tooltip; no registered name → `start directory` under it, so it never reads as one the session chose
function RowWhoQ({ row }) {
	const { session } = row.item;
	const name = row.copies.length > 1 ? `${row.copies.length} sessions` : session.name;
	return (
		<>
			<span className="queue-row-name" title={name}>{name}</span>
			{row.copies.length === 1 && session.isNameRegistered === false && <span className="queue-row-dir">start directory</span>}
		</>
	);
}

// no registered name → the start-directory name, marked so it never reads as one the session chose
function ItemSessionNameQ({ session }) {
	return (
		<>
			{session.name}
			{session.isNameRegistered === false && <span className="font-normal text-dim">{" start directory"}</span>}
		</>
	);
}

// a row's text facts run as one span, its badges trailing → a narrow column cuts the run from its end, the badges stay whole
function RowFactsLineQ({ facts }) {
	const texts = facts.filter((fact) => !fact.badge);
	return (
		<>
			{texts.length > 0 && <span className="queue-row-facts-text"><RowFactsQ facts={texts} /></span>}
			<RowFactsQ facts={facts.filter((fact) => fact.badge)} />
		</>
	);
}

// a settled receipt is a mark and a word, no shell (spec §9.4) → the mark rides the text, hidden from screen readers
function RowFactsQ({ facts }) {
	const { Badge, TONE_GLYPH } = window.UI;
	return <>{facts.map((fact, index) => (fact.badge
		? <Badge key={fact.text} fill={fact.badge}>{fact.text}</Badge>
		: (
			<span key={fact.text}>
				{index > 0 && !facts[index - 1].badge && " · "}
				{fact.mark && <span aria-hidden="true" className={`text-${fact.mark}`}>{`${TONE_GLYPH[fact.mark]} `}</span>}
				{fact.text}
			</span>
		)))}</>;
}

/**
 * What sets a row apart beside its band: a decision's option count and approval tag, an In delivery row's route word and receipt count.
 * @returns `{ text, badge? }` per fact — `badge` names the Badge fill
 */
function getRowFactsQ(row, isAccountShown) {
	const { item, copies } = row;
	const account = isAccountShown ? [{ text: item.session.profileLabel }] : [];
	if (item.status === "open" && item.kind === "decision") {
		const count = (item.options ?? []).length;
		return [...account, { text: `${count} ${count === 1 ? "option" : "options"}` }, ...(item.isApprovalClass ? [{ text: "Approval", badge: "tag" }] : [])];
	}
	if (item.status === "open" && item.kind === "report") return account;
	return [...account, ...getDeliveryFactsQ(item, copies)];
}

function getDeliveryFactsQ(item, copies) {
	const images = item.attachments?.length ?? 0;
	const route = item.kind === "decision" ? ["Answer", item.answer?.code].filter(Boolean).join(" ") : `Order${images > 0 ? ` · ${images} ${images === 1 ? "image" : "images"}` : ""}`;
	return [{ text: route }, ...getReceiptFactsQ(copies)];
}

// one copy → only a Not received shows · several → `2 of 3 received` (all waiting → the word Not yet), any not received → its own warning after the count
function getReceiptFactsQ(copies) {
	const receipts = copies.map(getReceiptQ);
	if (receipts.length === 1) return receipts[0] === "notReceived" ? [getReceiptFactQ(receipts[0])] : [];
	const received = getReceiptCountQ(receipts, "received");
	const failed = getReceiptCountQ(receipts, "notReceived");
	const count = { text: received === 0 && failed === 0 ? RECEIPT_Q.notYet : `${received} of ${receipts.length} received` };
	return [count, ...(failed > 0 ? [getNotReceivedFactQ(failed)] : [])];
}

function getReceiptFactQ(receipt) {
	if (receipt === "received") return { text: RECEIPT_Q.received, mark: "ok" };
	return { text: RECEIPT_Q[receipt], badge: receipt === "notYet" ? "tag" : "warn" };
}

/**
 * The receipt of one copy: `received` once its session acknowledged it; `notReceived` once the queue recorded it did not get there
 * (unacked, expired, or the set canResend names); every other state → `notYet`.
 */
function getReceiptQ(item) {
	if (item.status === "delivered") return "received";
	if (item.canResend || item.status === "unacked" || item.status === "expired") return "notReceived";
	return "notYet";
}

// kind + session + title + facts + age → `Decision from gersona: <title>, 3 options, posted 9m ago`
function getRowLabelQ(row, facts, isNameShown) {
	const { item } = row;
	const from = isNameShown ? ` from ${row.copies.length > 1 ? `${row.copies.length} sessions` : item.session.name}` : "";
	const parts = [`${getKindWordQ(item)}${from}: ${item.title}`, ...facts.map((fact) => fact.text), `posted ${window.UI.formatRelativeTime(item.askedAt)}`];
	return parts.join(", ");
}

function getKindWordQ(item) {
	if (item.kind === "decision") return item.status === "open" ? "Decision" : "Answer";
	if (item.kind === "report" && item.status === "open") return "Report";
	return "Order";
}

// the status line: the last act's result or a read's note · a line naming an order carries a quiet Show that opens the order view at it
// the off-view note follows the scroll, so it stays out of the live region: only reads and acts are announced
function ListFootQ({ queue, offView = null, onShowNew }) {
	const data = queue.list.data;
	const { text, orderId = null } = getStatusLineQ(queue.status);
	return (
		<>
			<span className="queue-status-line">
				<span role="status" className="queue-status">{text}</span>
				{orderId !== null && <button type="button" className="btn ghost sm" onClick={() => queue.openOrderRow({ id: orderId })}>Show</button>}
				{offView && <span className="queue-status-new fs-meta text-dim">{`${offView.count} new ${offView.direction}`}</span>}
				{offView && <button type="button" className="btn ghost sm" aria-label={`Show the new item ${offView.direction}`} onClick={() => onShowNew(offView.id)}>Show</button>}
			</span>
			{data && data.nextCursor !== null && <ShowMoreQ count={data.items.length} isBusy={queue.list.status === "loading"} onMore={queue.loadMore} />}
		</>
	);
}

// the page's status as `{ text, orderId? }`: a plain line is a string, a line backing Show names its order (getActionStatusQ)
function getStatusLineQ(status) {
	return typeof status === "string" ? { text: status } : status;
}

function ShowMoreQ({ count, isBusy, onMore }) {
	return <BusyButtonQ className="btn ghost sm" label="Show more" busyLabel="Loading…" title={`${count} items loaded`} isBusy={isBusy} onPress={onMore} />;
}

// in progress → focusable, its rank's rest look and the -ing label; a press does nothing until it settles (spec §12.5)
function BusyButtonQ({ className, label, busyLabel, title, isBusy, onPress }) {
	return (
		<button type="button" className={className} aria-disabled={isBusy || undefined} aria-busy={isBusy || undefined} title={title} onClick={isBusy ? undefined : onPress}>
			{isBusy ? busyLabel : label}
		</button>
	);
}

function QueueFilterBarQ({ items, filter, onFilter }) {
	const { FilterBar } = window.UI;
	const options = getFilterOptionsQ(items, filter);
	return (
		<FilterBar label="Queue filters" isApplied={Boolean(filter.profile)} onReset={() => onFilter({ ...filter, profile: "" })}>
			<FilterAxisTriggerQ axis="Account" options={options.profile} value={filter.profile} onPick={(profile) => onFilter({ ...filter, profile })} />
		</FilterBar>
	);
}

// One radio axis — "" (All) is a real option, so the trigger always names the value in force
function FilterAxisTriggerQ({ axis, options, value, onPick }) {
	const label = options.find((option) => option.key === value)?.label ?? value;
	return <window.UI.FilterTrigger axis={axis} value={label} options={options} chosenKeys={[value]} onPick={onPick} />;
}

/** The opened row's sheet in the list's place: the item as a one-page report, or the item that just left the queue; nothing opened → nothing. */
function QueueSheetQ({ queue }) {
	const { sheet } = queue;
	if (sheet.kind !== "item" && sheet.kind !== "left") return null;
	return <ItemSheetQ key={sheet.id} item={sheet.item} queue={queue} cliPath={queue.list.data?.cliPath} hasLeft={sheet.kind === "left"} />;
}

/**
 * One item on the sheet: head (the way back, kind and session, the stepping), body (the date line, title, text, kind block, state lines), foot (the composer).
 * Its own card markup: the head's h2 sits between two buttons, which the Card head's title slot cannot hold.
 * @param cliPath - the installed queue CLI the server resolved (GA_ROOT-aware)
 */
function ItemSheetQ({ item, queue, cliPath, hasLeft = false }) {
	const draft = queue.drafts[item.id] ?? {};
	const isBusy = queue.busy.id === item.id;
	const error = queue.busy.error?.id === item.id ? queue.busy.error.message : null;
	return (
		<div className="card queue-pane queue-sheet">
			<SheetHeadQ item={item} queue={queue} />
			<div className="card-body" tabIndex={-1}>
				<SheetBodyQ item={item} draft={draft} onDraft={(patch) => queue.setDraft(item.id, { ...patch, error: null })} cliPath={cliPath} />
			</div>
			<div className="card-foot">{hasLeft ? <LeftQueueLineQ /> : <SheetFootQ item={item} draft={draft} queue={queue} isBusy={isBusy} error={error} />}</div>
		</div>
	);
}

// the way back (its arrival count in its name, painted beside the glyph-only square) · the h2 · the position and previous / next (spec §4.3, §12.5)
function SheetHeadQ({ item, queue }) {
	const { Badge, Icon } = window.UI;
	const { steps } = queue;
	const arrived = queue.list.newIds.length;
	return (
		<div className="card-head queue-sheet-head">
			<span className="queue-back">
				<button type="button" className="btn ghost sm icon" aria-label={arrived > 0 ? `Back to the list, ${arrived} new in the list` : "Back to the list"} title="Back to the list (Esc)" onClick={queue.back}>
					<Icon name="arrow-left" size={16} />
				</button>
				{arrived > 0 && <span aria-hidden="true"><Badge fill="solid">{arrived}</Badge></span>}
			</span>
			<h2 className="card-title"><LetterheadQ item={item} nameNote={getNameNoteQ(item.session, queue)} /></h2>
			<span className="queue-steps">
				{steps.index >= 0 && <span className="fs-meta text-dim tabular-nums">{`${steps.index + 1} of ${steps.count}`}</span>}
				<button type="button" className="btn ghost sm icon" aria-label="Previous item" title="Previous item (K)" disabled={steps.prevId === null} onClick={() => queue.selectRow(steps.prevId)}><Icon name="chevron-up" size={16} /></button>
				<button type="button" className="btn ghost sm icon" aria-label="Next item" title="Next item (J)" disabled={steps.nextId === null} onClick={() => queue.selectRow(steps.nextId)}><Icon name="chevron-down" size={16} /></button>
			</span>
		</div>
	);
}

// visible only where it tells two apart: the 8-character id while two loaded sessions share the name, the account while items span accounts (spec §4.3, §9.1)
function getNameNoteQ(session, queue) {
	const items = queue.list.data?.items ?? [];
	const loaded = [...items.map((item) => item.session), ...(queue.sessions?.region?.data?.sessions ?? [])];
	const isTwin = loaded.some((other) => other.name === session.name && other.id !== session.id);
	const isManyAccounts = new Set(items.map((item) => item.session.profileLabel)).size > 1;
	return [isTwin && session.id.slice(0, SESSION_PREFIX_LENGTH_Q), isManyAccounts && session.profileLabel].filter(Boolean).map((part) => ` · ${part}`).join("");
}

// the head's h2 content: read as `Decision from gersona`; the session's account, directory and id ride its title
function LetterheadQ({ item, nameNote = "" }) {
	const { Badge } = window.UI;
	const { session } = item;
	const where = [session.profileLabel, session.cwd, session.id].filter(Boolean).join(" · ");
	return (
		<span className="queue-letter">
			<Badge fill="tag">{getKindWordQ(item)}</Badge>
			<span className="sr-only">{" from "}</span>
			<span className="queue-letter-name" title={where}><ItemSessionNameQ session={session} />{nameNote}</span>
		</span>
	);
}

function LetterheadFactsQ({ item }) {
	const facts = item.status === "open" ? getRowFactsQ({ item, copies: [item] }, false) : [getReceiptFactQ(getReceiptQ(item))];
	return facts.length > 0 ? <RowFactsQ facts={facts} /> : null;
}

function LetterheadTimeQ({ item }) {
	const isAnswered = item.status !== "open" && item.answeredAt;
	const verb = isAnswered ? "Answered" : "Posted";
	const time = getDatedTimeQ(isAnswered ? item.answeredAt : item.askedAt);
	const record = isAnswered ? getAnswerLineQ(item) : null;
	return (
		<span className="fs-meta text-faint tabular-nums" title={record && !record.isOutside ? record.text : `${verb} ${time}`}>
			<span className="sr-only">{`${verb} `}</span>{time}
		</span>
	);
}

// spec §4.3 → `2026-11-12 21:20 KST`
function getDatedTimeQ(iso) {
	const { formatKstDate, formatKstTime } = window.UI;
	return `${formatKstDate(iso)} ${formatKstTime(iso)} KST`;
}

function SheetBodyQ({ item, draft, onDraft, cliPath }) {
	const isAnsweredDecision = item.kind === "decision" && item.status !== "open";
	return (
		<div className="queue-sheet-body">
			<p className="queue-date-line">
				<span className="queue-date-facts"><LetterheadFactsQ item={item} /></span>
				<LetterheadTimeQ item={item} />
			</p>
			<h3 className="queue-sheet-title">{item.title}</h3>
			{isAnsweredDecision ? <YourAnswerQ item={item} /> : <ItemTextQ item={item} />}
			{item.kind === "decision" && item.status === "open" && <OptionsQ item={item} draft={draft} onDraft={onDraft} />}
			<CardStateQ item={item} cliPath={cliPath} />
			{isAnsweredDecision && <OriginalQuestionQ item={item} />}
			{item.resumes.length > 0 && <ResumeRecordListQ resumes={item.resumes} profileLabel={item.session.profileLabel} />}
		</div>
	);
}

function ItemTextQ({ item }) {
	const { ProseText } = window.UI;
	return (
		<>
			<ProseText text={item.body} linkedDocIds={item.linkedDocIds} />
			<DocumentsLineQ item={item} />
		</>
	);
}

// declared documents the text did not turn into a link; none → no line
function DocumentsLineQ({ item }) {
	const { linkedIds } = window.UI.getProseBlocks(item.body, item.linkedDocIds);
	const rest = item.linkedDocIds.filter((id) => !linkedIds.includes(id));
	if (rest.length === 0) return null;
	return (
		<p className="prose-text">
			{"Documents: "}
			{rest.map((id, index) => <React.Fragment key={id}>{index > 0 && ", "}<a className="prose-link" href={`#clauded-docs?doc=${id}`}>{id}</a></React.Fragment>)}
		</p>
	);
}

// no option preselected → the recommended answer is never one press away
function OptionsQ({ item, draft, onDraft }) {
	return (
		<fieldset className="queue-options queue-kind">
			<legend>Options</legend>
			{(item.options ?? []).map((option) => (
				<OptionRowQ key={option.code} itemId={item.id} option={option} isRecommended={option.code === item.recommendedCode}
					isChecked={draft.code === option.code} onPick={() => onDraft({ code: option.code })} />
			))}
		</fieldset>
	);
}

function OptionRowQ({ itemId, option, isRecommended, isChecked, onPick }) {
	const { Badge } = window.UI;
	return (
		<label className="queue-option">
			<input id={`queue-option-${itemId}-${option.code}`} type="radio" className="ctl-radio" name={`queue-options-${itemId}`} checked={isChecked} onChange={onPick} />
			<span className="min-w-0">
				<span className="queue-option-head">
					<span><span className="text-dim">{option.code}</span>{` ${option.label}`}</span>
					{isRecommended && <Badge fill="tag">Recommended</Badge>}
				</span>
				{(option.pros || option.cons) && (
					<span className="queue-option-sides">
						{option.pros && <><span className="queue-label">Pros</span><span>{option.pros}</span></>}
						{option.cons && <><span className="queue-label">Cons</span><span>{option.cons}</span></>}
					</span>
				)}
			</span>
		</label>
	);
}

function YourAnswerQ({ item }) {
	const { ProseText } = window.UI;
	const option = (item.options ?? []).find((candidate) => candidate.code === item.answer?.code);
	return (
		<div>
			<p className="queue-label">Your answer</p>
			{option && <p className="queue-answer">{`${option.code} · ${option.label}`}</p>}
			{item.answer?.text && <ProseText text={item.answer.text} />}
		</div>
	);
}

// the decision as it was asked, as text and not as controls
function OriginalQuestionQ({ item }) {
	const { ProseText } = window.UI;
	const options = item.options ?? [];
	return (
		<details className="queue-kind">
			<summary className="group disclosure queue-fold"><window.UI.DisclosureChevron /><span>{`Show the question and its ${options.length} ${options.length === 1 ? "option" : "options"}`}</span></summary>
			<ProseText text={item.body} linkedDocIds={item.linkedDocIds} />
			<ul className="prose-text">{options.map((option) => <li key={option.code}>{`${option.code} · ${option.label}`}</li>)}</ul>
		</details>
	);
}

/**
 * Answer record, deviation word, how a live session takes its answer, and precedence notes.
 * @param cliPath - the installed queue CLI the server resolved (GA_ROOT-aware)
 */
function CardStateQ({ item, cliPath }) {
	const { Stack } = window.UI;
	const notes = getCardNotesQ(item);
	return (
		<Stack gap="label">
			<AnswerLineQ item={item} />
			<PullLineQ item={item} cliPath={cliPath} />
			{notes.length === 0 && <NotReceivedLineQ item={item} cliPath={cliPath} />}
			{notes.map((note) => <p key={getNoteKeyQ(note)} className="fs-meta text-dim"><NotePartsQ parts={note} /></p>)}
		</Stack>
	);
}

// an answered item waits for its live session's pull: a waiting session claims it at its next poll, any other one needs the owner to run the pull
function PullLineQ({ item, cliPath }) {
	const { MachineString } = window.UI;
	if (item.status !== "answered" || item.session.state !== "live") return null;
	if (item.session.isWaiting) return <p className="fs-meta text-dim">The session is waiting: its next poll takes this answer.</p>;
	if (!cliPath) return null;
	return <p className="fs-meta text-dim">Run in that session: <MachineString>{`${getShellWordQ(cliPath)} pending`}</MachineString></p>;
}

// the ack window differs by route (pull or resume) and stays the server's → the line names no minutes
function NotReceivedLineQ({ item, cliPath }) {
	const { MachineString } = window.UI;
	if (item.status === "open" || getReceiptQ(item) !== "notReceived") return null;
	const name = item.session.name;
	return (
		<p className="fs-meta text-dim">
			{`${name} did not acknowledge it.`}
			{cliPath && <>{` If ${name} is alive, run in that session: `}<MachineString>{`${getShellWordQ(cliPath)} pending`}</MachineString></>}
		</p>
	);
}

/** Answer record line `{ text, isOutside }`; an item with no answer → null. */
function getAnswerLineQ(item) {
	const time = item.answeredAt ? getDatedTimeQ(item.answeredAt) : null;
	if (item.isAnsweredOutside) return { text: [OUTSIDE_ANSWER_LABEL_Q, time].filter(Boolean).join(" · "), isOutside: true };
	const record = item.answerRecord;
	if (!record) return null;
	const route = ANSWER_ROUTE_LABEL_Q[record.route] ?? record.route;
	return { text: [route, time, ANSWER_SIGNAL_LABEL_Q[record.signal] ?? record.signal].filter(Boolean).join(" "), isOutside: false };
}

function AnswerLineQ({ item }) {
	const line = getAnswerLineQ(item);
	if (line === null || !line.isOutside) return null;
	return <ToneLineQ tone="warn">{line.text}</ToneLineQ>;
}

function getNoteKeyQ(parts) {
	return parts.map((part) => (typeof part === "string" ? part : part.machine)).join("");
}

function NotePartsQ({ parts }) {
	const { MachineString } = window.UI;
	return <>{parts.map((part, index) => (typeof part === "string" ? part : <MachineString key={index}>{part.machine}</MachineString>))}</>;
}

// answered elsewhere, withdrawn or received while on the sheet → it stays until the owner moves on, with nothing left to send
function LeftQueueLineQ() {
	return <div className="queue-composer"><ToneLineQ tone="info">This item left the queue.</ToneLineQ></div>;
}

/** The sheet's foot: the composer in its decision or report use; an item already answered or sent → its buttons alone. */
function SheetFootQ({ item, draft, queue, isBusy, error }) {
	if (item.status === "open" && item.kind === "decision") return <DecisionComposerQ item={item} draft={draft} queue={queue} isBusy={isBusy} error={error} />;
	if (item.status === "open" && item.kind === "report") return <ReportComposerQ item={item} draft={draft} queue={queue} isBusy={isBusy} error={error} />;
	const label = item.kind === "decision" ? "Resend answer" : "Resend";
	const buttons = item.canResend ? [{ label, onPress: () => queue.send(item.id, "resend") }] : [];
	return <ComposerQ buttons={buttons} isBusy={isBusy} note={error ? <ToneLineQ tone="crit" role="alert" isTextToned>{error}</ToneLineQ> : null} />;
}

function DecisionComposerQ({ item, draft, queue, isBusy, error }) {
	const name = item.session.name;
	const firstCode = (item.options ?? [])[0]?.code;
	const onSend = () => {
		const body = getAnswerBodyQ(draft);
		if (body === null) return putInvalidQ(queue, item.id, COMPOSER_ERROR_Q.noAnswer, firstCode ? `queue-option-${item.id}-${firstCode}` : `queue-text-${item.id}`);
		return queue.answerItem(item.id, body);
	};
	const resend = item.canResend ? [{ label: "Resend", onPress: () => queue.send(item.id, "resend") }] : [];
	const rest = `${draft.code ? `${draft.code} picked` : "No option picked"}. Goes to ${name}.`;
	return (
		<ComposerQ field={item.isFreeTextAllowed ? { id: `queue-text-${item.id}`, label: "Your own answer or a note on this decision (optional)" } : null}
			text={draft.text ?? ""} onText={(text) => queue.setDraft(item.id, { text, error: null })} isBusy={isBusy}
			buttons={[...resend, { label: "Send answer", isInk: true, onPress: onSend }]}
			note={<ComposerNoteQ error={error ?? draft.error} info={item.isApprovalClass ? `Approval: after you answer here, confirm once more in ${name}'s terminal.` : null} rest={rest} />}
			later={{ label: "Answer later", keyName: "l", onPress: () => queue.later(item.id) }} />
	);
}

// Mark as read carries the ink while the box is empty, Send order once it holds text or an image; order, labels and widths never change
function ReportComposerQ({ item, draft, queue, isBusy, error }) {
	const name = item.session.name;
	const fieldId = `queue-reply-${item.id}`;
	const box = getDraftBoxQ(queue, item.id, draft);
	const hasText = box.text.trim() !== "";
	const hasContent = hasText || box.shots.length > 0;
	const { zone, tray } = useTrayZoneQ(fieldId, box);
	const markRead = () => (hasContent ? putInvalidQ(queue, item.id, COMPOSER_ERROR_Q.unsentOrder, fieldId) : queue.settle(item.id, "seen"));
	const sendOrder = () => (hasText ? sendReplyQ(queue, item.id, box) : putInvalidQ(queue, item.id, COMPOSER_ERROR_Q.noOrder, fieldId));
	const order = item.isFreeTextAllowed ? [{ label: "Send order", isInk: hasContent, onPress: sendOrder }] : [];
	const rest = hasContent ? `Send order delivers this to ${name} and closes the report.` : `Mark as read closes this report. ${name} hears nothing.`;
	return (
		<ComposerQ field={item.isFreeTextAllowed ? { id: fieldId, label: `Order to ${name} on this report (optional)` } : null} tray={item.isFreeTextAllowed ? tray : null} zone={zone.handlers}
			text={box.text} onText={box.setText} isBusy={isBusy || Boolean(draft.isWaiting)}
			buttons={[{ label: "Mark as read", isInk: !hasContent, keyName: "e", onPress: markRead }, ...order]}
			note={<ComposerNoteQ error={error ?? draft.error} tray={tray} fieldId={fieldId} rest={rest} />}
			later={{ label: "Read later", keyName: "l", onPress: () => queue.later(item.id) }} />
	);
}

/** A report's draft as a composer box `{ text, setText, shots, setShots, putError }`, every change written back to the draft. */
function getDraftBoxQ(queue, id, draft) {
	return {
		text: draft.text ?? "", setText: (text) => queue.setDraft(id, { text, error: null }),
		shots: draft.images ?? [], setShots: (update) => queue.setImages(id, update), putError: (error) => queue.setDraft(id, { error }),
	};
}

// the report's reply with the box's text and images; an upload still running → the draft waits (Sending…)
function sendReplyQ(queue, id, box) {
	return sendWithImagesQ(box.shots, (ids) => queue.settle(id, "reply", getImageBodyQ({ text: box.text }, ids)), (isWaiting) => queue.setDraft(id, { isWaiting }));
}

// a press with something missing → the note slot says what and focus goes to the first missing control
function putInvalidQ(queue, id, message, targetId) {
	queue.setDraft(id, { error: message });
	window.document?.getElementById(targetId)?.focus();
}

/**
 * One composer for every field the owner writes in: label, the box and its buttons on one row, the reserved note line.
 * Buttons are always enabled; while sending they read `Sending…` and carry aria-disabled. Cmd / Ctrl + Enter presses the ink button.
 * @param field - `{ id, label }` of the box; null → buttons alone
 * @param buttons - `{ label, isInk, keyName, onPress, parts }` in order, the ink one last; `keyName` = the desk key that presses it (getDeskKeyQ): a letter, or `send` for Cmd / Ctrl + Enter;
 *   `parts` (getSendPartsQ) → the label may be cut to its row, the whole label in the button's title
 * @param later - the quiet button at the end of the note line, `{ label, keyName, onPress }`
 */
function ComposerQ({ field = null, text = "", onText, isBusy, buttons, note, later, tray = null, zone = null }) {
	const ink = buttons.find((button) => button.isInk);
	// the send key presses the button keyed `send` where there is one, else the ink one
	const keyed = buttons.find((button) => button.keyName === "send") ?? ink;
	const onKeyDown = (event) => {
		if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || !keyed || isBusy) return;
		event.preventDefault();
		keyed.onPress();
	};
	return (
		<div className="queue-composer" {...(tray ? zone : null)}>
			{field && getFieldLabelQ(field)}
			<div className="queue-compose-row">
				{field && <ComposeBoxQ field={field} text={text} onText={onText} onKeyDown={onKeyDown} tray={tray} />}
				<div className="queue-compose-buttons">
					{buttons.map((button) => (
						<button key={button.label} type="button" className={button.isInk ? "btn lg primary" : "btn lg"} data-key={button.keyName} aria-disabled={isBusy || undefined}
							aria-busy={(isBusy && button.isInk) || undefined} title={button.parts ? button.label : undefined} onClick={isBusy ? undefined : button.onPress}>
							{isBusy && button.isInk ? "Sending…" : getButtonTextQ(button)}
						</button>
					))}
				</div>
			</div>
			<div className="queue-note">
				<div className="queue-note-text">{note}</div>
				{later && <button type="button" className="btn ghost sm" data-key={later.keyName} disabled={isBusy} onClick={later.onPress}>{later.label}</button>}
			</div>
		</div>
	);
}

function getFieldLabelQ(field) {
	return <label htmlFor={field.id} className="field-label">{field.label}</label>;
}

// a label in parts (getSendPartsQ) → one cut line inside the button; its text stays the whole label, so the accessible name does too
function getButtonTextQ({ label, parts }) {
	if (!parts) return label;
	return (
		<span className="queue-send-label">
			<span>{parts.head}</span>
			{parts.name && <span className="queue-send-name">{parts.name}</span>}
			{parts.tail && <span className="queue-send-tail">{parts.tail}</span>}
		</span>
	);
}

/** The bordered box: the thumbnails row while images are attached, the text, and `Add images` where the use takes images. */
function ComposeBoxQ({ field, text, onText, onKeyDown, tray }) {
	// a pasted file is an image to add; pasted text stays text
	const onPaste = (event) => {
		const files = Array.from(event.clipboardData?.files ?? []);
		if (!tray || files.length === 0) return;
		event.preventDefault();
		tray.onFiles(files, true);
	};
	return (
		<div className={`queue-compose-box${tray ? " has-images" : ""}${tray?.isOver ? " is-drop" : ""}`}>
			{tray && tray.shots.length > 0 && <ThumbsQ fieldId={field.id} tray={tray} />}
			<textarea id={field.id} rows={1} className="queue-compose-text" value={text} onChange={(event) => onText(event.target.value)} onKeyDown={onKeyDown} onPaste={onPaste} />
			{tray && <AddImagesQ fieldId={field.id} onFiles={tray.onFiles} />}
		</div>
	);
}

function AddImagesQ({ fieldId, onFiles }) {
	const { Icon } = window.UI;
	const inputId = `${fieldId}-files`;
	const onChange = (event) => {
		onFiles(Array.from(event.target.files ?? []), false);
		event.target.value = "";
	};
	return (
		<>
			<button type="button" className="btn ghost icon queue-compose-add" aria-label="Add images" title="Add images" onClick={() => window.document?.getElementById(inputId)?.click()}>
				<Icon name="image-plus" size={16} />
			</button>
			<input id={inputId} type="file" accept={IMAGES_Q.ACCEPT} multiple hidden onChange={onChange} />
		</>
	);
}

// the thumbnails wrap with the count after the last one; each remove button is always shown
function ThumbsQ({ fieldId, tray }) {
	return (
		<div className="queue-thumbs">
			<ul className="queue-thumb-list" aria-label="Attached images">
				{tray.shots.map((shot) => <ThumbQ key={shot.key} shot={shot} removeId={getRemoveIdQ(fieldId, shot.key)} onRemove={() => tray.onRemove(shot.key)} />)}
			</ul>
			<span className="queue-thumbs-count">{getImageCountLineQ(tray.shots)}</span>
		</div>
	);
}

function ThumbQ({ shot, removeId, onRemove }) {
	const isBusy = shot.status === "uploading";
	return (
		<li className={`queue-thumb${isBusy ? " is-busy" : ""}`} aria-busy={isBusy || undefined} title={`${shot.name} · ${getSizeTextQ(shot.bytes)}`}>
			{shot.status === "failed"
				? <span className="queue-thumb-failed" role="img" aria-label={`${shot.name}: not uploaded`}>✕</span>
				: <img src={shot.src} alt={shot.name} />}
			<button id={removeId} type="button" className="queue-thumb-remove" aria-label={`Remove ${shot.name}`} onClick={onRemove}><span aria-hidden="true">✕</span></button>
		</li>
	);
}

function getRemoveIdQ(fieldId, key) {
	return `${fieldId}-remove-${key}`;
}

// one line: a refusal or a missing control (crit alert), else what the images need, else the approval reminder (info), else the line at rest
function ComposerNoteQ({ error, info = null, rest, tray = null, fieldId = "" }) {
	if (error) return <ToneLineQ tone="crit" role="alert" isTextToned>{error}</ToneLineQ>;
	const image = tray ? getImageNoteQ(tray.shots, tray.isOver) : null;
	if (image?.tone === "crit") return <ImageFailureLineQ text={image.text} retryId={`${fieldId}-retry`} onRetry={() => tray.onRetry(image.retryKey)} />;
	if (image) return <p className="fs-meta" aria-live="polite">{image.text}</p>;
	if (info) return <ToneLineQ tone="info">{info}</ToneLineQ>;
	return <p className="fs-meta">{rest}</p>;
}

// re-sending a file is a re-send → it keeps its word (spec §12.5), the quiet tier
function ImageFailureLineQ({ text, retryId, onRetry }) {
	return (
		<span className="queue-note-failure">
			<ToneLineQ tone="crit" role="alert" isTextToned>{text}</ToneLineQ>
			<button id={retryId} type="button" className="btn ghost sm" onClick={onRetry}>Try again</button>
		</span>
	);
}

// one-line note led by its tone glyph → the tone survives without colour; an error line is toned whole
function ToneLineQ({ tone, role, isTextToned = false, children }) {
	return (
		<p className={isTextToned ? `fs-meta text-${tone}` : "fs-meta"} role={role}>
			<span aria-hidden="true" className={`text-${tone}`}>{`${window.UI.TONE_GLYPH[tone]} `}</span>
			{children}
		</p>
	);
}

// option code and/or non-blank free text; neither → no answer to send (null)
function getAnswerBodyQ(draft) {
	const text = draft.text?.trim() ? draft.text : undefined;
	if (draft.code === undefined && text === undefined) return null;
	return { ...(draft.code === undefined ? {} : { code: draft.code }), ...(text === undefined ? {} : { text }) };
}

function ResumeRecordListQ({ resumes, profileLabel }) {
	return (
		<ul className="fs-meta text-dim" aria-label="Automatic resumes">
			{resumes.map((resume) => <li key={`${resume.attempt}-${resume.sentAt}`}><ResumeLineQ resume={resume} profileLabel={profileLabel} /></li>)}
		</ul>
	);
}

function ResumeLineQ({ resume, profileLabel }) {
	const { formatKstDateTime } = window.UI;
	const account = profileLabel ? ` · ${profileLabel}` : "";
	return <span>{`Automatic resume ${formatKstDateTime(resume.sentAt)}${account} · attempt ${resume.attempt} · ${getResumeResultLabelQ(resume)}`}</span>;
}

/**
 * The Sessions rail (spec §9.1): the All sessions band, the live and unreachable rows, the Ended band and its rows when open.
 * A row button scopes the list (the Session filter); its box ticks a recipient. Foot: the recent automatic resumes.
 */
function SessionsRegionQ({ queue }) {
	const { Card, RegionUnavailable, LoadingPlaceholder, getRegionView } = window.UI;
	const { sessions } = queue;
	const view = getRegionView(sessions.region);
	const rows = view === "ready" ? sessions.region.data.sessions : [];
	const endedCount = rows.filter((row) => row.state === "exited").length;
	// a rail not read yet states no count (as getOrderNoteQ with no rows)
	const sub = view === "ready" ? `${rows.length - endedCount} live · ${endedCount} ended` : undefined;
	return (
		<Card className="queue-pane queue-sessions" title="Sessions" sub={sub}
			foot={<RailFootQ queue={queue} />} isFlush>
			{view === "loading" && <div className="queue-loading"><LoadingPlaceholder label="sessions" /></div>}
			{view === "error" && <RegionUnavailable source={SESSIONS_Q.SOURCE} error={sessions.region.error} isBusy={sessions.region.busy} onRetry={sessions.read} />}
			{view === "ready" && <SessionsBodyQ queue={queue} rows={rows} />}
		</Card>
	);
}

function SessionsBodyQ({ queue, rows }) {
	const { EmptyState } = window.UI;
	const { sessions } = queue;
	const live = rows.filter((row) => row.state !== "exited");
	const ended = rows.filter((row) => row.state === "exited");
	const shown = getShownSessionsQ(rows, sessions.isEndedShown);
	const view = { collidingNames: getCollidingNamesQ(shown), notReceived: getNotReceivedBySessionQ(queue.list.data?.items ?? []) };
	return (
		<>
			<p id={RAIL_HINT_Q.ID} hidden>{RAIL_HINT_Q.TEXT}</p>
			<AllSessionsBandQ rows={rows} sessions={sessions} notReceived={[...view.notReceived.values()].reduce((sum, count) => sum + count, 0)} />
			{live.length === 0 && <EmptyState message="No connected sessions" hint="A session appears here once it registers or posts to the queue." />}
			{live.map((row) => <SessionRailRowQ key={row.id} row={row} view={view} sessions={sessions} />)}
			{ended.length > 0 && <EndedBandQ count={ended.length} isOpen={sessions.isEndedShown} onToggle={() => sessions.setEndedShown(!sessions.isEndedShown)} />}
			{sessions.isEndedShown && ended.map((row) => <SessionRailRowQ key={row.id} row={row} view={view} sessions={sessions} />)}
		</>
	);
}

/** The head of the roster, the whole band its master box's label (spec §9.1): the box in the rows' box column, the label on their names' column; no live session that takes a message → no box. */
function AllSessionsBandQ({ rows, sessions, notReceived }) {
	const { Badge } = window.UI;
	const master = getMasterTickQ(sessions.selectedIds, rows);
	const waiting = rows.reduce((sum, row) => sum + row.count.awaiting, 0);
	const isMasterShown = getLiveTargetIdsQ(rows).length > 0;
	const Band = isMasterShown ? "label" : "div";
	const warn = notReceived > 0 && <Badge fill="warn" title={getNotReceivedFactQ(notReceived).text}>{notReceived}<span className="sr-only">{" not received"}</span></Badge>;
	return (
		<Band className="queue-band queue-rail-band">
			{isMasterShown && (
				<span className="queue-rail-box">
					<span className="inline-target"><CheckboxBoxQ isChecked={master === "all"} isMixed={master === "some"} onChange={() => sessions.setSelectedIds((ids) => putMasterTickQ(ids, rows))} ariaLabel="Select all live sessions" describedBy={RAIL_HINT_Q.ID} /></span>
				</span>
			)}
			<span className="queue-rail-all">All sessions{waiting > 0 && <Badge role="count" fill="tag">{waiting}</Badge>}{warn}</span>
		</Band>
	);
}

function EndedBandQ({ count, isOpen, onToggle }) {
	const { Badge, DisclosureButton } = window.UI;
	return (
		<div className="queue-band queue-rail-band">
			<DisclosureButton isOpen={isOpen} onToggle={onToggle} label={<>Ended <Badge role="count" fill="tag">{count}</Badge></>} />
		</div>
	);
}

/** The master box: `"none"` with nothing ticked, `"all"` with every live session that takes a message ticked, else `"some"`. */
function getMasterTickQ(ids, rows) {
	if (ids.length === 0) return "none";
	const live = getLiveTargetIdsQ(rows);
	return live.length > 0 && live.every((id) => ids.includes(id)) ? "all" : "some";
}

// nothing ticked → every live session that takes a message · anything ticked → none, an ended tick too: one press is back at the desk's rest
function putMasterTickQ(ids, rows) {
	return ids.length === 0 ? getLiveTargetIdsQ(rows) : [];
}

function getLiveTargetIdsQ(rows) {
	return rows.filter((row) => row.state !== "exited" && row.isSelectable).map((row) => row.id);
}

function getCollidingNamesQ(rows) {
	const seen = new Map();
	for (const row of rows) seen.set(row.name, (seen.get(row.name) ?? 0) + 1);
	return new Set([...seen].filter(([, count]) => count > 1).map(([name]) => name));
}

// recipients that did not get what was sent, per session: the copies in the list the queue recorded as not received
function getNotReceivedBySessionQ(items) {
	const counts = new Map();
	for (const item of items) {
		if (item.status !== "open" && getReceiptQ(item) === "notReceived") counts.set(item.session.id, (counts.get(item.session.id) ?? 0) + 1);
	}
	return counts;
}

/**
 * One session, one control (spec §9.1): the whole row is its box's label, so a press anywhere ticks it; a row that takes no message is no control.
 * From the start: box · state mark · name · count; a row with no box keeps its mark and name in place.
 */
function SessionRailRowQ({ row, view, sessions }) {
	const where = [row.profileLabel, row.cwd, row.id].filter(Boolean).join(" · ");
	const Row = row.isSelectable ? "label" : "div";
	return (
		<Row className="queue-rail-row" data-session={row.id} title={where}>
			{row.isSelectable && (
				<span className="queue-rail-box">
					<span className="inline-target"><CheckboxBoxQ isChecked={sessions.selectedIds.includes(row.id)} onChange={() => sessions.toggle(row.id)} ariaLabel={`Select ${row.name}`} describedBy={RAIL_HINT_Q.ID} /></span>
				</span>
			)}
			<RailRowFaceQ row={row} view={view} where={where} />
		</Row>
	);
}

// the mark is live or not by shape and colour together; line 2 says the state in words → the mark is hidden from screen readers
function RailRowFaceQ({ row, view, where }) {
	const { Badge } = window.UI;
	return (
		<>
			<span aria-hidden="true" className={`queue-rail-mark${row.state === "live" ? " is-live" : ""}`} />
			<span className="queue-rail-name">
				<SessionNameQ row={row} isIdShown={view.collidingNames.has(row.name)} />
			</span>
			{row.count.awaiting > 0 && <span className="queue-rail-count"><Badge role="count" fill="solid">{row.count.awaiting}</Badge><span className="sr-only">{" waiting"}</span></span>}
			<span className="queue-rail-line"><RowFactsQ facts={getSessionLineQ(row, view.notReceived.get(row.id) ?? 0)} /></span>
			<span className="sr-only">{`, ${where}`}</span>
		</>
	);
}

// no registered name → the server's start-directory name, marked so it never reads as one the session chose; the id only to tell two names apart
function SessionNameQ({ row, isIdShown }) {
	const { MachineString } = window.UI;
	return (
		<span className="queue-rail-name-text">
			{row.name}
			{!row.isNameRegistered && <span className="font-normal text-dim">{" · start directory"}</span>}
			{isIdShown && <span className="font-normal text-dim">{" · "}<MachineString>{row.sessionIdPrefix}</MachineString></span>}
		</span>
	);
}

/**
 * Line 2 of a rail row, the first matching condition (spec §9.1): not received · not reachable · live with orders on the way ·
 * live · a resume not yet registered · ended. Facts in the row-facts shape.
 */
function getSessionLineQ(row, notReceived) {
	const { formatRelativeTime } = window.UI;
	const age = { text: formatRelativeTime(row.lastActivityAt) };
	if (notReceived > 0) return [getNotReceivedFactQ(notReceived)];
	if (row.state === "stale") return [{ text: "Not reachable", badge: "warn" }, age];
	if (row.state === "live") return [{ text: SESSION_STATE_LABEL_Q.live }, row.count.inDelivery > 0 ? { text: `${row.count.inDelivery} in delivery` } : age];
	if (row.markerSetAt) return [{ text: "Resume not yet registered" }];
	return [{ text: getSessionStateLabelQ(row), badge: "tag" }, age];
}

// base.css → .ctl-checkbox visual: the mark drawn over the 16 box; the caller's label is the hit area; mixed → the DOM's indeterminate state
function CheckboxBoxQ({ isChecked, isMixed = false, onChange, ariaLabel, describedBy }) {
	const { Icon } = window.UI;
	const setMixed = (input) => { if (input) input.indeterminate = isMixed; };
	return (
		<span className="relative inline-flex items-center justify-center">
			<input ref={setMixed} type="checkbox" className="ctl-checkbox" checked={isChecked} onChange={onChange} aria-label={ariaLabel} aria-describedby={describedBy} />
			{(isChecked || isMixed) && <Icon name={isChecked ? "check" : "minus"} size={12} stroke={3} className="ctl-checkbox-mark pointer-events-none absolute" />}
		</span>
	);
}

/** Orders (spec §9.2), always open: head Orders + whose orders the thread holds, the thread of the owner's orders, the composer in its order use. */
function OrdersViewQ({ queue }) {
	const { Card } = window.UI;
	const { orders, sessions } = queue;
	const rows = sessions.region.data?.sessions ?? [];
	const box = getOrderBoxQ(queue);
	// a file dropped anywhere on the card joins the order box
	const { zone, tray } = useTrayZoneQ(ORDERS_Q.BOX_ID, box);
	const targets = getSendTargetsQ(rows, sessions.selectedIds);
	const names = rows.filter((row) => sessions.selectedIds.includes(row.id)).map((row) => row.name);
	const scope = names.length > 0 ? `to ${names.join(", ")}` : "to every session";
	return (
		<section className="queue-orders" aria-label="Orders" {...zone.handlers}>
			<Card className="queue-orders-card" title="Orders" sub={<span className="queue-orders-scope" title={scope}>{scope}</span>}
				foot={<OrderComposerQ queue={queue} targets={targets} rows={rows} box={box} tray={tray} isReady={sessions.region.data !== null} />} isFlush>
				<ThreadQ orders={orders} names={names} busy={queue.busy} />
			</Card>
		</section>
	);
}

/** The owner's orders oldest first under day labels, `Show earlier` at the top; it opens at its end (useThreadScrollQ). */
function ThreadQ({ orders, names, busy }) {
	const { LoadingPlaceholder } = window.UI;
	const { thread } = orders;
	const [viewer, setViewer] = useStateQ(null);
	const entries = getThreadEntriesQ(thread.items);
	const scroll = useThreadScrollQ(entries);
	useThreadAimQ(entries, orders.aim, orders.clearAim);
	return (
		<div ref={scroll.ref} onScroll={scroll.onScroll} role="log" aria-label={names.length > 0 ? `Orders to ${getNameListQ(names)}` : "All orders"} tabIndex={0} className="queue-thread">
			{thread.nextCursor !== null && <ShowEarlierQ isBusy={thread.status === "loading"} onShow={orders.showEarlier} />}
			{thread.status === "error" && <QueueFailureQ failure={thread.error} onRetry={orders.read} />}
			{thread.status === "loading" && entries.length === 0 && <div className="queue-loading"><LoadingPlaceholder label="orders" /></div>}
			{thread.status === "ready" && entries.length === 0 && <ThreadEmptyQ names={names} />}
			{getDayGroupsQ(entries).map((group) => (
				<div key={group.day} className="queue-day-group">
					<p className="queue-day">{group.label}</p>
					{group.entries.map((entry) => <OrderEntryQ key={entry.id} entry={entry} busy={busy} onResend={orders.resend} onOpenImage={(images, index) => setViewer({ images, index })} />)}
				</div>
			))}
			{viewer && <ImageViewerQ images={viewer.images} index={viewer.index} onStep={(index) => setViewer((prev) => ({ ...prev, index }))} onClose={() => setViewer(null)} />}
		</div>
	);
}

// spec §10 → Order view, no entry in scope
function ThreadEmptyQ({ names }) {
	const { EmptyState } = window.UI;
	if (names.length === 0) return <EmptyState message="No orders yet" hint="Tick a session in the rail and write the first one below." />;
	return <EmptyState message={`No orders to ${getNameListQ(names)} yet`} hint="Write the first one below." />;
}

// opens at its end · stays there as orders are added only if it was there · an earlier page keeps the entries on screen where they are
function useThreadScrollQ(entries) {
	const ref = useRefQ(null);
	const last = useRefQ({ firstId: null, height: 0, isAtEnd: true });
	const signature = entries.map((entry) => entry.id).join(",");
	useLayoutEffectQ(() => {
		const log = ref.current;
		if (!log) return;
		const prev = last.current;
		const firstId = signature.split(",")[0];
		if (prev.isAtEnd) log.scrollTop = log.scrollHeight;
		else if (firstId !== prev.firstId) log.scrollTop += log.scrollHeight - prev.height;
		last.current = { firstId, height: log.scrollHeight, isAtEnd: prev.isAtEnd };
	}, [signature]);
	// a composer growing under a draft shrinks the thread → one at its end stays there (spec §12.2: the last bubble and what stands under it)
	useEffectQ(() => {
		const log = ref.current;
		if (!log || typeof ResizeObserver === "undefined") return undefined;
		const observer = new ResizeObserver(() => {
			if (last.current.isAtEnd) log.scrollTop = log.scrollHeight;
		});
		observer.observe(log);
		return () => observer.disconnect();
	}, []);
	const onScroll = () => {
		const log = ref.current;
		last.current.isAtEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 2;
	};
	return { ref, onScroll };
}

// an order shown from its list row or Show → its entry centred and focused once a read holds it
function useThreadAimQ(entries, aim, clearAim) {
	const signature = entries.map((entry) => entry.id).join(",");
	useLayoutEffectQ(() => {
		const id = aim === null ? null : getAimedEntryIdQ(entries, aim.id);
		if (id === null) return;
		clearAim();
		const entry = document.getElementById(`${ORDER_ID_PREFIX_Q}${id}`);
		entry?.scrollIntoView({ block: "center" });
		entry?.focus({ preventScroll: true });
	}, [signature, aim]);
}

function getAimedEntryIdQ(entries, copyId) {
	return entries.find((entry) => entry.copies.some((copy) => copy.id === copyId))?.id ?? null;
}

function getDayGroupsQ(entries, now = new Date()) {
	const groups = [];
	for (const entry of entries) {
		const day = window.UI.formatKstDate(entry.item.answeredAt);
		if (groups[groups.length - 1]?.day !== day) groups.push({ day, label: getDayLabelQ(day, now), entries: [] });
		groups[groups.length - 1].entries.push(entry);
	}
	return groups;
}

function getDayLabelQ(day, now) {
	const { formatKstDate } = window.UI;
	if (day === formatKstDate(now.toISOString())) return "Today";
	if (day === formatKstDate(new Date(now.getTime() - ORDERS_Q.DAY_MS).toISOString())) return "Yesterday";
	return day;
}

/** One order: the time line (`Re:` + the report's title for a reply), the bubble, a row per recipient with its receipt. */
function OrderEntryQ({ entry, busy, onResend, onOpenImage }) {
	const { formatKstTime } = window.UI;
	const { item, copies } = entry;
	return (
		<article id={`${ORDER_ID_PREFIX_Q}${entry.id}`} tabIndex={-1} className="queue-order">
			<p className="queue-order-time" title={getAnswerLineQ(item)?.text}>
				{item.kind === "report" && <span className="queue-order-re">{`Re: ${item.title}`}</span>}
				<time dateTime={item.answeredAt}>{formatKstTime(item.answeredAt)}</time>
			</p>
			<OrderBubbleQ text={getOrderTextQ(item)} images={item.attachments ?? []} onOpenImage={onOpenImage} />
			<RecipientsQ copies={copies} busy={busy} onResend={onResend} />
		</article>
	);
}

// more than 12 written lines → clamped under `Show all N lines`; a long line that only wraps is not counted; the images stay in view under the clamp
function OrderBubbleQ({ text, images = [], onOpenImage }) {
	const { ProseText, DisclosureChevron } = window.UI;
	const [isFull, setFull] = useStateQ(false);
	const count = text.split("\n").length;
	const isLong = count > ORDERS_Q.CLAMP_LINES;
	return (
		<>
			<div className={`queue-bubble${isLong && !isFull ? " is-clamped" : ""}`} style={{ "--queue-clamp-lines": ORDERS_Q.CLAMP_LINES }}>
				<ProseText text={text} isCompact />
				{images.length > 0 && (
					<div className="queue-bubble-images">
						{images.map((image, index) => <BubbleImageQ key={image.id} image={image} label={`Open image ${index + 1} of ${images.length}: ${image.name}`} onOpen={() => onOpenImage(images, index)} />)}
					</div>
				)}
			</div>
			{isLong && (
				<details className="queue-order-more" onToggle={(event) => setFull(event.currentTarget.open)}>
					<summary className="group disclosure fs-meta"><DisclosureChevron /><span>{`Show all ${count} lines`}</span></summary>
				</details>
			)}
		</>
	);
}

// an image that cannot be loaded → a tile with ✕ and its file name; the order and its receipts stand
function BubbleImageQ({ image, label, onOpen }) {
	const [isBroken, setBroken] = useStateQ(false);
	return (
		<button type="button" className="queue-bubble-image" aria-label={label} title={`${image.name} · ${getSizeTextQ(image.bytes)}`} onClick={onOpen}>
			{isBroken
				? <span className="queue-bubble-broken"><span aria-hidden="true" className="text-crit">✕</span><span className="queue-bubble-broken-name">{image.name}</span></span>
				: <img src={getImageUrlQ(image.id)} alt="" onError={() => setBroken(true)} />}
		</button>
	);
}

function getImageUrlQ(id) {
	return `${OWNER_API_Q}/images/${id}`;
}

/**
 * One order's images, one at a time, fitted to the window on the page ground; one foot bar: name · size · place, previous / next, Close.
 * Left / Right step, Esc or Close closes and focus goes back to the thumbnail (DetailSurface).
 */
function ImageViewerQ({ images, index, onStep, onClose }) {
	const { DetailSurface } = window.UI;
	const image = images[index];
	useEffectQ(() => {
		const onKey = (event) => {
			const next = getSteppedIndexQ(index, images.length, event.key);
			if (next === null) return;
			event.preventDefault();
			onStep(next);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [index, images.length, onStep]);
	return (
		<DetailSurface open bare variant="fullscreen" title={image.name} onClose={onClose} panelClassName="queue-viewer" bodyClassName="queue-viewer-body">
			<figure className="queue-viewer-figure">
				<img src={getImageUrlQ(image.id)} alt={image.name} width={image.width} height={image.height} />
			</figure>
			<ViewerBarQ image={image} index={index} count={images.length} onStep={onStep} onClose={onClose} />
		</DetailSurface>
	);
}

function ShowEarlierQ({ isBusy, onShow }) {
	return <BusyButtonQ className="btn ghost sm queue-earlier" label="Show earlier" busyLabel="Loading…" isBusy={isBusy} onPress={onShow} />;
}

function ViewerBarQ({ image, index, count, onStep, onClose }) {
	const { Icon } = window.UI;
	return (
		<div className="queue-viewer-bar">
			<span className="queue-viewer-name">{`${image.name} · ${getSizeTextQ(image.bytes)} · ${index + 1} of ${count}`}</span>
			<button type="button" className="btn ghost sm icon" aria-label="Previous image" title="Previous image (←)" disabled={index === 0} onClick={() => onStep(index - 1)}><Icon name="chevron-left" size={16} /></button>
			<button type="button" className="btn ghost sm icon" aria-label="Next image" title="Next image (→)" disabled={index === count - 1} onClick={() => onStep(index + 1)}><Icon name="chevron-right" size={16} /></button>
			<button type="button" className="btn ghost sm icon" aria-label="Close" title="Close (Esc)" onClick={onClose}><Icon name="x" size={16} /></button>
		</div>
	);
}

function getSteppedIndexQ(index, count, key) {
	const next = key === "ArrowRight" ? index + 1 : key === "ArrowLeft" ? index - 1 : index;
	return next === index || next < 0 || next >= count ? null : next;
}

/** A row per recipient; from five on, one roll-up line opens the received and waiting ones while the not received stay listed under it. */
function RecipientsQ({ copies, busy, onResend }) {
	const { DisclosureChevron } = window.UI;
	const resendable = copies.filter((copy) => copy.canResend).map((copy) => copy.id);
	const isRolledUp = copies.length >= ORDERS_Q.ROLL_UP_FROM;
	const isOutside = (copy) => !isRolledUp || getReceiptQ(copy) === "notReceived";
	const list = (shown) => <ul className="queue-recipients" aria-label="Recipients">{shown.map((copy) => <RecipientRowQ key={copy.id} copy={copy} busy={busy} onResend={onResend} />)}</ul>;
	const [counts, ...badges] = getRollUpFactsQ(copies);
	return (
		<>
			{isRolledUp && (
				<details className="queue-roll-up">
					<summary className="group disclosure fs-meta"><span className="queue-roll-up-counts"><DisclosureChevron /><span>{counts.text}</span></span><RowFactsQ facts={badges} /></summary>
					{list(copies.filter((copy) => !isOutside(copy)))}
				</details>
			)}
			{copies.some(isOutside) && list(copies.filter(isOutside))}
			{resendable.length >= 2 && <BusyButtonQ className="btn ghost sm" label={`Resend to ${resendable.length}`} busyLabel="Resending…" isBusy={resendable.includes(busy?.id)} onPress={() => onResend(resendable)} />}
		</>
	);
}

// `7 sessions · 5 received · 1 not yet` + the amber `1 not received`; a zero count is left out
function getRollUpFactsQ(copies) {
	const receipts = copies.map(getReceiptQ);
	const counted = (receipt) => getReceiptCountQ(receipts, receipt);
	const parts = [`${copies.length} sessions`, `${counted("received")} received`, `${counted("notYet")} not yet`].filter((part, index) => index === 0 || !part.startsWith("0 "));
	const failed = counted("notReceived");
	return [{ text: parts.join(" · ") }, ...(failed > 0 ? [getNotReceivedFactQ(failed)] : [])];
}

// an order on a report's sheet is the report's answer text; a standalone order is the message's body
function getOrderTextQ(item) {
	return item.kind === "report" ? (item.answer?.text ?? "") : item.body;
}

// the session name and its receipt, and nothing else; Resend only where the queue names it (canResend); a refused resend says why under the row
function RecipientRowQ({ copy, busy, onResend }) {
	const { formatKstTime } = window.UI;
	const receipt = getReceiptQ(copy);
	const time = receipt === "received" && copy.deliveredAt ? [{ text: formatKstTime(copy.deliveredAt) }] : [];
	const refusal = busy?.error?.id === copy.id ? busy.error.message : null;
	return (
		<>
			<li className="queue-recipient">
				<span className="queue-recipient-name" title={copy.session.name}><ItemSessionNameQ session={copy.session} /></span>
				<RowFactsQ facts={[getReceiptFactQ(receipt), ...time]} />
				{copy.canResend && <BusyButtonQ className="btn sm" label="Resend" busyLabel="Resending…" isBusy={busy?.id === copy.id} onPress={() => onResend([copy.id])} />}
			</li>
			{refusal && <li className="queue-recipient-refusal"><ToneLineQ tone="crit" role="alert" isTextToned>{refusal}</ToneLineQ></li>}
		</>
	);
}

// the composer in its order use: the label line names every receiving session; the send carries the ink once the box holds text and a session is ticked
function OrderComposerQ({ queue, targets, rows = [], box, tray, isReady = true }) {
	const { orders } = queue;
	const [changed, setChanged] = useRecipientsNoteQ(targets, box, isReady);
	const onText = (text) => { setChanged(null); box.setText(text); };
	const onSend = () => {
		const invalid = getOrderInvalidQ(targets, box.text);
		if (invalid === null) {
			setChanged(null);
			return orders.send({ sessionIds: targets.ids, text: box.text }, targets.names, box.shots);
		}
		orders.putError(invalid.message);
		const selector = invalid.focus === "box" ? `#${ORDERS_Q.BOX_ID}` : ".queue-sessions .ctl-checkbox";
		window.document?.querySelector(selector)?.focus();
	};
	return (
		<ComposerQ field={{ id: ORDERS_Q.BOX_ID, label: <OrderLabelQ rows={rows.filter((row) => targets.ids.includes(row.id))} /> }} tray={tray}
			text={box.text} onText={onText} isBusy={box.isBusy}
			buttons={[{ label: getSendLabelQ(targets), parts: getSendPartsQ(targets), isInk: box.text.trim() !== "" && targets.ids.length > 0, keyName: "send", onPress: onSend }]}
			note={<ComposerNoteQ error={box.error} info={changed} tray={tray} fieldId={ORDERS_Q.BOX_ID} rest={getOrderNoteQ(targets, isReady ? rows : null)} />} />
	);
}

/**
 * The once-said note under a draft whose recipients changed (spec §9.2); a change before the rail first loads is no change.
 * @returns [note, setNote] — the note, null when none; cleared by the caller on a keystroke or a send
 */
function useRecipientsNoteQ(targets, box, isReady) {
	const [note, setNote] = useStateQ(null);
	const key = targets.ids.join(",");
	const last = useRefQ(null);
	const hasDraft = box.text.trim() !== "" || box.shots.length > 0;
	useEffectQ(() => {
		if (!isReady) return;
		if (last.current !== null && last.current !== key && hasDraft) setNote(getRecipientsNoteQ(targets.names));
		last.current = key;
	}, [key, isReady]);
	return [note, setNote];
}

// `New order to gersona, yoaida` — every name, an ended one tagged; none → said in dim (spec §9.2 → Label line)
function OrderLabelQ({ rows }) {
	const { Badge } = window.UI;
	if (rows.length === 0) return <>New order · no session ticked</>;
	return (
		<>
			{"New order to "}
			{rows.map((row, index) => (
				<span key={row.id} className="queue-order-to">
					{`${row.name}${index < rows.length - 1 ? ", " : ""}`}
					{row.state === "exited" && <> <Badge fill="tag">Ended</Badge></>}
				</span>
			))}
		</>
	);
}

/** The order box's text, busy state, refusal and images. */
function getOrderBoxQ(queue) {
	const { orders } = queue;
	const { composer } = orders;
	return { text: composer.text, setText: orders.setText, isBusy: composer.isBusy, error: composer.error, shots: composer.images ?? [], setShots: orders.setImages, putError: orders.putError };
}

/**
 * What a composer's images do: add (button, drop, paste) with the limits, remove, try an upload again.
 * Focus: an image added → the box · removed → the next remove button, else the box.
 * @param box - `{ shots, setShots, putError }` of the draft or order box the images belong to
 */
function getTrayQ({ fieldId, box, isOver = false }) {
	const { shots, setShots, putError } = box;
	const focus = (id) => window.document?.getElementById(id)?.focus();
	return {
		shots,
		isOver,
		onFiles: (files, isPasted) => {
			focus(fieldId);
			return putFilesQ({ files, shots, setShots, putError, isPasted });
		},
		onRemove: (key) => {
			const index = shots.findIndex((shot) => shot.key === key);
			deleteShotQ(shots[index], setShots);
			focus(shots[index + 1] ? getRemoveIdQ(fieldId, shots[index + 1].key) : fieldId);
		},
		onRetry: (key) => putRetryQ(shots.find((shot) => shot.key === key), setShots),
	};
}

/** Checks the files, adds the ones that pass with one line for the rest, then uploads each as it is added. */
async function putFilesQ({ files, shots, setShots, putError, isPasted = false }) {
	const candidates = await Promise.all(files.map(getCandidateQ));
	const { added, refusal } = getAddPlanQ(shots.length, candidates);
	putError(refusal);
	const fresh = added.map((candidate, index) => getShotQ(candidate, isPasted ? getPastedNameQ(shots, index, candidate.type) : candidate.name));
	setShots((prev) => [...prev, ...fresh]);
	await Promise.all(fresh.map((shot) => putUploadQ(shot, setShots)));
}

async function getCandidateQ(file) {
	const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
	return { file, name: file.name, bytes: file.size, type: getImageTypeQ(head) };
}

// the signature only: the server reads the whole header and stays the judge → the page may refuse less, never more
function getImageTypeQ(bytes) {
	const text = (start, end) => String.fromCharCode(...bytes.slice(start, end));
	if (bytes.length >= PNG_SIGNATURE_Q.length && PNG_SIGNATURE_Q.every((byte, index) => bytes[index] === byte)) return "png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
	if (text(0, 6) === "GIF87a" || text(0, 6) === "GIF89a") return "gif";
	if (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "webp";
	return null;
}

/** The files that fit the type, the size and the count of one order `{ added }`, and the one line naming the rest (null when none). */
function getAddPlanQ(count, candidates) {
	const fitting = candidates.filter((candidate) => candidate.type !== null && candidate.bytes <= IMAGES_Q.BYTES_MAX);
	const added = fitting.slice(0, Math.max(0, IMAGES_Q.MAX - count));
	const refused = candidates.filter((candidate) => !fitting.includes(candidate));
	return { added, refusal: getRefusalLineQ(refused, fitting.length - added.length) };
}

function getRefusalLineQ(refused, overflow) {
	const megabytes = IMAGES_Q.BYTES_MAX / IMAGES_Q.MB;
	if (refused.length === 0) return overflow === 0 ? null : `Up to ${IMAGES_Q.MAX} images per order: ${overflow} ${overflow === 1 ? "was" : "were"} not added.`;
	if (refused.length === 1 && overflow === 0) {
		const [file] = refused;
		return `${file.name} was not added: ${file.type === null ? IMAGES_Q.TYPES_LINE : `over ${megabytes} MB`}.`;
	}
	const cap = overflow > 0 ? ` and ${IMAGES_Q.MAX} per order` : "";
	return `${refused.length + overflow} files were not added: ${IMAGES_Q.TYPES_LINE}, up to ${megabytes} MB each${cap}.`;
}

function getPastedNameQ(shots, index, type) {
	const pasted = shots.filter((shot) => shot.name.startsWith(`${IMAGES_Q.PASTED} `)).length;
	return `${IMAGES_Q.PASTED} ${pasted + index + 1}.${IMAGES_Q.EXTENSION[type]}`;
}

// uploading → the picture from the browser's own memory until the server holds it
// random key → a draft restored after a reload keeps its keys, so a counter that restarts would hand one out again
function getShotQ(candidate, name) {
	return { key: `shot-${crypto.randomUUID()}`, name, bytes: candidate.bytes, status: "uploading", src: URL.createObjectURL(candidate.file), file: candidate.file, id: null, cause: null };
}

function putUploadQ(shot, setShots) {
	const upload = sendImageQ(shot.file, shot.name).then((answer) => {
		const result = getUploadResultQ(answer);
		setShots((prev) => prev.map((one) => (one.key === shot.key ? { ...one, ...result } : one)));
		if (result.status === "stored") URL.revokeObjectURL(shot.src);
		return result;
	});
	UPLOADS_Q.set(shot.key, upload);
	return upload;
}

function putRetryQ(shot, setShots) {
	if (!shot) return;
	setShots((prev) => prev.map((one) => (one.key === shot.key ? { ...one, status: "uploading", cause: null } : one)));
	putUploadQ(shot, setShots);
}

function deleteShotQ(shot, setShots) {
	if (!shot) return;
	UPLOADS_Q.delete(shot.key);
	if (shot.src.startsWith("blob:")) URL.revokeObjectURL(shot.src);
	setShots((prev) => prev.filter((one) => one.key !== shot.key));
}

// one image per request as the raw body under one fixed type → the server's byte check alone decides; the name is a label only
async function sendImageQ(file, name) {
	try {
		const response = await fetch(`${OWNER_API_Q}/images?name=${encodeURIComponent(getUploadNameQ(name))}`, {
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/octet-stream" },
			body: file,
		});
		return { status: response.status, data: await response.json().catch(() => null) };
	} catch {
		return { status: 0, data: null };
	}
}

// the upload's label is one line of at most NAME_MAX characters
function getUploadNameQ(name) {
	return name.replace(/\p{Cc}/gu, " ").trim().slice(0, IMAGES_Q.NAME_MAX).trim() || "image";
}

function getUploadResultQ(answer) {
	const id = answer.data?.id;
	if (isOkAnswerQ(answer) && typeof id === "string") return { status: "stored", id, src: getImageUrlQ(id), cause: null };
	return { status: "failed", cause: getUploadCauseQ(answer) };
}

function getUploadCauseQ(answer) {
	if (answer.status === 0) return "the monitor did not answer";
	const reason = answer.data?.reason;
	return typeof reason === "string" && reason !== "" ? reason : `the monitor answered ${answer.status}`;
}

// every image already stored → sent at once; one still uploading → the send waits for it (Sending…)
function sendWithImagesQ(shots, send, setWaiting) {
	if (shots.every((shot) => shot.status === "stored")) return send(shots.map((shot) => shot.id));
	return sendAfterUploadsQ(shots, send, setWaiting);
}

async function sendAfterUploadsQ(shots, send, setWaiting) {
	setWaiting(true);
	const ids = await getStoredIdsQ(shots);
	setWaiting(false);
	return ids === null ? false : send(ids);
}

/** The ids of the images in their order once every upload settled; any image not stored → null and nothing is sent. */
async function getStoredIdsQ(shots) {
	const results = await Promise.all(shots.map((shot) => UPLOADS_Q.get(shot.key) ?? shot));
	return results.every((result) => result.status === "stored") ? results.map((result) => result.id) : null;
}

function getImageBodyQ(body, ids) {
	return ids.length > 0 ? { ...body, attachmentIds: ids } : body;
}

// stored images only: a failed or running upload is not on the order yet
function getImageCountLineQ(shots) {
	const stored = shots.filter((shot) => shot.status === "stored");
	if (stored.length === 0) return "";
	const bytes = stored.reduce((sum, shot) => sum + shot.bytes, 0);
	return `${stored.length} ${stored.length === 1 ? "image" : "images"} · ${getSizeTextQ(bytes)}`;
}

function getSizeTextQ(bytes) {
	return bytes >= IMAGES_Q.MB ? `${(bytes / IMAGES_Q.MB).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

/** What the note slot says about the images `{ tone, text, retryKey }`: a hanging file, else a failed upload, else uploads running; else null. */
function getImageNoteQ(shots, isOver) {
	if (isOver) return { tone: "info", text: "Drop to add images.", retryKey: null };
	const failed = shots.find((shot) => shot.status === "failed");
	if (failed) return { tone: "crit", text: `${failed.name} could not be uploaded: ${failed.cause}.`, retryKey: failed.key };
	const uploading = shots.filter((shot) => shot.status === "uploading").length;
	if (uploading > 0) return { tone: "info", text: `Uploading ${uploading} ${uploading === 1 ? "image" : "images"}…`, retryKey: null };
	return null;
}

// a composer's image tray and the drop zone feeding it: a file dropped on the zone joins the tray's box
function useTrayZoneQ(fieldId, box) {
	const zone = useDropZoneQ((files) => getTrayQ({ fieldId, box }).onFiles(files, false));
	return { zone, tray: getTrayQ({ fieldId, box, isOver: zone.isOver }) };
}

// a file over the zone → the box shows the drop state; leaving it for a child of the zone is no leave
function useDropZoneQ(onFiles) {
	const [isOver, setOver] = useStateQ(false);
	const hasFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
	const handlers = {
		onDragOver: (event) => {
			if (!hasFiles(event)) return;
			event.preventDefault();
			setOver(true);
		},
		onDragLeave: (event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOver(false); },
		onDrop: (event) => {
			if (!hasFiles(event)) return;
			event.preventDefault();
			setOver(false);
			onFiles(Array.from(event.dataTransfer.files));
		},
	};
	return { isOver, handlers };
}

// a file dropped outside a composer does nothing, never replacing the page with the file
function usePageDropGuardQ() {
	useEffectQ(() => {
		const stop = (event) => {
			if (event.defaultPrevented || !Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "none";
		};
		window.addEventListener("dragover", stop);
		window.addEventListener("drop", stop);
		return () => {
			window.removeEventListener("dragover", stop);
			window.removeEventListener("drop", stop);
		};
	}, []);
}

function RailFootQ({ queue }) {
	const { sessions } = queue;
	const hasMore = sessions.region.data?.hasMore === true;
	return (
		<>
			<RecentResumesQ region={queue.resumes} onRead={queue.readResumes} />
			{hasMore && <span className="fs-meta text-dim">{`Showing the ${sessions.region.data.sessions.length} most recent`}</span>}
		</>
	);
}

/**
 * Recent automatic resumes newest first, in a drawer from the rail foot → quota spent without a click stays one press away.
 * @param onRead - reads the record again: Retry, and each opening of the drawer (spec §4.4)
 */
function RecentResumesQ({ region, onRead }) {
	const { RegionUnavailable, DetailSurface, TONE_GLYPH, getRegionView } = window.UI;
	const [isOpen, setOpen] = useStateQ(false);
	const view = getRegionView(region);
	if (view === "error") return <RegionUnavailable source="recent automatic resumes" error={region.error} isBusy={region.busy} onRetry={onRead} />;
	if (view === "loading" || region.data.length === 0) return null;
	const hasFailed = region.data.some((resume) => RESUME_RESULT_LABEL_Q[resume.result] === "failed");
	return (
		<>
			<button type="button" className="btn ghost sm" onClick={() => { setOpen(true); onRead(); }}>
				{hasFailed && <span className="text-warn">{TONE_GLYPH.warn}</span>}
				{`Automatic resumes ${region.data.length}`}
			</button>
			<DetailSurface open={isOpen} onClose={() => setOpen(false)} title="Recent automatic resumes">
				<RecentResumeListQ resumes={region.data} />
			</DetailSurface>
		</>
	);
}

function RecentResumeListQ({ resumes }) {
	return (
		<ul className="fs-body">
			{resumes.map((resume) => (
				<li key={`${resume.item.id}-${resume.attempt}-${resume.sentAt}`}>
					<ResumeLineQ resume={resume} profileLabel={`${resume.session.profileLabel} · ${resume.session.cwdTail}`} />
					<span className="fs-meta text-dim">{` — ${resume.item.title}`}</span>
				</li>
			))}
		</ul>
	);
}

window.ScreenQueue = ScreenQueue;
// shell reads the nav slot
window.QueueNav = { getQueueNavBadge, getQueueTitle };
