// Queue screen — the owner's decision and report queue: cards in queue order,
// answer / reply / Seen / Later / Resend, deviation and automatic-resume state per card.
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
const CARD_ID_PREFIX_Q = "queue-item-";
// characters a POSIX shell never treats as syntax in an unquoted word
const SHELL_SAFE_Q = /^[A-Za-z0-9_@%+=:,./-]+$/;
const FILTER_AXES_Q = ["profile", "session"];
const DEFAULT_FILTER_Q = Object.freeze({ profile: "", session: "" });

const DEVIATION_LABEL_Q = {
	unacked: "Unacked",
	held: "Held",
	expired: "Expired",
	resume_pending: "Resume pending",
	session_not_reachable: "Session not reachable",
	delivery_off: "Delivery off — session alive",
};
// owner runs the pull command in the session itself for these two
const PULL_DEVIATIONS_Q = new Set(["session_not_reachable", "delivery_off"]);

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

const APPROVAL_NOTE_Q = "Approval: the terminal confirmation is still needed after you answer here.";
const WRAPPER_RISK_NOTE_Q =
	"Started through the accept wrapper: on macOS the socket token is optional, so any same-uid process can drive this bypass session with no prompt.";

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
	const hash = window.location.hash.slice(1);
	const queryIndex = hash.indexOf("?");
	if (queryIndex < 0) return DEFAULT_FILTER_Q;
	const params = new URLSearchParams(hash.slice(queryIndex + 1));
	return Object.fromEntries(FILTER_AXES_Q.map((axis) => [axis, params.get(axis) ?? DEFAULT_FILTER_Q[axis]]));
}

// replaceState → a filter change adds no history entry; defaults leave a bare #queue
function setFilterHashQ(filter) {
	const hash = window.location.hash.slice(1);
	const queryIndex = hash.indexOf("?");
	const screenId = queryIndex < 0 ? hash : hash.slice(0, queryIndex);
	const search = new URLSearchParams(FILTER_AXES_Q.filter((axis) => filter[axis]).map((axis) => [axis, filter[axis]])).toString();
	const next = `#${search ? `${screenId}?${search}` : screenId}`;
	if (window.location.hash !== next) window.history.replaceState(null, "", next);
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
		<div className="flex flex-col gap-section">
			<TypeScaleStyle />
			<QueueHeaderQ queue={queue} />
			<QueueBodyQ queue={queue} />
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

// list read as a region summary input + the resume region
function getShownRegionsQ({ list, resumes }) {
	return [{ busy: list.status === "loading", error: list.status === "error" ? list.error : null }, resumes];
}

function QueueBodyQ({ queue }) {
	const { LoadingPlaceholder } = window.UI;
	if (queue.list.status === "error") return <QueueFailureQ failure={queue.list.error} onRetry={queue.reload} />;
	if (queue.list.data === null) return <LoadingPlaceholder label="Loading the queue" />;
	return <QueueListQ queue={queue} />;
}

/** Page state: the loaded list, per-card drafts kept across re-reads, and the owner actions. */
function useQueueStateQ({ onRetryHarness }) {
	const [list, setList] = useStateQ({ status: "loading", data: null, error: null, readAt: null });
	const [resumes, readResumes] = useRecentResumesQ();
	const [drafts, setDrafts] = useStateQ({});
	const [filter, setFilter] = useFilterQ();
	const [focus, setFocus] = useStateQ(null);
	const reload = useCallbackQ(() => {
		getListQ({ setList });
		readResumes();
	}, [readResumes]);
	const loadMore = useCallbackQ(() => getMoreQ({ list, setList }), [list]);
	useEffectQ(() => { reload(); }, [reload]);
	useFocusCardQ(focus);
	const actions = useQueueActionsQ({ list, filter, setList, setDrafts, setFocus, reload, onRetryHarness });
	const setDraft = useCallbackQ((id, patch) => setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } })), []);
	return { list, resumes, readResumes, drafts, setDraft, filter, setFilter, reload, loadMore, ...actions };
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

// focus request `{ id }` → a fresh object per request, so asking for the same card again still moves the focus
function useFocusCardQ(focus) {
	useEffectQ(() => {
		if (focus === null) return;
		document.getElementById(`${CARD_ID_PREFIX_Q}${focus.id}`)?.focus();
	}, [focus]);
}

function useQueueActionsQ({ list, filter, setList, setDrafts, setFocus, reload, onRetryHarness }) {
	const { busy, send } = useSendQ({ setDrafts, reload, onRetryHarness });
	// next card from the filtered list → the focus never lands on a card the filter hides
	const items = getVisibleItemsQ(list.data?.items ?? [], filter);
	const later = useCallbackQ((id) => {
		setList((prev) => (prev.data ? { ...prev, data: { ...prev.data, items: putLaterQ(prev.data.items, id) } } : prev));
		return send(id, "later");
	}, [send, setList]);
	const answerItem = useCallbackQ(async (id, body) => {
		const nextId = getNextAwaitingIdQ(items, id);
		if ((await send(id, "answer", body)) && nextId !== null) setFocus({ id: nextId });
	}, [send, items, setFocus]);
	return { busy, send, later, answerItem };
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
	const reason = answer.data?.reason;
	return typeof reason === "string" && reason !== "" ? `Refused: ${reason}.` : "The monitor refused this action. Refresh and try again.";
}

function QueueFailureQ({ failure, onRetry }) {
	const { AlertCard, RetryButton } = window.UI;
	return <AlertCard tone="crit" title={failure.sentence} body={failure.next} details={failure.detail} actions={<RetryButton onRetry={onRetry} />} />;
}

function QueueListQ({ queue }) {
	const { EmptyState } = window.UI;
	const data = queue.list.data;
	const visible = getVisibleItemsQ(data.items, queue.filter);
	return (
		<div className="flex flex-col gap-section">
			{!data.isSocketDeliveryOn && <DegradedBannerQ />}
			<QueueFilterBarQ items={data.items} filter={queue.filter} onFilter={queue.setFilter} />
			{data.items.length === 0 && <EmptyState message="Nothing waiting for you" hint="Sessions post decisions and reports here; the nav badge counts them." />}
			{data.items.length > 0 && visible.length === 0 && (
				<EmptyState kind="no-results" message="No records match these filters." onReset={() => queue.setFilter(DEFAULT_FILTER_Q)} />
			)}
			{visible.map((item) => <QueueCardQ key={item.id} item={item} queue={queue} cliPath={data.cliPath} />)}
			{data.nextCursor !== null && <ShowMoreQ count={data.items.length} isBusy={queue.list.status === "loading"} onMore={queue.loadMore} />}
			<RecentResumesQ region={queue.resumes} onRetry={queue.readResumes} />
		</div>
	);
}

function DegradedBannerQ() {
	const { AlertCard } = window.UI;
	return (
		<AlertCard tone="warn" title="Socket delivery is off"
			body="The format check turned socket delivery off: live sessions get answers when they pull, and exited sessions still resume." />
	);
}

function ShowMoreQ({ count, isBusy, onMore }) {
	const { Cluster } = window.UI;
	return (
		<Cluster gap="control">
			<span className="fs-meta text-dim">{`Showing the first ${count} items in queue order.`}</span>
			<button type="button" className="btn ghost sm" disabled={isBusy} onClick={onMore}>Show more</button>
		</Cluster>
	);
}

function QueueFilterBarQ({ items, filter, onFilter }) {
	const { FilterBar } = window.UI;
	const options = getFilterOptionsQ(items, filter);
	return (
		<FilterBar label="Queue filters" isApplied={isFilterAppliedQ(filter)} onReset={() => onFilter(DEFAULT_FILTER_Q)}>
			<FilterAxisTriggerQ axis="Account" options={options.profile} value={filter.profile} onPick={(profile) => onFilter({ ...filter, profile })} />
			<FilterAxisTriggerQ axis="Session" options={options.session} value={filter.session} onPick={(session) => onFilter({ ...filter, session })} />
		</FilterBar>
	);
}

// One radio axis — "" (All) is a real option, so the trigger always names the value in force
function FilterAxisTriggerQ({ axis, options, value, onPick }) {
	const label = options.find((option) => option.key === value)?.label ?? value;
	return <window.UI.FilterTrigger axis={axis} value={label} options={options} chosenKeys={[value]} onPick={onPick} />;
}

function QueueCardQ({ item, queue, cliPath }) {
	const { Card, Stack } = window.UI;
	const isBusy = queue.busy.id === item.id;
	const error = queue.busy.error?.id === item.id ? queue.busy.error.message : null;
	const draft = queue.drafts[item.id] ?? {};
	return (
		<section id={`${CARD_ID_PREFIX_Q}${item.id}`} tabIndex={-1} aria-label={item.title}>
			<Card title={item.title} sub={<CardMetaQ item={item} />}>
				<Stack gap="stack">
					{item.kind === "decision"
						? <DecisionBodyQ item={item} draft={draft} onDraft={(patch) => queue.setDraft(item.id, patch)} />
						: <ReportBodyQ item={item} draft={draft} onDraft={(patch) => queue.setDraft(item.id, patch)} />}
					<CardStateQ item={item} cliPath={cliPath} />
					<CardActionsQ item={item} draft={draft} queue={queue} isBusy={isBusy} />
					{error && <div className="fs-meta text-crit" role="alert"><span aria-hidden="true">✕ </span>{error}</div>}
					{item.resumes.length > 0 && <ResumeRecordListQ resumes={item.resumes} profileLabel={item.session.profileLabel} />}
				</Stack>
			</Card>
		</section>
	);
}

function CardMetaQ({ item }) {
	const { formatRelativeTime } = window.UI;
	const { session } = item;
	return <span>{`${session.profileLabel} · ${session.cwdTail} · asked ${formatRelativeTime(item.askedAt)}`}</span>;
}

function DecisionBodyQ({ item, draft, onDraft }) {
	const { Stack } = window.UI;
	const isOpen = item.status === "open";
	return (
		<Stack gap="stack">
			<p className="fs-body whitespace-pre-wrap">{item.body}</p>
			{item.isApprovalClass && <p className="fs-meta text-dim">{APPROVAL_NOTE_Q}</p>}
			<fieldset disabled={!isOpen}>
				<legend className="sr-only">Options</legend>
				<Stack gap="list">
					{(item.options ?? []).map((option) => (
						<DecisionOptionQ key={option.code} itemId={item.id} option={option} isRecommended={option.code === item.recommendedCode}
							isChecked={(draft.code ?? item.answer.code) === option.code} onPick={() => onDraft({ code: option.code })} />
					))}
				</Stack>
			</fieldset>
			{item.isFreeTextAllowed && isOpen && (
				<DraftFieldQ id={`queue-text-${item.id}`} label="Your answer (optional)" value={draft.text ?? ""} onChange={(text) => onDraft({ text })} />
			)}
		</Stack>
	);
}

function DecisionOptionQ({ itemId, option, isRecommended, isChecked, onPick }) {
	const { Cluster } = window.UI;
	const id = `queue-option-${itemId}-${option.code}`;
	return (
		<Cluster gap="control" className="flex-nowrap items-baseline">
			<input id={id} type="radio" name={`queue-options-${itemId}`} checked={isChecked} onChange={onPick} />
			<label htmlFor={id} className="fs-body">
				<span className="font-semibold">{`${option.code} · ${option.label}`}</span>
				{isRecommended && <span className="fs-meta text-dim">{" · recommended"}</span>}
				{option.pros && <span className="block fs-meta text-dim">{`Pros: ${option.pros}`}</span>}
				{option.cons && <span className="block fs-meta text-dim">{`Cons: ${option.cons}`}</span>}
			</label>
		</Cluster>
	);
}

function ReportBodyQ({ item, draft, onDraft }) {
	const { Stack, Link } = window.UI;
	return (
		<Stack gap="stack">
			<p className="fs-body whitespace-pre-wrap">{item.body}</p>
			{item.linkedDocIds.length > 0 && (
				<ul className="fs-body">
					{item.linkedDocIds.map((docId) => <li key={docId}><Link href={`#clauded-docs?doc=${docId}`}>{`Document ${docId} →`}</Link></li>)}
				</ul>
			)}
			{item.isFreeTextAllowed && item.status === "open" && (
				<DraftFieldQ id={`queue-reply-${item.id}`} label="Reply (optional)" value={draft.text ?? ""} onChange={(text) => onDraft({ text })} />
			)}
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

/**
 * Deviation word, the pull command where the owner must act in the session, precedence notes and the wrapper risk.
 * @param cliPath - the installed queue CLI the server resolved (GA_ROOT-aware)
 */
function CardStateQ({ item, cliPath }) {
	const { Stack, MachineString } = window.UI;
	const notes = getCardNotesQ(item);
	return (
		<Stack gap="label">
			{item.deviation && (
				<p className="fs-meta">
					<span aria-hidden="true" className="text-warn">{`${window.UI.TONE_GLYPH.warn} `}</span>
					{DEVIATION_LABEL_Q[item.deviation] ?? item.deviation}
				</p>
			)}
			{PULL_DEVIATIONS_Q.has(item.deviation) && cliPath && (
				<p className="fs-meta text-dim">Run in that session: <MachineString>{`${getShellWordQ(cliPath)} pending`}</MachineString></p>
			)}
			{notes.map((note) => <p key={getNoteKeyQ(note)} className="fs-meta text-dim"><NotePartsQ parts={note} /></p>)}
			{item.session.launchHint === "accept_wrapper" && <p className="fs-meta text-dim">{WRAPPER_RISK_NOTE_Q}</p>}
		</Stack>
	);
}

function getNoteKeyQ(parts) {
	return parts.map((part) => (typeof part === "string" ? part : part.machine)).join("");
}

function NotePartsQ({ parts }) {
	const { MachineString } = window.UI;
	return <>{parts.map((part, index) => (typeof part === "string" ? part : <MachineString key={index}>{part.machine}</MachineString>))}</>;
}

function CardActionsQ({ item, draft, queue, isBusy }) {
	const { Cluster } = window.UI;
	const isOpen = item.status === "open";
	return (
		<Cluster gap="control">
			{isOpen && item.kind === "decision" && <SendButtonQ item={item} draft={draft} queue={queue} isBusy={isBusy} />}
			{isOpen && item.kind === "report" && <ReportButtonsQ item={item} draft={draft} queue={queue} isBusy={isBusy} />}
			{isOpen && <button type="button" className="btn" disabled={isBusy} onClick={() => queue.later(item.id)}>Later</button>}
			{item.canResend && <button type="button" className="btn" disabled={isBusy} onClick={() => queue.send(item.id, "resend")}>Resend</button>}
		</Cluster>
	);
}

function SendButtonQ({ item, draft, queue, isBusy }) {
	const body = getAnswerBodyQ(draft);
	return (
		<button type="button" className="btn primary" disabled={isBusy || body === null} onClick={() => queue.answerItem(item.id, body)}>
			Send
		</button>
	);
}

// option code and/or non-blank free text; neither → no answer to send (null)
function getAnswerBodyQ(draft) {
	const text = draft.text?.trim() ? draft.text : undefined;
	if (draft.code === undefined && text === undefined) return null;
	return { ...(draft.code === undefined ? {} : { code: draft.code }), ...(text === undefined ? {} : { text }) };
}

function ReportButtonsQ({ item, draft, queue, isBusy }) {
	const hasReply = Boolean(draft.text?.trim());
	return (
		<>
			<button type="button" className="btn primary" disabled={isBusy} onClick={() => queue.send(item.id, "seen")}>Seen</button>
			{hasReply && <button type="button" className="btn" disabled={isBusy} onClick={() => queue.send(item.id, "reply", { text: draft.text })}>Send reply</button>}
		</>
	);
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

/** Page-level record: recent automatic resumes newest first → quota spent without a click stays visible. */
function RecentResumesQ({ region, onRetry }) {
	const { Card, RegionUnavailable, getRegionView } = window.UI;
	const view = getRegionView(region);
	if (view === "loading" || (view === "ready" && region.data.length === 0)) return null;
	return (
		<Card title="Recent automatic resumes">
			{view === "error"
				? <RegionUnavailable source="recent automatic resumes" error={region.error} isBusy={region.busy} onRetry={onRetry} />
				: <RecentResumeListQ resumes={region.data} />}
		</Card>
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
