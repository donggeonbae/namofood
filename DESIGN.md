# Design

## Source of truth

- Status: Active for staff directory and weekly roster updates; other screens retain their existing design.
- Last refreshed: 2026-10-06.
- Primary product surfaces: staff directory, stored staff, weekly roster and monthly labor summary.
- Evidence reviewed: `README.md`, `나모푸드_관리앱.html` (existing tokens, staff and roster components), `tools/test_staff_history.cjs`, `tools/test_staff_layout.cjs`, browser checks at 320–1440px. No earlier design document or approved mockup was found.

## Brand

- Personality: practical, calm, professional Korean food-service administration.
- Trust signals: explicit dates, scope, selected-cell counts and preserved historical records.
- Avoid: decorative dashboard changes, ambiguous destructive labels and unexplained automation.

## Product goals

- Goals: staff directory fits without sideways scrolling; weekly work-time entry is close to the selected week; stored staff remain recoverable.
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

## Design principles

- Place an action next to the records it changes; bulk editing has one active week.
- Make selection separate from saving; starting, switching or canceling bulk entry never changes roster data.
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
- Microcopy: show the active week, date range, count and overwrite consequence. Time labels use 24-hour format and existing midnight/noon hints.

## Implementation constraints

- Framework: existing single HTML app and native CSS/JavaScript, distributed through the encrypted loader.
- Tokens: existing CSS variables and controls only.
- Performance: selection state is ephemeral; no extra polling or external libraries.
- Compatibility: preserve archive/restore, tombstones, payroll, print, previous-day snapshot semantics and unselected cells.
- Tests: synthetic local browser actions with outgoing writes blocked; deployment observation is read-only. Capture desktop and mobile screenshots.

## Open questions

- [ ] Actual attendance of stored staff requires manager confirmation; matching roster values alone cannot prove attendance or the action that created them.
