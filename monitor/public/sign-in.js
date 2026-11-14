// Remote sign-in — turns the code shown on the Mac into this device's registration cookie, then opens the monitor.
// Pre-auth page → a plain script with no shell globals (ui.jsx sits behind registration); the server keeps every code refusal opaque.
(() => {
	"use strict";

	const REGISTER_URL = "/api/remote/register";
	const BUTTON_LABEL = { idle: "Register device", busy: "Registering…" };
	// server error → message + the field it marks; registration_refused = one answer for a wrong, expired, used or unopened code
	const REFUSALS = {
		registration_refused: { text: "Code not accepted — open a new code on the Mac and enter it", field: "code" },
		label_invalid: { text: "Device name not accepted — use letters, numbers, spaces, . _ - (the code is still valid)", field: "label" },
		device_limit_reached: { text: "Device limit reached — revoke a device on the Mac, then open a new code", field: null },
		too_many_requests: { text: "Too many tries — wait a minute, then try again", field: null },
	};
	const MISSING = {
		code: { text: "Enter the code shown on the Mac", field: "code" },
		label: { text: "Enter a device name", field: "label" },
	};
	const UNREACHED = { text: "Not sent — check this device is on the Mac's Wi-Fi, then try again", field: null };

	const form = document.getElementById("sign-in-form");
	const status = document.getElementById("sign-in-status");
	const button = form.querySelector('button[type="submit"]');
	const fields = { code: form.elements.namedItem("code"), label: form.elements.namedItem("label") };

	form.addEventListener("submit", (event) => {
		event.preventDefault();
		register();
	});

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
