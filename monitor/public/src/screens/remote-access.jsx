// Remote access — the Mac's own page: whether devices can reach this monitor, the five steps that connect one, and the registered devices.
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
const PROSE_STYLE_RA = { maxWidth: "var(--measure-prose)" };

const OPEN_ERROR_RA = {
	429: "Too many codes opened. Wait a minute, then open a code.",
	503: "No code was opened: the monitor could not record it. Try again in a minute.",
};
// admin-routes.ts → ConfirmRefusal: the network moved or the confirm's read went stale
const CONFIRM_REFUSALS_RA = new Set(["confirm_stale", "network_changed"]);
// admin-routes.ts → AccessApplyOutcome: a throw, an unnamed step exit, or config.toml written without the monitor/.env a restart reads → state unknown
const UNKNOWN_STATE_REFUSALS_RA = new Set(["act_failed", "write_failed", "env_not_rendered"]);
// admin-routes.ts → AccessApplyOutcome: the step wrote, this process could not apply it → the next restart does
const RESTART_PENDING_REFUSAL_RA = "start_failed";
const WIDEN_ERROR_RA = {
	on: {
		moved: "The network details were out of date. Nothing was turned on. Check the number again.",
		unknown: "Remote access may or may not be on. Refresh; if wrong, turn it off and on.",
		pending: "Remote access was turned on, but it starts only when the monitor restarts. Refresh; if you do not want it, turn it off.",
		failed: "Remote access was not turned on. Try again.",
	},
	trust: {
		moved: "The network details were out of date. Nothing was trusted. Check the number again.",
		unknown: "This network may or may not be trusted. Refresh; if wrong, turn remote access off and on.",
		pending: "This network was trusted, but it applies only when the monitor restarts. Refresh; if you do not want it, turn remote access off.",
		failed: "This network was not trusted. Try again.",
	},
};
const END_ERROR_RA = { off: "Remote access is still on. Try again.", "remove-all": "No device was removed. Try again." };

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
	"not-answering": { tone: "crit", title: "Remote access is on, but this Mac is not answering", body: "Refresh in a minute. If it stays, turn remote access off and on, then connect each device again from step 4." },
};
// the attention row above already says whether this network is trusted
const COUNT_ONLY_VIEWS_RA = new Set(["closed", "no-network", "off-no-network"]);
const CHECKING_LABEL_RA = "Checking network…";
const NETWORK_ERROR_RA = {
	unread: "This Mac's network could not be read. Try again.",
	// the re-read after a confirm refusal → the confirm closes, nothing was done
	reread: "This Mac's network changed and could not be read again, so nothing was done. Try again.",
};
const ROUTER_LABEL_RA = { wifi: "Router of this Mac's Wi-Fi", wired: "Router of this Mac's wired network", unknown: "Router of this Mac's network" };
const WIDEN_WORDS_RA = {
	on: { title: "Turn on remote access?", lead: "This also trusts the network this Mac is on now. A device you connect with a code from this screen can then open this monitor whenever this Mac is on that network.", commit: { label: "Turn on and trust", busy: "Turning on…" } },
	"on-trusted": { title: "Turn on remote access?", lead: "This Mac is on a network you already trust. A device you connect with a code from this screen can open this monitor whenever this Mac is on a trusted network.", commit: { label: "Turn on", busy: "Turning on…" } },
	trust: { title: "Trust this network?", lead: "This trusts the network this Mac is on now. Registered devices can then open this monitor whenever this Mac is on it.", commit: { label: "Trust this network", busy: "Trusting…" } },
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
	return OPEN_ERROR_RA[error?.status] ?? "No code was opened. Try again.";
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

function getOffLinesRA(setup) {
	if (!setup.hasRouter) return { message: "This Mac is not on a network.", hint: "Connect it to the network your devices use, then turn remote access on here." };
	if (setup.isOffByDevice) return { message: "A registered device turned remote access off.", hint: "Every device was removed. Turn it on to connect them again." };
	return { message: "A phone or tablet on the same network can use this monitor, exactly as on this Mac.", hint: "Turn it on to see the steps for connecting a device." };
}

/** The server's colon-joined SHA-256 → four lines of eight pairs, as the device lists them. */
function formatFingerprintRA(value) {
	const pairs = value.toUpperCase().split(":");
	return [0, 8, 16, 24].map((start) => pairs.slice(start, start + 8).join(" "));
}

function formatCodeRA(code) {
	return code.match(/.{1,4}/g).join(" ");
}

/** The `.local` name first, the number second; an unreadable one is left out. */
function getAddressesRA(setup) {
	const hosts = [setup.hostName, setup.address].filter(Boolean);
	return hosts.map((host, i) => ({ label: i === 0 ? "Address" : "If that does not open", url: `https://${host}:${setup.port}` }));
}

function canShareFileRA(file) {
	return file !== null && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
}

/** Share sheet where the browser offers one, else a download; a sheet the person closes is no error. */
async function sendCertificateRA(file, isShare) {
	if (isShare) {
		await navigator.share({ files: [file] }).catch((error) => {
			if (error?.name !== "AbortError") throw error;
		});
		return;
	}
	const url = URL.createObjectURL(file);
	Object.assign(document.createElement("a"), { href: url, download: file.name }).click();
	setTimeout(() => URL.revokeObjectURL(url), 0);
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
	const data = read.data;
	const view = data ? getViewRA(data.setup) : null;
	// isReread → the open confirm's own read after a refusal: a confirm cancelled meanwhile stays closed, one it cannot show again closes with E-16
	const onWiden = (act, isReread = false) => {
		if (check.act !== null) return;
		setCheck({ act, error: null });
		// a first read lands only on a page with no confirm, a re-read only in its own act's → never under a press meant for another confirm
		const isOwnDialog = (open) => (isReread ? open?.act === act : open === null);
		readConfirmNetworkRA().then(
			(network) => {
				const canConfirm = network.router !== null && !(act === "trust" && network.isNetworkTrusted);
				setCheck({ act: null, error: !canConfirm && isReread ? { act, text: NETWORK_ERROR_RA.reread } : null });
				setDialog((open) => (isOwnDialog(open) ? (canConfirm ? { act, network } : null) : open));
				if (!canConfirm) onReload();
			},
			(error) => {
				setDialog((open) => (isOwnDialog(open) ? null : open));
				setCheck({ act: null, error: { act, text: NETWORK_ERROR_RA[isReread ? "reread" : "unread"], detail: error.message } });
			},
		);
	};
	// held while a network read runs → its confirm never opens in their place
	const onEnd = (act) => {
		if (check.act === null) setDialog({ act });
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
	const line = getTrustedLineRA(setup, view);
	const foot = line && <span className="tabular-nums">{line}</span>;
	const hasDevicesCard = setup.enabled || devices.length > 0;
	const checkError = (act) => (check.error?.act === act ? check.error : null);
	return (
		<>
			{!setup.enabled && <OffCardRA setup={setup} foot={hasDevicesCard ? null : foot} error={checkError("on")} />}
			{setup.enabled && checkError("on") && <ActErrorRA error={checkError("on")} />}
			{view === "on" && <ConnectCardRA key={emptyKey} setup={setup} devices={devices} onDevicesRead={onDevicesRead} />}
			{ATTENTION_RA[view]
				? <AttentionRA row={ATTENTION_RA[view]} isChecking={check.act === "trust"} error={checkError("trust")} onTrust={() => onWiden("trust")} />
				: checkError("trust") && <ActErrorRA error={checkError("trust")} />}
			{hasDevicesCard && <DevicesCardRA devices={devices} limit={setup.deviceLimit} foot={foot} onChanged={onChanged} onRemoveAll={onRemoveAll} />}
		</>
	);
}

function OffCardRA({ setup, foot, error }) {
	const { Card, EmptyState } = window.UI;
	const lines = getOffLinesRA(setup);
	return (
		<Card foot={foot}>
			<EmptyState message={lines.message} hint={lines.hint} />
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

function ConnectCardRA({ setup, devices, onDevicesRead }) {
	const { Disclosure } = window.UI;
	return (
		<Disclosure kind={devices.length === 0 ? "status" : "detail"} title="Connect a device" sub="iPhone or iPad">
			<div className="flex flex-col gap-block">
				<ol className="flex flex-col gap-block list-decimal pl-card-pad">
					<StepRA title="Send this Mac's certificate to the device"><CertificateStepRA /></StepRA>
					<StepRA title="Check and install the certificate"><FingerprintStepRA fingerprint={setup.fingerprint} /></StepRA>
					<StepRA title="Turn on trust for the certificate">
						<StepTextRA>Do this only after the lines in step 2 matched. In Settings, open General → About → Certificate Trust Settings. Turn on Glass Atrium Local CA, then tap Continue.</StepTextRA>
					</StepRA>
					<StepRA title="Open this Mac's address on the device"><AddressStepRA setup={setup} /></StepRA>
					<StepRA title="Enter the code on the device">
						<StepTextRA>Open a code here. On the device, type it, give the device a name and tap Register device. The monitor opens on the device, and the device appears under Registered devices.</StepTextRA>
						<CodeStepRA devices={devices} limit={setup.deviceLimit} onDevicesRead={onDevicesRead} />
					</StepRA>
				</ol>
				<p className="fs-meta text-dim">A device removed earlier starts at step 4.</p>
			</div>
		</Disclosure>
	);
}

function StepRA({ title, children }) {
	return (
		<li>
			<div className="flex flex-col gap-stack">
				<span className="fs-body font-medium text-ink">{title}</span>
				<div className="flex flex-col gap-label items-start">{children}</div>
			</div>
		</li>
	);
}

function StepTextRA({ children }) {
	return <p className="fs-body text-dim" style={PROSE_STYLE_RA}>{children}</p>;
}

function CertificateStepRA() {
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
			() => setCert((prev) => ({ ...prev, isSending: false })),
			(error) => setCert((prev) => ({ ...prev, isSending: false, error: { text: "The certificate was not downloaded. Try again.", detail: error.message } })),
		);
	};
	return (
		<>
			<StepTextRA>
				{isShare
					? "The certificate lets the device confirm it is talking to this Mac. Choose AirDrop, then the device. If the device asks, tap Accept. It then shows “Profile Downloaded”."
					: "The certificate lets the device confirm it is talking to this Mac. In Downloads, right-click “Glass Atrium Local CA” and choose Share → AirDrop, then the device. If the device asks, tap Accept. It then shows “Profile Downloaded”."}
			</StepTextRA>
			<button type="button" className="btn" aria-busy={cert.isSending || undefined} onClick={onSend}>{isShare ? "Share certificate…" : "Download certificate"}</button>
			{cert.error && <ActErrorRA error={cert.error} />}
		</>
	);
}

function FingerprintStepRA({ fingerprint }) {
	const { MachineString } = window.UI;
	return (
		<>
			<StepTextRA>The device shows SHA-256 lines for the certificate, under Fingerprints. Before step 3, they must match these:</StepTextRA>
			{fingerprint
				? <MachineString className="block fs-meta text-ink">{formatFingerprintRA(fingerprint).map((line) => <span key={line} className="block">{line}</span>)}</MachineString>
				: <ActErrorRA error={{ text: "Fingerprint not shown. Refresh this page before you install." }} />}
			<StepTextRA>On the device, open Settings and tap Profile Downloaded, then More Details, then Glass Atrium Local CA. If the lines are there and match, go back and tap Install, enter the device passcode, then tap Install twice more and Done.</StepTextRA>
			<StepTextRA>If the lines are not there before installing, install first with the same taps. Then open Settings → General → VPN &amp; Device Management → Glass Atrium Local CA → More Details and compare the lines there.</StepTextRA>
			<StepTextRA>If the lines differ, stop and remove the certificate: tap Remove Downloaded Profile, or Remove Profile if it is already installed.</StepTextRA>
		</>
	);
}

// the typed-address form: the page carries no QR encoder (spec C-46)
function AddressStepRA({ setup }) {
	const { MachineString } = window.UI;
	return (
		<>
			<StepTextRA>With the device on the same network as this Mac, open Safari and type this address. The page reads “Register this device”.</StepTextRA>
			{getAddressesRA(setup).map((row) => (
				<div key={row.label} className="flex flex-col">
					<span className="fs-meta text-dim">{row.label}</span>
					<MachineString className="fs-body text-ink">{row.url}</MachineString>
				</div>
			))}
			<p className="fs-meta text-dim">If Safari says “This Connection Is Not Private”, close the page and repeat steps 2 and 3.</p>
		</>
	);
}

function CodeStepRA({ devices, limit, onDevicesRead }) {
	const [state, setState] = useSRA({ status: "idle" });
	const knownRef = useRRA(new Set());
	useERA(() => {
		if (state.status !== "open") return;
		const added = devices.find((device) => !knownRef.current.has(device.id));
		if (added) setState({ status: "connected", label: added.label });
	}, [devices, state.status]);
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
	return <CodeViewRA state={state} count={devices.length} limit={limit} onOpen={onOpen} />;
}

function CodeViewRA({ state, count, limit, onOpen }) {
	const { MachineString, TONE_GLYPH, formatKstTime } = window.UI;
	const isOpen = state.status === "open";
	const label = state.status === "opening" ? "Opening…" : isOpen ? "Open a new code" : "Open a code";
	return (
		<>
			{isOpen && <MachineString className="fs-stat font-semibold text-ink">{formatCodeRA(state.code)}</MachineString>}
			{isOpen && <p className="fs-meta text-dim">{`One use · valid until ${formatKstTime(state.expiresAt)}`}</p>}
			{state.status === "expired" && <p className="fs-body text-dim">That code expired. Open a new code.</p>}
			{state.status === "connected" && (
				<p className="fs-body text-ink"><span className="text-ok" aria-hidden="true">{TONE_GLYPH.ok}</span> {`“${state.label}” is connected.`}</p>
			)}
			{count >= limit
				? <p className="fs-body text-dim">{`${count} of ${limit} devices registered. Remove one to connect another.`}</p>
				: <button type="button" className="btn" aria-busy={state.status === "opening" || undefined} onClick={onOpen}>{label}</button>}
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
				(error) => setAct({ pendingId: null, error: { text: `“${device.label}” was not removed. Try again.`, detail: error.message } }),
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
				: <EmptyState message="No device registered" hint="A device appears here after step 5." />}
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
				<p className="fs-meta text-dim">Compare it on a phone joined to your own network: open Settings → Wi-Fi and tap the info button (ⓘ) beside the network. If “Router” there shows a different number, this Mac is on another network: choose Cancel.</p>
			</div>
			<p className="fs-body text-ink">Trusting a network keeps remote access closed while this Mac is on any other network. It does not check who else is on this one, so trust only a network you control, such as your home network.</p>
		</ConfirmRA>
	);
}

function EndConfirmRA({ act, count, isBusy, error, onCommit, onCancel }) {
	const isOff = act === "off";
	const title = isOff ? "Turn off remote access?" : `Remove all ${count} devices?`;
	const commit = isOff ? { label: "Turn off", busy: "Turning off…" } : { label: "Remove all devices", busy: "Removing…" };
	return (
		<ConfirmRA title={title} commit={commit} isDestructive isBusy={isBusy} error={error} onCommit={onCommit} onCancel={onCancel}>
			<p className="fs-body text-ink">{isOff ? getOffBodyRA(count) : "Each device must be connected again from step 4 before it can open this monitor."}</p>
		</ConfirmRA>
	);
}

function getOffBodyRA(count) {
	if (count === 0) return "This Mac stops answering other devices.";
	if (count === 1) return "1 registered device is removed, and this Mac stops answering other devices. To use it again, turn remote access on and connect it from step 4.";
	return `${count} registered devices are removed, and this Mac stops answering other devices. To use a device again, turn remote access on and connect the device from step 4.`;
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
