# Design

## Source of truth

- Status: Active for the management app, including finance and compact screen density. Preserve print typography and stored calculations.
- Last refreshed: 2026-10-13. Also active for invoice/card linking and direct daily meal entry.
- Primary product surfaces: staff directory, stored staff, weekly roster, monthly labor summary, recipe library and temporary menu builder.
- Evidence reviewed: `README.md`, `나모푸드_관리앱.html` (existing tokens, staff and roster components), `tools/test_staff_history.cjs`, `tools/test_staff_layout.cjs`, browser checks at 320–1440px. No earlier design document or approved mockup was found.

## Brand

- Personality: practical, calm, professional Korean food-service administration.
- Trust signals: explicit dates, scope, selected-cell counts and preserved historical records.
- Avoid: decorative dashboard changes, ambiguous destructive labels and unexplained automation.

## Product goals

- Goals: staff directory fits without sideways scrolling; weekly work-time entry is close to the selected week; stored staff remain recoverable.
- Recipe goals: browse by cooking method then primary ingredient; build a temporary meal from existing recipes before an explicit dated apply. Menu generation favors institutional/industrial cafeteria dishes and materially different proteins, cooking methods and seasonings, not just renamed dishes.
- Non-goals: change payroll formulas, alter historical shifts or redesign unrelated screens.
- Success signals: every directory field remains editable at supported widths; bulk apply affects only explicitly selected cells in one week; canceled actions preserve all data.

## Personas and jobs

- Primary personas: managers scheduling and paying food-service employees (inferred from existing workflows).
- User jobs: edit staff details, store or restore staff, enter repeated work times, inspect monthly labor costs.
- Key contexts: desktop table editing and narrow-screen quick changes.

## Information architecture

- Primary navigation: retain existing app navigation and monthly selector.
- Core screens: staff directory → collapsed stored staff → weekly roster → worked-employee labor summary.
- Content hierarchy: each week shows its dates and local bulk-entry action; only the active week's selection and time controls expand.
- Recipe hierarchy: search + cooking-method category → available ingredient subcategories → recipe results. Example: 튀김 → 생선/닭고기; 무침 → 나물/콩나물/당근. A temporary meal builder holds 국·메인1·메인2·부찬1·부찬2·부찬3 plus optional extras; rice remains implicit.

## Design principles

- Place an action next to the records it changes; bulk editing has one active week.
- Make selection separate from saving; starting, switching or canceling bulk entry never changes roster data.
- Recipe discovery is non-mutating. Draft menu choices never overwrite the live menu until date, meal and an explicit confirmation are supplied. Applied drafts are manual and cannot be overwritten by later AI regeneration.
- Tradeoffs: compact directory fields on desktop; labeled two-column employee cards below 620px. Weekly roster retains its existing table scrolling.

## Visual language

- PC-first revision: quieter white surfaces, slate/navy hierarchy, restrained 4–6px corners, and thin single boundaries instead of layered rounded outlines. Desktop controls stay compact; mobile field text/touch targets remain legible. Tables retain grid lines while their wrappers do not add a competing outer line. Reference: shadcn dashboard layout density and Linear's typographic hierarchy; reuse only principles, not assets. Rounded print templates remain unchanged.
- Color: reuse navy `--navy`, muted text, yellow editable cells and gray computed cells.
- Typography: existing Korean system font stack; directory may shrink to 11px on constrained desktop layouts, mobile employee cards use 13px.
- Spacing/layout: existing cards and wrapping rows; compact scoped directory padding.
- Shape/elevation: reuse existing borders and rounded controls; no new design-system layer.
- Motion: no added animation.
- Imagery/iconography: none required for this administrative workflow.

## Components

- Period navigation: roster and sales share the existing day/week/month vocabulary. Place the selector and previous/today/next/date controls above records. Keep monthly totals clearly labeled and unchanged by the filter. Month-boundary weeks show the selected month's dates explicitly; navigation to the adjacent month is available. A selected day's sales card uses that date, not the wall-clock date. Period switching cancels transient roster bulk selection, never stored shifts.
- Recipe monitor: a native collapsed details tab, with a concise visible status. Refresh only its body/badge so polling does not collapse an open panel; preserve the user's open state across renders. All existing actions/status/error text remain available and excluded from print.
- Final density review: after functional verification, reduce desktop base text from 18 to 16px, navigation from 19 to 16px, regular controls to 15–16px, headings to 24/18px, and excess card gaps by roughly 15–20%. Use screen-only rules; preserve print, payroll-specific sizing, mobile input legibility and coarse-pointer touch targets. Inspect all core routes at desktop/mobile sizes and rerun affected behavior tests.
- Finance: show entered-to-date and average-based full-month profit separately. Revenue averages use explicitly entered sales days (zero is a valid entry); future records are excluded. Purchase averages use elapsed calendar days, not purchase-day counts. Show both denominators, the configured operating days, and missing records. Target food cost is for comparison only; actual purchase totals exclude carried balances, cards, and unreviewed duplicates. Payroll allocation remains explicitly labeled and never changes stored shifts. Compact wrapping key/value cards avoid new horizontal scrolling.
- Fixed-cost documents: a collapsed, encrypted database collection with separate metadata and payload rows. Fetch metadata only on demand, and one payload on view/download. Uploading documents never creates a cost/payment record. Only inert PDF/image/DOCX files are accepted; HTML is rejected. Show progress, partial failures and identical-file detection; preserve concurrent additions.
- Tax estimates: collapsed voluntary inputs for Namofood general VAT and individual annual income tax. Confirm deductible input VAT manually; blank VAT is never invented. The existing management tax reserve is separate from statutory estimates. Show calculation assumptions, official sources, and no filing/issuance automation.
- Invoice/card extension: a compact status followed by collapsed explicit card selection; never auto-confirm a match or change invoice totals/balances. One invoice links to one approved card record. Missing/deleted/cancelled cards and conflicts show review states, not payment completion. Both screens expose the link.
- Price comparison: a small hint in the existing unit-price cell, comparing earlier invoices with identical vendor/item/spec/unit and known matching tax-presence basis. Ambiguous same-day prices are not compared. No new dashboard or AI calls.
- Daily meal editor: place the existing editor above print preview; the collapsed AI weekly recommendation remains immediately above the four meal cards. Each minimum slot has a labeled direct text field plus the existing picker; optional/rice pickers remain available. All editing remains screen-only, with original print layout intact.
- Employee payroll: no horizontal scrolling. Desktop uses aligned fixed columns with smaller text and full-width adjustment inputs; at 760px and below, each employee becomes a two-column labeled card showing all ten fields and totals. Amounts may wrap but are never clipped or hidden. Payroll calculations and stored shifts do not change. Test widths are 320–1440px.

- Reuse: cards, native checkboxes, buttons, 24-hour time selectors, hints and confirmation dialogs.
- Changed: fixed-width directory table, labeled mobile employee cards, local weekly bulk-entry panel.
- Recipe components: wrapping method/subcategory buttons with counts, visible active-filter trail/reset, recipe cards, local temporary meal panel and explicit apply confirmation. Reuse existing tags/buttons/modals and native date/meal/slot controls.
- States: inactive week, active week with no selection, selected cells, validation failure, canceled overwrite, applied changes.
- Ownership: directory styles scoped to its IDs; weekly controls use roster-specific classes.

## Accessibility

- Target: practical keyboard and readable-control support; formal WCAG conformance has not been audited.
- Keyboard/focus: native controls with accessible labels; do not hide essential actions behind hover.
- Contrast/readability: retain existing palette; selection uses checkbox state and count, not color alone.
- Semantics: retain directory table headers for assistive technology; mobile cells show field labels.
- Reduced motion: no motion required.

## Responsive behavior

- Test widths: 320, 390, 600, 768, 900, 1024, 1280 and 1440px.
- Directory: fixed proportional desktop columns; employee cards below 620px without clipping or horizontal overflow.
- Weekly bulk controls: wrap within the week card; apply remains close to the count and time inputs.
- Touch: visible checkboxes and buttons; no drag-only selection.
- Recipe filters and draft actions wrap at 320/390px; no new full-page horizontal overflow. Categories with no results are omitted or clearly disabled; unfamiliar dishes stay available under 기타/미분류 and global search.

## Interaction states

- Loading: keep existing cloud-sync behavior; this feature adds no network dependency.
- Empty: explain empty staff or selection; apply disabled with zero selected cells.
- Error: explain invalid times; previous-day copy skips missing, leave or invalid shifts.
- Success: report applied and skipped counts; clear selection after apply.
- Disabled: no apply until selection; inactive weeks retain normal individual-cell editing.
- Offline: local editing and existing persistence remain unchanged.

## Content voice

- Tone: concise, direct Korean.
- Terminology: staff action `삭제/보관`; collapsed collection `보관된 명단`; this removes staff only from the current directory, not history.
- Recipe terminology: `조리방식`, `주재료`, `임시 식단`, `식단표에 적용`. Catalog/recipe additions never imply actual scheduled meal changes.
- Microcopy: show the active week, date range, count and overwrite consequence. Time labels use 24-hour format and existing midnight/noon hints.

## Implementation constraints

- Framework: existing single HTML app and native CSS/JavaScript, distributed through the encrypted loader.
- Tokens: existing CSS variables and controls only.
- Performance: selection state is ephemeral; no extra polling or external libraries.
- Compatibility: preserve archive/restore, tombstones, payroll, print, previous-day snapshot semantics and unselected cells.
- Recipe compatibility: retain existing recipes, manual edits, quantities, bulk-cooking validation, search, monitor and recipe AI request authentication. No schemas/authentication changes are needed for ephemeral filters or draft selection.
- Temporary drafts: recipe choices and optional extras can be added/removed/replaced without saving any scheduled meal. Applying requires all six minimum slots, a non-alcohol soup in slot 1, distinct dish names, explicit date/meal and confirmation if existing dishes will change; preserve headcounts and unrelated meals. Classify chosen dishes as manual, while retaining institutional AI markings only on automatically generated meals.
- Tests: synthetic local browser actions with outgoing writes blocked; deployment observation is read-only. Capture desktop and mobile screenshots.
- Final review evidence (2026-10-13): 11 routes across 1440/1280/900/768/390/320px, zero root overflow or sibling-box overlap in 66 combinations. Actual cloud data also checked read-only on six routes at PC/mobile widths; document originals read back and hash-verified. Preserve original print font measurements (weekly meals 11px, title 18px). Monthly totals, payroll histories and manual recipes are covered by deterministic regressions. Inspect mobile sales as labeled cards and keep the time popover clamped to actual measured height.

## Open questions

- [ ] Actual attendance of stored staff requires manager confirmation; matching roster values alone cannot prove attendance or the action that created them.
