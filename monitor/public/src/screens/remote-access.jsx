// Remote access — the Mac's own page: open a registration code, the registered devices with revoke, and the feature's state.
// Loopback only: its routes answer the Mac page alone (route-classes.ts → remote-admin), so the remote page never lists it.
const { useState: useSRA, useEffect: useERA, useCallback: useCRA } = React;

const URL_RA = {
	DEVICES: "/api/remote/devices",
	REGISTRATION: "/api/remote/registration",
	REVOKE_ALL: "/api/remote/devices/revoke-all",
};
// registration-code.ts → REGISTRATION_CODE.WINDOW_MS (bound by remote-access.screen-render)
const CODE_WINDOW_MS_RA = 5 * 60_000;
const REVOKE_OUTLINE_STYLE_RA = { color: "rgb(var(--crit))", borderColor: "rgb(var(--crit))" };
const CODE_STYLE_RA = { fontSize: "var(--fs-kpi)", letterSpacing: "0.2em" };
const OPEN_REFUSAL_RA = {
	429: "Too many codes opened — wait a minute and open again",
	503: "Code not opened — the audit log is unavailable",
};
const CA_PATH_RA = "~/.glass-atrium/monitor/data/remote-access/ca.pem";

/** The registered devices and the feature's state, in one read. */
async function readDevicesRA() {
	const res = await fetch(URL_RA.DEVICES, { headers: { Accept: "application/json" } });
	if (!res.ok) throw await window.UI.getFetchError(res);
	return res.json();
}

/** Opens a registration and returns its code; a refused open rejects with the reason the owner can act on. */
async function createRegistrationRA() {
	const res = await fetch(URL_RA.REGISTRATION, { method: "POST" });
	if (res.ok) return (await res.json()).code;
	throw OPEN_REFUSAL_RA[res.status] ? new Error(OPEN_REFUSAL_RA[res.status]) : await window.UI.getFetchError(res);
}

/** Revokes one device; one already gone counts as revoked. */
async function deleteDeviceRA(id) {
	const res = await fetch(`${URL_RA.DEVICES}/${encodeURIComponent(id)}`, { method: "DELETE" });
	if (!res.ok && res.status !== 404) throw await window.UI.getFetchError(res);
}

async function deleteAllDevicesRA() {
	const res = await fetch(URL_RA.REVOKE_ALL, { method: "POST" });
	if (!res.ok) throw await window.UI.getFetchError(res);
}

function getAccessLineRA(access) {
	if (!access.enabled) return "Off";
	const count = access.trusted.length;
	if (count === 0) return "On · no trusted network — closed";
	return `On · ${count} trusted ${count === 1 ? "network" : "networks"}`;
}

/** One text line per trusted network → the owner sees which networks open the listener. */
function getTrustedLinesRA(access) {
	return access.trusted.map((network) => `${network.gateway} · ${network.hardwareAddress}`);
}

function ScreenRemoteAccess() {
	const { PageHeader, FreshnessStamp, RefreshButton } = window.UI;
	const [read, setRead] = useSRA({ status: "loading", data: null, error: null, at: null });
	const reload = useCRA(() => {
		setRead((prev) => ({ ...prev, status: "loading" }));
		readDevicesRA().then(
			(data) => setRead({ status: "ready", data, error: null, at: new Date().toISOString() }),
			(error) => setRead((prev) => ({ ...prev, status: "failed", error })),
		);
	}, []);
	useERA(() => reload(), [reload]);
	const isBusy = read.status === "loading";
	return (
		<div className="flex flex-col gap-section">
			<PageHeader title="Remote access"
				freshness={<FreshnessStamp at={read.at} loading={isBusy} failed={read.status === "failed"} />}
				refresh={<RefreshButton isBusy={isBusy} hasRead={read.data !== null} onRefresh={reload} label="Refresh remote access" />} />
			<RegistrationCardRA />
			<DevicesCardRA read={read} onChanged={reload} />
			<AccessCardRA access={read.data?.access ?? null} />
		</div>
	);
}

function RegistrationCardRA() {
	const { Card, MachineString } = window.UI;
	const [state, setState] = useSRA({ status: "idle", code: null, expiresAt: null, error: null });
	const onOpen = () => {
		if (state.status === "opening") return;
		setState({ status: "opening", code: null, expiresAt: null, error: null });
		createRegistrationRA().then(
			(code) => setState({ status: "open", code, expiresAt: new Date(Date.now() + CODE_WINDOW_MS_RA).toISOString(), error: null }),
			(error) => setState({ status: "idle", code: null, expiresAt: null, error }),
		);
	};
	return (
		<Card title="Register a device" sub="Enter the code on the device, once">
			<div className="flex items-center gap-control">
				<button type="button" className="btn" aria-busy={state.status === "opening" || undefined} onClick={onOpen}>
					{state.status === "opening" ? "Opening…" : state.code ? "Open a new code" : "Open registration"}
				</button>
				{state.code && <MachineString className="font-semibold" ><span style={CODE_STYLE_RA}>{state.code}</span></MachineString>}
			</div>
			{state.code && <p className="text-dim" style={{ fontSize: "var(--fs-meta)" }}>One use · valid until {window.UI.formatKstTime(state.expiresAt)}</p>}
			{state.error && <p role="alert" className="text-dim"><span className="text-crit" aria-hidden="true">{window.UI.TONE_GLYPH.crit}</span> {state.error.message}</p>}
		</Card>
	);
}

function DevicesCardRA({ read, onChanged }) {
	const { Card, LoadingPlaceholder, RegionUnavailable, EmptyState } = window.UI;
	const [act, setAct] = useSRA({ pendingId: null, error: null });
	const run = (pendingId, task) => {
		if (act.pendingId !== null) return;
		setAct({ pendingId, error: null });
		task().then(() => setAct({ pendingId: null, error: null }), (error) => setAct({ pendingId: null, error })).finally(onChanged);
	};
	const devices = read.data?.devices ?? [];
	const revokeAll = devices.length > 0 && (
		<button type="button" className="btn sm" style={REVOKE_OUTLINE_STYLE_RA} aria-busy={act.pendingId === "all" || undefined}
			onClick={() => run("all", deleteAllDevicesRA)}>{act.pendingId === "all" ? "Revoking…" : "Revoke all"}</button>
	);
	return (
		<Card title="Registered devices" sub="Up to 10" right={revokeAll}>
			{read.data === null && read.status === "loading" && <LoadingPlaceholder label="devices" minHeight={96} />}
			{read.status === "failed" && <RegionUnavailable source="Remote access devices" error={read.error} onRetry={onChanged} />}
			{read.data !== null && devices.length === 0 && <EmptyState message="No device registered" hint="Open registration, then enter the code on the device" />}
			{devices.length > 0 && <DeviceTableRA devices={devices} pendingId={act.pendingId} onRevoke={(id) => run(id, () => deleteDeviceRA(id))} />}
			{act.error && <p role="alert" className="text-dim"><span className="text-crit" aria-hidden="true">{window.UI.TONE_GLYPH.crit}</span> Revoke failed — {act.error.message}</p>}
		</Card>
	);
}

function DeviceTableRA({ devices, pendingId, onRevoke }) {
	const { Table, TableRow, TableCell } = window.UI;
	const columns = [{ key: "label", label: "Device" }, { key: "created", label: "Registered" }, { key: "seen", label: "Last seen" }, { key: "act", label: "Action" }];
	return (
		<Table caption="Registered devices" columns={columns}>
			{devices.map((device) => (
				<TableRow key={device.id}>
					<TableCell kind="row-header">{device.label}</TableCell>
					<TableCell>{window.UI.formatKstDateTime(device.createdAt)}</TableCell>
					<TableCell>{window.UI.formatKstDateTime(device.lastSeenAt)}</TableCell>
					<TableCell>
						<button type="button" className="btn sm" style={REVOKE_OUTLINE_STYLE_RA} aria-label={`Revoke ${device.label}`}
							aria-busy={pendingId === device.id || undefined} onClick={() => onRevoke(device.id)}>
							{pendingId === device.id ? "Revoking…" : "Revoke"}
						</button>
					</TableCell>
				</TableRow>
			))}
		</Table>
	);
}

function AccessCardRA({ access }) {
	const { Card, MachineString } = window.UI;
	const steps = [
		["Turn on or off", "glass-atrium remote on · glass-atrium remote off"],
		["Trust this Wi-Fi", "glass-atrium remote trust"],
		["Certificate to send (AirDrop)", CA_PATH_RA],
		["Fingerprint to compare on the device", `openssl x509 -fingerprint -sha256 -noout -in ${CA_PATH_RA}`],
	];
	return (
		<Card title="Access and certificate" sub={access === null ? "State not read" : getAccessLineRA(access)}>
			{access !== null && access.trusted.length > 0 && (
				<ul className="flex flex-col gap-label" aria-label="Trusted networks (gateway · hardware address)">
					{getTrustedLinesRA(access).map((line) => (
						<li key={line}><MachineString>{line}</MachineString></li>
					))}
				</ul>
			)}
			<dl className="flex flex-col gap-stack">
				{steps.map(([term, command]) => (
					<div key={term} className="flex flex-col gap-label">
						<dt className="text-dim" style={{ fontSize: "var(--fs-meta)" }}>{term}</dt>
						<dd><MachineString>{command}</MachineString></dd>
					</div>
				))}
			</dl>
			<p className="text-dim" style={{ fontSize: "var(--fs-meta)" }}>On the device, trust the certificate once, then open the Mac's address and enter the code.</p>
		</Card>
	);
}

window.ScreenRemoteAccess = ScreenRemoteAccess;
