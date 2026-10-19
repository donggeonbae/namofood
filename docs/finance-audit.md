# Finance audit and live consolidated refresh

## Behavior

- Consolidated reports check peer revisions every five seconds only while visible,
  refresh on re-entry/visibility and fetch encrypted state only when it changed.
  Month changes reuse cached snapshots. Reports never write business ledgers.
- Complete calculations retain their original meaning. If wages, supply prices
  or sales are missing, a separately labeled registered-known calculation is
  displayed. Missing expenses are excluded, not declared zero. Errors and missing
  rooms remain unknown. Desktop and mobile share the same amount renderer.
- Exact supplier aliases share one latest carried balance. Unrelated similar
  company names are not merged. Period-ledger pages without a single dated balance
  cannot override actual statement balances.
- Payment-after-balance shows net minus known balances as a labeled partial
  scenario if some vendors are unresolved. The strict field remains unknown.
  No known balances or missing tax-adjusted net still blocks the scenario.
- Blank preprinted catalog rows remain editable but no longer prevent checking
  the amounts on entered transaction rows. VAT blanks remain null.

## OCR diagnosis and bounds

The second existing OpenCode call reviews labels only: it cannot repair dates,
supplier headings or handwritten numbers. First-pass instructions now distinguish
period-ledger issuer headings, transaction dates and subtotal/cumulative rows, and
emphasize reading handwritten digits within their own horizontal row. Deterministic
validation recognizes issuer headings and checks entered rows despite catalog blanks.
There is no new retry, fallback provider or extra inference call: at most two calls
per extraction. The same stored source photograph was verified against the deployed
provider without registration or database writes.

## Production corrections

Source-backed corrections use encrypted pre-write snapshots, attachment hash/size
checks, per-order edit stamps, a fresh canonical read and updated-at compare-and-swap.
Original photos and unknown VAT values are retained. Inspection notes are attached
to affected records. Unresolved period-ledger duplicate policy requires an operator
decision; do not silently delete source documents or invent missing header totals.
No private originals, actual line items or credentials are committed here.

## Regressions

- `tools/test_finance_audit.cjs`: exact aliases, catalog blanks, registered-known
  arithmetic, unchanged strict unknowns and numeric partial settlement.
- `tools/test_overview.cjs`: three encrypted rooms, live changed-room refresh,
  no background peer reads on other routes, re-entry, failures, cached month changes,
  read-only state and desktop/mobile/print layouts.
- `tools/test_invoice_audit.ts`: ledger supplier heading, blank catalog retention,
  entered-row mismatch detection and first-pass instructions.
- Existing OCR, supplier, handwriting, receipt-header, spreadsheet, balance and
  payment-scenario tests remain required.
