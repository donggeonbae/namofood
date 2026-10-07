# Design

## Source of truth

- Status: Active for staff directory, weekly roster, menu generation and recipe discovery/planning; other screens retain their existing design.
- Last refreshed: 2026-10-08.
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

- Color: reuse navy `--navy`, muted text, yellow editable cells and gray computed cells.
- Typography: existing Korean system font stack; directory may shrink to 11px on constrained desktop layouts, mobile employee cards use 13px.
- Spacing/layout: existing cards and wrapping rows; compact scoped directory padding.
- Shape/elevation: reuse existing borders and rounded controls; no new design-system layer.
- Motion: no added animation.
- Imagery/iconography: none required for this administrative workflow.

## Components

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

## Open questions

- [ ] Actual attendance of stored staff requires manager confirmation; matching roster values alone cannot prove attendance or the action that created them.
