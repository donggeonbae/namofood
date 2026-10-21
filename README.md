# Namofood

Namofood manages daily operations for a factory canteen, cafe, and store: meal plans, recipes, purchasing, staff schedules, sales, meal tickets, and financial reporting.

Switch between **Food**, **Cafe**, and **Store** at the top left. Their records are stored separately under the Supabase state IDs `namofood`, `namocafe`, and `namostore`.

## Access and data safety

The GitHub Pages repository is public, but the application body in `index.html` is encrypted with **AES-256-GCM** and decrypted in the browser. The shared unlocking password is not sent to the server. Separate server-side administrator authentication controls access to financial and sensitive records.

- Keep passwords, signing keys, tokens, and the plaintext application out of commits.
- Use a shared password of at least 12 characters; short passwords are vulnerable to offline guessing.
- Do not enable password remembering or register a trusted device on a shared computer.
- Photos submitted for recognition are sent to the configured AI provider. Check its data-handling policy and redact unnecessary personal information first.
- AI output and tax estimates require human review. The app does not file tax returns, issue tax invoices, or establish eligibility for tax deductions.

## Daily use

1. Unlock the application and select Food, Cafe, or Store.
2. Enter operational records in the relevant tab. Food has a separate **Tickets** tab directly below Sales.
3. Check the shared-save indicator after editing.
4. Authenticate as an administrator below the business switcher to view financial summaries, payroll, settings, and backups.

### Standard and administrator modes

The operational access rules introduced in **1019-21** supersede the narrower purchasing, staff, and company-ticket restrictions documented for 1019-18/20.

| Area | Standard mode |
| --- | --- |
| Purchasing | Upload photos and spreadsheets; edit items, unit prices, and amounts; compare originals |
| Food tickets | Company sales, unit prices, opening balances, statements, and existing daily transactions |
| Sales | Enter operational counts and other sales for each business |
| Cafe | Enter daily POS revenue and other sales instead of cup counts; automatic POS integration is not implemented |
| Staff | Edit names, roles, default shifts, and regular days off; add/archive/restore/remove roster entries; retain the shared administrator-defined order |
| Archived staff | Manually mark payment complete without displaying an amount or overwriting wages, shifts, or payment amounts |
| Private areas | Monthly purchasing and outstanding-balance summaries, card records/AI matching, profit, consolidated profit, fixed costs, settings, backups, and sensitive payroll details remain administrator-only |

The two modes share the existing screens, recipe filters, ingredient editor, and day/week/month schedule. Standard mode hides restricted fields rather than replacing Home or Sales with a simplified interface. Monthly staff names do not wrap.

The administrator login has explicit text colors and a centered lock button. The old 15-minute failed-login lockout is removed; repeated clicks have a one-second interval. Refreshing, switching businesses, or reconnecting relocks administrator mode. Sessions last at most four hours, and administrator passwords/tokens are not remembered in browser storage.

`nmf-access` authorizes requests on the server. Standard saves merge only allowed operational fields into the latest state; they cannot overwrite restricted payroll, tax, or settings. Recipe, cooking-method, hygiene, and menu-description edits merge by their operational edit timestamps. Separate server authentication for scheduled recipe/tax work and the Coupang connector remains in place.

Standard device caches contain only public fields. Administrator drafts are encrypted with a high-entropy key received after authentication, never with the six-digit administrator password itself. Legacy full-state caches and card drafts are preserved as administrator-only `@local-draft-*` server backups before removal from the public cache. Failed uploads trigger a close-window warning; drafts remain downloadable from administrator backups. Previously downloaded or exposed copies cannot be recalled.

Access rollout order: secret hashes/signing keys, private attempt-limit table, `nmf-access` and related functions, encrypted web app, then SQL blocking direct public-table access. If deployment fails, preserve records and repair the access functions rather than reopening public access.

Checks: `test_guest_business_policy.cjs`, `test_guest_staff_policy.cjs`, `test_guest_business_access.cjs`, `test_guest_store_sales.cjs`, `test_operational_documents.ts`, `test_access_policy.cjs`, `test_admin_access.cjs`, `test_access_live.cjs`, and `admin-auth_test.ts` under their existing tool/function directories.

### Navigation and business boundaries

Food and Cafe place **Profit → Consolidated Revenue & Profit** immediately below Fixed Costs. Store hides Staff/Schedules and Fixed Costs; after Sales it shows Profit, Consolidated Revenue & Profit, and Settings. Moving menus does not alter records.

Store profit excludes labor, fixed costs, and supplies while preserving any existing records. Settings shows tax-reference calculations rather than hourly-pay and insurance settings. Food and Cafe calculations are unchanged. Checks: `node tools/test_navigation_order.cjs`, `node tools/test_store_simple_profit_tax.cjs`.

Store starts with empty product, staff, and fixed-cost lists. Product Management supports names, free-form categories, units, selling prices, optional purchase prices, and deletion. Daily sales preserve the name and price at the time of sale, so later product edits/deletions do not rewrite history. Edit historical quantities/prices on the relevant date; clearing a quantity removes that sale. Price lists, day/week/month navigation, CSV, purchases, cards, and backups are supported. Timestamps and deletion markers prevent stale devices from overwriting or reviving records. Check: `node tools/test_store.cjs`.

## Food tickets, sales, and profit

### Company sales and ticket returns

Company ticket sales and tickets returned by diners are separate:

- Enter `0` on a day with no company sale. Zero means zero sales; only a blank uses historical return-based revenue compatibility. Bulk purchases do not have to match daily returns.
- Save company names by date. A collapsed company editor supports multiple companies on one day, each with its own quantity and historical price. Changing the default company does not rename earlier transactions. With multiple companies, edit details rather than the read-only top total.
- Opening unreturned quantity defaults to zero. The running balance is **opening quantity + company sales − Food returns − Store returns**, carried across months. Cash, card, and credit meals are excluded.
- Store contributes only tickets actually received; it does not issue or sell company tickets. If Store cannot be read, show an unknown combined balance and a separate Food-only reference balance.
- Company, quantity, price, and deletion fields synchronize with individual edit timestamps. Read encrypted Store state initially and on changes; Food Sales/Profit checks revisions every five seconds without overwriting active drafts.

Sales, statements, server tax calculations, and sales reports retain the company-sales basis. Consolidated reporting keeps Store ticket-settlement performance but removes that settlement amount once from combined revenue on dates with explicit company sales, including zero. Historical blank-sale fallback dates retain Store performance. Enter the actual company sales history to replace this compatibility estimate.

Food Profit defaults to returned Food tickets plus cash, card, credit, and other sales. The optional **Include cumulative unreturned-ticket balance · reference** adds the running quantity times an explicitly stated valuation price once to both current and monthly projected profit; it is never multiplied by the daily average. Negative or unknown balances defer this addition without changing the base profit. Negative quantities remain warnings, not negative revenue deductions. The checkbox and valuation price are local display settings, not ledger, tax, or statement edits. This is a historical valuation scenario, not confirmed revenue or available cash; cost ratios exclude this adjustment.

Company statements use only the selected company's quantities and prices. Generate a PDF, store it encrypted, then view/print it, or attach an externally received original. Ticket files use a separate list and load on demand. New files use `#ticket-document#`; legacy files open only after verification against the ticket list. Attaching a file does not change sales or issue a tax invoice. Cash/card/credit labels reserve equal two-line height to align inputs.

Checks: `node tools/test_ticket_companies_store.cjs`, `node tools/test_food_ticket_store_sync.cjs`, `node tools/test_profit_ticket_basis.cjs`, `node tools/test_food_ticket_ledger.cjs`, `deno run tools/test_tax_company_tickets.ts`, and `node tools/test_sales_report.cjs`. These cover company/date separation, price-specific statements, deletion/sync, encrypted Store reads, draft preservation, one-time balance valuation, unchanged originals, and 320–1440px layouts.

### Store payment channels and stock

Store separates product units sold by ticket/card/cash from the number of tickets actually received. One ticket is fixed at KRW 10,000. Card/cash revenue uses the historical selling price. A blank received-ticket quantity uses the legacy quantity-times-price reference; an explicit quantity, including zero, replaces it with ticket settlement revenue. Both values and their difference are shown without adding them together. Physical units sold remain unchanged. Profit, consolidated comparisons, CSV, and saved state use the same settlement basis; nothing is automatically added to Food company-ticket sales.

Standard Store mode retains operational sales inputs. The server preserves historical selling/purchase prices when quantities change; standard responses omit restricted amounts. Inventory responses contain product names, received quantities, and pack links without private values. Legacy unclassified sales are not silently allocated; received-ticket counts are not guessed from selling prices.

Purchased items are added to the sales product list when Sales opens. Product Management sets the initial selling price and sales unit; a box purchase price is never assumed to be a per-unit selling price. Duplicate or deleted products are not re-created.

In **Coupang receipts, sales, and remaining quantity**, link an ordered pack to a product and enter sales units per pack: for example, 24 cans × 2 packs = 48 cans. Confirmed receipts through the selected date minus cumulative sales give the reference remainder. Unlinked products or unknown quantities/pack sizes are not confirmed stock. Opening inventory, other suppliers, waste, and returns are outside this comparison; order dates may differ from receipt dates.

Imported non-sale items can be excluded and restored. Stable item keys and edit times prevent re-imports, sorting, or stale devices from reviving exclusions. Neither actual Coupang orders nor card payments are changed. The collapsed date-based removal section deletes only the imported review list, preserving registered purchases, inventory, and sales.

Checks: `node tools/test_coupang_date_removal.cjs`, `node tools/test_store_payment_channels.cjs`, `node tools/test_store_stock_tickets.cjs`, `node tools/test_store_cloud.cjs`, and `node tools/test_store.cjs`.

### Consolidated revenue and profit

This read-only monthly view compares the three businesses' recorded revenue, actual purchase costs, pre-tax profit, and margins. Food/Cafe include schedule-based labor, fixed costs, and supplies; Store uses revenue minus purchases and marks other costs as excluded.

The active business uses current device inputs; other businesses use saved server records loaded on entry or explicit refresh. Displayed whole-won amounts are summed. Missing/failed reads show unknown values and partial totals rather than zero. No sample staff or menus are inserted into another business. The comparison does not mutate ledgers/payroll, and excludes tax, month-end forecasts, inventory valuation, and other inter-business eliminations beyond the ticket rule above. Check: `node tools/test_overview.cjs`.

## Shared state and synchronization

Meal plans, shifts, sales, hygiene records, and other app state are encrypted with the shared application password. Supabase stores one current-state row and dated backups such as `namofood@YYYY-MM-DD`, retained for up to one year. Edits save after three seconds. Other devices check for changes every five seconds or when the page becomes active.

`nmf_state_revision` returns only the update time and ciphertext SHA-256. Full state downloads occur on first load, manual reload, or a real change. Different ciphertexts with identical timestamps remain distinguishable. A missing/broken revision function falls back to full reads and retries lightweight checking after one minute. Custom tables keep full reads; pre-save reads and compare-and-swap (CAS) protection remain.

The revision function is installed by `supabase/migrations/20261011133500_nmf_state_revision.sql` and follows existing table grants/RLS without changing operational rows or access policies. Check: `node tools/test_cloud_egress.cjs`, which compares real browser traffic against a simulated server.

Print-meal selections, display options, and general settings save only fields changed from the last synchronized value. Stale screens cannot revert another device's headcounts, prices, or ratios. Independent field edits merge; role/pay edit timestamps remain authoritative. Edits made while saving/loading are protected, and ciphertext comparison distinguishes close or identical save timestamps. Check: `node tools/test_cloud_settings_sync.cjs`.

<details>
<summary>Historical shared-table bootstrap (not the current access policy)</summary>

The original setup used the SQL below in the Supabase SQL Editor. **Do not apply these anonymous-write policies to a deployment protected by `nmf-access`.** The administrator rollout above subsequently blocks direct public-table access. This reference preserves the original setup context; encryption alone does not prevent deletion or overwrites.

```sql
create table if not exists public.namofood_state (
  id text primary key,
  data text not null,
  updated_at timestamptz not null default now()
);
alter table public.namofood_state enable row level security;
create policy "namofood anon read" on public.namofood_state for select to anon using (true);
create policy "namofood anon write" on public.namofood_state for insert to anon with check (true);
create policy "namofood anon update" on public.namofood_state for update to anon using (true) with check (true);
-- Optional historical policy for cleanup of dated backups:
create policy "namofood anon delete old" on public.namofood_state for delete to anon using (id like 'namofood@%');
```

The original **Save / Backup → Shared storage** setup accepted a project URL and anon key unless supplied by the build. Keep backups even when state is encrypted.

</details>

## Purchasing: invoices and spreadsheets

### Recognition and review

In Purchasing, upload up to eight JPG/PNG/WebP photos. `nmf-invoice-ocr` reads the table and reviews product labels before automatically registering each valid extraction. Suspected duplicates require confirmation first. Review/edit dates, suppliers, statement numbers, item names, specifications, quantities, units, unit prices, supply amounts, VAT, totals, current delivery amounts, prior unpaid balances, and inclusive balances.

- Preserve unreadable values as blanks. Quantity × price, item-total, and supply-plus-tax mismatches produce review messages rather than invented corrections.
- Recipient/buyer labels such as “Namofood, attention” are not suppliers. Accept a supplier only when the source identifies one unambiguous supplier name. Multiple names, missing names, business numbers alone, or account-holder names alone leave the supplier blank for review.
- For statements showing prior unpaid balance, current transaction amount, and their combined total, count **only the current transaction** in purchases. Carry-forward balances remain separate reference information.
- Preserve item-level taxable/exempt amounts. Blank VAT stays blank and is not itself a special note. Keep other uncertainty warnings, genuine mismatches, and manually written notes.

Quantities, prices, amounts, balances, and ingredient requirements use thousands separators in the screen and print views. Editing preserves decimals, negative values, long numbers, and the cursor without changing stored values, calculations, or CSV numbers. Dates, invoice numbers, specifications, and units are not formatted as money.

The top monthly summary always covers the selected month, even when a date, week, invoice, or card tab is selected. It excludes card records and transactions awaiting duplicate confirmation. Statement-level supply/tax totals take precedence; absent totals are summed only when all corresponding item amounts are known. Unknown VAT is not zero.

The inclusive outstanding reference balance counts the latest statement per supplier once for the month. Missing latest balances, conflicting same-day balances, absent dates, or missing suppliers remain review items; this is not a payment-settlement ledger. Date-specific prints omit the full-month reference summary.

Progress shows **prepare → recognize → register**, using completed stages and elapsed recognition time rather than a fabricated recognition percentage. Completion, registration, failure, and duplicate exclusion are counted separately. Registration completion and shared-save completion are distinct.

Uncertainty and amount mismatches do not block registration; editable multiline notes and separate recognition/arithmetic warnings remain. Exact photos are deduplicated. Same supplier/statement number, or near-identical same-supplier/date item lists, trigger a comparison with choices to open the existing invoice, register a distinct transaction, or cancel. Matching dates alone do not block registration.

Explicit distinct-transaction approvals synchronize to the server. A final duplicate check runs before shared save, including concurrent registrations from other devices. Unconfirmed candidates are excluded from totals, CSV, and server saves. Records are placed in their transaction month.

Monthly/weekly calendars show daily invoice counts and delivery amounts. Selecting a date opens that date's invoice tab; whole-period view clears the date filter. Weeks span seven days across month boundaries. CSV and print respect the date/period selection and include all selected records, not just the current page. Arrow/Home/End navigation works on tabs; mobile tabs wrap. Printing restores the previous selection/collapse state afterward.

CSV includes specifications, VAT, and totals and guards against spreadsheet-formula execution. Numeric input text shrinks to fit long values without hiding digits or rounding them. Stable invoice/item IDs preserve the correct edit target when another device reorders a table. New OCR cannot overwrite manual edits/deletion markers, and an explicit backup restore applies the selected purchase list.

Recognition sends photos to OpenCode's image model. Do not log photos or raw OCR text. Registration does not mean comparison with the original is complete. Source-file retention depends on the intake path: encrypted saved spreadsheet sources are documented below; older photo-intake records may not retain an original.

Checks: `node tools/test_invoice_number_format.cjs`, `deno run --deny-env --deny-net tools/test_invoice_supplier.ts`, `deno run tools/test_invoice_ocr.ts`, and `node tools/test_invoice_ocr_ui.cjs`.

### Spreadsheet and period-ledger intake

Purchase classification previews existing invoices before any move. The operator
confirms line destinations: food ingredients, store beverages, or Food fixed-cost
purchases. Clear new invoices can be classified after shared save; uncertain
items and non-food Coupang purchases require confirmation. Mixed statements must
balance exactly before splitting. The server locks both business roots, retains
encrypted originals and recovery snapshots, and records an idempotent routing
journal. Classified one-off costs are dated expenses, not recurring allowances.

Exact duplicate review compares every item field as a multiset and all header
amounts. Fully populated, arithmetically consistent duplicates use the newest
upload and retain older evidence outside totals; incomplete matches require
explicit review. Signed return/credit amounts can be shared without breaking
the original-file linkage.

Store catalog removal is shared across purchase, product, and sales-entry lists.
Historical transactions and amounts remain available in the archived-items view.
The per-unit purchase-cost calculator divides a purchase line amount by an
editable total unit count; volume/weight is never treated as a piece count.

Plain item-count text is a total, not an implicit pack: `Pepero 50g, 30 items`
means 30 pieces even when the quantity column also says 30. Multiplication is
used only for an explicit pack description or an operator-confirmed pack factor.
The same parser drives stock and suggested per-unit cost. Missing catalog costs
are filled where the count and purchase amount are clear; operator-entered and
historical sale costs remain unchanged. Uncertain counts have per-item warnings.
Imported catalog entries retain separate invoice-line identities even when their
names match, with links to the relevant purchase records and saved originals.

Classification previews preselect suggested moves. Operators can select/deselect
lines, choose a shared destination, and confirm the selected transfer. Unselected
lines remain in their original business; saved originals and totals are retained.
Active classified receipts can be corrected without reaggregating archived sources.

Food's shared Fixed Costs screen exposes only procurement-routed fixed-cost
receipts and their linked invoice originals. Recurring fixed costs, general
documents/contracts, payroll, and financial reports remain administrator-only.
The server projects receipt fields explicitly and ignores guest attempts to edit
the protected fixed-purchase records; private-document namespaces stay closed.

See [Invoice spreadsheet intake](assets/README-invoice-files.md) for local XLSX/XLS/CSV/TSV parsing, encrypted originals, and the side-by-side source viewer.

Recognized line-ledger layouts contain date/transaction number, item/specification, quantity, unit price, supply amount, VAT, total, counterparty, and description columns, plus a company/period heading. Read their original cells directly and group by date and transaction number. Never allocate one daily subtotal to multiple same-day transactions. Identify the supplier from the company heading and distinguish it from buyer columns.

The general limit is **1,000 items**, with **500 characters each** for item names and specifications. Separate file/cell/row safety limits remain. Preserve unpriced items, negative returns, and blank VAT, and check subtotals/grand totals.

Period ledgers carry `sourceAudit.sourceType=period-ledger` and are stored as references excluded from duplicate aggregation. Intake does not automatically delete existing invoices, change amounts, or switch the accounting basis. Checks: `deno run tools/test_invoice_ledger.ts`, `node tools/verify_invoice_ledger_files.cjs <ledger.xlsx>`.

### AI provider and request boundary

Use the selected **OpenCode Go** plan and **Claude Haiku 5.5**, model `claude-haiku-5-5`, at `https://opencode.ai/inference/go/anthropic/v1/messages`. This model also serves recipe generation, recommendations, tax review, card matching, and Coupang organization; references to GPT-6 Luna or Zen in earlier operating notes describe previous configurations.

The shared app secret is `NMF_PW`. Provider keys are resolved from `NMF_INVOICE_API_KEY`, then `OPENCODE_GO_API_KEY`, then legacy `OPENCODE_API_KEY`. Keep their values outside source control.

Photo recognition uses native image input and distinguishes completed, refused, and truncated output. A second text-only pass reviews item names/specifications/units. It cannot change amounts, dates, suppliers, raw OCR, numeric/package specifications, or guess missing units. Preserve valid recognition if label review fails; display original labels and complete/partial/failed status. At most two calls share the request deadline, without automatic retry.

Do not send OpenAI-only `store` or `reasoning` options to Anthropic Messages. `NMF_INVOICE_MODEL`, if set, must be `claude-haiku-5-5`; `NMF_INVOICE_BASE_URL` accepts only the Go endpoint. `NMF_INVOICE_TIMEOUT_MS` defaults to 100 seconds and is capped at 120 seconds. Use the actual app identity in User-Agent and a signed-request-based session ID for each photo conversation.

Go's published usage is oriented toward coding agents; generic web-app OCR support is not guaranteed. Surface key/subscription/limit errors without disguising the use case or switching to paid Zen calls. Provider retention policies apply separately.

Server connection checks establish configuration presence only. Real recognition is needed to establish provider authentication and extraction accuracy. Requests use a 60-second HMAC including the full-body SHA-256, and validate allowed origins, real file types, the 8MB image limit, replay, and concurrency. No public Storage or additional database permissions are introduced.

`tools/verify_invoice_photo.cjs` processes only operator-selected originals passed through `NMF_INVOICE_PHOTOS`, with `NMF_PW` supplied securely in the environment. It compares item counts/totals without registering purchases or writing business data. Set `NMF_EXPECTED_OCR_MODEL=claude-haiku-5-5` and `NMF_EXPECTED_OCR_PLAN=go` to verify configuration before sending photos.

After deployment, `node tools/test_live_invoice_status.cjs` checks the encrypted page and signed status endpoint without photos, provider calls, or operational writes. Offline OCR tests use synthetic statements.

### Card transaction photos

**Purchasing → Card records** is separate from invoices. Upload up to eight JPG/PNG/WebP card-statement photos/screenshots to the authenticated `documentType:"card"` branch of `nmf-invoice-ocr`. It uses one provider call per photo, with no retry or paid fallback.

Progress shows prepare, recognize, then review/register. Review payment date, 24-hour time, merchant, KRW amount, authorization/cancellation, card label, last four digits, approval number, installments, and notes before registering selected transactions. Unknown dates/amounts are not replaced with today/zero. Missing required fields or ambiguous authorization/cancellation must be corrected first. Non-KRW transactions are unsupported.

Authorizations and cancellations are distinct positive-amount records; totals show authorized, cancelled, and net amounts. Exact photo rows are not re-registered. Similar approval numbers or date/time/merchant/amount/card combinations start unselected and require confirmation as distinct transactions. Concurrent duplicates are checked before save. Card amounts are never automatically added again to invoice totals, ingredient requirements, or profit.

The view provides calendars, merchant/card/note search, authorization/cancellation filters, 20-record pages, collapse/expand, editing/deletion, CSV, and print. Exports cover the entire filtered period. Invoice and card views share the order: date calendar, period summary, then upload.

Card photos/raw OCR are not retained in app/server storage. Both client/server filter full/partial card numbers, accounts, contacts, CVCs, and passwords; only the last four digits are allowed. Pre-registration results can remain on-device without the photo. Registered `cardTransactions`/`cardEdits` join encrypted state and dated backups. Explicit deletion markers prevent resurrection; older states lacking card fields cannot erase card records. Compare with the original manually.

### Removing documents

Invoice deletion removes that purchase and its totals. Deleting an archived ledger removes only its original archive entry, retaining linked daily aggregates. Removing a photo/spreadsheet attachment removes its source link without changing the extracted table or amounts.

Fixed-cost, ticket-statement, and payroll-transfer document libraries also support confirmed deletion. Removing a document does not change costs, sales, or paid status. Shared encrypted originals may be retained on the server rather than permanently deleted. Check: `node tools/test_document_deletion.cjs`.

## Coupang completed-order connector

### Web-app login

**Store → Purchasing → Coupang login** controls one dedicated Coupang login tab on the Mac mini from an in-app dialog. It does not iframe Coupang or copy another device's cookies.

For a new browser, compare the ten-digit confirmation code in the web app and Mac mini approval window, then approve on the Mac mini. Default/timeouts deny access. Approved browsers can reconnect for 90 days. This is device approval, not per-employee accounts/RBAC. Clearing approval removes the browser's private key and requires a new approval.

The browser keeps a non-exportable ECDH private key only in IndexedDB. The Mac mini records directly approved public keys in a mode-0600 `devices.json`; a forged server approval cannot override that local list. Fresh session keys use ECDH/HKDF/AES-GCM for screens and input. Supabase Realtime carries only ciphertext on random 256-bit topics, without recording or database playback. Job rows contain encrypted public keys, device proof, and connection metadata.

Do not persist passwords, verification codes, cookies, keystrokes, or login screens to the database/logs/AI. Service credentials and the local Chrome debugging port are not exposed to the web client. No separate public port, tunnel, or Browserless account is required.

The viewer exposes only its dedicated tab, not other tabs, the address bar, files, or automatic clipboard reads. Navigation is limited to login/completion checks; purchase/cart/payment/cancellation requests are blocked. External-popup authentication may require direct Mac mini interaction.

Sessions last at most five minutes; unresponsive connections close after 20 seconds. While the viewer is open, changed frames are sent at most once per second. There is no continuous recording/full-state sync. Login is reported complete only after real order-list and logout markers are confirmed; registering orders remains a separate choice.

The viewer identifies the focused input, lets users review a visible draft and send it explicitly, masks passwords by default with an optional reveal, supports next-field navigation, and acknowledges input. A changed input target rejects the submission. Draft input is not saved. The obsolete “open Mac mini login window” button is removed.

`NMF_COUPANG_WEB_LOGIN_DISABLED=1` stops new device registration/web-login requests while keeping order reads. Active sessions end within five minutes or immediately after a normal connector restart. Chrome login is preserved.

Checks: `node --test tools/test_coupang_remote.mjs`, `deno run --deny-env --deny-net tools/test_coupang_remote_handler.ts`, and `node tools/test_coupang_web_login.cjs`. Isolated tests cover encryption, replay/tampering, unapproved devices, other-tab preservation, old-session isolation, remote input, completion, mobile width, and unchanged ledgers. They do not auto-approve production devices, audit the entire app, or guarantee every physical iOS/external-verification flow. An earlier dependency check reported zero findings from `npm audit --omit=dev`; recheck dependencies before relying on that historical result.

### Importing and reviewing orders

Select up to 93 days in **Store → Purchasing → Import Coupang orders**. The dedicated Mac mini Chrome profile reads completed orders; OpenCode Go organizes items, specifications, quantities, and actual amounts.

Use the top select-all/date controls to review, exclude, or edit items, then register selected purchases and inventory together. Confirm product links and pack sizes before treating remainders as stock. Successful registration clears the entire current review list, including unselected items, without deleting actual Coupang orders. Completion markers synchronize in encrypted shared state so old results do not reappear.

If validation/local save fails, roll back registration and completion together and retain the review list. Temporary status failures retry at 2–30-second intervals for at most 15 minutes without duplicating imports/AI jobs. Results appear automatically; tab return/reload resumes from the saved job ID.

No purchases, payments, or cancellations are automated. Users complete credentials/additional verification on the official Coupang page, including through the dedicated viewer. Expired sessions and access blocks remain errors, never successful connections.

`connectors/coupang` polls a signed Supabase job queue without opening an external port. Its Chrome profile is isolated at `~/Library/Application Support/Namofood/Coupang/chrome-profile`. It does not read/change the normal Chrome profile or send cookies/passwords to the app, Supabase, or AI. Ordinary Chrome connects through a temporary 127.0.0.1 debugging port only.

Order text sent for organization excludes email/contact/address fields and payment-method areas. Results use AES-GCM with a separate strong key and are readable for 24 hours; old ciphertext is cleaned on a subsequent import. Only order numbers, completion state, items, and total payments are submitted. The browser keeps a job ID in sessionStorage to resume checking.

Private tables `namofood_private.coupang_jobs` and `coupang_connector` have RLS and block direct `anon`/`authenticated` access. The app uses password-based HMAC; the Mac mini uses a separate connector-key HMAC. Signed bodies/roles and expiring execution leases prevent cross-job completion and duplicate AI calls. Repeated requests return existing work; status reads do not download the full ledger.

Each order number maps to a stable purchase ID. Imports never overwrite/revive orders already registered, edited, or deleted. Partial registration sums only verified selected-item amounts without inventing shipping/discount allocation; edit further through the existing purchase. Unknown VAT/unit prices/quantities remain blank.

One run reads at most ten list pages and 60 order details; reaching a limit produces a partial-results warning. Prefer a uniquely identified source total tied to the same order number/detail URL. Missing AI total evidence must not trigger an invented item sum; conflicting or cross-order totals are not auto-corrected. Revalidate changed Coupang layouts against authorized read-only account results.

The date range and saved purchase date use the explicit **order date**, never the delivery/arrival date. Eligible paid/confirmed orders include order/payment completion, preparation, shipment and delivery states; canceled/returned/refunded orders remain excluded. Detail headers are checked separately from delivery dates, even when both dates occur in the source.

The browser whitelists product subtotal, discount, shipping and paid-total monetary lines without copying recipient/card details. A uniquely matched single-product order uses its observed paid total as the item amount, including its order-level discount/shipping. For multi-product orders, observed prices are interpreted as unit or line prices only when quantities and the printed product subtotal disambiguate them; quantity-one rows can retain their observed price directly. Multi-product discounts/shipping are not allocated arbitrarily. Ambiguous amounts remain blank with a review warning, and source-based amount notes are visible in the import preview. Checks: `deno run tools/test_coupang_order_amounts.ts`, `node tools/test_coupang_order_read.cjs`, and `node tools/test_coupang_ui.cjs`.

Standard details with an explicit matching order number/URL, order-date header, eligible status, complete product rows, uniquely printed subtotal and paid total are parsed directly and run through the same source validation. Their printed subtotal must reconcile with the observed rows before bypassing AI. Only unfamiliar/ambiguous pages go to the existing AI batches; `extraction.sourceOrders` and `extraction.aiOrders` describe the result. Formatted numeric JSON strings on the AI path are normalized only when they are canonical integers, and verified complete source rows take precedence over invalid proposed AI money.

AI organization uses batches of at most four source pages (16,000 input characters), with at most three concurrent requests and an 85-second overall AI deadline. A token-limited batch is split, never accepted as a partial JSON result. Detail-page references are bound to the explicit order number and exact detail URL before applying the existing date/status/item/amount grounding checks. Eligible detail orders omitted by AI fail validation. Legacy evidence-shaped responses remain validated against their source. Diagnostic errors distinguish output limits, refusals, and model mismatch without storing raw AI responses or credentials.

The date picker defaults to the day after the last fully successful import, through today (today again if already current). Its small signed `defaults` request reads a durable private connector cursor, independent of the 24-hour encrypted preview retention. Failed or truncated scans, expired diagnostic jobs, and login tasks do not advance this cursor; overlapping older retries cannot move it backwards. Manual date edits are protected from delayed defaults responses. Without a successful cursor, the current month is used; an existing purchase's date is not treated as proof of complete coverage.

Regression checks: `deno run tools/test_coupang_ai_batches.ts`, `deno run tools/test_coupang_cursor.ts`, and `node tools/test_coupang_date_defaults.cjs`. The opt-in `tools/test_coupang_live_import.cjs` verifies actual signed browser-to-worker-to-AI retrieval and automatic preview rendering while blocking every business-ledger write. It requires `NMF_COUPANG_LIVE_IMPORT=1` and a securely injected `NMF_PW`; it never registers selected purchases.

The evidence/statement-printing guide links official desktop issuance routes and National Tax Service deduction guidance. App purchase prints are management reports, not tax invoices/card slips or deduction applications. Opening official Coupang pages may require another sign-in.

### Installation and rollback

Requires Node 24+, Google Chrome, and an initial `npm ci --ignore-scripts` inside `connectors/coupang`.

```sh
cd connectors/coupang
node install.mjs --provision
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.namofood.coupang.plist"
```

The installer creates a random 256-bit connector key in a mode-0600 configuration outside the repo and provisions `NMF_COUPANG_WORKER_TOKEN` through standard input, never command arguments/output. Executables are copied to Application Support so later Git edits/document-folder permissions do not control the installed worker.

The worker starts at user login and appears offline during shutdown, logout, sleep, or network failure. Worker startup is separate from Coupang authentication. Dedicated Chrome survives worker restarts; the next worker verifies the local profile/process before reconnecting. Users must select Coupang's automatic-login option themselves and reauthenticate when account security policy expires a session.

Stop the worker:

```sh
launchctl bootout gui/$(id -u)/com.namofood.coupang
```

Stopping preserves registered purchases and Chrome login. If removing local files, handle the profile and connector configuration separately. Rotate server/local connector keys together. Protect the shared app password and Mac mini account.

Protocol/browser/UI checks: `node --test tools/test_coupang_protocol.mjs`, `node --test tools/test_coupang_browser.mjs`, `node tools/test_coupang_read.cjs`, `deno run --deny-env --deny-net tools/test_coupang_handler.ts`, `node tools/test_coupang_ui.cjs`, plus Store/ledger merge regressions.

<details>
<summary>Historical connector verification and known gaps</summary>

Earlier isolated OpenCode Go GPT-6 Luna tests exercised provider calls, JSON validation, and encrypted results without business-ledger writes; temporary jobs were removed. Unsupported `text.format:json_object` was not sent. Source evidence and result structures were validated server-side.

The operating notes record a 2026-10-19 end-to-end check from the web app through queue, order details/pages, AI organization, encrypted results, and fresh-client recovery: 12 completed October orders and 14 items, with zero purchase-ledger writes. Order tabs were reused without overwriting unrelated tabs. These are historical observations, not proof that the current account is authenticated or that every imported item belongs to the business.

At baseline `9404387` and the associated change, five existing card-history checks failed whole-state comparisons involving `recipeResolutions`/`salesEdits` initialization. Those test expectations/card behaviors were not changed in that connector work. Physical iOS keyboards and every additional-verification screen remained unverified.

</details>

### Store tax reference

Store Settings automatically combines recorded sales, ticket settlement, other sales, and registered purchases through today. It distinguishes an all-sales-taxed-at-10% scenario from VAT actually recorded on invoices. Blank VAT is not filled and input-tax eligibility is not established.

Annual income tax is a simple scenario based on entered year-to-date records, not one month multiplied by 12. Missing purchase amounts defer the scenario. Inventory, actual deductible expenses, other income, deductions/credits, and prepaid taxes are not fully represented. A collapsed manual-conditions calculator remains available.

## Recipes and meal planning

### Manual meal operation

Automatic meal-plan generation ended at the operator's request on **2026-10-08**. Daily generation and 15-minute retry schedules are disabled. Even authenticated requests return `disabled:true` and zero generated/saved meals. `force`, `retry`, `preview`, and environment variables cannot re-enable it. Run history/backups remain; automatic missing-recipe filling operates separately.

Each KRW 10,000 meal has default white rice, soup, three substantial mains (meat, fish/seafood, and another main), and two vegetable sides, with flexible additions/removals. Breakfast, lunch, dinner, and late-night service are supported. Soup, vegetables, or dessert must not replace a substantial main.

The [meal-composition manual](docs/menu-composition-manual.md) is derived from verified human-edited historical meals rather than treating AI drafts as authoritative. Choose the main ingredient first, then cooking method. Existing cells do not move/disappear merely because categories or layouts change; only explicitly applied meals change.

AI labels/banners are removed from published meal plans. Explicit AI-meal cleanup preserves manual meals, headcounts, default rice, and recipes. Cleanup uses encrypted backups, latest-state conflict checks, read-after-write verification, exact deletion markers, and manual edit times to prevent old screens from reviving removed content.

Photo-plan headcounts through **2026-10-12** remain. From **2026-10-13**, only photo-plan-derived values were cleared after backup; manual counts and sales remain. Photo-plan wording/icons are hidden.

Expected meal counts and actual ticket/return records are separate. Expected counts feed meal plans, recipes, and ingredient requirements; an empty Food expected count is zero, while Cafe retains its previous default servings. Earlier expected-versus-actual comparisons use actual minus expected and distinguish blank sales from explicit zero. Newer company-ticket and profit basis rules are described above. The original six sales CSV columns are retained, with expected/difference fields appended. Check: `node tools/test_sales_expected_actual.cjs`.

### Selecting recipes and rice

Food recipe/meal pickers follow **main ingredient → cooking method**. Meat groups beef, pork, chicken, and duck, with collapsed subcategories. Other top groups are fish/seafood, vegetables, and other dishes. Meat methods include stir-frying, grilling, steaming, braising, frying, pan-frying, and boiling; empty categories display zero and are disabled.

Boiled pork dishes belong under boiling, chicken galbi/marinated stir-fries under stir-frying, and karaage/chili-fried chicken under frying. For ambiguous names, use a clearly established main cooking step; preparation-only, sauce-only, or conflicting methods leave the dish unclassified. Name/ingredient search works with soup/main/side filters. Unclassified dishes remain selectable; Cafe categories are unchanged.

Below direct entry and clear, **Choose from all menus** searches every registered dish beyond slot categories, excluding forbidden items such as alcohol. Returning to slot categories preserves collapsed recommendations. Clicking the default-rice display opens alternatives such as curry or black-bean-sauce rice. Rice stays in slot 0; clearing restores white rice. Choices flow through viewing, print, CSV, purchasing, and previous-day/month copies without changing other dishes/headcounts. Check: `node tools/test_menu_all_rice_picker.cjs`.

The historical temporary-meal workflow lets users collect soup, three mains, two vegetable sides, and extras, then apply to a selected date/meal after replacement confirmation. Until applied, choices are unsaved and absent from print. Application changes only that meal's dishes and marks them manual, preserving headcounts/shifts.

`tools/institutional_catalog.ts` contains AI-authored bulk-cooking drafts informed by publicly available catering menus, not copied official recipes. Ingredients are per person and work instructions per 100 people. Kitchen staff must adjust for equipment, delivered specifications, and serving sizes. Imports add only new names/aliases without overwriting existing recipes.

### Automatic missing recipes and bulk-cooking conversion

Save a meal to request missing recipes immediately; a once-per-minute check catches missed requests. Generated recipes are merged into the latest state after conflict checking, including while other fields are edited. Internal screens refresh actual start time, phase, estimated completion range, and next check/retry every five seconds. External notices/prints contain no AI labels.

Requests use short-lived password HMAC signatures, not a client-visible cron secret. A database claim allows one concurrent run. Ingredients remain **per person**, while methods are **100-person institutional cooking worksheets**, specifying large kettles, fryers, griddles, capacity-based batches, and service finishing. Household pans/spoon measures are rejected; ovens are optional. Instructions follow the food-safety heating/holding criteria described by the recipe policy.

After new missing recipes, convert at most two older household-style AI methods per run. Preserve ingredients, amounts, allergens, provenance, and manual recipes. Fingerprints/CAS protect concurrent edits; create a unique encrypted backup before conversion. The recipe screen shows conversion queue/progress, 100/300/500-person calculations, and one-page A4 worksheets. Restored methods are protected as manual choices.

Read-only audit: `NMF_PW=... deno run -A tools/audit_bulk_recipes.ts`.

Food ingredient requirements are **base recipe × expected diners × preparation-loss correction × ordering allowance**. The default allowance is **2×**, adjustable from 1× to 10× in the collapsed allowance control shared across the daily table, recipe details, and purchasing requirements. Rice/new ingredients are included. Per-person originals, headcounts, actual purchases, and profit are unchanged. Apply manual additions/adjustments after the multiplier. Display the basis and multiplier in UI/CSV and use the same quantities for cooking print/PDF. This does not apply to Cafe/Store. Check: `node tools/test_recipe_order_allowance.cjs`.

| Component | Purpose |
| --- | --- |
| `supabase/functions/nmf-recipe-fill/` | Decrypt state, find missing recipes, call Claude Haiku 5.5 through Go, CAS-merge, encrypt/save |
| `supabase/migrations/20260922050000_nmf_recipe_fill_cron.sql` | Original schedule and `namofood_recipe_runs` |
| `supabase/migrations/20260922060000_nmf_recipe_fill_every_10min.sql` | Historical ten-minute schedule |
| `supabase/migrations/20260924182650_nmf_recipe_immediate_status.sql` | Immediate run locks/status and current once-per-minute schedule |
| `tools/nmf_cron_setup.ps1` | One-time secret/migration/Vault/deployment/dry-run setup |
| `tools/test_recipe_fill.ts` | Recipe logic checks |

The setup script prompts for secrets and stores them in Supabase, not Git. Run history query: `select * from namofood_recipe_runs order by started_at desc;`. If rotating the shared password, update the server's `NMF_PW` securely as well. Both `NMF_RECIPE_MODEL` and `NMF_RECIPE_FALLBACK_MODEL` default to `claude-haiku-5-5`; identical models are not called twice.

`NMF_MAX_PER_RUN` defaults to eight recipes generated in parallel. Failed claims wait two minutes; the run limit is four minutes. `NMF_RECIPE_TIMEOUT_MS` defaults to 52 seconds and is capped at 55 seconds; `NMF_RECIPE_MAX_TOKENS` controls output length.

### Weekly AI suggestions (not automatic meal writing)

At **06:05 KST daily**, the recommendation service checks today through two weeks ahead. Every five minutes it fills at most two missing/failed days, leaving complete banks unchanged. The UI loads the Monday–Sunday bank containing the selected date; suggestions start collapsed.

Each meal slot shows three suggestions after opening its recommendation section. The display title translates to **“Not sure what to serve? Donggeon's picks!”**, with the category and actual model/generation time shown separately. There is no separate request/date/meal panel.

Registered complete recipes supply randomized candidates; the model selects against the KRW 10,000 institutional-canteen standard and surrounding seven-day menus. Exclude same dishes/aliases, alcohol, desserts, and unregistered recipes. Report shortages rather than filling with duplicates.

Banks live separately from meal plans in `nmf_menu_recommend_banks` and are shared across devices. Old browser-storage banks are ignored; the UI uses an in-memory cache. A 150-second atomic lease limits generation to two days across schedules/devices. In-progress requests return 202 and wait for a bounded period with refreshed signatures.

Recipe changes refresh a requested day's bank; meal selection alone does not reroll it. Show readiness by day, cancel pending calls for deselected weeks, and retry a failed day only through the explicit retry control. Reopening a screen does not silently retry.

Pickers recheck current meals, aliases, and recipe conditions on opening and remove already-selected dishes. Only choosing a suggestion saves that one date/meal/slot as a manual selection, with replacement confirmation. Recommendation preparation never changes meals, headcounts, staff, recipes, or state backups. Default rice remains; recommendations/AI labels do not appear on external prints.

`supabase/functions/nmf-menu-recommend/` validates date/nonce/time HMAC, reads encrypted state, and writes only recommendation tables. RLS blocks public/ordinary authenticated table access; schedules use the existing Vault cron secret. Model failures are reported honestly; local random picks are not labeled AI.

Checks: `deno run -A tools/test_menu_recommend.ts`, `node tools/test_daily_menu_recommendations.cjs`, `node tools/test_weekly_menu_recommendations.cjs`, and `deno run --allow-read tools/test_menu_recommend_schedule.ts`.

Historical automatic-menu tools remain for audits. `tools/refresh_institutional_menus.ts` supports read-only preview and rejects `--apply` before server access; past write routes in `rebuild_week_20261005.ts` and `recover_menu_20261016.ts` are also blocked.

| Retired automation component | Purpose |
| --- | --- |
| `supabase/functions/nmf-menu-plan/` | Authenticated no-op response for retired generation |
| `supabase/migrations/20260924162050_nmf_menu_plan_weekly.sql` | Historical run table, Vault URL, daily checks, and initial two-week fill |
| `tools/test_menu_automation_disabled.ts` | Verify no database/model/save work in the actual handler |
| `tools/remove_ai_menus.ts` | Remove only AI-marked meal content; dry by default, backup/CAS with explicit `--apply` |

Historical runs: `select * from namofood_menu_runs order by started_at desc;`.

### Print and PDF

Meal printing uses 2mm A4 margins and scales to one page. Breakfast/lunch/dinner/late-night checkboxes affect only preview/print, retaining at least one meal. Day/week/month and internal/external views share page fitting.

Checks: `node tools/test_app_print.cjs` (Playwright/pdf-lib; optional `CHROME_PATH`) and `node tools/test_bulk_recipe_ui.cjs`. Recipe status permits the configured `https://d-bae.com` and GitHub origins while preserving request/cron authentication; check `deno run -A tools/test_recipe_cors.ts`.

## Staff schedules and archived history

Archiving/removing from the active roster preserves employee information and all work records. Employees remain in the weekly schedule, payroll, CSV, and prints for months they worked. Monthly employee payroll lists only staff with actual work records that month.

The collapsed archive searches names, roles, and previous-name aliases, with ten employees per page and restoration controls. Renaming preserves employee IDs, archive state, wages, hours, and payroll. Edit times prevent old devices/backups from replacing new names. Selecting an archived employee in payroll clears search, opens the correct archive page, and focuses the name field. Historical identity/rate warnings are not resolved merely by renaming.

Confirmed deletion inside the archive hides only its roster entry, preserving employee information, all monthly hours/payroll, CSV, and print history. Synced deletion markers prevent resurrection. Clicking a deleted employee's payroll name temporarily opens just that historical record for renaming/restoration; closing the historical view does not restore the roster. Check: `node tools/test_staff_archive_delete.cjs`.

Fill-default and copy-previous-month target current employees and blank cells only. Missing records in sync/backups/copies are not deletions. Individual clear/month-clear actions create explicit cross-device deletion markers. Archive/restore choices persist across restart and synchronization.

Weekly bulk entry selects cells, employees, dates, or an entire week and applies 24-hour start/end/break times or previous-day shifts. Only one week is selected at a time. Switching weeks/closing clears selection without edits. Previous-day copy reads originals, including the prior month's last day; replacing existing shifts requires confirmation. Unselected cells remain unchanged.

New employees, new shifts, fill-default, and bulk entry default to **zero break minutes**. Existing shifts retain breaks; old shift codes convert under their historical defaults before new defaults apply. Explicit employee break settings remain.

The staff roster fits its container; narrow screens use employee cards without horizontal scrolling. This layout does not change other tables. Checks: `node tools/test_staff_layout.cjs`, `node tools/test_weekly_bulk.cjs`, and `node tools/test_staff_history.cjs` (Playwright/pdf-lib/pdfjs-dist).

### Roles and hourly rates

Initial lead/cook roles are KRW 15,000/hour; assistant/transport roles are KRW 13,000/hour. Three designated current employees have individual overrides; all amounts are editable. Blank individual pay uses the role default. Existing archived rates are preserved.

Roles can be added/deleted. Deleting an assigned role requires reassignment and preserves the previous effective wage as an individual override to avoid accidental payroll changes. Role/rate edit markers prevent stale settings restoration.

The operator can inspect initial settings with `tools/apply_staff_pay_settings.ts`, supplying `NMF_PW` and a JSON array in `NMF_STAFF_PAY_NAMES` securely. Only explicit `--apply` performs the one-time write after unique encrypted backup/conflict checks.

`NMF_PW=... deno run -A tools/recover_staff_history.ts` audits surviving historical shifts read-only. Explicit `--apply` restores only exact employee information verified in dated backups to the archive after backup/conflict checking; other data stays unchanged.

## Release files and password changes

| File | Purpose |
| --- | --- |
| `index.html` | Unlock page and encrypted app body |
| `encrypt_app.py` | Re-encrypt the local plaintext app for a release |
| `ver.json` | Full release version tag |

Keep the app display, encrypted loader, and `ver.json` on the same full version tag. Regression check: `NMF_PW=... node tools/test_app_version.cjs`.

The existing encryption entry point accepts the local source filename and output directory. Supply the password through the operator's secure workflow; never paste a real value into documentation, logs, or Git:

```text
python encrypt_app.py <local-plaintext-app.html> <output-directory> <password>
```

The local source filename remains unchanged by this documentation translation. The encryption tool requires Python's `cryptography` package. Publish only reviewed encrypted/public release files.

Changing the password does not re-encrypt existing Supabase records automatically. Before rotation, download a backup with the old password; unlock with the new password, import the backup, and explicitly save. Update server secrets consistently. Do not commit the plaintext app or secret values.
