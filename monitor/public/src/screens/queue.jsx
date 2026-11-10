// Queue screen — the owner's decision and report queue behind the passphrase login: cards in queue order,
// answer / reply / Seen / Later / Resend, deviation and automatic-resume state per card.
// Every server field renders as React text, never as HTML.
const {
	useState: useStateQ,
	useEffect: useEffectQ,
	useCallback: useCallbackQ,
	useRef: useRefQ,
} = React;

const OWNER_API_Q = "/api/queue/owner";
const LIST_LIMIT_Q = 100;
const RECENT_RESUME_LIMIT_Q = 10;
const SESSION_PREFIX_LENGTH_Q = 8;
const CARD_ID_PREFIX_Q = "queue-item-";
// installed CLI the owner runs inside the session (scripts/lib/queue-session.sh → queue_get_cli_path)
const PENDING_COMMAND_Q = "~/.glass-atrium/scripts/atrium-queue.sh pending";

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
const APPROVAL_NOTE_Q = "Approval: the terminal confirmation is still needed after you answer here.";
const WRAPPER_RISK_NOTE_Q =
	"Started through the accept wrapper: on macOS the socket token is optional, so any same-uid process can drive this bypass session with no prompt.";

/**
 * Queue nav slot: awaiting count, a deviation glyph when any deviation is open, a lock while signed out.
 * Never read → no key (no zero that was not loaded) · read failed → "?" so the badge never goes blank.
 * @param countState - shell store of /api/queue/count
 * @param auth - owner auth: 'unknown' | 'in' | 'out' | 'not_provisioned'
 */
function getQueueNavBadge(countState, auth) {
	if (countState?.status === "error") {
		return { queue: { badges: [{ badge: "?", title: "Queue count unavailable", description: "queue count unavailable" }] } };
	}
	if (countState?.status !== "ready") return {};
	const { awaiting, deviations } = countState.data ?? {};
	if (!Number.isInteger(awaiting) || !Number.isInteger(deviations)) return getQueueNavBadge({ status: "error" }, auth);
	const parts = [`${awaiting} awaiting you`, deviations > 0 && `${deviations} ${deviations === 1 ? "deviation" : "deviations"}`];
	const title = parts.filter(Boolean).join(", ");
	const glyph = deviations > 0 ? window.UI.TONE_GLYPH.warn : undefined;
	const badges = [{ badge: String(awaiting), badgeTone: "warn", glyph, source: "queue", title, description: title }];
	if (auth === "out" || auth === "not_provisioned") {
		badges.push({ badge: "", icon: "lock", source: "auth", title: "Signed out of the queue", description: "signed out" });
	}
	return { queue: { badges } };
}

/**
 * Owner answer → auth state; any other answer leaves it unchanged (null).
 * 503 is also a database outage (`database_unavailable`) → only the body's code means not provisioned.
 */
function getAuthFromAnswerQ({ status, data }) {
	if (status === 401) return "out";
	if (isNotProvisionedQ({ status, data })) return "not_provisioned";
	return status >= 200 && status < 300 ? "in" : null;
}

function isNotProvisionedQ({ status, data }) {
	return status === 503 && data?.error === "not_provisioned";
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

/** Every resume record on the page, newest first, each tagged with its item's account and cwd tail. */
function getRecentResumesQ(items, limit = RECENT_RESUME_LIMIT_Q) {
	return items
		.flatMap((item) => item.resumes.map((resume) => ({ ...resume, itemId: item.id, title: item.title, session: item.session })))
		.sort((left, right) => Date.parse(right.sentAt) - Date.parse(left.sentAt))
		.slice(0, limit);
}

function getConfigPrefixQ(session) {
	return session.configDir ? `CLAUDE_CONFIG_DIR=${session.configDir} ` : "";
}

/** Marker text: captured-id form when the spawn recorded a bg id, else the listing form. */
function getMarkerTextQ(session) {
	const prefix = getConfigPrefixQ(session);
	const lead = `the resumed session may still be running in the background: under profile ${session.profileLabel}, `;
	const bgId = session.marker?.bgId;
	if (bgId) {
		return `${lead}check it with \`${prefix}claude logs ${bgId}\`, and resume it yourself in a terminal only after \`${prefix}claude stop ${bgId}\``;
	}
	return (
		`${lead}check \`${prefix}claude agents --json --cwd ${session.cwd}\` for the entry of session ${session.id}, ` +
		`and resume it yourself in a terminal only once that entry is no longer listed, or after \`${prefix}claude stop <id>\` with that entry's id`
	);
}

function getMarkedOccupantTextQ(occupant) {
	return (
		`waiting on ${occupant.profileLabel} · ${occupant.cwdTail} · ${occupant.sessionIdPrefix}, whose automatic resume has not registered: ` +
		"this one waits until that session registers or is resumed in a terminal (see its card), and resumes automatically once that session has then ended"
	);
}

/**
 * Lines shown in place of (or beside) Resend, by card precedence: the marker on every card of a marked session,
 * then the server's sweep skip reason; a resume in flight shows nothing.
 */
function getCardNotesQ(item) {
	if (item.session.marker) return [getMarkerTextQ(item.session)];
	const skip = item.skipReason;
	if (!skip || skip.kind === "in_flight" || skip.kind === "marker") return [];
	if (skip.kind !== "shared_worktree") return [SKIP_TEXT_Q[skip.kind]];
	const marked = skip.markedOccupants.map(getMarkedOccupantTextQ);
	const hasGeneric = skip.hasUnmarkedOccupant || marked.length === 0;
	return hasGeneric ? [...marked, SKIP_TEXT_Q.shared_worktree] : marked;
}

/** Account and session filter choices from the loaded items; "" = every value. */
function getFilterOptionsQ(items) {
	const profiles = [...new Set(items.map((item) => item.session.profileLabel))].sort();
	const sessions = [...new Map(items.map((item) => [item.session.id, item.session])).values()];
	return {
		profile: [{ key: "", label: "All accounts" }, ...profiles.map((label) => ({ key: label, label }))],
		session: [
			{ key: "", label: "All sessions" },
			...sessions.map((session) => ({ key: session.id, label: `${session.cwdTail} · ${session.id.slice(0, SESSION_PREFIX_LENGTH_Q)}` })),
		],
	};
}

function getVisibleItemsQ(items, filter) {
	return items.filter(
		(item) => (!filter.profile || item.session.profileLabel === filter.profile) && (!filter.session || item.session.id === filter.session),
	);
}

function ScreenQueue({ onQueueAuth, onRetryHarness }) {
	const { PageHeader, TypeScaleStyle, FreshnessStamp, RefreshButton } = window.UI;
	const queue = useQueueStateQ({ onQueueAuth, onRetryHarness });
	const { list } = queue;
	return (
		<div className="flex flex-col gap-section">
			<TypeScaleStyle />
			<PageHeader
				title="Queue"
				freshness={<FreshnessStamp at={list.readAt} loading={list.status === "loading"} failed={list.status === "error"} />}
				refresh={<RefreshButton onRefresh={queue.reload} isBusy={list.status === "loading"} hasRead={list.readAt !== null} label="Refresh queue" />}
			/>
			<QueueBodyQ queue={queue} />
		</div>
	);
}

function QueueBodyQ({ queue }) {
	const { LoadingPlaceholder } = window.UI;
	if (queue.auth === "out" || queue.auth === "not_provisioned") {
		return <LoginFormQ auth={queue.auth} onLogin={queue.login} />;
	}
	if (queue.list.status === "error") return <QueueFailureQ error={queue.list.error} onRetry={queue.reload} />;
	if (queue.list.data === null) return <LoadingPlaceholder label="Loading the queue" />;
	return <QueueListQ queue={queue} />;
}

/** Page state: auth, the loaded list, per-card drafts kept across a re-login, and the owner actions. */
function useQueueStateQ({ onQueueAuth, onRetryHarness }) {
	const [auth, putAuth] = useAuthQ(onQueueAuth);
	const [list, setList] = useStateQ({ status: "loading", data: null, error: null, readAt: null });
	const [drafts, setDrafts] = useStateQ({});
	const [filter, setFilter] = useStateQ({ profile: "", session: "" });
	const [focusId, setFocusId] = useStateQ(null);
	const reload = useCallbackQ(() => getListQ({ setList, putAuth }), [putAuth]);
	useEffectQ(() => { reload(); }, [reload]);
	useFocusCardQ(focusId);
	const actions = useQueueActionsQ({ list, setList, setDrafts, setFocusId, putAuth, reload, onRetryHarness });
	const setDraft = useCallbackQ((id, patch) => setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } })), []);
	const login = useCallbackQ((passphrase) => putSessionQ({ passphrase, putAuth, reload }), [putAuth, reload]);
	return { auth, list, drafts, setDraft, filter, setFilter, reload, login, ...actions };
}

// login → the held drafts stay in page state, so the owner sends the interrupted action again
async function putSessionQ({ passphrase, putAuth, reload }) {
	const error = await putLoginQ(passphrase);
	if (error === null) {
		putAuth({ status: 200, data: null });
		reload();
	}
	return error;
}

// auth state + the setter every owner answer feeds; the shell hears each change for its lock badge
function useAuthQ(onQueueAuth) {
	const [auth, setAuth] = useStateQ("unknown");
	const putAuth = useCallbackQ((answer) => {
		const next = getAuthFromAnswerQ(answer);
		if (next === null) return;
		setAuth(next);
		onQueueAuth?.(next);
	}, [onQueueAuth]);
	return [auth, putAuth];
}

async function getListQ({ setList, putAuth }) {
	setList((prev) => ({ ...prev, status: "loading" }));
	const answer = await sendOwnerRequestQ(`/items?limit=${LIST_LIMIT_Q}`);
	putAuth(answer);
	if (answer.status >= 200 && answer.status < 300 && Array.isArray(answer.data?.items)) {
		return setList({ status: "ready", data: answer.data, error: null, readAt: new Date().toISOString() });
	}
	if (answer.status === 401 || isNotProvisionedQ(answer)) return setList((prev) => ({ ...prev, status: "ready" }));
	const error = answer.error ?? new Error(answer.status < 300 ? "the queue answer carries no item list" : `HTTP ${answer.status}`);
	setList((prev) => ({ ...prev, status: "error", error }));
}

function useFocusCardQ(focusId) {
	useEffectQ(() => {
		if (focusId === null) return;
		document.getElementById(`${CARD_ID_PREFIX_Q}${focusId}`)?.focus();
	}, [focusId]);
}

function useQueueActionsQ({ list, setList, setDrafts, setFocusId, putAuth, reload, onRetryHarness }) {
	const { busy, send } = useSendQ({ setDrafts, putAuth, reload, onRetryHarness });
	const items = list.data?.items ?? [];
	const later = useCallbackQ((id) => {
		setList((prev) => (prev.data ? { ...prev, data: { ...prev.data, items: putLaterQ(prev.data.items, id) } } : prev));
		return send(id, "later");
	}, [send, setList]);
	const answerItem = useCallbackQ(async (id, body) => {
		const nextId = getNextAwaitingIdQ(items, id);
		if ((await send(id, "answer", body)) && nextId !== null) setFocusId(nextId);
	}, [send, items, setFocusId]);
	return { busy, send, later, answerItem };
}

/** One owner action: a 401 keeps the card draft for the re-login, any other refusal shows on the card. */
function useSendQ({ setDrafts, putAuth, reload, onRetryHarness }) {
	const [busy, setBusy] = useStateQ({ id: null, error: null });
	const send = useCallbackQ(
		async (id, action, body) => {
			setBusy({ id, error: null });
			const answer = await sendOwnerRequestQ(`/items/${id}/${action}`, body ?? {});
			putAuth(answer);
			const isDone = answer.status >= 200 && answer.status < 300;
			setBusy({ id: null, error: isDone || answer.status === 401 ? null : { id, message: getActionErrorQ(answer) } });
			if (!isDone) return false;
			setDrafts((prev) => ({ ...prev, [id]: undefined }));
			reload();
			onRetryHarness?.();
			return true;
		},
		[putAuth, setDrafts, reload, onRetryHarness],
	);
	return { busy, send };
}

function getActionErrorQ(answer) {
	if (answer.status === 0) return "The monitor did not answer. Try again.";
	if (answer.status === 409) return "Refused: the item changed state. Refresh to see where it is now.";
	return answer.data?.message ?? answer.data?.error ?? `The monitor refused this (HTTP ${answer.status}).`;
}

function QueueFailureQ({ error, onRetry }) {
	const { AlertCard, RetryButton } = window.UI;
	return <AlertCard tone="crit" title="Couldn't read the queue" body={error?.message ?? String(error)} actions={<RetryButton onRetry={onRetry} />} />;
}

function LoginFormQ({ auth, onLogin }) {
	const { Card } = window.UI;
	if (auth === "not_provisioned") {
		return (
			<Card title="Queue not set up">
				<p className="fs-control">No owner passphrase is set. Run the queue setup script once in a terminal, then reload this page.</p>
			</Card>
		);
	}
	return <PassphraseFormQ onLogin={onLogin} />;
}

// passphrase field state; the value is cleared once the login succeeds
function usePassphraseSubmitQ(onLogin) {
	const [passphrase, setPassphrase] = useStateQ("");
	const [state, setState] = useStateQ({ isBusy: false, error: null });
	const onSubmit = async (event) => {
		event.preventDefault();
		setState({ isBusy: true, error: null });
		const error = await onLogin(passphrase);
		setState({ isBusy: false, error });
		if (error === null) setPassphrase("");
	};
	return { passphrase, setPassphrase, state, onSubmit };
}

function PassphraseFormQ({ onLogin }) {
	const { Card, Stack } = window.UI;
	const { passphrase, setPassphrase, state, onSubmit } = usePassphraseSubmitQ(onLogin);
	return (
		<Card title="Sign in to the queue">
			<form onSubmit={onSubmit}>
				<Stack gap="stack">
					<label htmlFor="queue-passphrase" className="field-label">Passphrase</label>
					<input id="queue-passphrase" type="password" autoComplete="current-password" className={`field${state.error ? " is-error" : ""}`}
						value={passphrase} onChange={(event) => setPassphrase(event.target.value)} aria-invalid={state.error ? "true" : undefined}
						aria-describedby={state.error ? "queue-passphrase-error" : undefined} />
					{state.error && <div id="queue-passphrase-error" className="fs-meta text-crit" role="alert"><span aria-hidden="true">✕ </span>{state.error}</div>}
					<button type="submit" className="btn primary self-start" disabled={state.isBusy || passphrase === ""}>Sign in</button>
				</Stack>
			</form>
		</Card>
	);
}

/** Login → null on success, else the message the form shows. */
async function putLoginQ(passphrase) {
	const answer = await sendOwnerRequestQ("/login", { passphrase });
	if (answer.status >= 200 && answer.status < 300) return null;
	if (answer.status === 401) return "Wrong passphrase.";
	if (answer.status === 429) return `Too many attempts. Try again in ${answer.data?.retryAfterSeconds ?? "a few"} seconds.`;
	if (answer.status === 0) return "The monitor did not answer. Try again.";
	return `Sign-in failed (HTTP ${answer.status}).`;
}

function QueueListQ({ queue }) {
	const { EmptyState, Stack } = window.UI;
	const data = queue.list.data;
	const visible = getVisibleItemsQ(data.items, queue.filter);
	return (
		<Stack gap="block">
			{!data.isSocketDeliveryOn && <DegradedBannerQ />}
			<QueueFilterBarQ items={data.items} filter={queue.filter} onFilter={queue.setFilter} />
			{data.items.length === 0 && <EmptyState message="Nothing waiting for you" hint="Sessions post decisions and reports here; the nav badge counts them." />}
			{data.items.length > 0 && visible.length === 0 && (
				<EmptyState kind="no-results" message="No records match these filters." onReset={() => queue.setFilter({ profile: "", session: "" })} />
			)}
			{visible.map((item) => <QueueCardQ key={item.id} item={item} queue={queue} />)}
			{data.nextCursor !== null && <p className="fs-meta text-dim">{`Showing the first ${data.items.length} items in queue order.`}</p>}
			<RecentResumesQ items={data.items} />
		</Stack>
	);
}

function DegradedBannerQ() {
	const { AlertCard } = window.UI;
	return (
		<AlertCard tone="warn" title="Socket delivery is off"
			body="The format check turned socket delivery off: live sessions get answers when they pull, and exited sessions still resume." />
	);
}

function QueueFilterBarQ({ items, filter, onFilter }) {
	const { Cluster, Select } = window.UI;
	const options = getFilterOptionsQ(items);
	return (
		<Cluster gap="control-group">
			<Select id="queue-filter-profile" label="Account" value={filter.profile} options={options.profile} onChange={(profile) => onFilter({ ...filter, profile })} />
			<Select id="queue-filter-session" label="Session" value={filter.session} options={options.session} onChange={(session) => onFilter({ ...filter, session })} />
		</Cluster>
	);
}

function QueueCardQ({ item, queue }) {
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
					<CardStateQ item={item} />
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
			<p className="fs-control whitespace-pre-wrap">{item.body}</p>
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
	const id = `queue-option-${itemId}-${option.code}`;
	return (
		<div className="flex gap-2 items-start">
			<input id={id} type="radio" name={`queue-options-${itemId}`} checked={isChecked} onChange={onPick} className="mt-1" />
			<label htmlFor={id} className="fs-control">
				<span className="font-semibold">{`${option.code} · ${option.label}`}</span>
				{isRecommended && <span className="fs-meta text-dim">{" · recommended"}</span>}
				{option.pros && <span className="block fs-meta text-dim">{`Pros: ${option.pros}`}</span>}
				{option.cons && <span className="block fs-meta text-dim">{`Cons: ${option.cons}`}</span>}
			</label>
		</div>
	);
}

function ReportBodyQ({ item, draft, onDraft }) {
	const { Stack, Link } = window.UI;
	return (
		<Stack gap="stack">
			<p className="fs-control whitespace-pre-wrap">{item.body}</p>
			{item.linkedDocIds.length > 0 && (
				<ul className="fs-control">
					{item.linkedDocIds.map((docId) => <li key={docId}><Link href={`#clauded-docs?doc=${docId}`}>{`Document ${docId} →`}</Link></li>)}
				</ul>
			)}
			{item.status === "open" && (
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

/** Deviation word, the pull command where the owner must act in the session, precedence notes and the wrapper risk. */
function CardStateQ({ item }) {
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
			{PULL_DEVIATIONS_Q.has(item.deviation) && (
				<p className="fs-meta text-dim">Run in that session: <MachineString>{PENDING_COMMAND_Q}</MachineString></p>
			)}
			{notes.map((note) => <p key={note} className="fs-meta text-dim">{note}</p>)}
			{item.session.launchHint === "accept_wrapper" && <p className="fs-meta text-dim">{WRAPPER_RISK_NOTE_Q}</p>}
		</Stack>
	);
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
function RecentResumesQ({ items }) {
	const { Card } = window.UI;
	const recent = getRecentResumesQ(items);
	if (recent.length === 0) return null;
	return (
		<Card title="Recent automatic resumes">
			<ul className="fs-control">
				{recent.map((resume) => (
					<li key={`${resume.itemId}-${resume.attempt}-${resume.sentAt}`}>
						<ResumeLineQ resume={resume} profileLabel={`${resume.session.profileLabel} · ${resume.session.cwdTail}`} />
						<span className="fs-meta text-dim">{` — ${resume.title}`}</span>
					</li>
				))}
			</ul>
		</Card>
	);
}

window.ScreenQueue = ScreenQueue;
// shell reads: the nav slot and the auth mapping its mount probe shares with this page
window.QueueNav = { getQueueNavBadge, getAuthFromAnswerQ };
