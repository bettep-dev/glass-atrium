// The saved-file name a screen reads from a download's Content-Disposition: the name the server's header builder wrote.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { getAttachmentDisposition } from "../src/server/response-headers.js";
import { loadScreenModule } from "./lib/render-screen.js";

const UI_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../public/src/ui.jsx");
const ui = await loadScreenModule(UI_SRC);
const getAttachmentName = ui.getAttachmentName as (headerValue: string | null) => string | null;

describe("the name read back is the name the server's attachment header carries", () => {
  const rows = [
    { name: "the certificate download", file: "Glass Atrium Local CA.pem", ascii: undefined },
    { name: "a non-ASCII document title beside its ASCII fallback", file: "원격 접속 안내 (초안).html", ascii: "doc-44105.html" },
    { name: "the characters RFC 5987 escapes beyond encodeURIComponent", file: "it's (draft)! *final*.yaml", ascii: "draft.yaml" },
    { name: "a semicolon and a percent sign inside the name", file: "50% done; v2.txt", ascii: "done.txt" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      assert.equal(getAttachmentName(getAttachmentDisposition(row.file, row.ascii)), row.file);
    });
  }
});

describe("without a usable filename*, the plain filename or nothing", () => {
  const rows = [
    { name: "a plain quoted filename alone", header: 'attachment; filename="report.html"', expected: "report.html" },
    { name: "a malformed percent sequence falls back to the plain filename", header: "attachment; filename=\"report.html\"; filename*=UTF-8''bad%E0%A4%A.html", expected: "report.html" },
    { name: "a header with no filename", header: "attachment", expected: null },
    { name: "no header", header: null, expected: null },
  ];
  for (const row of rows) {
    test(row.name, () => {
      assert.equal(getAttachmentName(row.header), row.expected);
    });
  }
});
