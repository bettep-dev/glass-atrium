// Remote sign-in — turns the code shown on the Mac into this device's registration cookie, then opens the monitor.
// Pre-auth page → a plain script on its own; the server keeps every code refusal opaque.
(() => {
	"use strict";

	const REGISTER_URL = "/api/remote/register";
	const BUTTON_LABEL = { idle: "Register device", busy: "Registering…" };
	// server error → message + the field it marks; registration_refused = one answer for a wrong, expired, used or unopened code
	const REFUSALS = {
		registration_refused: { text: "Code not accepted — show a new code on the Mac and use it", field: "code" },
		label_invalid: { text: "Device name not accepted — use letters, numbers, spaces, . _ -", field: "label" },
		device_limit_reached: { text: "Device limit reached — remove a device on the Mac, then show a new code", field: null },
		too_many_requests: { text: "Too many tries — wait a minute, then try again", field: null },
	};
	const MISSING = {
		code: { text: "Enter the code shown on the Mac", field: "code" },
		label: { text: "Enter a device name", field: "label" },
	};
	const UNREACHED = { text: "Not sent — check this device is on the Mac's network, then try again", field: null };
	const LEAD = {
		empty: "Enter the code from the Mac, name this device, then tap Register device.",
		filled: "Check the code, name this device, then tap Register device.",
	};
	// registration-code.ts → REGISTRATION_CODE (bound by remote-sign-in.e2e)
	const CODE = { ALPHABET: "23456789ABCDEFGHJKLMNPQRSTUVWXYZ", LENGTH: 8 };
	// the Mac's QR code → this page's own path + "#code=" + the open code
	const FRAGMENT = { PAGE_PATH: "/sign-in.html", PREFIX: "#code=" };

	const form = document.getElementById("sign-in-form");
	const status = document.getElementById("sign-in-status");
	const lead = document.querySelector(".sign-in-lead");
	const button = form.querySelector('button[type="submit"]');
	const fields = { code: form.elements.namedItem("code"), label: form.elements.namedItem("label") };

	form.addEventListener("submit", (event) => {
		event.preventDefault();
		register();
	});
	fields.code.addEventListener("input", showLead);
	// a second scan into an open page changes only the fragment
	window.addEventListener("hashchange", readFragment);
	readFragment();
	showLead();
	if (fields.code.value === "") fields.code.focus();

	/**
	 * The QR code's one-use code → the code field, and nowhere else.
	 * The address is cleaned before the value is tested, valid or not; nothing is submitted here.
	 */
	function readFragment() {
		const fragment = window.location.hash;
		if (fragment === "") return;
		window.history.replaceState(null, "", FRAGMENT.PAGE_PATH);
		const value = fragment.startsWith(FRAGMENT.PREFIX) ? fragment.slice(FRAGMENT.PREFIX.length) : "";
		if (!isCode(value)) return;
		fields.code.value = value;
		showLead();
		fields.label.focus();
	}

	// exact length and alphabet, upper case as the Mac shows it; no decoding
	function isCode(value) {
		return value.length === CODE.LENGTH && [...value].every((symbol) => CODE.ALPHABET.includes(symbol));
	}

	function showLead() {
		lead.textContent = fields.code.value === "" ? LEAD.empty : LEAD.filled;
	}

	/** One registration try: an empty entry stops here, before it can spend one of the code's tries. */
	async function register() {
		const entry = getEntry();
		const missing = entry.code === "" ? MISSING.code : entry.label === "" ? MISSING.label : null;
		if (missing) return showRefusal(missing);
		showRefusal(null);
		setBusy(true);
		const refusal = await send(entry);
		if (refusal === null) return window.location.replace("/");
		setBusy(false);
		// a refused code is spent or wrong → only a new code from the Mac helps
		if (refusal === REFUSALS.registration_refused) {
			fields.code.value = "";
			showLead();
		}
		showRefusal(refusal);
	}

	// spaces and dashes a person adds while copying are not part of the code; the server compares upper case
	function getEntry() {
		return { code: fields.code.value.replace(/[\s-]/g, "").toUpperCase(), label: fields.label.value.trim() };
	}

	/** null once registered (the response set the device cookie); otherwise the refusal to show. */
	async function send(entry) {
		try {
			const res = await fetch(REGISTER_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(entry),
				credentials: "same-origin",
			});
			return res.ok ? null : getRefusal(res);
		} catch {
			return UNREACHED;
		}
	}

	async function getRefusal(res) {
		const body = await res.json().catch(() => null);
		const error = typeof body?.error === "string" ? body.error : "";
		if (Object.hasOwn(REFUSALS, error)) return REFUSALS[error];
		return { text: `Not registered (HTTP ${res.status}) — try again`, field: null };
	}

	/** Shows one refusal and marks its field; null clears the line and every mark. */
	function showRefusal(refusal) {
		status.textContent = refusal?.text ?? "";
		status.classList.toggle("is-error", refusal !== null);
		for (const [name, input] of Object.entries(fields)) {
			const isInvalid = refusal?.field === name;
			input.classList.toggle("is-error", isInvalid);
			if (isInvalid) input.setAttribute("aria-invalid", "true");
			else input.removeAttribute("aria-invalid");
		}
		if (refusal?.field) fields[refusal.field].focus();
	}

	function setBusy(isBusy) {
		button.disabled = isBusy;
		button.setAttribute("aria-busy", String(isBusy));
		button.textContent = isBusy ? BUTTON_LABEL.busy : BUTTON_LABEL.idle;
	}
})();
