# Invoice spreadsheet intake

`invoice-sheet-worker.js` reads XLSX, XLS, CSV and TSV locally in a disposable
worker (20-second deadline). It does not execute macros, formulas or external
links. UTF-8, UTF-16 and CP949 text are supported. Hidden sheets are reported
and skipped. Oversize sheets fail explicitly rather than being truncated.

The signed `nmf-invoice-ocr` spreadsheet request sends bounded, typed cells to
OpenCode Go / GPT-6 Luna. The fixed prompt maps cell addresses to invoice
fields; the server reads money from source cells, not AI-generated numbers.
One pooled label review follows. At most two provider calls are made per sheet.
This does not allow documents or the model to modify the production prompt.

Source files are encrypted separately under `#invoice-file#<sha256>` using the
existing shared-store/password mechanism. Shared invoice state contains only
small references, not file bytes. Files download on request only. Partial
imports remain retryable; completed identical files bypass AI. Existing
invoice duplicate review, arithmetic checks and manual edits still apply.

Saved sources also open in a read-only, local sheet viewer beside the editable
invoice (stacked on mobile). Sheet tabs, merged cells, dates and 50-row paging
retain source context. Only verified source bytes are loaded on demand; tabs
and downloads reuse that in-memory file without further transfer or AI calls.
The viewer does not reproduce embedded charts, drawings or every Excel style.

Vendored parser: SheetJS Community Edition 0.20.3, Apache-2.0.
Source: https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js
License: `xlsx-LICENSE.txt`.
Upstream installation: https://docs.sheetjs.com/docs/getting-started/installation/standalone/

Checks: `tools/test_invoice_sheet.ts` (Deno),
`tools/test_invoice_sheet_parser.cjs` and `tools/test_invoice_sheet_ui.cjs`
(Node, JSZip and Playwright; see the existing tools for runtime setup).
