// Remote access — the Mac's own page: whether devices can reach this monitor, the steps that connect one, and the registered devices.
// Loopback only: its routes answer the Mac page alone (route-classes.ts → remote-admin), so the remote page never lists it.
const { useState: useSRA, useEffect: useERA, useCallback: useCRA, useRef: useRRA } = React;

const URL_RA = {
	SETUP: "/api/remote/setup",
	DEVICES: "/api/remote/devices",
	REGISTRATION: "/api/remote/registration",
	REVOKE_ALL: "/api/remote/devices/revoke-all",
	CONFIRM_NETWORK: "/api/remote/access/network",
	CERTIFICATE: "/api/remote/certificate",
};
const ACCESS_URL_RA = { on: "/api/remote/access/on", trust: "/api/remote/access/trust", off: "/api/remote/access/off" };
// admin-routes.ts → MAC_PAGE_HEADER (bound by remote-access.screen-render) — a document's markup can never send it
const PAGE_HEADERS_RA = { "x-glass-atrium-page": "remote-access" };
// admin-routes.ts → CONFIRM_HEADER (bound by remote-access.screen-render): an on or trust acts only on the read it names
const CONFIRM_HEADER_RA = "x-glass-atrium-confirm";
// registration-code.ts → REGISTRATION_CODE.WINDOW_MS (bound by remote-access.screen-render)
const CODE_WINDOW_MS_RA = 5 * 60_000;
// while a code is open → a device that registers shows without a refresh
const DEVICE_POLL_MS_RA = 5_000;
// Action: isNumeric for the atom's right-end alignment (a button, no figures) · 1% → the column shrinks to its button
const DEVICE_COLUMNS_RA = [{ key: "label", label: "Device" }, { key: "created", label: "Registered" }, { key: "seen", label: "Last seen" }, { key: "act", label: "Action", isNumeric: true }];
const DEVICE_WIDTHS_RA = [undefined, undefined, undefined, "1%"];
const DESTRUCTIVE_STYLE_RA = { color: "rgb(var(--crit))", borderColor: "rgb(var(--crit))", background: "transparent" };

/**
 * The connect procedure per device (spec 44105 → Connect a device): a title, one line or one Settings path, at most three Trouble? lines.
 * hosts → the setup facts that make the address, first shown, second in the fold · a device joins only once its steps are ruled (Android: A4).
 */
const STEPS_RA = {
	iphone: {
		name: "iPhone or iPad",
		hosts: ["hostName", "address"],
		steps: [
			{
				kind: "send",
				title: "Send the certificate to your iPhone",
				line: { share: "Choose AirDrop, then your iPhone; it shows “Profile Downloaded”.", download: "In Downloads, AirDrop “Glass Atrium Local CA” to your iPhone." },
				trouble: [{ text: "No AirDrop prompt? Unlock your iPhone and keep it near this Mac." }, { text: "Set up this iPhone before?", isJump: true }],
			},
			{
				kind: "fingerprint",
				title: "Match the fingerprint before installing",
				path: "Settings › Profile Downloaded › More Details › Glass Atrium Local CA",
				trouble: [{ text: "No lines before installing? Install, then check General › VPN & Device Management." }, { text: "Lines differ? Tap Remove Downloaded Profile and stop here." }],
			},
			{ kind: "phone", title: "Install the certificate", line: "Go back, tap Install, enter your passcode, tap Install twice, then Done.", trouble: [{ text: "No “Profile Downloaded” in Settings? Repeat step 1." }] },
			{
				kind: "phone",
				title: "Turn on full trust",
				path: "Settings › General › About › Certificate Trust Settings › Glass Atrium Local CA",
				trouble: [{ text: "No switch there? Repeat step 3." }, { text: "Asked to confirm? Tap Continue." }],
			},
			{
				kind: "scan",
				title: "Scan with Camera, then register",
				line: "Do this after step 4; close any page saying “This Connection Is Not Private”.",
				trouble: [{ text: "Camera does nothing? Open this in Safari: {address}" }, { text: "Still nothing? Try: {address-2}" }],
			},
		],
	},
};
// a Trouble? line's value slot → its value; a line whose value is missing is left out
const SLOT_RA = /(\{[a-z0-9-]+\})/;
const PATH_SEPARATOR_RA = " › ";
// spec 44105 → The QR drawing: 4 CSS px a module, a 4-module quiet zone, modules in elev on an ink field (16.74:1)
const QR_RA = { MODULE_PX: 4, QUIET: 4, FIELD: { fill: "rgb(var(--ink))" }, MODULE: { fill: "rgb(var(--elev))" } };

// progress null → the device choice · open null → every step done
const PROGRESS_ACTS_RA = {
	choose: (_, act) => ({ device: act.device, open: 0, done: STEPS_RA[act.device].steps.map(() => false), isTroubleOpen: false, label: null }),
	change: () => null,
	next: (progress) => putOpenStepRA(progress, progress.open + 1, progress.done.map((isDone, i) => isDone || i === progress.open)),
	// the share sheet completes after the person may have moved on → only step 1 still open moves
	sent: (progress) => (progress?.open === 0 ? PROGRESS_ACTS_RA.next(progress) : progress),
	back: (progress) => putOpenStepRA(progress, progress.open - 1),
	reopen: (progress, act) => putOpenStepRA(progress, act.index),
	// a phone that already holds the certificate → straight to the scan step
	jump: (progress) => putOpenStepRA(progress, progress.done.length - 1, progress.done.map((_, i) => i < progress.done.length - 1)),
	connected: (progress, act) => ({ ...progress, open: null, done: progress.done.map(() => true), isTroubleOpen: false, label: act.label }),
	trouble: (progress) => ({ ...progress, isTroubleOpen: !progress.isTroubleOpen }),
};

const OPEN_ERROR_RA = {
	429: "Too many codes opened; wait a minute, then show a new one.",
	503: "No code was opened; try again in a minute.",
};
// admin-routes.ts → ConfirmRefusal: the network moved or the confirm's read went stale
const CONFIRM_REFUSALS_RA = new Set(["confirm_stale", "network_changed"]);
// admin-routes.ts → AccessApplyOutcome: a throw, an unnamed step exit, or config.toml written without the monitor/.env a restart reads → state unknown
const UNKNOWN_STATE_REFUSALS_RA = new Set(["act_failed", "write_failed", "env_not_rendered"]);
// admin-routes.ts → AccessApplyOutcome: the step wrote, this process could not apply it → the next restart does
const RESTART_PENDING_REFUSAL_RA = "start_failed";
const WIDEN_ERROR_RA = {
	on: {
		moved: "Nothing was turned on: the network changed; check the number again.",
		unknown: "Remote access may or may not be on; refresh to check.",
		pending: "Remote access starts at the next monitor restart; Turn off cancels it.",
		failed: "Remote access was not turned on; try again.",
	},
	trust: {
		moved: "Nothing was trusted: the network changed; check the number again.",
		unknown: "This network may or may not be trusted; refresh to check.",
		pending: "This network is trusted from the next monitor restart.",
		failed: "This network was not trusted; try again.",
	},
};
const END_ERROR_RA = { off: "Remote access is still on; try again.", "remove-all": "No device was removed; try again." };

const STATUS_RA = {
	off: { text: "Off", tone: "neutral" },
	"off-no-network": { text: "Off", tone: "neutral" },
	on: { text: "On", tone: "ok" },
	closed: { text: "Closed on this network", tone: "warn" },
	"no-network": { text: "Not on a network", tone: "warn" },
	"not-answering": { text: "Not answering", tone: "crit" },
};
const ATTENTION_RA = {
	closed: { tone: "warn", title: "This Mac is on a network you have not trusted", body: "Registered devices reach this Mac only on networks you trust.", canTrust: true },
	"no-network": { tone: "warn", title: "This Mac is not on a network", body: "Registered devices reach this Mac only on a trusted network." },
	"not-answering": { tone: "crit", title: "Remote access is on, but this Mac is not answering", body: "Refresh in a minute; if it stays, turn off and on, then reconnect devices." },
};
// the attention row above already says whether this network is trusted
const COUNT_ONLY_VIEWS_RA = new Set(["closed", "no-network", "off-no-network"]);
const CHECKING_LABEL_RA = "Checking network…";
const NETWORK_ERROR_RA = {
	unread: "This Mac's network could not be read; try again.",
	// the re-read after a confirm refusal → the confirm closes, nothing was done
	reread: "Nothing was done: this Mac's network could not be read again.",
};
const ROUTER_LABEL_RA = { wifi: "Router of this Mac's Wi-Fi", wired: "Router of this Mac's wired network", unknown: "Router of this Mac's network" };
const WIDEN_WORDS_RA = {
	on: { title: "Turn on remote access?", lead: "This also trusts this Mac's network; the trust stays after Turn off.", commit: { label: "Turn on and trust", busy: "Turning on…" } },
	"on-trusted": { title: "Turn on remote access?", lead: "This Mac's network is already trusted.", commit: { label: "Turn on", busy: "Turning on…" } },
	trust: { title: "Trust this network?", lead: "Registered devices can then reach this Mac here; the trust stays after Turn off.", commit: { label: "Trust this network", busy: "Trusting…" } },
};

/** Every Mac-only call: the page header and no body; a refusal rejects with its status and the server's error code. */
async function requestRA(url, method = "GET", headers = {}) {
	const res = await fetch(url, { method, headers: { ...PAGE_HEADERS_RA, ...headers } });
	if (res.ok) return res;
	const error = await window.UI.getFetchError(res.clone());
	error.status = res.status;
	error.code = (await res.json().catch(() => null))?.error ?? null;
	throw error;
}

async function readSetupRA() {
	return (await requestRA(URL_RA.SETUP)).json();
}

async function readDevicesRA() {
	return (await requestRA(URL_RA.DEVICES)).json();
}

/** The router a turn-on or trust confirm shows, with the one-use confirm value its act carries back. */
async function readConfirmNetworkRA() {
	return (await requestRA(URL_RA.CONFIRM_NETWORK)).json();
}

/** The certificate as a file named by the server's Content-Disposition (admin-routes.ts → CA_DOWNLOAD). */
async function readCertificateRA() {
	const res = await requestRA(URL_RA.CERTIFICATE);
	const name = window.UI.getAttachmentName(res.headers.get("content-disposition"));
	if (name === null) throw new Error("The certificate download named no file.");
	const blob = await res.blob();
	return new File([blob], name, { type: blob.type });
}

async function readScreenRA() {
	const [setup, { devices }] = await Promise.all([readSetupRA(), readDevicesRA()]);
	return { setup, devices };
}

async function createRegistrationRA() {
	return (await (await requestRA(URL_RA.REGISTRATION, "POST")).json()).code;
}

/** Removes one device; one already gone counts as removed. */
async function deleteDeviceRA(id) {
	try {
		await requestRA(`${URL_RA.DEVICES}/${encodeURIComponent(id)}`, "DELETE");
	} catch (error) {
		if (error.status !== 404) throw error;
	}
}

async function deleteAllDevicesRA() {
	await requestRA(URL_RA.REVOKE_ALL, "POST");
}

/** confirm → the value of the network read the open confirm shows; an off carries none. */
async function postAccessRA(act, confirm = null) {
	await requestRA(ACCESS_URL_RA[act], "POST", confirm === null ? {} : { [CONFIRM_HEADER_RA]: confirm });
}

function getOpenErrorTextRA(error) {
	return OPEN_ERROR_RA[error?.status] ?? "No code was opened; try again.";
}

/** The connect card's progress after one act. */
function putProgressRA(progress, act) {
	return PROGRESS_ACTS_RA[act.type](progress, act);
}

function putOpenStepRA(progress, open, done = progress.done) {
	return { ...progress, open, done, isTroubleOpen: false };
}

function getWidenErrorTextRA(act, error) {
	const words = WIDEN_ERROR_RA[act];
	if (CONFIRM_REFUSALS_RA.has(error?.code)) return words.moved;
	if (error?.code === RESTART_PENDING_REFUSAL_RA) return words.pending;
	return UNKNOWN_STATE_REFUSALS_RA.has(error?.code) ? words.unknown : words.failed;
}

/** A widening answer after which something may stand written → its confirm value is spent, so a second press could only contradict it. */
function isMaybeWrittenRA(error) {
	return error?.code === RESTART_PENDING_REFUSAL_RA || UNKNOWN_STATE_REFUSALS_RA.has(error?.code);
}

function getViewRA(setup) {
	if (!setup.enabled) return setup.hasRouter ? "off" : "off-no-network";
	if (setup.listenReason === "untrusted") return "closed";
	if (setup.listenReason === "identity_unreadable") return "no-network";
	return setup.listenReason === "trusted" && setup.isAnswering ? "on" : "not-answering";
}

/** The foot line; null while off with nothing trusted yet → nothing to act on before the first turn-on. */
function getTrustedLineRA(setup, view) {
	if (!setup.enabled && setup.trustedCount === 0) return null;
	const head = `Trusted networks: ${setup.trustedCount}`;
	if (COUNT_ONLY_VIEWS_RA.has(view)) return head;
	return `${head} · this Mac's network is ${setup.isNetworkTrusted ? "one" : "not one"} of them`;
}

// the setup read names no time for a device's turn-off → the line reads without one
function getOffLineRA(setup) {
	if (!setup.hasRouter) return "Connect this Mac to your network to turn this on.";
	if (setup.isOffByDevice) return "A registered device turned this off; every device was removed.";
	return "Turn on to use this monitor from a phone on your network.";
}

/** The server's colon-joined SHA-256 → four lines of eight pairs, as the device lists them. */
function formatFingerprintRA(value) {
	const pairs = value.toUpperCase().split(":");
	return [0, 8, 16, 24].map((start) => pairs.slice(start, start + 8).join(" "));
}

function formatCodeRA(code) {
	return code.match(/.{1,4}/g).join(" ");
}

/** The device's address slots from its hosts in order; an unreadable host is left out. */
function getAddressesRA(setup, hosts) {
	const [address, second] = hosts.map((key) => setup[key]).filter(Boolean).map((host) => `https://${host}:${setup.port}`);
	return { address, "address-2": second };
}

function canShareFileRA(file) {
	return file !== null && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
}

/**
 * Share sheet where the browser offers one, else a download; a sheet the person closes is no error.
 * @returns true only when the share sheet completed → step 1 finishes by itself; a download moves on by Next
 */
async function sendCertificateRA(file, isShare) {
	if (isShare) {
		return navigator.share({ files: [file] }).then(
			() => true,
			(error) => {
				if (error?.name !== "AbortError") throw error;
				return false;
			},
		);
	}
	const url = URL.createObjectURL(file);
	Object.assign(document.createElement("a"), { href: url, download: file.name }).click();
	setTimeout(() => URL.revokeObjectURL(url), 0);
	return false;
}

// first device → the fold stays as the person left it; back to none → a new key reopens it
function useEmptyKeyRA(count) {
	const ref = useRRA({ key: 0, count });
	if (ref.current.count > 0 && count === 0) ref.current.key += 1;
	ref.current.count = count;
	return ref.current.key;
}

function ScreenRemoteAccess() {
	const [read, setRead] = useSRA({ status: "loading", data: null, error: null, at: null });
	const reload = useCRA(() => {
		setRead((prev) => ({ ...prev, status: "loading" }));
		readScreenRA().then(
			(data) => setRead({ status: "ready", data, error: null, at: new Date().toISOString() }),
			(error) => setRead((prev) => ({ ...prev, status: "failed", error })),
		);
	}, []);
	// a missed poll is retried by the next one; the page's own read reports failures
	const readDevices = useCRA(() => {
		readDevicesRA().then(({ devices }) => setRead((prev) => (prev.data ? { ...prev, data: { ...prev.data, devices } } : prev)), () => undefined);
	}, []);
	useERA(() => reload(), [reload]);
	return <RemoteAccessPageRA read={read} onReload={reload} onDevicesRead={readDevices} />;
}

function RemoteAccessPageRA({ read, onReload, onDevicesRead }) {
	const { TypeScaleStyle } = window.UI;
	const [dialog, setDialog] = useSRA(null);
	const [check, setCheck] = useSRA({ act: null, error: null });
	// the read in flight, on a ref → two calls before the next render still start one read, so a commit is never released early
	const isReadingRef = useRRA(false);
	const data = read.data;
	const view = data ? getViewRA(data.setup) : null;
	// isReread → the open confirm's own read after a refusal: a confirm cancelled meanwhile stays closed, one it cannot show again closes with E-16
	const onWiden = (act, isReread = false) => {
		if (isReadingRef.current) return;
		isReadingRef.current = true;
		setCheck({ act, error: null });
		// a first read lands only on a page with no confirm, a re-read only in its own act's → never under a press meant for another confirm
		const isOwnDialog = (open) => (isReread ? open?.act === act : open === null);
		readConfirmNetworkRA().then(
			(network) => {
				isReadingRef.current = false;
				const canConfirm = network.router !== null && !(act === "trust" && network.isNetworkTrusted);
				setCheck({ act: null, error: !canConfirm && isReread ? { act, text: NETWORK_ERROR_RA.reread } : null });
				setDialog((open) => (isOwnDialog(open) ? (canConfirm ? { act, network } : null) : open));
				if (!canConfirm) onReload();
			},
			(error) => {
				isReadingRef.current = false;
				setDialog((open) => (isOwnDialog(open) ? null : open));
				setCheck({ act: null, error: { act, text: NETWORK_ERROR_RA[isReread ? "reread" : "unread"], detail: error.message } });
			},
		);
	};
	// held while a network read runs → its confirm never opens in their place
	const onEnd = (act) => {
		if (!isReadingRef.current) setDialog({ act });
	};
	// the confirm closes on an answer that may have written → its words stay on the page over a fresh read
	const onMaybeWritten = (error) => {
		setDialog(null);
		setCheck({ act: null, error });
		onReload();
	};
	const onDone = () => {
		setCheck((prev) => ({ ...prev, error: null }));
		onReload();
	};
	return (
		<div className="flex flex-col gap-section">
			<TypeScaleStyle />
			<HeaderRA read={read} view={view} checkingAct={check.act} onReload={onReload} onWiden={onWiden} onOff={() => onEnd("off")} />
			{data === null
				? <FirstReadRA read={read} onRetry={onReload} />
				: <BodyRA setup={data.setup} devices={data.devices} view={view} check={check} onWiden={onWiden} onChanged={onReload} onDevicesRead={onDevicesRead} onRemoveAll={() => onEnd("remove-all")} />}
			{dialog && <AccessDialogRA dialog={dialog} count={data?.devices.length ?? 0} isChecking={check.act !== null}
				onRecheck={() => onWiden(dialog.act, true)} onClose={() => setDialog(null)} onDone={onDone} onMaybeWritten={onMaybeWritten} />}
		</div>
	);
}

function HeaderRA({ read, view, checkingAct, onReload, onWiden, onOff }) {
	const { PageHeader, FreshnessStamp, RefreshButton, Badge, QuietButton } = window.UI;
	const isBusy = read.status === "loading";
	const status = view && STATUS_RA[view];
	const turnOn = view === "off" && (
		<button type="button" className="btn primary" aria-busy={checkingAct === "on" || undefined} onClick={() => onWiden("on")}>
			{checkingAct === "on" ? CHECKING_LABEL_RA : "Turn on"}
		</button>
	);
	return (
		<PageHeader title="Remote access"
			status={status && <Badge role="status" tone={status.tone} glyph={status.tone !== "neutral"}>{status.text}</Badge>}
			actions={read.data?.setup.enabled && <QuietButton onClick={onOff}>Turn off</QuietButton>}
			primary={turnOn}
			freshness={<FreshnessStamp at={read.at} loading={isBusy} failed={read.status === "failed"} />}
			refresh={<RefreshButton isBusy={isBusy} hasRead={read.data !== null} onRefresh={onReload} label="Refresh remote access" />} />
	);
}

function FirstReadRA({ read, onRetry }) {
	const { Card, LoadingPlaceholder, RegionUnavailable } = window.UI;
	return (
		<Card>
			{read.status === "failed"
				? <RegionUnavailable source="Remote access" error={read.error} onRetry={onRetry} />
				: <LoadingPlaceholder label="remote access" minHeight={96} />}
		</Card>
	);
}

function BodyRA({ setup, devices, view, check, onWiden, onChanged, onDevicesRead, onRemoveAll }) {
	const emptyKey = useEmptyKeyRA(devices.length);
	// held over the card → a read that briefly finds the Mac not answering does not lose the person's place
	const [progress, setProgress] = useSRA(null);
	const onAct = useCRA((act) => setProgress((current) => putProgressRA(current, act)), []);
	// access turned off → every device went with it, so the procedure starts over
	if (!setup.enabled && progress !== null) setProgress(null);
	const line = getTrustedLineRA(setup, view);
	const foot = line && <span className="tabular-nums">{line}</span>;
	const hasDevicesCard = setup.enabled || devices.length > 0;
	const checkError = (act) => (check.error?.act === act ? check.error : null);
	return (
		<>
			{!setup.enabled && <OffCardRA setup={setup} foot={hasDevicesCard ? null : foot} error={checkError("on")} />}
			{setup.enabled && checkError("on") && <ActErrorRA error={checkError("on")} />}
			{view === "on" && <ConnectCardRA key={emptyKey} setup={setup} devices={devices} progress={progress} onAct={onAct} onDevicesRead={onDevicesRead} />}
			{ATTENTION_RA[view]
				? <AttentionRA row={ATTENTION_RA[view]} isChecking={check.act === "trust"} error={checkError("trust")} onTrust={() => onWiden("trust")} />
				: checkError("trust") && <ActErrorRA error={checkError("trust")} />}
			{hasDevicesCard && <DevicesCardRA devices={devices} limit={setup.deviceLimit} foot={foot} onChanged={onChanged} onRemoveAll={onRemoveAll} />}
		</>
	);
}

function OffCardRA({ setup, foot, error }) {
	const { Card, EmptyState } = window.UI;
	return (
		<Card foot={foot}>
			<EmptyState message={getOffLineRA(setup)} />
			{error && <ActErrorRA error={error} />}
		</Card>
	);
}

function AttentionRA({ row, isChecking, error, onTrust }) {
	const { AlertCard } = window.UI;
	const trust = row.canTrust && (
		<button type="button" className="btn primary" aria-busy={isChecking || undefined} onClick={onTrust}>
			{isChecking ? CHECKING_LABEL_RA : "Trust this network"}
		</button>
	);
	return (
		<>
			<AlertCard tone={row.tone} surface="raised" title={row.title} body={row.body} actions={trust} />
			{error && <ActErrorRA error={error} />}
		</>
	);
}

function ActErrorRA({ error }) {
	const { TONE_GLYPH, ErrorDetails } = window.UI;
	return (
		<div role="alert" className="flex flex-col gap-label">
			<p className="fs-body text-ink"><span className="text-crit" aria-hidden="true">{TONE_GLYPH.crit}</span> {error.text}</p>
			<ErrorDetails detail={error.detail} />
		</div>
	);
}

function ConnectCardRA({ setup, devices, progress, onAct, onDevicesRead }) {
	const { Disclosure } = window.UI;
	return (
		<Disclosure kind={devices.length === 0 ? "status" : "detail"} title="Connect a device">
			<ConnectBodyRA setup={setup} devices={devices} progress={progress} onAct={onAct} onDevicesRead={onDevicesRead} />
		</Disclosure>
	);
}

// a finished card stays as it is at the limit → the device the person just connected is not hidden under the limit line
function ConnectBodyRA({ setup, devices, progress, onAct, onDevicesRead }) {
	const isFinished = progress?.open === null;
	if (!isFinished && devices.length >= setup.deviceLimit) {
		return <p className="fs-body text-dim">{`${devices.length} of ${setup.deviceLimit} devices registered; remove one to connect another.`}</p>;
	}
	if (progress === null) return <DeviceChoiceRA onAct={onAct} />;
	return <ProcedureRA setup={setup} devices={devices} progress={progress} onAct={onAct} onDevicesRead={onDevicesRead} />;
}

function DeviceChoiceRA({ onAct }) {
	const { Stack, Cluster } = window.UI;
	return (
		<Stack gap="stack">
			<p className="fs-body text-ink">Which device are you connecting?</p>
			<Cluster>
				{Object.entries(STEPS_RA).map(([device, { name }]) => (
					<button key={device} type="button" className="btn" onClick={() => onAct({ type: "choose", device })}>{name}</button>
				))}
			</Cluster>
		</Stack>
	);
}

function ProcedureRA({ setup, devices, progress, onAct, onDevicesRead }) {
	const { Stack, QuietButton, TONE_GLYPH } = window.UI;
	const { name, steps } = STEPS_RA[progress.device];
	const isFinished = progress.open === null;
	return (
		<Stack gap="block">
			<div className="flex items-center justify-between fs-meta text-dim">
				<span>{isFinished ? `All ${steps.length} steps done · ${name}` : `Step ${progress.open + 1} of ${steps.length} · ${name}`}</span>
				{!isFinished && <QuietButton onClick={() => onAct({ type: "change" })}>Change device</QuietButton>}
			</div>
			<StepListRA setup={setup} devices={devices} progress={progress} onAct={onAct} onDevicesRead={onDevicesRead} />
			{isFinished && (
				<Stack gap="stack" className="items-start">
					<p className="fs-body text-ink"><span className="text-ok">{TONE_GLYPH.ok}</span> {`“${progress.label}” is connected.`}</p>
					<button type="button" className="btn" onClick={() => onAct({ type: "change" })}>Connect another device</button>
				</Stack>
			)}
		</Stack>
	);
}

function StepListRA({ setup, devices, progress, onAct, onDevicesRead }) {
	const { QuietButton, TONE_GLYPH } = window.UI;
	const titleRef = useRRA(null);
	// a step opened by a press or by finishing → focus follows to its title
	useERA(() => titleRef.current?.focus(), [progress.open]);
	const { steps } = STEPS_RA[progress.device];
	return (
		<ol className="flex flex-col gap-list">
			{steps.map((step, i) => (
				<li key={step.title}>
					{i === progress.open
						? <OpenStepRA step={step} index={i} setup={setup} devices={devices} progress={progress} titleRef={titleRef} onAct={onAct} onDevicesRead={onDevicesRead} />
						: progress.done[i]
							? <QuietButton onClick={() => onAct({ type: "reopen", index: i })}><span className="text-ok">{TONE_GLYPH.ok}</span> <span className="text-ink">{step.title}</span></QuietButton>
							: <span className="fs-body text-faint">{i + 1} {step.title}</span>}
				</li>
			))}
		</ol>
	);
}

function OpenStepRA({ step, index, setup, devices, progress, titleRef, onAct, onDevicesRead }) {
	const { Stack, Cluster, QuietButton } = window.UI;
	const { hosts, steps } = STEPS_RA[progress.device];
	const values = getAddressesRA(setup, hosts);
	return (
		<Stack gap="stack">
			<p ref={titleRef} tabIndex={-1} aria-current="step" className="fs-body font-medium text-ink">{index + 1} {step.title}</p>
			<Stack gap="block">
				<Stack gap="label" className="items-start">
					<StepBodyRA step={step} setup={setup} devices={devices} address={values.address} onAct={onAct} onDevicesRead={onDevicesRead} />
					<TroubleRA rows={step.trouble} values={values} isOpen={progress.isTroubleOpen} scanStep={steps.length} onAct={onAct} />
				</Stack>
				<Cluster>
					{index > 0 && <QuietButton onClick={() => onAct({ type: "back" })}>Back</QuietButton>}
					{step.kind !== "scan" && <button type="button" className="btn" onClick={() => onAct({ type: "next" })}>Next</button>}
				</Cluster>
			</Stack>
		</Stack>
	);
}

function StepBodyRA({ step, setup, devices, address, onAct, onDevicesRead }) {
	const { MachineString } = window.UI;
	if (step.kind === "send") return <CertificateStepRA line={step.line} onSent={() => onAct({ type: "sent" })} />;
	const lead = step.path ? <PathRA path={step.path} /> : <p className="fs-body text-dim">{step.line}</p>;
	if (step.kind === "fingerprint") {
		return (
			<>
				{lead}
				{setup.fingerprint
					? <MachineString className="block fs-meta text-ink">{formatFingerprintRA(setup.fingerprint).map((line) => <span key={line} className="block">{line}</span>)}</MachineString>
					: <ActErrorRA error={{ text: "Fingerprint not shown; refresh this page before installing." }} />}
			</>
		);
	}
	if (step.kind !== "scan") return lead;
	return (
		<>
			{lead}
			{address && <QrCodeRA text={address} />}
			<CodeStepRA devices={devices} onConnected={(label) => onAct({ type: "connected", label })} onDevicesRead={onDevicesRead} />
		</>
	);
}

/** The device's address as a QR code, drawn in the page; no encoder on the page → the address as text. */
function QrCodeRA({ text }) {
	const { MachineString } = window.UI;
	if (typeof window.qrcode !== "function") return <ValueRA label="Address"><MachineString className="fs-body text-ink">{text}</MachineString></ValueRA>;
	const qr = window.qrcode(0, "M");
	qr.addData(text);
	qr.make();
	const size = qr.getModuleCount() + QR_RA.QUIET * 2;
	return (
		<svg role="img" aria-label={`QR code for ${text}`} width={size * QR_RA.MODULE_PX} height={size * QR_RA.MODULE_PX} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges">
			<rect width={size} height={size} style={QR_RA.FIELD} />
			<path d={getQrPathRA(qr)} style={QR_RA.MODULE} />
		</svg>
	);
}

// one unit square per dark module, offset by the quiet zone
function getQrPathRA(qr) {
	const count = qr.getModuleCount();
	const squares = [];
	for (let row = 0; row < count; row++) {
		for (let col = 0; col < count; col++) if (qr.isDark(row, col)) squares.push(`M${col + QR_RA.QUIET} ${row + QR_RA.QUIET}h1v1h-1z`);
	}
	return squares.join("");
}

// a Settings path: the labels in the mono face, the separators in dim
function PathRA({ path }) {
	const { MachineString } = window.UI;
	return (
		<MachineString className="fs-body text-ink">
			{path.split(PATH_SEPARATOR_RA).map((label, i) => (
				<React.Fragment key={label}>{i > 0 && <span className="text-dim">{PATH_SEPARATOR_RA}</span>}{label}</React.Fragment>
			))}
		</MachineString>
	);
}

function ValueRA({ label, children }) {
	return (
		<div className="flex flex-col">
			<span className="fs-meta text-dim">{label}</span>
			{children}
		</div>
	);
}

function TroubleRA({ rows, values, isOpen, scanStep, onAct }) {
	const { Stack, DisclosureButton, QuietButton } = window.UI;
	const lines = rows.filter((row) => row.text.split(SLOT_RA).every((part) => !SLOT_RA.test(part) || values[part.slice(1, -1)]));
	if (lines.length === 0) return null;
	return (
		<Stack gap="label">
			<DisclosureButton isOpen={isOpen} onToggle={() => onAct({ type: "trouble" })} label="Trouble?" />
			{isOpen && lines.map((row) => (
				<p key={row.text} className="fs-meta text-dim">
					<TroubleTextRA text={row.text} values={values} />
					{row.isJump && <> <QuietButton onClick={() => onAct({ type: "jump" })}>{`Go to step ${scanStep}`}</QuietButton></>}
				</p>
			))}
		</Stack>
	);
}

function TroubleTextRA({ text, values }) {
	const { MachineString } = window.UI;
	return <>{text.split(SLOT_RA).map((part) => (SLOT_RA.test(part) ? <MachineString key={part} className="text-ink">{values[part.slice(1, -1)]}</MachineString> : part))}</>;
}

function CertificateStepRA({ line, onSent }) {
	const [cert, setCert] = useSRA({ file: null, isSending: false, error: null });
	const isShare = canShareFileRA(cert.file);
	// read ahead → the share sheet opens inside the click, which a browser requires
	useERA(() => {
		readCertificateRA().then((file) => setCert((prev) => ({ ...prev, file })), () => undefined);
	}, []);
	const onSend = () => {
		if (cert.isSending) return;
		setCert((prev) => ({ ...prev, isSending: true, error: null }));
		const file = cert.file ? Promise.resolve(cert.file) : readCertificateRA();
		file.then((value) => sendCertificateRA(value, isShare)).then(
			(isSent) => {
				setCert((prev) => ({ ...prev, isSending: false }));
				if (isSent) onSent();
			},
			(error) => setCert((prev) => ({ ...prev, isSending: false, error: { text: "The certificate was not sent; try again.", detail: error.message } })),
		);
	};
	return (
		<>
			<p className="fs-body text-dim">{isShare ? line.share : line.download}</p>
			<button type="button" className="btn" aria-busy={cert.isSending || undefined} onClick={onSend}>{isShare ? "Share certificate…" : "Download certificate"}</button>
			{cert.error && <ActErrorRA error={cert.error} />}
		</>
	);
}

function CodeStepRA({ devices, onConnected, onDevicesRead }) {
	const [state, setState] = useSRA({ status: "idle" });
	const knownRef = useRRA(new Set());
	useERA(() => {
		if (state.status !== "open") return;
		const added = devices.find((device) => !knownRef.current.has(device.id));
		if (added) onConnected(added.label);
	}, [devices, state.status, onConnected]);
	useERA(() => {
		if (state.status !== "open") return undefined;
		const expiry = setTimeout(() => setState({ status: "expired" }), Date.parse(state.expiresAt) - Date.now());
		const poll = setInterval(onDevicesRead, DEVICE_POLL_MS_RA);
		return () => {
			clearTimeout(expiry);
			clearInterval(poll);
		};
	}, [state.status, state.expiresAt, onDevicesRead]);
	const onOpen = () => {
		if (state.status === "opening") return;
		knownRef.current = new Set(devices.map((device) => device.id));
		setState({ status: "opening" });
		createRegistrationRA().then(
			(code) => setState({ status: "open", code, expiresAt: new Date(Date.now() + CODE_WINDOW_MS_RA).toISOString() }),
			(error) => setState({ status: "idle", error: { text: getOpenErrorTextRA(error), detail: error.message } }),
		);
	};
	return <CodeViewRA state={state} onOpen={onOpen} />;
}

function CodeViewRA({ state, onOpen }) {
	const { MachineString, formatKstTime } = window.UI;
	const isOpen = state.status === "open";
	return (
		<>
			{isOpen && (
				<ValueRA label="Code">
					<MachineString className="fs-stat font-semibold text-ink">{formatCodeRA(state.code)}</MachineString>
					<span className="fs-meta text-dim">{`One use · valid until ${formatKstTime(state.expiresAt)}`}</span>
				</ValueRA>
			)}
			{state.status === "expired" && <p className="fs-body text-dim">That code expired; show a new one.</p>}
			<button type="button" className="btn" aria-busy={state.status === "opening" || undefined} onClick={onOpen}>{state.status === "opening" ? "Opening…" : "Show a new code"}</button>
			{state.error && <ActErrorRA error={state.error} />}
		</>
	);
}

function DevicesCardRA({ devices, limit, foot, onChanged, onRemoveAll }) {
	const { Card, EmptyState, QuietButton } = window.UI;
	const [act, setAct] = useSRA({ pendingId: null, error: null });
	const onRemove = (device) => {
		if (act.pendingId !== null) return;
		setAct({ pendingId: device.id, error: null });
		deleteDeviceRA(device.id)
			.then(
				() => setAct({ pendingId: null, error: null }),
				(error) => setAct({ pendingId: null, error: { text: `“${device.label}” was not removed; try again.`, detail: error.message } }),
			)
			.finally(onChanged);
	};
	const removeAll = devices.length >= 2 && <QuietButton onClick={onRemoveAll}>Remove all</QuietButton>;
	const hasTable = devices.length > 0;
	// flush only under the table → its edge cells take the card padding; the error line under it insets itself
	return (
		<Card title="Registered devices" sub={`${devices.length} of ${limit}`} right={removeAll} foot={foot} isFlush={hasTable}>
			{hasTable
				? <DeviceTableRA devices={devices} pendingId={act.pendingId} onRemove={onRemove} />
				: <EmptyState message="No device registered" hint="A device appears here once it registers." />}
			{act.error && <div className={hasTable ? "p-card-pad" : undefined}><ActErrorRA error={act.error} /></div>}
		</Card>
	);
}

function DeviceTableRA({ devices, pendingId, onRemove }) {
	const { Table, TableRow, TableCell, AbsentValue, formatKstDateTime } = window.UI;
	return (
		<Table caption="Registered devices" columns={DEVICE_COLUMNS_RA} widths={DEVICE_WIDTHS_RA}>
			{devices.map((device) => (
				<TableRow key={device.id}>
					<TableCell kind="row-header">{device.label}</TableCell>
					<TableCell>{formatKstDateTime(device.createdAt)}</TableCell>
					<TableCell>{device.lastSeenAt ? formatKstDateTime(device.lastSeenAt) : <AbsentValue kind="none" />}</TableCell>
					<TableCell isNumeric>
						<button type="button" className="btn sm" style={DESTRUCTIVE_STYLE_RA} aria-label={`Remove ${device.label}`}
							aria-busy={pendingId === device.id || undefined} onClick={() => onRemove(device)}>
							{pendingId === device.id ? "Removing…" : "Remove"}
						</button>
					</TableCell>
				</TableRow>
			))}
		</Table>
	);
}

/** The open confirm's act: a widening act whose network moved stays open, its commit held until the page's fresh read is on screen. */
function AccessDialogRA({ dialog, count, isChecking, onRecheck, onClose, onDone, onMaybeWritten }) {
	const [act, setAct] = useSRA({ isBusy: false, error: null });
	const isWiden = dialog.act === "on" || dialog.act === "trust";
	const onCommit = () => {
		if (act.isBusy || isChecking) return;
		setAct({ isBusy: true, error: null });
		const run = dialog.act === "remove-all" ? deleteAllDevicesRA() : postAccessRA(dialog.act, isWiden ? dialog.network.confirm : null);
		run.then(
			() => {
				onClose();
				onDone();
			},
			(error) => {
				const text = isWiden ? getWidenErrorTextRA(dialog.act, error) : END_ERROR_RA[dialog.act];
				if (isWiden && isMaybeWrittenRA(error)) {
					onMaybeWritten({ act: dialog.act, text, detail: error.message });
					return;
				}
				setAct({ isBusy: false, error: { text, detail: error.message } });
				if (isWiden && CONFIRM_REFUSALS_RA.has(error.code)) onRecheck();
			},
		);
	};
	const props = { isBusy: act.isBusy, error: act.error, onCommit, onCancel: onClose };
	// keyed on the confirm value → a re-read's network mounts a fresh confirm, focus back on Cancel
	return isWiden ? <WidenConfirmRA key={dialog.network.confirm} act={dialog.act} network={dialog.network} isChecking={isChecking} {...props} /> : <EndConfirmRA act={dialog.act} count={count} {...props} />;
}

function WidenConfirmRA({ act, network, isChecking, isBusy, error, onCommit, onCancel }) {
	const { DetailField } = window.UI;
	const words = WIDEN_WORDS_RA[act === "on" && network.isNetworkTrusted ? "on-trusted" : act];
	const commit = isChecking ? { ...words.commit, busy: CHECKING_LABEL_RA } : words.commit;
	return (
		<ConfirmRA title={words.title} commit={commit} isBusy={isBusy || isChecking} error={error} onCommit={onCommit} onCancel={onCancel}>
			<p className="fs-body text-ink">{words.lead}</p>
			<div className="flex flex-col gap-label">
				<DetailField label={ROUTER_LABEL_RA[network.link] ?? ROUTER_LABEL_RA.unknown} value={network.router} mono />
				<p className="fs-meta text-dim">Match it with “Router” in your phone's Wi-Fi details; if different, choose Cancel.</p>
			</div>
			<p className="fs-body text-ink">Trust only a network you control: it does not check who else joins.</p>
		</ConfirmRA>
	);
}

function EndConfirmRA({ act, count, isBusy, error, onCommit, onCancel }) {
	const isOff = act === "off";
	const title = isOff ? "Turn off remote access?" : `Remove all ${count} devices?`;
	const commit = isOff ? { label: "Turn off", busy: "Turning off…" } : { label: "Remove all devices", busy: "Removing…" };
	return (
		<ConfirmRA title={title} commit={commit} isDestructive isBusy={isBusy} error={error} onCommit={onCommit} onCancel={onCancel}>
			<p className="fs-body text-ink">{isOff ? getOffBodyRA(count) : "Each device must scan a new code to connect again."}</p>
		</ConfirmRA>
	);
}

function getOffBodyRA(count) {
	if (count === 0) return "This Mac stops answering other devices; trusted networks stay trusted.";
	if (count === 1) return "This removes 1 registered device; trusted networks stay trusted.";
	return `This removes ${count} registered devices; trusted networks stay trusted.`;
}

function ConfirmRA({ title, commit, isDestructive = false, isBusy, error, onCommit, onCancel, children }) {
	const { DetailSurface } = window.UI;
	const cancelRef = useRRA(null);
	// runs after DetailSurface's own mount focus (a parent's effect follows its child's) → Enter never commits by reflex
	useERA(() => cancelRef.current?.focus(), []);
	const footer = (
		<>
			<button ref={cancelRef} type="button" className="btn ghost sm" onClick={onCancel}>Cancel</button>
			<button type="button" className={isDestructive ? "btn sm" : "btn primary sm"} style={isDestructive ? DESTRUCTIVE_STYLE_RA : undefined}
				aria-busy={isBusy || undefined} onClick={onCommit}>{isBusy ? commit.busy : commit.label}</button>
		</>
	);
	return (
		<DetailSurface open variant="confirm" title={title} onClose={onCancel} footer={footer} suppressOutsideClose>
			<div className="flex flex-col gap-block">
				{children}
				{error && <ActErrorRA error={error} />}
			</div>
		</DetailSurface>
	);
}

window.ScreenRemoteAccess = ScreenRemoteAccess;
