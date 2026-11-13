// Queue screen — the desk: the Sessions pane, the list of decisions, reports and items in delivery under their bands,
// and the sheet showing the selected item as a one-page report with its composer (answer / order / Mark as read / later / Resend).
// Every server field renders as React text, never as HTML.
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
const FILTER_AXES_Q = ["profile", "session"];
const DEFAULT_FILTER_Q = Object.freeze({ profile: "", session: "" });
// every key the page keeps in its hash → one writer merges them all
const HASH_KEYS_Q = ["session", "profile", "item", "to", "view"];
const LIST_GROUPS_Q = {
	decisions: { key: "decisions", label: "Decisions" },
	reports: { key: "reports", label: "Reports" },
	inDelivery: { key: "inDelivery", label: "In delivery" },
};

// one vocabulary on every surface (spec §9.4): whether a recipient has the order, never why it waits
const RECEIPT_Q = { received: "Received", notYet: "Not yet", notReceived: "Not received" };

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
	{ keys: "Esc", does: "From the sheet back to the row; closes Orders" },
	{ keys: "1 – 9", does: "Pick the option at that position" },
	{ keys: "R", does: "The sheet's field" },
	{ keys: "E", does: "Mark as read" },
	{ keys: "L", does: "Answer later / Read later" },
	{ keys: "N", does: "New order" },
	{ keys: "O", does: "Order to the selected item's session" },
	{ keys: "Cmd / Ctrl + Enter", does: "Send from the pane in focus" },
];
// the history read's page and the pane bodies whose scroll the Orders mode keeps (a hidden box does not keep its own)
// MAX = the history read's own cap (schemas.ts → ORDER_PAGE_LIMIT)
const ORDERS_Q = { PAGE: 30, MAX: 100, CLAMP_LINES: 12, ROLL_UP_FROM: 5, DAY_MS: 24 * 60 * 60 * 1000, BOX_ID: "queue-order-text", PANE_BODIES: [".queue-list > .card-body", ".queue-sheet > .card-body"] };
const EMPTY_THREAD_Q = Object.freeze({ status: "loading", items: [], nextCursor: null, error: null });
// the sheet holds no item and the owner has not handled everything
const EMPTY_HOLD_Q = Object.freeze({ item: null, isHandled: false });
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
 * Account and session filter choices from the loaded items; "" = All.
 * A chosen value no loaded item carries (a hash link) stays an option → the trigger still names it.
 */
function getFilterOptionsQ(items, filter = DEFAULT_FILTER_Q) {
	const profiles = [...new Set(items.map((item) => item.session.profileLabel))].sort();
	const sessions = new Map(items.map((item) => [item.session.id, `${item.session.cwdTail} · ${item.session.id.slice(0, SESSION_PREFIX_LENGTH_Q)}`]));
	if (filter.profile && !profiles.includes(filter.profile)) profiles.unshift(filter.profile);
	if (filter.session && !sessions.has(filter.session)) sessions.set(filter.session, filter.session.slice(0, SESSION_PREFIX_LENGTH_Q));
	return {
		profile: [{ key: "", label: "All" }, ...profiles.map((label) => ({ key: label, label }))],
		session: [{ key: "", label: "All" }, ...[...sessions].map(([key, label]) => ({ key, label }))],
	};
}

function isFilterAppliedQ(filter) {
	return FILTER_AXES_Q.some((axis) => filter[axis] !== DEFAULT_FILTER_Q[axis]);
}

// #queue?profile=…&session=… → the filter survives a reload; an absent query → defaults
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

/** The row the sheet shows: the one holding the hash's item (a folded copy included), else the first row of the first band; none → null. */
function getSelectedIdQ(groups, hashItemId) {
	const rows = groups.flatMap((group) => group.rows);
	const named = rows.find((row) => row.copies.some((copy) => String(copy.id) === hashItemId));
	return (named ?? rows[0])?.id ?? null;
}

/**
 * What the sheet shows, `{ kind, id, item? }`: `item` the selected row's · `left` the open item it held, which the read no longer has open ·
 * `handled` once the owner's acts left nothing open · `none` with no row. No item in the hash → the held item stays selected.
 */
function getSheetStateQ(groups, hashItemId, hold) {
	if (hold.isHandled) return { kind: "handled", id: null };
	const held = hold.item;
	const named = hashItemId || (held === null ? "" : String(held.id));
	const rows = groups.flatMap((group) => group.rows);
	if (held !== null && named === String(held.id) && !rows.some((row) => row.id === held.id && row.item.status === "open")) {
		return { kind: "left", id: held.id, item: held };
	}
	const id = getSelectedIdQ(groups, named);
	return id === null ? { kind: "none", id: null } : { kind: "item", id, item: rows.find((row) => row.id === id).item };
}

function getVisibleItemsQ(items, filter) {
	return items.filter(
		(item) => (!filter.profile || item.session.profileLabel === filter.profile) && (!filter.session || item.session.id === filter.session),
	);
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

/**
 * DOM order Sessions → list → sheet; the panes are fixed-role columns that never stack.
 * The Orders mode puts the list and the sheet away, mounted and unchanged, and gives their room to the order view; Esc on the desk leaves it.
 */
function QueueDeskQ({ queue }) {
	const { orders } = queue;
	usePageDropGuardQ();
	const onKeyDown = (event) => {
		const action = getDeskKeyQ(event, { isOrdersOpen: orders.isOpen, isKeysOn: queue.keys?.isOn ?? true });
		if (action === null) return;
		event.preventDefault();
		putDeskKeyQ(action, { queue, target: event.target, root: window.document });
	};
	return (
		<div className={orders.isOpen ? "queue-desk is-orders" : "queue-desk"} onKeyDown={onKeyDown}>
			<SessionsRegionQ queue={queue} />
			<div className="queue-away" hidden={orders.isOpen || undefined}>
				<QueueListQ queue={queue} />
				<QueueSheetQ queue={queue} />
			</div>
			{orders.isOpen && <OrdersViewQ queue={queue} />}
		</div>
	);
}

/**
 * The desk's key (spec §11) as `{ name, index? }`, null when the key is not the desk's.
 * An open dialog (the key list, the viewer, the drawer) takes every key first; Enter, Esc and Cmd / Ctrl + Enter work in a field and with the switch off,
 * the single letters and digits (WCAG 2.1.4) only outside a text field and with it on.
 */
function getDeskKeyQ(event, { isOrdersOpen, isKeysOn }) {
	const { key, target } = event;
	if (event.defaultPrevented || target?.closest?.('[role="dialog"]')) return null;
	if (key === "Escape") return getEscKeyQ(target, isOrdersOpen);
	if (key === "Enter" && (event.metaKey || event.ctrlKey)) return target?.closest?.(".queue-sheet, .queue-orders") ? { name: "send" } : null;
	if (event.metaKey || event.ctrlKey || event.altKey) return null;
	if (key === "Enter") return !isOrdersOpen && target?.closest?.('[role="option"]') ? { name: "enter" } : null;
	if (!isKeysOn || isTextFieldQ(target)) return null;
	return getSingleKeyQ(key.toLowerCase(), isOrdersOpen);
}

// in the Orders mode Esc closes it from anywhere on the desk; on the desk it leaves the sheet for the selected row
function getEscKeyQ(target, isOrdersOpen) {
	if (isOrdersOpen) return { name: "close" };
	return target?.closest?.(".queue-sheet") ? { name: "back" } : null;
}

// the Orders mode hides the list and the sheet → only N of the single keys is live there
function getSingleKeyQ(letter, isOrdersOpen) {
	if (isOrdersOpen) return letter === "n" ? { name: "new" } : null;
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
	close: ({ queue }) => queue.orders.close(),
	new: ({ queue }) => queue.orders.open(),
	next: ({ queue }) => putSteppedRowQ(queue, "ArrowDown"),
	prev: ({ queue }) => putSteppedRowQ(queue, "ArrowUp"),
	back: ({ queue, root }) => root?.getElementById(`${ROW_ID_PREFIX_Q}${queue.selectedId}`)?.focus(),
	enter: putSheetEntryQ,
	pick: putPickedOptionQ,
	field: ({ root }) => root?.querySelector(".queue-sheet .queue-compose-text")?.focus(),
	read: ({ root }) => root?.querySelector('.queue-sheet [data-key="e"]')?.click(),
	later: ({ root }) => root?.querySelector('.queue-sheet [data-key="l"]')?.click(),
	send: ({ target }) => target?.closest?.(".queue-sheet, .queue-orders")?.querySelector(".queue-composer .btn.primary")?.click(),
	order: putOrderKeyQ,
};

function putSteppedRowQ(queue, key) {
	const id = getKeyedRowIdQ(queue.groups.flatMap((group) => group.rows), queue.selectedId, key);
	if (id !== null) queue.selectRow(id);
}

// a decision → its option group (the picked radio, else the first) · a report → its primary button · an order → the Orders mode at its entry
function putSheetEntryQ({ queue, root }) {
	const row = queue.groups.flatMap((group) => group.rows).find((one) => one.id === queue.selectedId);
	if (!row) return;
	if (getKindWordQ(row.item) === "Order") return queue.openOrderRow(row);
	const entry = root?.querySelector(".queue-sheet input[type=radio]:checked") ?? root?.querySelector(".queue-sheet input[type=radio]") ?? root?.querySelector(".queue-sheet .queue-composer .btn.primary");
	entry?.focus();
}

function putPickedOptionQ({ queue, index }) {
	const item = getSheetOpenItemQ(queue.sheet);
	const option = item?.kind === "decision" ? (item.options ?? [])[index] : undefined;
	if (option) queue.setDraft(item.id, { code: option.code, error: null });
}

function getSheetOpenItemQ(sheet) {
	return sheet.kind === "item" && sheet.item.status === "open" ? sheet.item : null;
}

// a rail row's own session, else the selected item's · an open report keeps its Re: line and its draft (useReplyOrderQ)
function putOrderKeyQ({ queue, target }) {
	const railId = target?.closest?.("[data-session]")?.getAttribute("data-session");
	const item = queue.sheet.kind === "item" ? queue.sheet.item : null;
	if (!railId && item?.kind === "report" && item.status === "open") return queue.openReplyOrder(item);
	const id = railId || item?.session.id;
	const isTakingOrders = (queue.sessions.region.data?.sessions ?? []).some((row) => row.id === id && row.isSelectable);
	if (isTakingOrders) queue.sessions.setSelectedIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
	queue.orders.open();
}

// Refresh is busy while any region reads; a failed resume or session read shows in its own region, not here
function QueueHeaderQ({ queue }) {
	const { PageHeader, RefreshButton, getRegionSummary } = window.UI;
	const regions = getShownRegionsQ(queue);
	const { list } = queue;
	return (
		<PageHeader
			title={QUEUE_TITLE_Q}
			freshness={<QueueFreshnessQ list={list} />}
			refresh={<RefreshButton onRefresh={queue.refresh} isBusy={getRegionSummary(regions).isBusy} hasRead={list.readAt !== null} label="Refresh queue" />}
		/>
	);
}

// the page's own cadence · a failed read with rows on screen → since when they stand (spec §4.4); nothing loaded → the list card says it
function QueueFreshnessQ({ list }) {
	const { TONE_GLYPH, formatKstTime } = window.UI;
	if (list.data === null || list.error === null) return <span className="fs-meta text-dim">{`Checks every ${POLL_Q.MS / 1000}s`}</span>;
	return (
		<span className="fs-meta">
			<span aria-hidden="true" className="text-warn">{`${TONE_GLYPH.warn} `}</span>
			{`Not updated · last read ${formatKstTime(list.readAt)}`}
		</span>
	);
}

// list read as a region summary input + the resume and session regions
function getShownRegionsQ({ list, resumes, sessions }) {
	return [{ busy: list.status === "loading", error: list.status === "error" ? list.error : null }, resumes, sessions.region];
}

/** Page state: the loaded list, its bands and selection, per-item drafts kept across re-reads, and the owner actions. */
function useQueueStateQ({ onRetryHarness, onReadQueueCount }) {
	const [list, setList] = useStateQ(EMPTY_LIST_Q);
	const [resumes, readResumes] = useRecentResumesQ();
	const [drafts, setDrafts] = useStoredStateQ(DRAFT_STORE_Q.ITEMS, {}, getKeptDraftsQ);
	const [filter, setFilter] = useFilterQ();
	const [focus, setFocus] = useStateQ(null);
	const [status, setStatus] = useStateQ("");
	const groups = getGroupsQ(getVisibleItemsQ(list.data?.items ?? [], filter));
	const { sheet, selectItem } = useSheetQ(groups);
	const sessions = useSessionsStateQ(filter.profile);
	const keys = useKeysSwitchQ();
	const readList = useListReadQ(list, setList);
	// sessions.read changes with the Account filter → a filter change re-reads the page; an owner act's read runs after any read in flight
	const reload = useCallbackQ(() => {
		readList({ isMarked: true, isFresh: true });
		readResumes();
		sessions.read();
		onReadQueueCount?.();
	}, [readList, readResumes, sessions.read, onReadQueueCount]);
	const loadMore = useCallbackQ(() => getMoreQ({ list, setList }), [list]);
	useEffectQ(() => { reload(); }, [reload]);
	useFocusRowQ(focus);
	const actions = useQueueActionsQ({ list, filter, setList, setDrafts, setFocus, setStatus, selectItem, reload, onRetryHarness });
	const orders = useOrdersQ({ selectedIds: sessions.selectedIds, selectedId: sheet.id, sendAction: actions.send, setStatus, reload });
	const ticks = usePageTickQ({ setList, readList, readResumes, sessions, orders, setStatus, onReadQueueCount });
	const setDraft = useCallbackQ((id, patch) => setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } })), []);
	const setImages = useCallbackQ((id, update) => setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], images: update(prev[id]?.images ?? []) } })), []);
	// selecting a row is the owner seeing it → its New mark goes
	const selectRow = useCallbackQ((id) => {
		selectItem(id);
		setFocus({ id });
		setList((prev) => ({ ...prev, newIds: prev.newIds.filter((other) => other !== id) }));
	}, [selectItem]);
	const openOrderRow = useOrderRowQ({ list, selectItem, sessions, orders });
	const openReplyOrder = useReplyOrderQ({ sessions, orders });
	return {
		list, resumes, readResumes, sessions, orders, drafts, setDraft, setImages, filter, setFilter, reload, loadMore,
		groups, sheet, selectedId: sheet.id, selectRow, openOrderRow, openReplyOrder, status, keys, ...actions, ...ticks,
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
	return useCallbackQ(({ isMarked, isFresh = false }) => {
		const start = () => getListQ({ setList, getList: () => latestList.current, isMarked });
		return getJoinedReadQ(flight, start, isFresh);
	}, [setList]);
}

/**
 * The page's own tick (spec §4.4): the items, the sessions, the nav count and, with the Orders mode open, its thread.
 * An arrival is said on the list's status line and, while the mode hides the list, in the order view's head.
 * Refresh clears every New mark and joins the read in flight.
 */
function usePageTickQ({ setList, readList, readResumes, sessions, orders, setStatus, onReadQueueCount }) {
	const [arrival, setArrival] = useStateQ([]);
	useEffectQ(() => { setArrival([]); }, [orders.isOpen]);
	const tick = useCallbackQ(async () => {
		const [read] = await Promise.all([readList({ isMarked: true }), sessions.read(), onReadQueueCount?.(), orders.isOpen && orders.reread()]);
		if (read.arrived.length > 0) setArrival(read.arrived);
		setReadStatusQ(read, setStatus);
		return read.isGood;
	}, [readList, sessions.read, onReadQueueCount, orders.isOpen, orders.reread, setStatus]);
	useAutoReadQ(tick);
	// ponytail: a turn first seen by an owner act's read is not said (its row still shows it) → the act's own line keeps the status line
	const refresh = useCallbackQ(() => {
		setList((prev) => ({ ...prev, newIds: [] }));
		readResumes();
		const list = readList({ isMarked: false }).then((read) => setReadStatusQ(read, setStatus));
		return Promise.all([list, sessions.read(), onReadQueueCount?.(), orders.isOpen && orders.reread()]);
	}, [setList, readList, readResumes, sessions.read, onReadQueueCount, orders.isOpen, orders.reread, setStatus]);
	return { refresh, arrival };
}

// a turn to Not received outranks an arrival: it asks for an act, and an arrival keeps its New mark on its row
function setReadStatusQ(read, setStatus) {
	if (read.turned.length > 0) setStatus({ text: getNotReceivedNoteQ(read.turned), orderId: read.turned[0].id });
	else if (read.arrived.length > 0) setStatus(getArrivalNoteQ(read.arrived));
}

// `⚠ yoaida has not received an order` · several sessions named together
function getNotReceivedNoteQ(turned) {
	const names = [...new Set(turned.map((item) => getSessionNameQ(item.session)))];
	const what = getKindWordQ(turned[0]) === "Answer" ? "an answer" : "an order";
	return `${window.UI.TONE_GLYPH.warn} ${getNameListQ(names)} ${names.length === 1 ? "has" : "have"} not received ${what}`;
}

/**
 * Re-runs `tick` on the page's cadence while the page is mounted; a hidden tab keeps its timer at the browser's own throttle,
 * and a tab shown again ticks at once when its last read is older than the step.
 * @param tick - resolves true when the list read landed
 */
function useAutoReadQ(tick) {
	const latestTick = useRefQ(tick);
	latestTick.current = tick;
	useEffectQ(() => {
		const clock = createReadClockQ(() => latestTick.current());
		const onShow = () => { if (document.visibilityState === "visible") clock.runIfStale(); };
		document.addEventListener("visibilitychange", onShow);
		return () => {
			clock.stop();
			document.removeEventListener("visibilitychange", onShow);
		};
	}, []);
}

// a timer chain → each tick schedules the next once it settles, and never two run at once
function createReadClockQ(tick) {
	const clock = { timer: null, settledAt: Date.now(), fails: 0, isBusy: false, isLive: true };
	const run = async () => {
		if (clock.isBusy) return;
		clearTimeout(clock.timer);
		clock.isBusy = true;
		const isGood = await tick();
		Object.assign(clock, { isBusy: false, settledAt: Date.now(), fails: isGood ? 0 : clock.fails + 1 });
		if (clock.isLive) clock.timer = setTimeout(run, getPollDelayQ(clock.fails));
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
	return `New ${item.kind} from ${getSessionNameQ(item.session)}: ${item.title}`;
}

// an order's row → the row selected for the return, its recipients ticked, the mode open at its entry
function useOrderRowQ({ list, selectItem, sessions, orders }) {
	const { setSelectedIds } = sessions;
	const { openAt } = orders;
	return useCallbackQ((row) => {
		selectItem(row.id);
		setSelectedIds(getOrderRecipientIdsQ(list.data?.items ?? [], row.id));
		openAt(row.id);
	}, [list, selectItem, setSelectedIds, openAt]);
}

// `O` on a report → its session the one tick, its draft in the box under the Re: line
function useReplyOrderQ({ sessions, orders }) {
	const { setSelectedIds } = sessions;
	const { linkReply, open } = orders;
	return useCallbackQ((item) => {
		setSelectedIds([item.session.id]);
		linkReply(item);
		open();
	}, [setSelectedIds, linkReply, open]);
}

// every session the send went to, from the whole loaded list → a scope that shows one copy still ticks them all
function getOrderRecipientIdsQ(items, id) {
	const row = getFoldedRowsQ(items).find((one) => one.copies.some((copy) => copy.id === id));
	return [...new Set((row?.copies ?? []).map((copy) => copy.session.id))];
}

/**
 * The sheet's selection and the open item it holds while that item is on it.
 * selectItem(null) → all handled; any other selection → the owner moved on, so the held item goes.
 */
function useSheetQ(groups) {
	const [hashItemId, setHashItemId] = useStateQ(() => getHashStateQ().item);
	const [hold, setHold] = useStateQ(EMPTY_HOLD_Q);
	const sheet = getSheetStateQ(groups, hashItemId, hold);
	const shown = getSheetOpenItemQ(sheet);
	useEffectQ(() => {
		if (shown !== null) setHold((prev) => (prev.item === shown ? prev : { item: shown, isHandled: false }));
	}, [shown]);
	const selectItem = useCallbackQ((id) => {
		const value = id === null ? "" : String(id);
		setHashItemId(value);
		setHashStateQ({ item: value });
		setHold({ item: null, isHandled: id === null });
	}, []);
	return { sheet, selectItem };
}

/** Session list region, the ticked rows and Show ended; the list follows the Account filter. */
function useSessionsStateQ(profile) {
	const [region, setRegion] = useStateQ(window.UI.INITIAL_REGION_STATE);
	const [selectedIds, setSelectedIds] = useStateQ(getTicksFromHashQ);
	useEffectQ(() => { setHashStateQ({ to: selectedIds.join(",") }); }, [selectedIds]);
	const [isEndedShown, setEndedShown] = useStateQ(false);
	const read = useCallbackQ(() => getSessionsQ({ profile, setRegion, setSelectedIds }), [profile]);
	const toggle = useCallbackQ((id) => setSelectedIds((ids) => putToggledIdQ(ids, id)), []);
	const clear = useCallbackQ(() => setSelectedIds([]), []);
	return { region, read, selectedIds, setSelectedIds, toggle, clear, isEndedShown, setEndedShown };
}

// #queue?to=<ids> → the recipients survive a reload; a read then drops the ones no longer taking a message (getKeptSelectionQ)
function getTicksFromHashQ() {
	return getHashStateQ().to.split(",").filter(Boolean);
}

// a read drops the ticks on rows it no longer lists or that turned unselectable
async function getSessionsQ({ profile, setRegion, setSelectedIds }) {
	const { putRegionRequest, putRegionData, putRegionFailure } = window.UI;
	const request = {};
	setRegion((state) => putRegionRequest(state, profile, request));
	const query = profile ? `?${new URLSearchParams({ profile })}` : "";
	const answer = await sendOwnerRequestQ(`/sessions${query}`);
	if (answer.status >= 200 && answer.status < 300 && Array.isArray(answer.data?.sessions)) {
		setSelectedIds((ids) => getKeptSelectionQ(ids, answer.data.sessions));
		return setRegion((state) => putRegionData(state, request, answer.data));
	}
	setRegion((state) => putRegionFailure(state, request, answer.status === 0 ? answer.error : new Error(getAnswerDetailQ(answer))));
}

function getKeptSelectionQ(ids, sessions) {
	const selectable = new Set(sessions.filter((row) => row.isSelectable).map((row) => row.id));
	return ids.filter((id) => selectable.has(id));
}

function putToggledIdQ(ids, id) {
	return ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id];
}

function getShownSessionsQ(sessions, isEndedShown) {
	return isEndedShown ? sessions : sessions.filter((row) => row.state !== "exited");
}

/** Send targets `{ ids, names, endedCount }`: ticked rows on show that take a message → a hidden ended row or a replaced row is never sent to. */
function getSendTargetsQ(shownRows, selectedIds) {
	const rows = shownRows.filter((row) => row.isSelectable && selectedIds.includes(row.id));
	return { ids: rows.map((row) => row.id), names: rows.map((row) => row.name), endedCount: rows.filter((row) => row.state === "exited").length };
}

// one target by name, several by count · an ended target is resumed to take the order → the label says how many before the owner sends
function getSendLabelQ({ ids, names, endedCount }) {
	if (ids.length === 0) return "Send order";
	const label = ids.length === 1 ? `Send to ${names[0]}` : `Send to ${ids.length} sessions`;
	return endedCount > 0 ? `${label} · resumes ${endedCount} ended` : label;
}

/** What a send press lacks `{ message, focus }` — `focus` names the control that fixes it (`rail` / `box`); nothing missing → null. */
function getOrderInvalidQ(targets, text) {
	const count = targets.ids.length;
	if (count === 0) return { message: COMPOSER_ERROR_Q.noTick, focus: "rail" };
	if (!text.trim()) return { message: COMPOSER_ERROR_Q.noOrder, focus: "box" };
	if (count > MESSAGE_Q.MAX_TARGETS) return { message: `Up to ${MESSAGE_Q.MAX_TARGETS} sessions per order: untick ${count - MESSAGE_Q.MAX_TARGETS}.`, focus: "rail" };
	return null;
}

function getOrderNoteQ({ ids, names }) {
	if (ids.length === 0) return "Tick sessions in the rail.";
	return ids.length === 1 ? `Goes to ${names[0]}.` : "Each ticked session gets its own copy.";
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
 * @returns true once the server took the send
 */
async function sendMessageQ({ body, names, shots = [], setComposer, setStatus, onSent }) {
	setComposer((prev) => ({ ...prev, isBusy: true, error: null }));
	const ids = await getStoredIdsQ(shots);
	if (ids === null) {
		setComposer((prev) => ({ ...prev, isBusy: false }));
		return false;
	}
	const answer = await sendOwnerRequestQ("/messages/send", getImageBodyQ(body, ids));
	if (answer.status >= 200 && answer.status < 300) {
		setComposer(() => EMPTY_COMPOSER_Q);
		setStatus({ text: getOrderSentStatusQ(names), orderId: answer.data?.items?.[0]?.id ?? null });
		window.document?.getElementById(ORDERS_Q.BOX_ID)?.focus();
		onSent();
		return true;
	}
	setComposer((prev) => ({ ...prev, isBusy: false, error: getSendErrorQ(answer) }));
	return false;
}

function getSendErrorQ(answer) {
	return getOutageStepQ(answer) ?? getRefusalReasonQ(answer) ?? "The monitor refused this order. Refresh the session list and try again.";
}

/**
 * The Orders mode (spec §9.2): open state (`view=orders` in the hash), the thread of the ticked sessions' orders, and the order composer.
 * Entering stores the list's and the sheet's scroll and the opener; leaving sets them again (useOrdersFocusQ).
 */
function useOrdersQ({ selectedIds, selectedId, sendAction, setStatus, reload }) {
	const { isOpen, open, openAt, aim, close } = useOrdersOpenQ(selectedId);
	const replyLink = useReplyLinkQ(isOpen);
	const [composer, setComposer] = useStoredStateQ(DRAFT_STORE_Q.ORDER, EMPTY_COMPOSER_Q, getKeptDraftQ);
	const { thread, read, showEarlier, reread } = useThreadQ(isOpen, selectedIds);
	const setText = useCallbackQ((text) => setComposer((prev) => ({ ...prev, text, error: null })), []);
	const putError = useCallbackQ((error) => setComposer((prev) => ({ ...prev, error })), []);
	const setImages = useCallbackQ((update) => setComposer((prev) => ({ ...prev, images: update(prev.images ?? []) })), []);
	const onSent = useCallbackQ(() => { reload(); read(); }, [reload, read]);
	const send = useCallbackQ((body, names, shots) => sendMessageQ({ body, names, shots, setComposer, setStatus, onSent }), [setStatus, onSent]);
	const resend = useCallbackQ((ids) => putResendsQ(ids, sendAction, read), [sendAction, read]);
	return { isOpen, open, openAt, aim, close, thread, read, reread, showEarlier, composer, setText, putError, setImages, send, resend, ...replyLink };
}

// `openAt(id)` aims the thread at the order holding that copy (useThreadAimQ); the aim goes with the mode
function useOrdersOpenQ(selectedId) {
	const [isOpen, setOpen] = useStateQ(() => getHashStateQ().view === "orders");
	const away = useRefQ(null);
	const aim = useRefQ(null);
	useEffectQ(() => { setHashStateQ({ view: isOpen ? "orders" : "" }); }, [isOpen]);
	useOrdersFocusQ(isOpen, away, selectedId);
	const open = useCallbackQ(() => {
		if (isOpen) return document.getElementById(ORDERS_Q.BOX_ID)?.focus();
		const opener = document.activeElement;
		away.current = { scrolls: getPaneScrollsQ(document), opener, openerSession: opener?.closest?.(".queue-rail-row")?.getAttribute("data-session") ?? null };
		setOpen(true);
	}, [isOpen]);
	const openAt = useCallbackQ((id) => { aim.current = id; open(); }, [open]);
	const close = useCallbackQ(() => { aim.current = null; setOpen(false); }, []);
	return { isOpen, open, openAt, aim, close };
}

/** The report an order from the mode answers (`O` on a report): `{ item, isDropped }`, dropped by the ✕, gone when the mode closes. */
function useReplyLinkQ(isOpen) {
	const [reply, setReply] = useStateQ(null);
	useEffectQ(() => { if (!isOpen) setReply(null); }, [isOpen]);
	const linkReply = useCallbackQ((item) => setReply(item ? { item, isDropped: false } : null), []);
	const dropReply = useCallbackQ(() => setReply((prev) => prev && { ...prev, isDropped: true }), []);
	return { reply, linkReply, dropReply };
}

// one after another → one busy state and one refusal line at a time; the thread re-reads once
async function putResendsQ(ids, sendAction, read) {
	let isAnyTaken = false;
	for (const id of ids) isAnyTaken = (await sendAction(id, "resend")) || isAnyTaken;
	if (isAnyTaken) read();
}

// entering → the caret in the box · leaving → both scrolls set again, focus back to the opener, else the selected row
function useOrdersFocusQ(isOpen, away, selectedId) {
	const selected = useRefQ(selectedId);
	selected.current = selectedId;
	useLayoutEffectQ(() => {
		if (isOpen) return void document.getElementById(ORDERS_Q.BOX_ID)?.focus();
		const stored = away.current;
		if (stored === null) return;
		away.current = null;
		setPaneScrollsQ(document, stored.scrolls);
		getReturnFocusQ(stored, document, selected.current)?.focus();
	}, [isOpen, away]);
}

// the opener itself · a rail row the mode re-rendered → that row's button again · else the selected row
function getReturnFocusQ(stored, root, selectedId) {
	if (stored.opener?.isConnected) return stored.opener;
	const row = stored.openerSession ? [...root.querySelectorAll(".queue-rail-row")].find((one) => one.getAttribute("data-session") === stored.openerSession) : null;
	return row?.querySelector(".queue-rail-main") ?? root.getElementById(`${ROW_ID_PREFIX_Q}${selectedId}`);
}

function getPaneScrollsQ(root) {
	return ORDERS_Q.PANE_BODIES.map((selector) => root.querySelector(selector)?.scrollTop ?? 0);
}

function setPaneScrollsQ(root, scrolls) {
	ORDERS_Q.PANE_BODIES.forEach((selector, index) => {
		const body = root.querySelector(selector);
		if (body) body.scrollTop = scrolls[index];
	});
}

// first page on opening and on every tick change; a read for ticks since changed is dropped
// ponytail: a send, a resend or a tick change reads the first page again → loaded earlier pages go; the page's tick (reread) keeps them
function useThreadQ(isOpen, selectedIds) {
	const [thread, setThread] = useStateQ(EMPTY_THREAD_Q);
	const key = selectedIds.join(",");
	const latest = useRefQ(key);
	latest.current = key;
	const latestThread = useRefQ(thread);
	latestThread.current = thread;
	const ids = key ? key.split(",") : [];
	const isCurrent = () => latest.current === key;
	const read = useCallbackQ(() => getThreadQ({ ids, before: null, setThread, isCurrent }), [key]);
	useEffectQ(() => { if (isOpen) read(); }, [isOpen, read]);
	const showEarlier = useCallbackQ(() => getThreadQ({ ids, before: thread.nextCursor, setThread, isCurrent }), [key, thread.nextCursor]);
	const reread = useCallbackQ(() => getThreadQ({ ids, before: null, setThread, isCurrent, limit: getThreadLimitQ(latestThread.current.items), isQuiet: true }), [key]);
	return { thread, read, showEarlier, reread };
}

/**
 * One page of the history read: a first page replaces the thread, an earlier one joins it with a copy on both kept once.
 * @param isQuiet - the page's own re-read: no loading state, and a failure keeps the thread as it stands
 */
async function getThreadQ({ ids, before, setThread, isCurrent = () => true, limit = ORDERS_Q.PAGE, isQuiet = false }) {
	if (!isQuiet) setThread((prev) => ({ ...prev, status: "loading" }));
	const answer = await sendOwnerRequestQ(`/orders?${getOrdersQueryQ(ids, before, limit)}`);
	if (!isCurrent()) return;
	if (answer.status >= 200 && answer.status < 300 && Array.isArray(answer.data?.items)) {
		const { items, nextCursor } = answer.data;
		return setThread((prev) => ({ status: "ready", items: before === null ? items : putEarlierPageQ(prev.items, items), nextCursor: nextCursor ?? null, error: null }));
	}
	if (!isQuiet) setThread((prev) => ({ ...prev, status: "error", error: getReadFailureQ(answer) }));
}

// every loaded order, so a thread extended by Show earlier is not cut back, up to the read's cap
function getThreadLimitQ(items) {
	return Math.min(Math.max(ORDERS_Q.PAGE, getFoldedRowsQ(items).length), ORDERS_Q.MAX);
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
	if (answer.status >= 200 && answer.status < 300 && Array.isArray(answer.data?.resumes)) {
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
 * @param isMarked - an arrival takes the New mark (every read but Refresh)
 * @returns `{ isGood, arrived, turned }` — `arrived` the items this read marked New, in server order; `turned` as getMergedDataQ
 */
async function getListQ({ setList, getList = () => EMPTY_LIST_Q, isMarked = false }) {
	if (getList().data === null) setList((prev) => ({ ...prev, status: "loading" }));
	const answer = await sendOwnerRequestQ(`/items?limit=${getListLimitQ(getList().data?.items.length ?? 0)}`);
	const prev = getList();
	if (answer.status >= 200 && answer.status < 300 && Array.isArray(answer.data?.items)) {
		const { data, arrived, turned } = getMergedDataQ(prev.data, answer.data);
		const marked = isMarked ? arrived : [];
		const kept = (prev.newIds ?? []).filter((id) => data.items.some((item) => item.id === id));
		setList({ status: "ready", data, error: null, readAt: new Date().toISOString(), newIds: [...kept, ...marked.map((item) => item.id)] });
		return { isGood: true, arrived: marked, turned };
	}
	const error = getReadFailureQ(answer);
	setList(prev.data === null ? { ...prev, status: "error", error } : { ...prev, status: "ready", error });
	return { isGood: false, arrived: [], turned: [] };
}

// every loaded row, so a list extended by Show more is not cut back, up to the read's cap
function getListLimitQ(loaded) {
	return Math.min(Math.max(LIST_Q.LIMIT, loaded), LIST_Q.MAX);
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
	const read = new Set(answer.items.map((item) => item.id));
	const beyond = answer.nextCursor === null ? [] : prev.items.filter((item) => !read.has(item.id) && item.queuePosition > answer.nextCursor);
	const arrived = answer.items.filter((item) => !receipts.has(item.id) && item.status === "open" && (item.kind === "decision" || item.kind === "report"));
	const turned = answer.items.filter((item) => receipts.has(item.id) && receipts.get(item.id) !== "notReceived" && getReceiptQ(item) === "notReceived");
	const nextCursor = beyond.length > 0 ? prev.nextCursor : answer.nextCursor;
	return { data: { ...answer, items: [...answer.items, ...beyond], nextCursor }, arrived, turned };
}

// Show more → the next page after the cursor joins the loaded list; a refused read → the page failure card with Retry
// ponytail: a re-read covers the loaded rows up to the read's cap (getListLimitQ), rows past it keep their last state until reached; upgrade = server-side filters
async function getMoreQ({ list, setList }) {
	const cursor = list.data?.nextCursor;
	if (cursor === null || cursor === undefined) return;
	setList((prev) => ({ ...prev, status: "loading" }));
	const answer = await sendOwnerRequestQ(`/items?limit=${LIST_Q.LIMIT}&after=${cursor}`);
	if (answer.status >= 200 && answer.status < 300 && Array.isArray(answer.data?.items)) {
		const append = (prev) => ({ ...prev.data, items: [...prev.data.items, ...answer.data.items], nextCursor: answer.data.nextCursor });
		return setList((prev) => ({ ...prev, status: "ready", data: append(prev), error: null, readAt: new Date().toISOString() }));
	}
	setList((prev) => ({ ...prev, status: "error", error: getReadFailureQ(answer) }));
}

// focus request `{ id }` → a fresh object per request, so asking for the same row again still moves the focus
function useFocusRowQ(focus) {
	useEffectQ(() => {
		if (focus === null) return;
		document.getElementById(`${ROW_ID_PREFIX_Q}${focus.id}`)?.focus();
	}, [focus]);
}

/** Owner acts on the sheet: a taken act selects the next open item in list order, focuses its row and says what happened on the list's status line. */
function useQueueActionsQ({ list, filter, setList, setDrafts, setFocus, setStatus, selectItem, reload, onRetryHarness }) {
	const { busy, send } = useSendQ({ setDrafts, reload, onRetryHarness });
	// next item from the filtered list → the focus never lands on a row the filter hides
	const items = getVisibleItemsQ(list.data?.items ?? [], filter);
	const settle = useCallbackQ(async (id, action, body) => {
		const nextId = getNextAwaitingIdQ(items, id);
		if (!(await send(id, action, body))) return false;
		setStatus(getActionStatusQ(items.find((item) => item.id === id), action));
		// a later item is still open → it stays on the sheet; any other act with nothing open left → all handled
		if (nextId !== null) {
			selectItem(nextId);
			setFocus({ id: nextId });
		} else if (action !== "later") selectItem(null);
		return true;
	}, [send, items, setFocus, setStatus, selectItem]);
	const later = useCallbackQ((id) => {
		setList((prev) => (prev.data ? { ...prev, data: { ...prev.data, items: putLaterQ(prev.data.items, id) } } : prev));
		return settle(id, "later");
	}, [settle, setList]);
	const answerItem = useCallbackQ((id, body) => settle(id, "answer", body), [settle]);
	return { busy, send, settle, later, answerItem };
}

// the list's status line after a taken act; an unknown item (gone from the list) → the act alone · a reply's order is the report itself → its id backs Show
function getActionStatusQ(item, action) {
	const name = item ? getSessionNameQ(item.session) : "the session";
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
 * One owner action: a refusal shows on the card and keeps its draft.
 * @returns true once the server took the action
 */
async function sendActionQ({ id, action, body, setBusy, setDrafts, reload, onRetryHarness }) {
	setBusy({ id, error: null });
	const answer = await sendOwnerRequestQ(`/items/${id}/${action}`, body ?? {});
	const isDone = answer.status >= 200 && answer.status < 300;
	setBusy({ id: null, error: isDone ? null : { id, message: getActionErrorQ(answer) } });
	if (!isDone) return false;
	setDrafts((prev) => ({ ...prev, [id]: undefined }));
	reload();
	onRetryHarness?.();
	return true;
}

// the server's refusal body is `{ error, reason }`: `reason` is its worded cause, `error` a machine code never shown
function getActionErrorQ(answer) {
	const outage = getOutageStepQ(answer);
	if (outage !== null) return outage;
	if (answer.status === 409) return "Refused: the item changed state. Refresh to see where it is now.";
	return getRefusalReasonQ(answer) ?? "The monitor refused this action. Refresh and try again.";
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
	const visible = getVisibleItemsQ(items, queue.filter);
	const offView = useOffViewNewQ(queue.list.newIds, queue.orders.isOpen);
	return (
		<Card className="queue-pane queue-list" title={getScopeTitleQ(items, queue.filter)} sub={queue.list.data === null ? null : `${visible.filter((item) => item.status === "open").length} waiting`}
			info={<DeskKeysQ keys={queue.keys} />} infoLabel="Keyboard shortcuts"
			bar={isListBarShownQ(items, queue.filter) ? <QueueFilterBarQ items={items} filter={queue.filter} onFilter={queue.setFilter} /> : null}
			foot={<ListFootQ queue={queue} offView={offView} onShowNew={putNewRowInViewQ} />} isFlush>
			<ListBodyQ queue={queue} items={items} visible={visible} />
		</Card>
	);
}

/**
 * The New rows outside the list body's visible part (spec §4.4), measured when the marks change, on scroll and when the list returns from the Orders mode.
 * @returns `{ count, direction, id }` as getOffViewQ, null while every New row shows
 */
function useOffViewNewQ(newIds, isHidden) {
	const [offView, setOffView] = useStateQ(null);
	useEffectQ(() => {
		const body = document.querySelector(ORDERS_Q.PANE_BODIES[0]);
		if (!body || isHidden || newIds.length === 0) return void setOffView(null);
		const measure = () => {
			const next = getOffViewQ(body.getBoundingClientRect(), getRowBoxesQ(newIds));
			setOffView((prev) => (prev?.count === next?.count && prev?.direction === next?.direction && prev?.id === next?.id ? prev : next));
		};
		measure();
		body.addEventListener("scroll", measure, { passive: true });
		return () => body.removeEventListener("scroll", measure);
	}, [newIds, isHidden]);
	return offView;
}

function getRowBoxesQ(ids) {
	return ids.flatMap((id) => {
		const box = document.getElementById(`${ROW_ID_PREFIX_Q}${id}`)?.getBoundingClientRect();
		return box ? [{ id, top: box.top, bottom: box.bottom }] : [];
	});
}

/**
 * A row cut by an edge still shows; only one wholly past an edge is off view. Both sides → the side below, where arrivals land.
 * @param view - the list body's box; zero high while the Orders mode puts the list away
 * @returns `{ count, direction, id }` — `id` the off-view New row nearest the visible part · null when none
 */
function getOffViewQ(view, rows) {
	if (view.bottom <= view.top) return null;
	const below = rows.filter((row) => row.top >= view.bottom).sort((a, b) => a.top - b.top);
	const above = rows.filter((row) => row.bottom <= view.top).sort((a, b) => b.bottom - a.bottom);
	const [side, direction] = below.length > 0 ? [below, "below"] : [above, "above"];
	return side.length === 0 ? null : { count: side.length, direction, id: side[0].id };
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

function getScopeTitleQ(items, filter) {
	if (!filter.session) return "All sessions";
	const session = items.find((item) => item.session.id === filter.session)?.session;
	return session ? getSessionNameQ(session) : filter.session.slice(0, SESSION_PREFIX_LENGTH_Q);
}

// the rail is the Session filter → the bar holds the Account axis, shown while it tells items apart
function isListBarShownQ(items, filter) {
	return Boolean(filter.profile) || new Set(items.map((item) => item.session.profileLabel)).size > 1;
}

function ListBodyQ({ queue, items, visible }) {
	const { EmptyState, LoadingPlaceholder } = window.UI;
	if (queue.list.status === "error") return <QueueFailureQ failure={queue.list.error} onRetry={queue.reload} />;
	if (queue.list.data === null) return <div className="queue-loading"><LoadingPlaceholder label="the queue" /></div>;
	if (items.length === 0) return <EmptyState message="Nothing is waiting for you" hint="Sessions post reports and decisions here. The page checks every 15 seconds." />;
	if (visible.length === 0) return <EmptyState kind="no-results" message="No items match these filters." onReset={() => queue.setFilter(DEFAULT_FILTER_Q)} />;
	return <QueueListboxQ queue={queue} items={items} />;
}

// one tab stop: the selected row holds tabindex 0, else the first row; Up / Down / Home / End move and select
function QueueListboxQ({ queue, items }) {
	const rows = queue.groups.flatMap((group) => group.rows);
	const tabStopId = rows.some((row) => row.id === queue.selectedId) ? queue.selectedId : rows[0]?.id;
	const view = { isNameShown: !queue.filter.session, isAccountShown: new Set(items.map((item) => item.session.profileLabel)).size > 1, tabStopId };
	const onKeyDown = (event) => {
		const nextId = getKeyedRowIdQ(rows, queue.selectedId, event.key);
		if (nextId === null) return;
		event.preventDefault();
		queue.selectRow(nextId);
	};
	return (
		<div role="listbox" aria-label="Queue items" className="queue-listbox" onKeyDown={onKeyDown}>
			{queue.groups.map((group) => <QueueGroupQ key={group.key} group={group} queue={queue} view={view} />)}
		</div>
	);
}

/** The row a list key moves to: Up / Down step (held at the ends), Home / End jump; any other key → null. */
function getKeyedRowIdQ(rows, selectedId, key) {
	const index = rows.findIndex((row) => row.id === selectedId);
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
				<QueueRowQ key={row.id} row={row} isSelected={row.id === queue.selectedId} isNew={queue.list.newIds.includes(row.id)} view={view} onSelect={queue.selectRow} onOrder={queue.openOrderRow} />
			))}
		</div>
	);
}

// an order's row opens the Orders mode at it (spec §9.2); every other row opens on the sheet
// an arrival not yet selected leads its meta line and its name with New (spec §4.4)
function QueueRowQ({ row, isSelected, isNew = false, view, onSelect, onOrder }) {
	const { Icon, Badge, formatRelativeTime, formatKstDateTime } = window.UI;
	const { item } = row;
	const facts = getRowFactsQ(row, view.isAccountShown);
	return (
		<div id={`${ROW_ID_PREFIX_Q}${row.id}`} role="option" aria-selected={isSelected} tabIndex={row.id === view.tabStopId ? 0 : -1}
			aria-label={`${isNew ? "New, " : ""}${getRowLabelQ(row, facts, view.isNameShown)}`} className="queue-row"
			onClick={() => (getKindWordQ(item) === "Order" ? onOrder(row) : onSelect(row.id))}>
			<span className="queue-row-title" title={item.title}>{item.title}</span>
			<span className="queue-row-meta">
				<span className="queue-row-who">
					{isNew && <Badge fill="solid">New</Badge>}
					{isNew && view.isNameShown && " "}
					{view.isNameShown && <RowWhoQ row={row} />}
				</span>
				<span className="queue-row-facts">
					{view.isNameShown && facts.length > 0 && <span aria-hidden="true" className="queue-row-sep">·</span>}
					<RowFactsQ facts={facts} />
				</span>
				<span className="queue-row-age" title={formatKstDateTime(item.askedAt)}>{formatRelativeTime(item.askedAt)}</span>
			</span>
			<Icon name="chevR" size={16} className="queue-row-chevron" />
		</div>
	);
}

function RowWhoQ({ row }) {
	if (row.copies.length > 1) return `${row.copies.length} sessions`;
	return <ItemSessionNameQ session={row.item.session} />;
}

// no registered name → the start-directory name, marked so it never reads as one the session chose
function ItemSessionNameQ({ session }) {
	return (
		<>
			{getSessionNameQ(session)}
			{session.isNameRegistered === false && <span className="font-normal text-dim">{" start directory"}</span>}
		</>
	);
}

// the item view's session name; an item from before the name existed → its start directory
function getSessionNameQ(session) {
	return session.name ?? session.cwdTail;
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
				{fact.dot && <span aria-hidden="true" className={`text-${fact.dot}`}>{"● "}</span>}
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
	const received = receipts.filter((receipt) => receipt === "received").length;
	const failed = receipts.filter((receipt) => receipt === "notReceived").length;
	const count = { text: received === 0 && failed === 0 ? RECEIPT_Q.notYet : `${received} of ${receipts.length} received` };
	return [count, ...(failed > 0 ? [{ text: `${failed} not received`, badge: "warn" }] : [])];
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
	const from = isNameShown ? ` from ${row.copies.length > 1 ? `${row.copies.length} sessions` : getSessionNameQ(item.session)}` : "";
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
	const { text, orderId = null } = typeof queue.status === "string" ? { text: queue.status } : queue.status;
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

function ShowMoreQ({ count, isBusy, onMore }) {
	return <button type="button" className="btn ghost sm" disabled={isBusy} title={`${count} items loaded`} onClick={onMore}>Show more</button>;
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

/** The reading pane: the selected item as a one-page report, or the item that just left the queue; else one collapsed line at the top of its column. */
function QueueSheetQ({ queue }) {
	const { Card, EmptyState } = window.UI;
	const { sheet } = queue;
	if (sheet.kind === "item" || sheet.kind === "left") {
		return <ItemSheetQ key={sheet.id} item={sheet.item} queue={queue} cliPath={queue.list.data?.cliPath} hasLeft={sheet.kind === "left"} />;
	}
	const state = sheet.kind === "handled"
		? { message: "All handled", hint: getOnTheWayLineQ(queue.groups) }
		: { message: "Nothing selected", hint: "Pick a row, or give an order." };
	if (sheet.kind === "handled") return <Card className="queue-sheet is-collapsed">{queue.list.data !== null && <EmptyState {...state} />}</Card>;
	return (
		<Card className="queue-sheet is-collapsed">
			{queue.list.data !== null && (
				<p className="queue-sheet-empty">
					<span className="font-semibold text-ink">{state.message}</span>
					<span className="text-dim">{state.hint}</span>
					<button type="button" className="btn" onClick={queue.orders.open}>New order</button>
				</p>
			)}
		</Card>
	);
}

// the In delivery rows → `2 answers and orders are still on their way.`; none → no line
function getOnTheWayLineQ(groups) {
	const count = groups.find((group) => group.key === LIST_GROUPS_Q.inDelivery.key)?.rows.length ?? 0;
	if (count === 0) return undefined;
	return count === 1 ? "1 answer or order is still on its way." : `${count} answers and orders are still on their way.`;
}

/**
 * One item on the sheet: letterhead (kind, session, time), body (title, text, kind block, state lines), foot (the composer).
 * @param cliPath - the installed queue CLI the server resolved (GA_ROOT-aware)
 */
function ItemSheetQ({ item, queue, cliPath, hasLeft = false }) {
	const { Card } = window.UI;
	const draft = queue.drafts[item.id] ?? {};
	const isBusy = queue.busy.id === item.id;
	const error = queue.busy.error?.id === item.id ? queue.busy.error.message : null;
	return (
		<Card className="queue-pane queue-sheet" title={<LetterheadQ item={item} />} sub={<LetterheadFactsQ item={item} />} right={<LetterheadTimeQ item={item} />}
			foot={hasLeft ? <LeftQueueLineQ /> : <SheetFootQ item={item} draft={draft} queue={queue} isBusy={isBusy} error={error} />}>
			<SheetBodyQ item={item} draft={draft} onDraft={(patch) => queue.setDraft(item.id, { ...patch, error: null })} cliPath={cliPath} />
		</Card>
	);
}

// the card's h2: read as `Decision from gersona`; the session's account, directory and id ride its title
function LetterheadQ({ item }) {
	const { Badge } = window.UI;
	const { session } = item;
	const where = [session.profileLabel, session.cwd, session.id].filter(Boolean).join(" · ");
	return (
		<span className="queue-letter">
			<Badge fill="tag">{getKindWordQ(item)}</Badge>
			<span className="sr-only">{" from "}</span>
			<span title={where}><ItemSessionNameQ session={session} /></span>
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
	const name = getSessionNameQ(item.session);
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
	const name = getSessionNameQ(item.session);
	const firstCode = (item.options ?? [])[0]?.code;
	const onSend = () => {
		const body = getAnswerBodyQ(draft);
		if (body === null) return putInvalidQ(queue, item.id, COMPOSER_ERROR_Q.noAnswer, firstCode ? `queue-option-${item.id}-${firstCode}` : `queue-text-${item.id}`);
		return queue.answerItem(item.id, body);
	};
	const resend = item.canResend ? [{ label: "Resend", onPress: () => queue.send(item.id, "resend") }] : [];
	const rest = `${draft.code ? `${draft.code} picked` : "No option picked"}. Goes to ${name}.`;
	return (
		<ComposerQ field={item.isFreeTextAllowed ? { id: `queue-text-${item.id}`, label: "Your own answer or a note (optional)" } : null}
			text={draft.text ?? ""} onText={(text) => queue.setDraft(item.id, { text, error: null })} isBusy={isBusy}
			buttons={[...resend, { label: "Send answer", isInk: true, onPress: onSend }]}
			note={<ComposerNoteQ error={error ?? draft.error} info={item.isApprovalClass ? `Approval: after you answer here, confirm once more in ${name}'s terminal.` : null} rest={rest} />}
			later={{ label: "Answer later", keyName: "l", onPress: () => queue.later(item.id) }} />
	);
}

// Mark as read carries the ink while the box is empty, Send order once it holds text or an image; order, labels and widths never change
function ReportComposerQ({ item, draft, queue, isBusy, error }) {
	const name = getSessionNameQ(item.session);
	const fieldId = `queue-reply-${item.id}`;
	const text = draft.text ?? "";
	const hasText = text.trim() !== "";
	const box = { shots: draft.images ?? [], setShots: (update) => queue.setImages(item.id, update), putError: (next) => queue.setDraft(item.id, { error: next }) };
	const hasContent = hasText || box.shots.length > 0;
	const zone = useDropZoneQ((files) => getTrayQ({ fieldId, box }).onFiles(files, false));
	const tray = getTrayQ({ fieldId, box, isOver: zone.isOver });
	const sendReply = (ids) => queue.settle(item.id, "reply", getImageBodyQ({ text }, ids));
	const markRead = () => (hasContent ? putInvalidQ(queue, item.id, COMPOSER_ERROR_Q.unsentOrder, fieldId) : queue.settle(item.id, "seen"));
	const sendOrder = () => (hasText ? sendWithImagesQ(box.shots, sendReply, (isWaiting) => queue.setDraft(item.id, { isWaiting })) : putInvalidQ(queue, item.id, COMPOSER_ERROR_Q.noOrder, fieldId));
	const order = item.isFreeTextAllowed ? [{ label: "Send order", isInk: hasContent, onPress: sendOrder }] : [];
	const rest = hasContent ? `Send order delivers this to ${name} and closes the report.` : `Mark as read closes this report. ${name} hears nothing.`;
	return (
		<ComposerQ field={item.isFreeTextAllowed ? { id: fieldId, label: `Order to ${name} (optional)` } : null} tray={item.isFreeTextAllowed ? tray : null} zone={zone.handlers}
			text={text} onText={(next) => queue.setDraft(item.id, { text: next, error: null })} isBusy={isBusy || Boolean(draft.isWaiting)}
			buttons={[{ label: "Mark as read", isInk: !hasContent, keyName: "e", onPress: markRead }, ...order]}
			note={<ComposerNoteQ error={error ?? draft.error} tray={tray} fieldId={fieldId} rest={rest} />}
			later={{ label: "Read later", keyName: "l", onPress: () => queue.later(item.id) }} />
	);
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
 * @param buttons - `{ label, isInk, keyName, onPress }` in order, the ink one last; `keyName` = the desk letter that presses it (getDeskKeyQ)
 * @param later - the quiet button at the end of the note line, `{ label, keyName, onPress }`
 */
function ComposerQ({ field = null, text = "", onText, isBusy, buttons, note, later, tray = null, zone = null }) {
	const ink = buttons.find((button) => button.isInk);
	const onKeyDown = (event) => {
		if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || !ink || isBusy) return;
		event.preventDefault();
		ink.onPress();
	};
	return (
		<div className="queue-composer" {...(tray ? zone : null)}>
			{field && (field.aside ? <div className="queue-compose-label">{getFieldLabelQ(field)}{field.aside}</div> : getFieldLabelQ(field))}
			<div className="queue-compose-row">
				{field && <ComposeBoxQ field={field} text={text} onText={onText} onKeyDown={onKeyDown} tray={tray} />}
				<div className="queue-compose-buttons">
					{buttons.map((button) => (
						<button key={button.label} type="button" className={button.isInk ? "btn lg primary" : "btn lg"} data-key={button.keyName} aria-disabled={isBusy || undefined}
							aria-busy={(isBusy && button.isInk) || undefined} onClick={isBusy ? undefined : button.onPress}>
							{isBusy && button.isInk ? "Sending…" : button.label}
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
	return (
		<Card className="queue-pane queue-sessions" title="Sessions" sub={`${rows.length - endedCount} live · ${endedCount} ended`}
			right={<button type="button" className="btn" onClick={queue.orders.open}>New order</button>}
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
	const isOrders = queue.orders.isOpen;
	const view = { collidingNames: getCollidingNamesQ(shown), notReceived: getNotReceivedBySessionQ(queue.list.data?.items ?? []), scope: isOrders ? null : queue.filter.session, isOrders };
	const scope = (session) => queue.setFilter({ ...queue.filter, session });
	return (
		<>
			<AllSessionsBandQ rows={rows} sessions={sessions} view={view} notReceived={[...view.notReceived.values()].reduce((sum, count) => sum + count, 0)} onScope={() => scope("")} />
			{live.length === 0 && <EmptyState message="No connected sessions" hint="A session appears here once it registers or posts to the queue." />}
			{live.map((row) => <SessionRailRowQ key={row.id} row={row} view={view} sessions={sessions} onScope={scope} />)}
			{ended.length > 0 && <EndedBandQ count={ended.length} isOpen={sessions.isEndedShown} onToggle={() => sessions.setEndedShown(!sessions.isEndedShown)} />}
			{sessions.isEndedShown && ended.map((row) => <SessionRailRowQ key={row.id} row={row} view={view} sessions={sessions} onScope={scope} />)}
		</>
	);
}

/**
 * The head of the roster: on the desk All sessions clears the scope and the master box ticks every live session that takes a message;
 * in the Orders mode the whole band is the master box's label.
 */
function AllSessionsBandQ({ rows, sessions, view, notReceived, onScope }) {
	const { Badge, Icon } = window.UI;
	const master = getMasterTickQ(sessions.selectedIds, rows);
	const waiting = rows.reduce((sum, row) => sum + row.count.awaiting, 0);
	const isCurrent = view.scope === "";
	const box = <CheckboxBoxQ isChecked={master === "all"} isMixed={master === "some"} onChange={() => sessions.setSelectedIds((ids) => putMasterTickQ(ids, rows))} ariaLabel="Order to all live sessions" />;
	const face = <>All sessions{waiting > 0 && <Badge role="count" fill="tag">{waiting}</Badge>}</>;
	const warn = notReceived > 0 && <Badge fill="warn" title={`${notReceived} not received`}>{notReceived}<span className="sr-only">{" not received"}</span></Badge>;
	if (view.isOrders) return <label className="queue-band queue-rail-band is-pick">{face}{warn}<span className="queue-rail-box"><span className="inline-target">{box}</span></span></label>;
	return (
		<div className="queue-band queue-rail-band">
			<button type="button" className="queue-rail-scope" aria-current={isCurrent ? "true" : undefined} onClick={onScope}>
				{face}
				{isCurrent && <Icon name="chevR" size={16} className="queue-rail-chevron" />}
			</button>
			{warn}
			<span className="queue-rail-box"><label className="inline-target">{box}</label></span>
		</div>
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

/** Live sessions that take a message `"all"` ticked, `"some"`, or `"none"` (none live counts as none). */
function getMasterTickQ(ids, rows) {
	const live = getLiveTargetIdsQ(rows);
	const ticked = live.filter((id) => ids.includes(id)).length;
	if (ticked === 0) return "none";
	return ticked === live.length ? "all" : "some";
}

// every live session ticked → untick them; else tick them all · an ended tick is the row's own and stays
function putMasterTickQ(ids, rows) {
	const live = getLiveTargetIdsQ(rows);
	if (getMasterTickQ(ids, rows) === "all") return ids.filter((id) => !live.includes(id));
	return [...ids, ...live.filter((id) => !ids.includes(id))];
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
 * One session. On the desk the row button (name, waiting count, line 2) scopes the list and the box at its end ticks it as a recipient;
 * in the Orders mode the whole row is the box's label, so a press anywhere ticks it, and the scope cue is not shown.
 */
function SessionRailRowQ({ row, view, sessions, onScope }) {
	const where = [row.profileLabel, row.cwd, row.id].filter(Boolean).join(" · ");
	const box = row.isSelectable && <CheckboxBoxQ isChecked={sessions.selectedIds.includes(row.id)} onChange={() => sessions.toggle(row.id)} ariaLabel={`Order to ${row.name}`} />;
	if (view.isOrders) {
		const Row = row.isSelectable ? "label" : "div";
		return (
			<Row className="queue-rail-row is-pick" data-session={row.id} title={where}>
				<span className="queue-rail-main"><RailRowFaceQ row={row} view={view} isCurrent={false} where={where} /></span>
				{box && <span className="queue-rail-box"><span className="inline-target">{box}</span></span>}
			</Row>
		);
	}
	const isCurrent = view.scope === row.id;
	return (
		<div className="queue-rail-row" data-session={row.id}>
			<button type="button" className="queue-rail-main" title={where} aria-current={isCurrent ? "true" : undefined} onClick={() => onScope(row.id)}>
				<RailRowFaceQ row={row} view={view} isCurrent={isCurrent} where={where} />
			</button>
			{box && <span className="queue-rail-box"><label className="inline-target">{box}</label></span>}
		</div>
	);
}

// name, waiting count and line 2 of a rail row
function RailRowFaceQ({ row, view, isCurrent, where }) {
	const { Badge, Icon } = window.UI;
	return (
		<>
			<span className="queue-rail-name">
				<SessionNameQ row={row} isIdShown={view.collidingNames.has(row.name)} />
				{isCurrent && <Icon name="chevR" size={16} className="queue-rail-chevron" />}
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
	if (notReceived > 0) return [{ text: `${notReceived} not received`, badge: "warn" }];
	if (row.state === "stale") return [{ text: "Not reachable", badge: "warn" }, age];
	if (row.state === "live") return [{ text: SESSION_STATE_LABEL_Q.live, dot: "ok" }, row.count.inDelivery > 0 ? { text: `${row.count.inDelivery} in delivery` } : age];
	if (row.markerSetAt) return [{ text: "Resume not yet registered" }];
	return [{ text: getSessionStateLabelQ(row), badge: "tag" }, age];
}

// base.css → .ctl-checkbox visual: the mark drawn over the 16 box; the caller's label is the hit area; mixed → the DOM's indeterminate state
function CheckboxBoxQ({ isChecked, isMixed = false, onChange, ariaLabel }) {
	const { Icon } = window.UI;
	const setMixed = (input) => { if (input) input.indeterminate = isMixed; };
	return (
		<span className="relative inline-flex items-center justify-center">
			<input ref={setMixed} type="checkbox" className="ctl-checkbox" checked={isChecked} onChange={onChange} aria-label={ariaLabel} />
			{(isChecked || isMixed) && <Icon name={isChecked ? "check" : "minus"} size={12} stroke={3} className="ctl-checkbox-mark pointer-events-none absolute" />}
		</span>
	);
}

/** The order view (spec §9.2): head Orders + Close, the To bar, the thread of the owner's orders, the composer in its order use. */
function OrdersViewQ({ queue }) {
	const { Card } = window.UI;
	const { orders, sessions, arrival = [] } = queue;
	const rows = sessions.region.data?.sessions ?? [];
	// a file dropped anywhere on the card joins the order box
	const zone = useDropZoneQ((files) => getTrayQ({ fieldId: ORDERS_Q.BOX_ID, box: getOrderBoxQ(queue) }).onFiles(files, false));
	const onShow = () => {
		orders.close();
		queue.selectRow(arrival[0].id);
	};
	const close = <button type="button" className="btn ghost" title="Esc" onClick={orders.close}><span aria-hidden="true">{"✕ "}</span>Close</button>;
	return (
		<section className="queue-orders" aria-label="Orders" {...zone.handlers}>
			<Card className="queue-orders-card" title="Orders" sub={<OrdersArrivalQ arrived={arrival} onShow={onShow} />} right={close} bar={<ToBarQ rows={rows} selectedIds={sessions.selectedIds} onClear={sessions.clear} />}
				foot={<OrderComposerQ queue={queue} targets={getSendTargetsQ(getShownSessionsQ(rows, sessions.isEndedShown), sessions.selectedIds)} isOver={zone.isOver} />} isFlush>
				<ThreadQ orders={orders} names={rows.filter((row) => sessions.selectedIds.includes(row.id)).map((row) => row.name)} />
			</Card>
		</section>
	);
}

// an arrival while the mode hides the list (spec §4.4) → said in the head; Show closes the mode on the first arrived row
function OrdersArrivalQ({ arrived, onShow }) {
	const { Badge } = window.UI;
	const [first] = arrived;
	const text = arrived.length === 1 ? `${getKindWordQ(first)} from ${getSessionNameQ(first.session)}` : `${arrived.length} items`;
	return (
		<span role="status" className="queue-arrival">
			{first && <Badge fill="solid">New</Badge>}
			{first && " "}
			{first && <span>{text}</span>}
			{first && " "}
			{first && <button type="button" className="btn ghost sm" onClick={onShow}>Show</button>}
		</span>
	);
}

// who the next order goes to and whose orders are shown; the rail's boxes edit it, the bar only clears
function ToBarQ({ rows, selectedIds, onClear }) {
	const { Badge } = window.UI;
	const ticked = rows.filter((row) => selectedIds.includes(row.id));
	return (
		<div className="queue-to">
			<span className="queue-to-label">To</span>
			{ticked.length === 0 && <span className="text-dim">No session ticked</span>}
			{ticked.map((row, index) => (
				<span key={row.id} className="queue-to-name">
					{`${row.name}${index < ticked.length - 1 ? "," : ""}`}
					{row.state === "exited" && <Badge fill="tag">Ended</Badge>}
				</span>
			))}
			<button type="button" className="btn ghost sm queue-to-clear" hidden={ticked.length === 0 || undefined} onClick={onClear}>Clear</button>
		</div>
	);
}

/** The owner's orders oldest first under day labels, `Show earlier` at the top; it opens at its end (useThreadScrollQ). */
function ThreadQ({ orders, names }) {
	const { LoadingPlaceholder } = window.UI;
	const { thread } = orders;
	const [viewer, setViewer] = useStateQ(null);
	const entries = getThreadEntriesQ(thread.items);
	const scroll = useThreadScrollQ(entries);
	useThreadAimQ(entries, orders.aim);
	return (
		<div ref={scroll.ref} onScroll={scroll.onScroll} role="log" aria-label={names.length > 0 ? `Orders to ${getNameListQ(names)}` : "All orders"} tabIndex={0} className="queue-thread">
			{thread.nextCursor !== null && <button type="button" className="btn ghost sm queue-earlier" disabled={thread.status === "loading"} onClick={orders.showEarlier}>Show earlier</button>}
			{thread.status === "error" && <QueueFailureQ failure={thread.error} onRetry={orders.read} />}
			{thread.status === "loading" && entries.length === 0 && <div className="queue-loading"><LoadingPlaceholder label="orders" /></div>}
			{thread.status === "ready" && entries.length === 0 && <ThreadEmptyQ names={names} />}
			{getDayGroupsQ(entries).map((group) => (
				<div key={group.day} className="queue-day-group">
					<p className="queue-day">{group.label}</p>
					{group.entries.map((entry) => <OrderEntryQ key={entry.id} entry={entry} onResend={orders.resend} onOpenImage={(images, index) => setViewer({ images, index })} />)}
				</div>
			))}
			{viewer && <ImageViewerQ images={viewer.images} index={viewer.index} onStep={(index) => setViewer((prev) => ({ ...prev, index }))} onClose={() => setViewer(null)} />}
		</div>
	);
}

// spec §10 → Order view, no entry in scope
function ThreadEmptyQ({ names }) {
	const { EmptyState } = window.UI;
	if (names.length === 0) return <EmptyState message="No orders yet" hint="Tick sessions in the rail and write the first one below." />;
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
	const onScroll = () => {
		const log = ref.current;
		last.current.isAtEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 2;
	};
	return { ref, onScroll };
}

// an order opened from its list row → its entry centred and focused once a read holds it; the aim goes with the mode
function useThreadAimQ(entries, aim) {
	const signature = entries.map((entry) => entry.id).join(",");
	useLayoutEffectQ(() => {
		const id = aim?.current == null ? null : getAimedEntryIdQ(entries, aim.current);
		if (id === null) return;
		aim.current = null;
		const entry = document.getElementById(`${ORDER_ID_PREFIX_Q}${id}`);
		entry?.scrollIntoView({ block: "center" });
		entry?.focus({ preventScroll: true });
	}, [signature]);
}

function getAimedEntryIdQ(entries, copyId) {
	return entries.find((entry) => entry.copies.some((copy) => copy.id === copyId))?.id ?? null;
}

// consecutive entries of one KST day under one label
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
function OrderEntryQ({ entry, onResend, onOpenImage }) {
	const { formatKstTime } = window.UI;
	const { item, copies } = entry;
	return (
		<article id={`${ORDER_ID_PREFIX_Q}${entry.id}`} tabIndex={-1} className="queue-order">
			<p className="queue-order-time" title={getAnswerLineQ(item)?.text}>
				{item.kind === "report" && <span className="queue-order-re">{`Re: ${item.title}`}</span>}
				<time dateTime={item.answeredAt}>{formatKstTime(item.answeredAt)}</time>
			</p>
			<OrderBubbleQ text={getOrderTextQ(item)} images={item.attachments ?? []} onOpenImage={onOpenImage} />
			<RecipientsQ copies={copies} onResend={onResend} />
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

function ViewerBarQ({ image, index, count, onStep, onClose }) {
	const { Icon } = window.UI;
	return (
		<div className="queue-viewer-bar">
			<span className="queue-viewer-name">{`${image.name} · ${getSizeTextQ(image.bytes)} · ${index + 1} of ${count}`}</span>
			<button type="button" className="btn ghost sm icon" aria-label="Previous image" disabled={index === 0} onClick={() => onStep(index - 1)}><Icon name="chevron-left" size={16} /></button>
			<button type="button" className="btn ghost sm icon" aria-label="Next image" disabled={index === count - 1} onClick={() => onStep(index + 1)}><Icon name="chevron-right" size={16} /></button>
			<button type="button" className="btn ghost sm" onClick={onClose}>✕ Close</button>
		</div>
	);
}

// one step within the order's images; an end or another key → null
function getSteppedIndexQ(index, count, key) {
	const next = key === "ArrowRight" ? index + 1 : key === "ArrowLeft" ? index - 1 : index;
	return next === index || next < 0 || next >= count ? null : next;
}

/** A row per recipient; from five on, one roll-up line opens the received and waiting ones while the not received stay listed under it. */
function RecipientsQ({ copies, onResend }) {
	const { DisclosureChevron } = window.UI;
	const resendable = copies.filter((copy) => copy.canResend).map((copy) => copy.id);
	const isRolledUp = copies.length >= ORDERS_Q.ROLL_UP_FROM;
	const isOutside = (copy) => !isRolledUp || getReceiptQ(copy) === "notReceived";
	const list = (shown) => <ul className="queue-recipients" aria-label="Recipients">{shown.map((copy) => <RecipientRowQ key={copy.id} copy={copy} onResend={onResend} />)}</ul>;
	return (
		<>
			{isRolledUp && (
				<details className="queue-roll-up">
					<summary className="group disclosure fs-meta"><DisclosureChevron /><RowFactsQ facts={getRollUpFactsQ(copies)} /></summary>
					{list(copies.filter((copy) => !isOutside(copy)))}
				</details>
			)}
			{copies.some(isOutside) && list(copies.filter(isOutside))}
			{resendable.length >= 2 && <button type="button" className="btn ghost sm" onClick={() => onResend(resendable)}>{`Resend to ${resendable.length}`}</button>}
		</>
	);
}

// `7 sessions · 5 received · 1 not yet` + the amber `1 not received`; a zero count is left out
function getRollUpFactsQ(copies) {
	const receipts = copies.map(getReceiptQ);
	const counted = (receipt) => receipts.filter((one) => one === receipt).length;
	const parts = [`${copies.length} sessions`, `${counted("received")} received`, `${counted("notYet")} not yet`].filter((part, index) => index === 0 || !part.startsWith("0 "));
	const failed = counted("notReceived");
	return [{ text: parts.join(" · ") }, ...(failed > 0 ? [{ text: `${failed} not received`, badge: "warn" }] : [])];
}

// an order on a report's sheet is the report's answer text; a standalone order is the message's body
function getOrderTextQ(item) {
	return item.kind === "report" ? (item.answer?.text ?? "") : item.body;
}

// the session name and its receipt, and nothing else; Resend only where the queue names it (canResend)
function RecipientRowQ({ copy, onResend }) {
	const { formatKstTime } = window.UI;
	const receipt = getReceiptQ(copy);
	const time = receipt === "received" && copy.deliveredAt ? [{ text: formatKstTime(copy.deliveredAt) }] : [];
	return (
		<li className="queue-recipient">
			<span className="queue-recipient-name"><ItemSessionNameQ session={copy.session} /></span>
			<RowFactsQ facts={[getReceiptFactQ(receipt), ...time]} />
			{copy.canResend && <button type="button" className="btn sm" onClick={() => onResend([copy.id])}>Resend</button>}
		</li>
	);
}

// the composer in its order use: the send carries the ink once the box holds text; a press with something missing says what and moves focus
function OrderComposerQ({ queue, targets, isOver = false }) {
	const { orders } = queue;
	const box = getOrderBoxQ(queue);
	const tray = getTrayQ({ fieldId: ORDERS_Q.BOX_ID, box, isOver });
	const isLinked = isReplyLinkedQ(orders.reply, targets.ids);
	const onSend = () => {
		const invalid = getOrderInvalidQ(targets, box.text);
		if (invalid === null) return isLinked ? sendReplyOrderQ(queue, box) : sendPlainOrderQ(queue, targets, box);
		orders.putError(invalid.message);
		const selector = invalid.focus === "box" ? `#${ORDERS_Q.BOX_ID}` : ".queue-sessions .ctl-checkbox";
		window.document?.querySelector(selector)?.focus();
	};
	// the text and images move from the report's draft to the order box
	const onDrop = () => {
		orders.setText(box.text);
		orders.setImages(() => box.shots);
		queue.setDraft(orders.reply.item.id, { text: "", images: [] });
		orders.dropReply();
	};
	return (
		<ComposerQ field={{ id: ORDERS_Q.BOX_ID, label: "Order", aside: isLinked ? <ReLineQ title={orders.reply.item.title} onDrop={onDrop} /> : null }} tray={tray}
			text={box.text} onText={box.setText} isBusy={box.isBusy}
			buttons={[{ label: getSendLabelQ(targets), isInk: box.text.trim() !== "", onPress: onSend }]}
			note={<ComposerNoteQ error={box.error} tray={tray} fieldId={ORDERS_Q.BOX_ID} rest={getReplyNoteQ(orders.reply, isLinked, targets)} />} />
	);
}

// a reply while its report's session is the one tick; any other tick set → a plain order, the report stays open
function isReplyLinkedQ(reply, ids) {
	return Boolean(reply) && !reply.isDropped && ids.length === 1 && ids[0] === reply.item.session.id;
}

/** The box's text, busy state and refusal: the report's own draft while a reply is linked and not dropped, else the order composer's. */
function getOrderBoxQ(queue) {
	const { orders, drafts, busy } = queue;
	const { reply, composer } = orders;
	if (!reply || reply.isDropped) {
		return { text: composer.text, setText: orders.setText, isBusy: composer.isBusy, error: composer.error, shots: composer.images ?? [], setShots: orders.setImages, putError: orders.putError };
	}
	const { id } = reply.item;
	const draft = drafts[id] ?? {};
	const refusal = busy.error?.id === id ? busy.error.message : null;
	return {
		text: draft.text ?? "", setText: (text) => queue.setDraft(id, { text, error: null }),
		isBusy: busy.id === id || composer.isBusy || Boolean(draft.isWaiting), error: refusal ?? draft.error ?? composer.error,
		shots: draft.images ?? [], setShots: (update) => queue.setImages(id, update), putError: (error) => queue.setDraft(id, { error }),
	};
}

function getReplyNoteQ(reply, isLinked, targets) {
	if (isLinked) return `Sends this to ${targets.names[0]} and closes the report.`;
	if (reply) return "Not a reply any more: the report stays open.";
	return getOrderNoteQ(targets);
}

// the report's own Send order: it closes and leaves the queue, the next open item selected (settle) → the link goes, the thread re-reads
async function sendReplyOrderQ(queue, box) {
	const { orders } = queue;
	const { id } = orders.reply.item;
	const send = (ids) => queue.settle(id, "reply", getImageBodyQ({ text: box.text }, ids));
	if (!(await sendWithImagesQ(box.shots, send, (isWaiting) => queue.setDraft(id, { isWaiting })))) return;
	orders.linkReply(null);
	orders.read();
}

// a plain order typed in the report's draft → sent, so the draft empties and the report never gets it twice
async function sendPlainOrderQ(queue, targets, box) {
	const { orders } = queue;
	const isSent = await orders.send({ sessionIds: targets.ids, text: box.text }, targets.names, box.shots);
	if (isSent && orders.reply && !orders.reply.isDropped) queue.setDraft(orders.reply.item.id, { text: "", images: [] });
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
	if (answer.status >= 200 && answer.status < 300 && typeof id === "string") return { status: "stored", id, src: getImageUrlQ(id), cause: null };
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

function ReLineQ({ title, onDrop }) {
	return (
		<>
			<span className="queue-compose-re" title={title}><span aria-hidden="true">{"· "}</span>{`Re: ${title}`}</span>
			<button type="button" className="btn ghost sm" aria-label="Do not link this order to the report" onClick={onDrop}><span aria-hidden="true">✕</span></button>
		</>
	);
}

function RailFootQ({ queue }) {
	const { sessions } = queue;
	const hasMore = sessions.region.data?.hasMore === true;
	return (
		<>
			<RecentResumesQ region={queue.resumes} onRetry={queue.readResumes} />
			{hasMore && <span className="fs-meta text-dim">{`Showing the ${sessions.region.data.sessions.length} most recent`}</span>}
		</>
	);
}

/** Recent automatic resumes newest first, in a drawer from the rail foot → quota spent without a click stays one press away. */
function RecentResumesQ({ region, onRetry }) {
	const { RegionUnavailable, DetailSurface, TONE_GLYPH, getRegionView } = window.UI;
	const [isOpen, setOpen] = useStateQ(false);
	const view = getRegionView(region);
	if (view === "error") return <RegionUnavailable source="recent automatic resumes" error={region.error} isBusy={region.busy} onRetry={onRetry} />;
	if (view === "loading" || region.data.length === 0) return null;
	const hasFailed = region.data.some((resume) => RESUME_RESULT_LABEL_Q[resume.result] === "failed");
	return (
		<>
			<button type="button" className="btn ghost sm" onClick={() => setOpen(true)}>
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
