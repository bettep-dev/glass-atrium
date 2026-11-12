// Queue screen — the desk: the Sessions pane, the list of decisions, reports and items in delivery under their bands,
// and the sheet showing the selected item as a one-page report with its composer (answer / order / Mark as read / later / Resend).
// Every server field renders as React text, never as HTML.
const {
	useState: useStateQ,
	useEffect: useEffectQ,
	useCallback: useCallbackQ,
	useRef: useRefQ,
} = React;

const OWNER_API_Q = "/api/queue/owner";
const LIST_Q = { LIMIT: 100, SOURCE: "the queue" };
const SESSION_PREFIX_LENGTH_Q = 8;
const ROW_ID_PREFIX_Q = "queue-row-";
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
const EMPTY_COMPOSER_Q = Object.freeze({ text: "", isBusy: false, error: null, sentCount: null });
// the sheet holds no item and the owner has not handled everything
const EMPTY_HOLD_Q = Object.freeze({ item: null, isHandled: false });
const SESSION_STATE_LABEL_Q = { live: "Live" };
const EXIT_REASON_LABEL_Q = { ended: "Ended", dead: "Ended · process gone", replaced: "Replaced" };

const COMPOSER_ERROR_Q = {
	noAnswer: "Pick an option or write an answer, then send.",
	noOrder: "Write the order, then send.",
	unsentOrder: "Unsent order in the field. Send it, or clear it first.",
};

/**
 * Queue nav slot: awaiting count plus a deviation glyph when any deviation is open.
 * Never read → no key (no zero that was not loaded) · read failed → "?" so the badge never goes blank.
 * @param countState - shell store of /api/queue/count
 */
function getQueueNavBadge(countState) {
	const count = getCountBadgeQ(countState);
	return count === null ? {} : { queue: { badges: [count] } };
}

// count slot alone: never read → null · failed or numberless read → "?"
function getCountBadgeQ(countState) {
	if (countState?.status !== "ready" && countState?.status !== "error") return null;
	const { awaiting, deviations } = countState.data ?? {};
	if (countState.status === "error" || !Number.isInteger(awaiting) || !Number.isInteger(deviations)) {
		return { badge: "?", title: "Queue count unavailable", description: "queue count unavailable" };
	}
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

function ScreenQueue({ onRetryHarness }) {
	const { TypeScaleStyle } = window.UI;
	const queue = useQueueStateQ({ onRetryHarness });
	return (
		<div className="queue-screen">
			<TypeScaleStyle />
			<QueueHeaderQ queue={queue} />
			<QueueDeskQ queue={queue} />
		</div>
	);
}

// DOM order Sessions → list → sheet; the panes are fixed-role columns that never stack
function QueueDeskQ({ queue }) {
	return (
		<div className="queue-desk">
			<SessionsRegionQ queue={queue} />
			<QueueListQ queue={queue} />
			<QueueSheetQ queue={queue} />
		</div>
	);
}

// stamp and Refresh read one region summary → a failed resume re-read beside a good list read shows Partial, never Fresh
function QueueHeaderQ({ queue }) {
	const { PageHeader, FreshnessStamp, RefreshButton, getRegionSummary } = window.UI;
	const regions = getShownRegionsQ(queue);
	const { list } = queue;
	return (
		<PageHeader
			title="Queue"
			freshness={<FreshnessStamp at={list.readAt} regions={regions} />}
			refresh={<RefreshButton onRefresh={queue.reload} isBusy={getRegionSummary(regions).isBusy} hasRead={list.readAt !== null} label="Refresh queue" />}
		/>
	);
}

// list read as a region summary input + the resume and session regions
function getShownRegionsQ({ list, resumes, sessions }) {
	return [{ busy: list.status === "loading", error: list.status === "error" ? list.error : null }, resumes, sessions.region];
}

/** Page state: the loaded list, its bands and selection, per-item drafts kept across re-reads, and the owner actions. */
function useQueueStateQ({ onRetryHarness }) {
	const [list, setList] = useStateQ({ status: "loading", data: null, error: null, readAt: null });
	const [resumes, readResumes] = useRecentResumesQ();
	const [drafts, setDrafts] = useStateQ({});
	const [filter, setFilter] = useFilterQ();
	const [focus, setFocus] = useStateQ(null);
	const [status, setStatus] = useStateQ("");
	const groups = getGroupsQ(getVisibleItemsQ(list.data?.items ?? [], filter));
	const { sheet, selectItem } = useSheetQ(groups);
	const sessions = useSessionsStateQ(filter.profile);
	// sessions.read changes with the Account filter → a filter change re-reads the page
	const reload = useCallbackQ(() => {
		getListQ({ setList });
		readResumes();
		sessions.read();
	}, [readResumes, sessions.read]);
	const loadMore = useCallbackQ(() => getMoreQ({ list, setList }), [list]);
	useEffectQ(() => { reload(); }, [reload]);
	useFocusRowQ(focus);
	const actions = useQueueActionsQ({ list, filter, setList, setDrafts, setFocus, setStatus, selectItem, reload, onRetryHarness });
	const setDraft = useCallbackQ((id, patch) => setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } })), []);
	const selectRow = useCallbackQ((id) => { selectItem(id); setFocus({ id }); }, [selectItem]);
	return {
		list, resumes, readResumes, sessions, drafts, setDraft, filter, setFilter, reload, loadMore,
		groups, sheet, selectedId: sheet.id, selectRow, status, ...actions,
	};
}

/**
 * The sheet's selection and the open item it holds while that item is on it.
 * selectItem(null) → all handled; any other selection → the owner moved on, so the held item goes.
 */
function useSheetQ(groups) {
	const [hashItemId, setHashItemId] = useStateQ(() => getHashStateQ().item);
	const [hold, setHold] = useStateQ(EMPTY_HOLD_Q);
	const sheet = getSheetStateQ(groups, hashItemId, hold);
	const shown = sheet.kind === "item" && sheet.item.status === "open" ? sheet.item : null;
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

/** Session list region, the ticked rows, Show ended and the message composer; the list follows the Account filter. */
function useSessionsStateQ(profile) {
	const [region, setRegion] = useStateQ(window.UI.INITIAL_REGION_STATE);
	const [selectedIds, setSelectedIds] = useStateQ(getTicksFromHashQ);
	useEffectQ(() => { setHashStateQ({ to: selectedIds.join(",") }); }, [selectedIds]);
	const [isEndedShown, setEndedShown] = useStateQ(false);
	const [composer, setComposer] = useStateQ(EMPTY_COMPOSER_Q);
	const read = useCallbackQ(() => getSessionsQ({ profile, setRegion, setSelectedIds }), [profile]);
	const toggle = useCallbackQ((id) => {
		setSelectedIds((ids) => putToggledIdQ(ids, id));
		setComposer((prev) => ({ ...prev, sentCount: null }));
	}, []);
	const clear = useCallbackQ(() => setSelectedIds([]), []);
	const setText = useCallbackQ((text) => setComposer((prev) => ({ ...prev, text, error: null })), []);
	const send = useCallbackQ((body, onSent) => sendMessageQ({ body, setComposer, setSelectedIds, onSent }), []);
	return { region, read, selectedIds, setSelectedIds, toggle, clear, isEndedShown, setEndedShown, composer, setText, send };
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

/** Send targets `{ ids, endedCount }`: ticked rows on show that take a message → a hidden ended row or a replaced row is never sent to. */
function getSendTargetsQ(shownRows, selectedIds) {
	const rows = shownRows.filter((row) => row.isSelectable && selectedIds.includes(row.id));
	return { ids: rows.map((row) => row.id), endedCount: rows.filter((row) => row.state === "exited").length };
}

// an ended target is resumed to take the message → the label says how many before the owner sends
function getSendLabelQ({ ids, endedCount }) {
	const label = `Send to ${ids.length} ${ids.length === 1 ? "session" : "sessions"}`;
	return endedCount > 0 ? `${label} · resumes ${endedCount} ended` : label;
}

// targets within the per-send cap and non-blank text; anything else → null (Send stays disabled)
function getSendBodyQ(targets, text) {
	const count = targets.ids.length;
	if (count === 0 || count > MESSAGE_Q.MAX_TARGETS || !text.trim()) return null;
	return { sessionIds: targets.ids, text };
}

function getSessionStateLabelQ(row) {
	if (row.state !== "exited") return SESSION_STATE_LABEL_Q[row.state] ?? row.state;
	return EXIT_REASON_LABEL_Q[row.exitReason] ?? EXIT_REASON_LABEL_Q.ended;
}

/**
 * One message to every target, all or nothing: a refusal keeps the text and the ticks and shows in the composer.
 * @param onSent - re-reads the page, so the new message cards and the delivery counts show
 * @returns true once the server took the send
 */
async function sendMessageQ({ body, setComposer, setSelectedIds, onSent }) {
	setComposer((prev) => ({ ...prev, isBusy: true, error: null, sentCount: null }));
	const answer = await sendOwnerRequestQ("/messages/send", body);
	if (answer.status >= 200 && answer.status < 300) {
		setComposer(() => ({ ...EMPTY_COMPOSER_Q, sentCount: body.sessionIds.length }));
		setSelectedIds([]);
		onSent();
		return true;
	}
	setComposer((prev) => ({ ...prev, isBusy: false, error: getSendErrorQ(answer) }));
	return false;
}

function getSendErrorQ(answer) {
	return getOutageStepQ(answer) ?? getRefusalReasonQ(answer) ?? "The monitor refused this message. Refresh the session list and try again.";
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

async function getListQ({ setList }) {
	setList((prev) => ({ ...prev, status: "loading" }));
	const answer = await sendOwnerRequestQ(`/items?limit=${LIST_Q.LIMIT}`);
	if (answer.status >= 200 && answer.status < 300 && Array.isArray(answer.data?.items)) {
		return setList({ status: "ready", data: answer.data, error: null, readAt: new Date().toISOString() });
	}
	setList((prev) => ({ ...prev, status: "error", error: getReadFailureQ(answer) }));
}

// Show more → the next page after the cursor joins the loaded list; a refused read → the page failure card with Retry
// ponytail: a reload (Refresh, or after an answer) reads the first page again → Show more again past 100 items; upgrade = server-side filters
async function getMoreQ({ list, setList }) {
	const cursor = list.data?.nextCursor;
	if (cursor === null || cursor === undefined) return;
	setList((prev) => ({ ...prev, status: "loading" }));
	const answer = await sendOwnerRequestQ(`/items?limit=${LIST_Q.LIMIT}&after=${cursor}`);
	if (answer.status >= 200 && answer.status < 300 && Array.isArray(answer.data?.items)) {
		const append = (prev) => ({ ...prev.data, items: [...prev.data.items, ...answer.data.items], nextCursor: answer.data.nextCursor });
		return setList((prev) => ({ status: "ready", data: append(prev), error: null, readAt: new Date().toISOString() }));
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
		if (!(await send(id, action, body))) return;
		setStatus(getActionStatusQ(items.find((item) => item.id === id), action));
		// a later item is still open → it stays on the sheet; any other act with nothing open left → all handled
		if (nextId === null) return action === "later" ? undefined : selectItem(null);
		selectItem(nextId);
		setFocus({ id: nextId });
	}, [send, items, setFocus, setStatus, selectItem]);
	const later = useCallbackQ((id) => {
		setList((prev) => (prev.data ? { ...prev, data: { ...prev.data, items: putLaterQ(prev.data.items, id) } } : prev));
		return settle(id, "later");
	}, [settle, setList]);
	const answerItem = useCallbackQ((id, body) => settle(id, "answer", body), [settle]);
	return { busy, send, settle, later, answerItem };
}

// the list's status line after a taken act; an unknown item (gone from the list) → the act alone
function getActionStatusQ(item, action) {
	const name = item ? getSessionNameQ(item.session) : "the session";
	if (action === "seen") return "Marked as read";
	if (action === "reply") return `${window.UI.TONE_GLYPH.ok} Order sent to ${name}`;
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
	return typeof reason === "string" && reason !== "" ? `Refused: ${reason}.` : null;
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
	return (
		<Card className="queue-pane queue-list" title={getScopeTitleQ(items, queue.filter)} sub={`${visible.filter((item) => item.status === "open").length} waiting`}
			bar={isListBarShownQ(items, queue.filter) ? <QueueFilterBarQ items={items} filter={queue.filter} onFilter={queue.setFilter} /> : null}
			foot={<ListFootQ queue={queue} />} isFlush>
			<ListBodyQ queue={queue} items={items} visible={visible} />
		</Card>
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
	if (queue.list.data === null) return <LoadingPlaceholder label="Loading the queue…" />;
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
			{group.rows.map((row) => <QueueRowQ key={row.id} row={row} isSelected={row.id === queue.selectedId} view={view} onSelect={queue.selectRow} />)}
		</div>
	);
}

function QueueRowQ({ row, isSelected, view, onSelect }) {
	const { Icon, formatRelativeTime, formatKstDateTime } = window.UI;
	const { item } = row;
	const facts = getRowFactsQ(row, view.isAccountShown);
	return (
		<div id={`${ROW_ID_PREFIX_Q}${row.id}`} role="option" aria-selected={isSelected} tabIndex={row.id === view.tabStopId ? 0 : -1}
			aria-label={getRowLabelQ(row, facts, view.isNameShown)} className="queue-row" onClick={() => onSelect(row.id)}>
			<span className="queue-row-title" title={item.title}>{item.title}</span>
			<span className="queue-row-meta">
				<span className="queue-row-who">{view.isNameShown && <RowWhoQ row={row} />}</span>
				<span className="queue-row-facts"><RowFactsQ facts={facts} /></span>
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

// one copy → its word · several → `2 of 3 received` (all waiting → Not yet), any not received → its own warning after the count
function getReceiptFactsQ(copies) {
	const receipts = copies.map(getReceiptQ);
	if (receipts.length === 1) return [getReceiptFactQ(receipts[0])];
	const received = receipts.filter((receipt) => receipt === "received").length;
	const failed = receipts.filter((receipt) => receipt === "notReceived").length;
	const count = received === 0 && failed === 0 ? getReceiptFactQ("notYet") : { text: `${received} of ${receipts.length} received` };
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

function ListFootQ({ queue }) {
	const data = queue.list.data;
	return (
		<>
			<span role="status" className="queue-status">{queue.status}</span>
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
	return <Card className="queue-sheet is-collapsed">{queue.list.data !== null && <EmptyState {...state} />}</Card>;
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
	const facts = getRowFactsQ({ item, copies: [item] }, false);
	return facts.length > 0 ? <RowFactsQ facts={facts} /> : null;
}

function LetterheadTimeQ({ item }) {
	const isAnswered = item.status !== "open" && item.answeredAt;
	const verb = isAnswered ? "Answered" : "Posted";
	const time = window.UI.formatKstDateTime(isAnswered ? item.answeredAt : item.askedAt);
	return (
		<span className="fs-meta text-faint tabular-nums" title={`${verb} ${time}`}>
			<span className="sr-only">{`${verb} `}</span>{time}
		</span>
	);
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
			<summary className="queue-fold">{`Show the question and its ${options.length} ${options.length === 1 ? "option" : "options"}`}</summary>
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

/** Answer record line `{ text, isOutside }`; an item with no answer → null. */
function getAnswerLineQ(item) {
	const time = item.answeredAt ? window.UI.formatKstDateTime(item.answeredAt) : null;
	if (item.isAnsweredOutside) return { text: [OUTSIDE_ANSWER_LABEL_Q, time].filter(Boolean).join(" · "), isOutside: true };
	const record = item.answerRecord;
	if (!record) return null;
	const route = ANSWER_ROUTE_LABEL_Q[record.route] ?? record.route;
	return { text: [route, time, ANSWER_SIGNAL_LABEL_Q[record.signal] ?? record.signal].filter(Boolean).join(" "), isOutside: false };
}

function AnswerLineQ({ item }) {
	const line = getAnswerLineQ(item);
	if (line === null) return null;
	if (!line.isOutside) return <p className="fs-meta text-dim">{line.text}</p>;
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
			later={{ label: "Answer later", onPress: () => queue.later(item.id) }} />
	);
}

// Mark as read carries the ink while the box is empty, Send order once it holds text; order, labels and widths never change
function ReportComposerQ({ item, draft, queue, isBusy, error }) {
	const name = getSessionNameQ(item.session);
	const fieldId = `queue-reply-${item.id}`;
	const text = draft.text ?? "";
	const hasText = text.trim() !== "";
	const markRead = () => (hasText ? putInvalidQ(queue, item.id, COMPOSER_ERROR_Q.unsentOrder, fieldId) : queue.settle(item.id, "seen"));
	const sendOrder = () => (hasText ? queue.settle(item.id, "reply", { text }) : putInvalidQ(queue, item.id, COMPOSER_ERROR_Q.noOrder, fieldId));
	const order = item.isFreeTextAllowed ? [{ label: "Send order", isInk: hasText, onPress: sendOrder }] : [];
	const rest = hasText ? `Send order delivers this to ${name} and closes the report.` : `Mark as read closes this report. ${name} hears nothing.`;
	return (
		<ComposerQ field={item.isFreeTextAllowed ? { id: fieldId, label: `Order to ${name} (optional)` } : null}
			text={text} onText={(next) => queue.setDraft(item.id, { text: next, error: null })} isBusy={isBusy}
			buttons={[{ label: "Mark as read", isInk: !hasText, onPress: markRead }, ...order]}
			note={<ComposerNoteQ error={error ?? draft.error} rest={rest} />}
			later={{ label: "Read later", onPress: () => queue.later(item.id) }} />
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
 * @param buttons - `{ label, isInk, onPress }` in order, the ink one last
 * @param later - the quiet button at the end of the note line
 */
function ComposerQ({ field = null, text = "", onText, isBusy, buttons, note, later }) {
	const ink = buttons.find((button) => button.isInk);
	const onKeyDown = (event) => {
		if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || !ink || isBusy) return;
		event.preventDefault();
		ink.onPress();
	};
	return (
		<div className="queue-composer">
			{field && <label htmlFor={field.id} className="field-label">{field.label}</label>}
			<div className="queue-compose-row">
				{field && (
					<div className="queue-compose-box">
						<textarea id={field.id} rows={1} className="queue-compose-text" value={text} onChange={(event) => onText(event.target.value)} onKeyDown={onKeyDown} />
					</div>
				)}
				<div className="queue-compose-buttons">
					{buttons.map((button) => (
						<button key={button.label} type="button" className={button.isInk ? "btn lg primary" : "btn lg"} aria-disabled={isBusy || undefined}
							aria-busy={(isBusy && button.isInk) || undefined} onClick={isBusy ? undefined : button.onPress}>
							{isBusy && button.isInk ? "Sending…" : button.label}
						</button>
					))}
				</div>
			</div>
			<div className="queue-note">
				<div className="queue-note-text">{note}</div>
				{later && <button type="button" className="btn ghost sm" disabled={isBusy} onClick={later.onPress}>{later.label}</button>}
			</div>
		</div>
	);
}

// one line: a refusal or a missing control (crit alert), else the approval reminder (info), else the line at rest
function ComposerNoteQ({ error, info = null, rest }) {
	if (error) return <ToneLineQ tone="crit" role="alert" isTextToned>{error}</ToneLineQ>;
	if (info) return <ToneLineQ tone="info">{info}</ToneLineQ>;
	return <p className="fs-meta">{rest}</p>;
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
			right={<button type="button" className="btn" onClick={() => queue.openOrders?.()}>New order</button>}
			foot={<RailFootQ queue={queue} />} isFlush>
			{view === "loading" && <LoadingPlaceholder label="Loading sessions" />}
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
	const targets = getSendTargetsQ(shown, sessions.selectedIds);
	const view = { collidingNames: getCollidingNamesQ(shown), notReceived: getNotReceivedBySessionQ(queue.list.data?.items ?? []), scope: queue.filter.session };
	const scope = (session) => queue.setFilter({ ...queue.filter, session });
	return (
		<>
			<AllSessionsBandQ rows={rows} sessions={sessions} isCurrent={!view.scope} notReceived={[...view.notReceived.values()].reduce((sum, count) => sum + count, 0)} onScope={() => scope("")} />
			{live.length === 0 && <EmptyState message="No connected sessions" hint="A session appears here once it registers or posts to the queue." />}
			{live.map((row) => <SessionRailRowQ key={row.id} row={row} view={view} sessions={sessions} onScope={scope} />)}
			{ended.length > 0 && <EndedBandQ count={ended.length} isOpen={sessions.isEndedShown} onToggle={() => sessions.setEndedShown(!sessions.isEndedShown)} />}
			{sessions.isEndedShown && ended.map((row) => <SessionRailRowQ key={row.id} row={row} view={view} sessions={sessions} onScope={scope} />)}
			{/* ponytail: the composer sits under the rail until the Orders mode holds it (spec §9.2, this stream's next unit) */}
			{targets.ids.length > 0 && (
				<MessageComposerQ targets={targets} composer={sessions.composer} onText={sessions.setText}
					onSend={(body) => sessions.send(body, queue.reload)} onClear={sessions.clear} />
			)}
			{sessions.composer.sentCount !== null && <SentNoticeQ count={sessions.composer.sentCount} />}
		</>
	);
}

// the head of the roster: All sessions clears the scope, the master box ticks every live session that takes a message
function AllSessionsBandQ({ rows, sessions, isCurrent, notReceived, onScope }) {
	const { Badge, Icon } = window.UI;
	const master = getMasterTickQ(sessions.selectedIds, rows);
	const waiting = rows.reduce((sum, row) => sum + row.count.awaiting, 0);
	return (
		<div className="queue-band queue-rail-band">
			<button type="button" className="queue-rail-scope" aria-current={isCurrent ? "true" : undefined} onClick={onScope}>
				All sessions
				<Badge role="count" fill="tag">{waiting}</Badge>
				{isCurrent && <Icon name="chevR" size={16} className="queue-rail-chevron" />}
			</button>
			{notReceived > 0 && <Badge fill="warn">{`${notReceived} not received`}</Badge>}
			<span className="queue-rail-box">
				<CheckboxQ isChecked={master === "all"} isMixed={master === "some"} onChange={() => sessions.setSelectedIds((ids) => putMasterTickQ(ids, rows))} ariaLabel="Order to all live sessions" />
			</span>
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

/** One session: the row button (name, waiting count, line 2) scopes the list; the box at its end ticks it as a recipient. */
function SessionRailRowQ({ row, view, sessions, onScope }) {
	const { Badge, Icon } = window.UI;
	const isCurrent = view.scope === row.id;
	const where = [row.profileLabel, row.cwd, row.id].filter(Boolean).join(" · ");
	return (
		<div className="queue-rail-row" data-session={row.id}>
			<button type="button" className="queue-rail-main" title={where} aria-current={isCurrent ? "true" : undefined} onClick={() => onScope(row.id)}>
				<span className="queue-rail-name">
					<SessionNameQ row={row} isIdShown={view.collidingNames.has(row.name)} />
					{isCurrent && <Icon name="chevR" size={16} className="queue-rail-chevron" />}
				</span>
				{row.count.awaiting > 0 && <span className="queue-rail-count"><Badge role="count" fill="solid">{row.count.awaiting}</Badge><span className="sr-only">{" waiting"}</span></span>}
				<span className="queue-rail-line"><RowFactsQ facts={getSessionLineQ(row, view.notReceived.get(row.id) ?? 0)} /></span>
				<span className="sr-only">{`, ${where}`}</span>
			</button>
			{row.isSelectable && (
				<span className="queue-rail-box">
					<CheckboxQ isChecked={sessions.selectedIds.includes(row.id)} onChange={() => sessions.toggle(row.id)} ariaLabel={`Order to ${row.name}`} />
				</span>
			)}
		</div>
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
	if (row.state === "live") return [{ text: SESSION_STATE_LABEL_Q.live, mark: "ok" }, row.count.inDelivery > 0 ? { text: `${row.count.inDelivery} in delivery` } : age];
	if (row.markerSetAt) return [{ text: "Resume not yet registered" }];
	return [{ text: getSessionStateLabelQ(row), badge: "tag" }, age];
}

// base.css → .ctl-checkbox visual: the mark drawn over the 16 box, the label the 24 hit area; mixed → the DOM's indeterminate state
function CheckboxQ({ isChecked, isMixed = false, isDisabled = false, onChange, ariaLabel, children }) {
	const { Icon } = window.UI;
	const setMixed = (input) => { if (input) input.indeterminate = isMixed; };
	return (
		<label className="inline-target gap-label-inline">
			<span className="relative inline-flex items-center justify-center">
				<input ref={setMixed} type="checkbox" className="ctl-checkbox" checked={isChecked} disabled={isDisabled} onChange={onChange} aria-label={ariaLabel} />
				{isChecked && <Icon name="check" size={12} stroke={3} className="ctl-checkbox-mark pointer-events-none absolute" />}
			</span>
			{children}
		</label>
	);
}

function MessageComposerQ({ targets, composer, onText, onSend, onClear }) {
	const { Stack, Cluster } = window.UI;
	const body = getSendBodyQ(targets, composer.text);
	const overCap = targets.ids.length - MESSAGE_Q.MAX_TARGETS;
	return (
		<Stack gap="stack">
			<DraftFieldQ id="queue-message-text" label="Message to the ticked sessions" value={composer.text} onChange={onText} />
			{overCap > 0 && <p className="fs-meta text-dim">{`Up to ${MESSAGE_Q.MAX_TARGETS} sessions per message: untick ${overCap}.`}</p>}
			<Cluster gap="control">
				<button type="button" className="btn primary" disabled={composer.isBusy || body === null} onClick={() => onSend(body)}>{getSendLabelQ(targets)}</button>
				<button type="button" className="btn ghost" disabled={composer.isBusy} onClick={onClear}>Clear selection</button>
			</Cluster>
			{composer.error && <ToneLineQ tone="crit" role="alert" isTextToned>{composer.error}</ToneLineQ>}
		</Stack>
	);
}

function DraftFieldQ({ id, label, value, onChange }) {
	const { Stack } = window.UI;
	return (
		<Stack gap="label">
			<label htmlFor={id} className="field-label">{label}</label>
			<textarea id={id} rows={3} className="field" value={value} onChange={(event) => onChange(event.target.value)} />
		</Stack>
	);
}

function SentNoticeQ({ count }) {
	return (
		<ToneLineQ tone="ok" role="status">
			{`Sent to ${count} ${count === 1 ? "session" : "sessions"}: each message is a card in the queue, with its delivery state.`}
		</ToneLineQ>
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
window.QueueNav = { getQueueNavBadge };
