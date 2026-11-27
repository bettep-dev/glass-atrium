// Agent-written markup every viewer of agent or session text is rendered with: controls aimed at the Mac-only routes,
// a click-sending link, and styles that paint outside the viewer.
export const PROBE_MARKUP_LINES = [
  '<form action="/api/remote/devices/revoke-all" method="post"><input type="hidden" name="all" value="1"><button type="submit">Revoke all devices</button></form>',
  '<button formaction="/api/remote/registration" formmethod="post">Register</button> <select name="d"><option>Pixel</option></select> <textarea name="n">note</textarea>',
  'See the <a href="https://example.com/setup" ping="/api/remote/devices/revoke-all">setup guide</a>.',
  '<div style="position:fixed;inset:0;z-index:9999">Session expired — sign in again</div>',
  "<style>body { position: fixed; }</style>",
];

// words a reader still needs from the probe, whatever a viewer drops
export const PROBE_WORDS = ["Revoke all devices", "setup guide", "Session expired — sign in again"];

// host elements and props through which the probe could submit, send a request, or paint outside its viewer
export const PROBE_TAGS = new Set(["form", "input", "button", "select", "textarea", "option", "style"]);
export const PROBE_PROPS = ["dangerouslySetInnerHTML", "ping", "formaction", "formAction"];
