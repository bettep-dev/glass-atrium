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
// Device takes the slack; the dates and Remove hug their text (spec 44105 → Layout → Registered devices)
const DEVICE_WIDTHS_RA = [undefined, "1%", "1%", "1%"];
const DESTRUCTIVE_STYLE_RA = { color: "rgb(var(--crit))", borderColor: "rgb(var(--crit))", background: "transparent" };

// spec 44105 → Galaxy phone: GX-25 stands in the fold of both path steps
const SEARCH_LINE_RA = { text: "Different names on your phone? Search Settings for “certificate”." };
/**
 * The connect procedure per device (spec 44105 → Connect a device): a title, one line or one Settings path, at most three Trouble? lines.
 * hosts → the setup facts that make {address}, then {address-2} · fileName → the certificate's name on that device, null → the served name.
 * jump → the step a phone already set up opens on · lockedStep → opens only through the compare step's forward control.
 * compare → the field name the phone shows over the fingerprint, the forward control, the line in the fingerprint's place when none is read.
 * isTyped → the last step shows the address and the code first, the QR code beside them.
 * stop → a line the security ruling keeps visible beside the step's value, never behind Trouble? · isQrOnly → a fold line shown only beside a drawn QR code.
 * isCodeOnly → a fold line shown only while a code is open (G5: the typed values in step 5, only beside an open code).
 * kind installer → a phone step whose path ends at the phone's installer, so it names no certificate.
 */
const DEVICE_RA = {
	iphone: {
		name: "iPhone or iPad",
		hosts: ["hostName", "address"],
		fileName: null,
		jump: 4,
		lockedStep: null,
		isTyped: false,
		compare: { label: "SHA-256", next: "Next", missing: "Fingerprint not shown; refresh this page before installing." },
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
				stop: "If lines differ, remove the profile and never turn on full trust.",
				trouble: [{ text: "No lines before installing? Install, then check General › VPN & Device Management." }],
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
				title: "Scan, name the device, tap Register",
				line: "Close any page that says “This Connection Is Not Private”.",
				trouble: [{ text: "Camera does nothing? Open this in Safari: {address}" }, { text: "Then type this code: {code}" }, { text: "Still nothing? Try: {address-2}" }],
			},
		],
	},
	// installs before it compares (Android shows the fingerprint only once installed) → install and compare are adjacent, the address only after the compare
	// SECURITY: release gate G8 open — unmeasured on a phone; no release may carry this entry before galaxy-build-record.md → S8 phone record is filled and read by security.
	galaxy: {
		name: "Galaxy phone",
		hosts: ["address", "hostName"],
		// PEM text under the extension Android's installer takes · the served bytes unchanged
		fileName: "Glass Atrium Local CA.cer",
		jump: 3,
		lockedStep: 4,
		isTyped: true,
		compare: { label: "SHA-256 fingerprint", next: "Lines match", missing: "Fingerprint not shown; refresh this page, then compare." },
		steps: [
			{
				kind: "send",
				title: "Send the certificate to your phone",
				line: { share: "Email or message it to yourself, then save it on your phone.", download: "From Downloads, send “Glass Atrium Local CA” to yourself; save it on your phone." },
				trouble: [{ text: "Set up this phone before?", isJump: true }, { text: "Tapping it did not install? Save it only; step 3 installs it." }],
			},
			{
				kind: "installer",
				title: "Open the certificate installer",
				path: "Settings › Security and privacy › More security settings › Install from device storage",
				trouble: [SEARCH_LINE_RA, { text: "Older phone? Settings › Biometrics and security › Other security settings" }],
			},
			{
				kind: "phone",
				title: "Install it as a CA certificate",
				line: "Tap CA certificate, then Install anyway, then pick “Glass Atrium Local CA”.",
				trouble: [
					{ text: "Asked for your screen lock? Enter it, or set one and repeat." },
					{ text: "File not listed? Open Downloads in the picker, or repeat step 1." },
					{ text: "Install refused? Use the phone's main Settings, not Secure Folder." },
				],
			},
			{
				kind: "fingerprint",
				title: "Match the fingerprint right after installing",
				path: "Settings › Security and privacy › More security settings › Trusted credentials › User › Glass Atrium Local CA",
				// a missing fingerprint leaves the same unproven CA as a mismatch → one visible stop for both
				stop: "Lines differ or missing? Tap Remove now; do not scan or open the address.",
				trouble: [SEARCH_LINE_RA, { text: "Not listed under User? Repeat step 3; never press Lines match." }, { text: "“Network may be monitored” notice? It stays while the certificate is installed." }],
			},
			{
				kind: "scan",
				title: "Open the address, enter the code",
				line: "In Chrome, type the address, https:// included.",
				trouble: [
					{ text: "Page will not open? Try: {address-2}", isCodeOnly: true },
					{ text: "Camera does nothing? Type the address and the code instead.", isQrOnly: true },
					{ text: "Warning in Chrome? Close the page, then repeat step 4." },
				],
			},
		],
	},
};
// the step bodies' own words beside the step table → the card's word caps count them too · {time} → the code's expiry
const STEP_TEXT_RA = {
	// read beside a glyph → a mark never rests on its shape or colour alone
	mark: { done: "Done:", warn: "Warning:" },
	certificate: { share: "Share certificate…", download: "Download certificate", failed: "The certificate was not sent; try again." },
	code: {
		label: "Code",
		address: "Address",
		scan: "Or scan with Camera",
		validUntil: "One use · valid until {time}",
		renew: "Show a new code",
		expired: "That code expired; show a new one.",
		opening: "Opening…",
		open: { qr: "Show QR code", typed: "Show address and code" },
		openFailed: "No code was opened; try again.",
	},
};
// a Trouble? line's value slot → its value; a line whose value is missing is left out
const SLOT_RA = /(\{[a-z0-9-]+\})/;
const PATH_SEPARATOR_RA = " › ";
// routes.ts → SIGN_IN_FILES serves the page itself; sign-in.js reads the one fragment key → one scan fills the code
const SIGN_IN_RA = { PATH: "/sign-in.html", FRAGMENT: "#code=" };
// spec 44105 → The QR drawing: 4 CSS px a module, a 4-module quiet zone, modules in elev on an ink field (16.74:1)
// LABEL names the image, never its payload → the address and code are read only beside it as text
const QR_RA = { MODULE_PX: 4, QUIET: 4, FIELD: { fill: "rgb(var(--ink))" }, MODULE: { fill: "rgb(var(--elev))" }, LABEL: "QR code for the sign-in page with this code" };

// null → the device choice on first render · CHOICE → the choice reached by a way back, the question taking focus · open null → every step done
const CHOICE_PROGRESS_RA = { device: null, isReturned: true };
const PROGRESS_ACTS_RA = {
	choose: (_, act) => ({ device: act.device, open: 0, done: DEVICE_RA[act.device].steps.map(() => false), isTroubleOpen: false, label: null }),
	// Change device and Connect another device → every mark dropped, so one device's progress never opens another's step
	restart: () => CHOICE_PROGRESS_RA,
	// hasFingerprint → the compare step moves on only with a fingerprint on screen (ruling B5)
	next: (progress, act) => {
		if (!act.hasFingerprint && getCompareStepRA(progress) === progress.open) return progress;
		return putOpenStepRA(progress, progress.open + 1, progress.done.map((isDone, i) => isDone || i === progress.open));
	},
	// the share sheet completes after the person may have moved on → only step 1 still open moves
	sent: (progress, act) => (progress.open === 0 ? PROGRESS_ACTS_RA.next(progress, act) : progress),
	back: (progress) => putOpenStepRA(progress, progress.open - 1),
	// the locked step → only once the compare step is done, so no way round the match opens it
	reopen: (progress, act) => {
		const isLocked = act.index === DEVICE_RA[progress.device].lockedStep && !progress.done[getCompareStepRA(progress)];
		return isLocked ? progress : putOpenStepRA(progress, act.index);
	},
	// a phone that already holds the certificate → the device's own jump step, every step before it done
	jump: (progress) => {
		const { jump } = DEVICE_RA[progress.device];
		return putOpenStepRA(progress, jump, progress.done.map((_, i) => i < jump));
	},
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

/**
 * The certificate as a file named by the server's Content-Disposition (admin-routes.ts → CA_DOWNLOAD).
 * @param fileName - the device's own fixed name for the same bytes; null → the served name
 */
async function readCertificateRA(fileName = null) {
	const res = await requestRA(URL_RA.CERTIFICATE);
	const name = window.UI.getAttachmentName(res.headers.get("content-disposition"));
	if (name === null) throw new Error("The certificate download named no file.");
	const blob = await res.blob();
	return new File([blob], fileName ?? name, { type: blob.type });
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
	return OPEN_ERROR_RA[error?.status] ?? STEP_TEXT_RA.code.openFailed;
}

/** The connect card's progress after one act; null → no device chosen yet. */
function putProgressRA(progress, act) {
	return PROGRESS_ACTS_RA[act.type](progress, act);
}

function putOpenStepRA(progress, open, done = progress.done) {
	return { ...progress, open, done, isTroubleOpen: false };
}

function getCompareStepRA(progress) {
	return DEVICE_RA[progress.device].steps.findIndex((step) => step.kind === "fingerprint");
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

function hasQrEncoderRA() {
	return typeof window.qrcode === "function";
}

// the one owner of "a QR code is drawn" → the code view draws it, the fold's Camera line follows it
function isQrDrawnRA(state, address) {
	return state.status === "open" && Boolean(address) && hasQrEncoderRA();
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
			{/* the action slot → under the off line at --gap-label, on its column */}
			<EmptyState message={getOffLineRA(setup)} action={error && <ActErrorRA error={error} />} />
		</Card>
	);
}

function AttentionRA({ row, isChecking, error, onTrust }) {
	const { AlertCard } = window.UI;
	const trust = row.canTrust && (
		<button type="button" className="btn primary sm" aria-busy={isChecking || undefined} onClick={onTrust}>
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
		<Disclosure kind={devices.length === 0 ? "status" : "detail"} title="Connect a device" isFlush={Boolean(progress?.device) && !isAtLimitRA(setup, devices, progress)}>
			<ConnectBodyRA setup={setup} devices={devices} progress={progress} onAct={onAct} onDevicesRead={onDevicesRead} />
		</Disclosure>
	);
}

// a finished card stays as it is at the limit → the device the person just connected is not hidden under the limit line
function isAtLimitRA(setup, devices, progress) {
	return progress?.open !== null && devices.length >= setup.deviceLimit;
}

function ConnectBodyRA({ setup, devices, progress, onAct, onDevicesRead }) {
	const { EmptyState } = window.UI;
	if (isAtLimitRA(setup, devices, progress)) {
		return <EmptyState message={`${devices.length} of ${setup.deviceLimit} devices registered; remove one to connect another.`} />;
	}
	if (!progress?.device) return <DeviceChoiceRA isReturned={progress?.isReturned === true} onAct={onAct} />;
	return <ProcedureRA setup={setup} devices={devices} progress={progress} onAct={onAct} onDevicesRead={onDevicesRead} />;
}

// one question, two equal answers acting at once → no primary · nothing takes focus on first render
// stacked at one width → no button lies where a step-1 control lands, so a double-click presses nothing there
function DeviceChoiceRA({ isReturned, onAct }) {
	const { Stack } = window.UI;
	const questionRef = useRRA(null);
	useERA(() => {
		if (isReturned) questionRef.current?.focus();
	}, [isReturned]);
	return (
		<Stack gap="label" className="items-start">
			<h3 ref={questionRef} tabIndex={-1} className="ra-pane-title fs-title font-semibold text-ink">Which device are you connecting?</h3>
			<div className="flex flex-col gap-control">
				{Object.entries(DEVICE_RA).map(([key, device]) => (
					<button key={key} type="button" className="btn" onClick={() => onAct({ type: "choose", device: key })}>{device.name}</button>
				))}
			</div>
		</Stack>
	);
}

// the rail shows where the person is, the pane what to do now · the grid sits inside the container its query sizes
function ProcedureRA({ setup, devices, progress, onAct, onDevicesRead }) {
	const device = DEVICE_RA[progress.device];
	return (
		<div className="ra-procedure">
			<div className="ra-procedure-grid">
				<RailRA device={device} progress={progress} onAct={onAct} />
				<PaneRA device={device} setup={setup} devices={devices} progress={progress} onAct={onAct} onDevicesRead={onDevicesRead} />
			</div>
		</div>
	);
}

// Change device is the rail's first Tab stop; a head too narrow for both puts it on a second line, end-aligned
function RailRA({ device, progress, onAct }) {
	const { Cluster, QuietButton } = window.UI;
	const isFinished = progress.open === null;
	const count = device.steps.length;
	return (
		<div className="ra-rail">
			<Cluster className="ra-rail-head justify-between">
				<p className="fs-meta text-dim">{isFinished ? `All ${count} steps done · ${device.name}` : `Step ${progress.open + 1} of ${count} · ${device.name}`}</p>
				{!isFinished && <QuietButton className="sm ms-auto" onClick={() => onAct({ type: "restart" })}>Change device</QuietButton>}
			</Cluster>
			<ol>
				{device.steps.map((step, i) => (
					<li key={step.title} aria-current={i === progress.open ? "step" : undefined}>
						<RailRowRA title={step.title} index={i} position={getPositionRA(progress, i)} isLocked={i === device.lockedStep} onAct={onAct} />
					</li>
				))}
			</ol>
		</div>
	);
}

function getPositionRA(progress, index) {
	if (index === progress.open) return "open";
	return progress.done[index] ? "done" : "ahead";
}

// three cues per position (glyph or numeral, ink step, the one filled row) · only a done row is a control; the open one's focus is the pane's heading
// isLocked → a step that opens only through the compare step's forward control: its done row is a mark, never a button
function RailRowRA({ title, index, position, isLocked, onAct }) {
	const { StatusDot } = window.UI;
	const mark = position === "done" ? <StatusDot status="ok" word={STEP_TEXT_RA.mark.done} isInText /> : index + 1;
	if (position === "done" && !isLocked) {
		return (
			<button type="button" className="ra-step" onClick={() => onAct({ type: "reopen", index })}>
				<span className="ra-step-mark">{mark}</span>
				<span className="ra-step-title">{title}</span>
			</button>
		);
	}
	return (
		<span className={`ra-step is-${position}`}>
			<span className="ra-step-mark">{mark}</span>
			<span className="ra-step-title">{title}</span>
		</span>
	);
}

function PaneRA({ device, setup, devices, progress, onAct, onDevicesRead }) {
	const { Stack } = window.UI;
	const titleRef = useRRA(null);
	// a step opened by a press or by finishing → focus follows to its heading
	useERA(() => titleRef.current?.focus(), [progress.open]);
	if (progress.open === null) return <FinishedPaneRA label={progress.label} titleRef={titleRef} onAct={onAct} />;
	const step = device.steps[progress.open];
	const values = getAddressesRA(setup, device.hosts);
	// extra → values only the step itself knows (the open code), filling their Trouble? slots
	const trouble = (extra, isQrShown = false) => (
		<TroubleRA rows={step.trouble} values={{ ...values, ...extra }} isQrShown={isQrShown} isOpen={progress.isTroubleOpen} jump={device.jump} onAct={onAct} />
	);
	const forward = step.kind === "fingerprint" ? device.compare.next : "Next";
	return (
		<div className="ra-pane">
			<Stack className="ra-pane-body">
				<Stack gap="stack">
					<h3 ref={titleRef} tabIndex={-1} className="ra-pane-title fs-title font-semibold text-ink">{step.title}</h3>
					<StepLineRA step={step} fileName={device.fileName} onAct={onAct} />
				</Stack>
				<StepValueRA step={step} device={device} setup={setup} devices={devices} address={values.address} trouble={trouble} onAct={onAct} onDevicesRead={onDevicesRead} />
				{step.kind !== "scan" && trouble({})}
			</Stack>
			<PaneFootRA step={step} index={progress.open} forward={forward} hasFingerprint={Boolean(setup.fingerprint)} onAct={onAct} />
		</div>
	);
}

function FinishedPaneRA({ label, titleRef, onAct }) {
	const { Stack, TONE_GLYPH } = window.UI;
	return (
		<div className="ra-pane">
			<Stack gap="label" className="ra-pane-body items-start">
				<h3 ref={titleRef} tabIndex={-1} className="ra-pane-title fs-title font-semibold text-ink"><span className="text-ok">{TONE_GLYPH.ok}</span> {`“${label}” is connected.`}</h3>
				<button type="button" className="btn" onClick={() => onAct({ type: "restart" })}>Connect another device</button>
			</Stack>
		</div>
	);
}

// step 1's line carries its certificate button, the pane's one primary
function StepLineRA({ step, fileName, onAct }) {
	if (step.kind === "send") return <CertificateStepRA line={step.line} fileName={fileName} onSent={() => onAct({ type: "sent" })} />;
	return step.path ? <PathRA path={step.path} /> : <p className="fs-body text-dim">{step.line}</p>;
}

function StepValueRA({ step, device, setup, devices, address, trouble, onAct, onDevicesRead }) {
	if (step.kind === "fingerprint") return <FingerprintRA fingerprint={setup.fingerprint} compare={device.compare} stop={step.stop} />;
	if (step.kind !== "scan") return null;
	return <CodeStepRA address={address} isTyped={device.isTyped} devices={devices} trouble={trouble} onConnected={(label) => onAct({ type: "connected", label })} onDevicesRead={onDevicesRead} />;
}

// Back at the start, the forward control at the end · step 1's Next stays secondary beside its certificate button · the scan step moves on by itself
function PaneFootRA({ step, index, forward, hasFingerprint, onAct }) {
	const { QuietButton } = window.UI;
	const nextClass = step.kind === "send" ? "btn ra-pane-next" : "btn primary ra-pane-next";
	return (
		<div className="control-row ra-pane-foot">
			{index > 0 && <QuietButton onClick={() => onAct({ type: "back" })}>Back</QuietButton>}
			{step.kind !== "scan" && <button type="button" className={nextClass} disabled={step.kind === "fingerprint" && !hasFingerprint} onClick={() => onAct({ type: "next", hasFingerprint })}>{forward}</button>}
		</div>
	);
}

// 16px, not the 13 floor: 64 characters matched pair by pair against a phone held beside the screen · the stop line is never folded
function FingerprintRA({ fingerprint, compare, stop }) {
	const { Stack, MachineString, StatusDot } = window.UI;
	return (
		<Stack gap="label">
			{fingerprint
				? (
					<ValueRA label={compare.label} className="ra-fingerprint">
						<MachineString className="fs-title text-ink">{formatFingerprintRA(fingerprint).map((line) => <FingerprintLineRA key={line} line={line} />)}</MachineString>
					</ValueRA>
				)
				: <ActErrorRA error={{ text: compare.missing }} />}
			<p className="fs-body font-medium text-ink"><StatusDot status="warn" word={STEP_TEXT_RA.mark.warn} isInText /> {stop}</p>
		</Stack>
	);
}

// two groups of four pairs, one space between → a copy reads as the phone writes it
function FingerprintLineRA({ line }) {
	const pairs = line.split(" ");
	return <span className="block"><span>{pairs.slice(0, 4).join(" ")}</span> <span className="ra-fingerprint-group">{pairs.slice(4).join(" ")}</span></span>;
}

/** A QR code drawn in the page; no encoder on the page → the text itself. */
function QrCodeRA({ text }) {
	const { MachineString } = window.UI;
	if (!hasQrEncoderRA()) return <ValueRA label="Address"><MachineString className="fs-body text-ink">{text}</MachineString></ValueRA>;
	const qr = window.qrcode(0, "M");
	qr.addData(text);
	qr.make();
	const size = qr.getModuleCount() + QR_RA.QUIET * 2;
	return (
		<svg role="img" aria-label={QR_RA.LABEL} width={size * QR_RA.MODULE_PX} height={size * QR_RA.MODULE_PX} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges">
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

// a Settings path in the phone's own words, matched by eye → sans labels, wrapping between labels, never inside one
function PathRA({ path }) {
	return (
		<p className="fs-body">
			{path.split(PATH_SEPARATOR_RA).map((label, i) => (
				<React.Fragment key={label}>{i > 0 && <span className="text-dim">{PATH_SEPARATOR_RA}</span>}<span className="ra-path-label">{label}</span></React.Fragment>
			))}
		</p>
	);
}

function ValueRA({ label, className = "", children }) {
	const { Stack } = window.UI;
	return (
		<Stack gap="stack" className={className}>
			<span className="fs-meta text-dim">{label}</span>
			{children}
		</Stack>
	);
}

// jump → the device's own jump step, never read from the step count
function TroubleRA({ rows, values, isQrShown, isOpen, jump, onAct }) {
	const { Stack, DisclosureButton, QuietButton } = window.UI;
	const lines = getTroubleLinesRA(rows, values, isQrShown);
	if (lines.length === 0) return null;
	return (
		<Stack gap="stack" className="items-start">
			<DisclosureButton isOpen={isOpen} onToggle={() => onAct({ type: "trouble" })} label="Trouble?" />
			{isOpen && lines.map((row) => (
				<p key={row.text} className="fs-meta text-dim">
					<TroubleTextRA text={row.text} values={values} />
					{row.isJump && <> <QuietButton className="sm" onClick={() => onAct({ type: "jump" })}>{`Go to step ${jump + 1}`}</QuietButton></>}
				</p>
			))}
		</Stack>
	);
}

// a line whose slot has no value, or that speaks of a QR code not drawn or a code not open, is left out
function getTroubleLinesRA(rows, values, isQrShown) {
	return rows.filter((row) => (isQrShown || !row.isQrOnly) && (values.code || !row.isCodeOnly) && row.text.split(SLOT_RA).every((part) => !SLOT_RA.test(part) || values[part.slice(1, -1)]));
}

function TroubleTextRA({ text, values }) {
	const { MachineString } = window.UI;
	return <>{text.split(SLOT_RA).map((part) => (SLOT_RA.test(part) ? <MachineString key={part} className="text-ink">{values[part.slice(1, -1)]}</MachineString> : part))}</>;
}

function CertificateStepRA({ line, fileName, onSent }) {
	const { Stack } = window.UI;
	const [cert, setCert] = useSRA({ file: null, isSending: false, error: null });
	const isShare = canShareFileRA(cert.file);
	// read ahead → the share sheet opens inside the click, which a browser requires
	useERA(() => {
		readCertificateRA(fileName).then((file) => setCert((prev) => ({ ...prev, file })), () => undefined);
	}, [fileName]);
	const onSend = () => {
		if (cert.isSending) return;
		setCert((prev) => ({ ...prev, isSending: true, error: null }));
		const file = cert.file ? Promise.resolve(cert.file) : readCertificateRA(fileName);
		file.then((value) => sendCertificateRA(value, isShare)).then(
			(isSent) => {
				setCert((prev) => ({ ...prev, isSending: false }));
				if (isSent) onSent();
			},
			(error) => setCert((prev) => ({ ...prev, isSending: false, error: { text: STEP_TEXT_RA.certificate.failed, detail: error.message } })),
		);
	};
	return (
		<Stack gap="label" className="items-start">
			<p className="fs-body text-dim">{isShare ? line.share : line.download}</p>
			<button type="button" className="btn primary" aria-busy={cert.isSending || undefined} onClick={onSend}>{isShare ? STEP_TEXT_RA.certificate.share : STEP_TEXT_RA.certificate.download}</button>
			{cert.error && <ActErrorRA error={cert.error} />}
		</Stack>
	);
}

function CodeStepRA({ address, isTyped, devices, trouble, onConnected, onDevicesRead }) {
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
	const isOpen = state.status === "open";
	return (
		<>
			<CodeViewRA state={state} address={address} isTyped={isTyped} onOpen={onOpen} />
			{trouble(isOpen ? { code: formatCodeRA(state.code) } : {}, isQrDrawnRA(state, address))}
		</>
	);
}

// drawn only while a code is open · iPhone: the QR code, the code and its renewal at its right, top-aligned
// isTyped → the address and the code first, the QR code second under its own label · opening a code is the step's one primary
function CodeViewRA({ state, address, isTyped = false, onOpen }) {
	const { Stack } = window.UI;
	if (state.status === "open") {
		const qrText = address && `${address}${SIGN_IN_RA.PATH}${SIGN_IN_RA.FRAGMENT}${state.code}`;
		if (!isTyped) {
			return (
				<div className="ra-code">
					{qrText && <QrCodeRA text={qrText} />}
					<CodeValueRA state={state} onOpen={onOpen} />
				</div>
			);
		}
		return (
			<div className="ra-code is-typed">
				<CodeValueRA state={state} address={address} onOpen={onOpen} />
				{isQrDrawnRA(state, address) && <ValueRA label={STEP_TEXT_RA.code.scan}><QrCodeRA text={qrText} /></ValueRA>}
			</div>
		);
	}
	const open = isTyped ? STEP_TEXT_RA.code.open.typed : STEP_TEXT_RA.code.open.qr;
	return (
		<Stack gap="label" className="items-start">
			{state.status === "expired" && <p className="fs-body text-dim">{STEP_TEXT_RA.code.expired}</p>}
			<button type="button" className="btn primary" aria-busy={state.status === "opening" || undefined} onClick={onOpen}>{state.status === "opening" ? STEP_TEXT_RA.code.opening : open}</button>
			{state.error && <ActErrorRA error={state.error} />}
		</Stack>
	);
}

// address → typed first above the code: plain text on one line, never a link, scheme to port alone
function CodeValueRA({ state, address, onOpen }) {
	const { Stack, MachineString, formatKstTime } = window.UI;
	return (
		<Stack gap="block" className="items-start">
			{address && <ValueRA label={STEP_TEXT_RA.code.address}><MachineString className="fs-title font-medium text-ink whitespace-nowrap">{address}</MachineString></ValueRA>}
			<ValueRA label={STEP_TEXT_RA.code.label}>
				<MachineString className="fs-stat font-semibold text-ink">{formatCodeRA(state.code)}</MachineString>
				<span className="fs-meta text-dim tabular-nums">{STEP_TEXT_RA.code.validUntil.replace("{time}", formatKstTime(state.expiresAt))}</span>
			</ValueRA>
			<button type="button" className="btn" onClick={onOpen}>{STEP_TEXT_RA.code.renew}</button>
		</Stack>
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
	// flush → the table's edge cells and EmptyState each carry the card padding once; the error line insets itself
	return (
		<Card title="Registered devices" sub={`${devices.length} of ${limit}`} right={removeAll} foot={foot} isFlush>
			{hasTable
				? <DeviceTableRA devices={devices} pendingId={act.pendingId} onRemove={onRemove} />
				: <EmptyState message="No device registered" hint="A device appears here once it registers." />}
			{act.error && <div className="p-card-pad"><ActErrorRA error={act.error} /></div>}
		</Card>
	);
}

function DeviceTableRA({ devices, pendingId, onRemove }) {
	const { Table, TableRow, TableCell, AbsentValue, NoWrap, formatKstDateTime } = window.UI;
	// a 1% column under "None" alone is narrower than its header → the header never wraps
	const columns = [{ key: "label", label: "Device" }, { key: "created", label: <NoWrap>Registered</NoWrap> }, { key: "seen", label: <NoWrap>Last seen</NoWrap> }, { key: "act", label: "Action", isNumeric: true }];
	return (
		<Table caption="Registered devices" columns={columns} widths={DEVICE_WIDTHS_RA}>
			{devices.map((device) => (
				<TableRow key={device.id}>
					{/* max-w-0 → the column takes the leftover width, not the name's nowrap width */}
					<TableCell kind="row-header" className="w-full max-w-0">
						<div className="truncate" title={device.label}>{device.label}</div>
					</TableCell>
					<TableCell className="whitespace-nowrap tabular-nums">{formatKstDateTime(device.createdAt)}</TableCell>
					<TableCell className="whitespace-nowrap tabular-nums">{device.lastSeenAt ? formatKstDateTime(device.lastSeenAt) : <AbsentValue kind="none" />}</TableCell>
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
