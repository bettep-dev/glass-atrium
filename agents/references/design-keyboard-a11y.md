# Keyboard A11y — Focus Models, Per-Widget Key Contract, Dialog Lifecycle, ARIA State

> Reference for `design-designer` agent. By-hand keyboard-accessibility contract per ARIA-APG: the two focus models, the per-widget key reference table, typeahead, the dialog/overlay focus lifecycle, and the per-widget ARIA role + live-state contract. The agent specs WHAT attributes/keys a widget needs, never the React/Vue wiring (that is downstream codegen's HOW).

## Applicability

This contract applies ONLY when the deliverable specs **interactive widgets** (menu / listbox / select / combobox / tabs / dialog / toolbar / radio group). It does NOT gate canvas, visual philosophy, branding, or static-layout deliverables.

---

## Focus Model — the binary rule

There are exactly two focus models, and the widget dictates which one:

- **aria-activedescendant (virtual focus)** → use when a **text input must keep DOM focus** to keep typing (combobox, search, editable command palette). DOM focus stays on the input/container; the active item is referenced by `aria-activedescendant` (an id); items are NOT individually tab-focused.
- **Roving tabindex** → use for **every other composite** (menu, listbox, select-popup, tabs, toolbar, radio group). Exactly one item has `tabindex=0`, the rest `tabindex=-1`; real DOM focus moves with arrow keys; the widget is a SINGLE tab stop in the page.

Getting this wrong breaks either typing (combobox with roving) or the single-tab-stop rule (menu with activedescendant).

---

## Per-Component Key Reference Table

Each widget has a fixed, ARIA-APG-mandated key contract. DESIGN.md cites the matching row for every interactive component it specs.

| Widget | Focus model | Arrow keys | Enter/Space | Esc | Home/End | Typeahead | Open trigger |
|--------|-------------|------------|-------------|-----|----------|-----------|--------------|
| **Menu** | roving | Up/Down move; Right opens submenu, Left closes submenu | activates item | closes + restores focus to trigger | first / last item | yes | ArrowDown→first / ArrowUp→last; Enter/Space opens + focuses first |
| **Listbox** | roving | Up/Down navigate (2-D arrows for grid) | toggles selection | — | first / last | yes | — |
| **Select** | roving (popup) | Up/Down navigate | Enter selects + closes + focus returns to trigger | closes | first / last | yes | Enter opens |
| **Combobox** | aria-activedescendant | Up/Down navigate (updates `aria-activedescendant`) | Enter selects | Esc closes | — | n/a (typing filters) | ArrowDown opens |
| **Tabs** | roving | follow `aria-orientation` (horizontal→Left/Right, vertical→Up/Down; RTL flips) | Enter only in manual-activation mode (else select-on-focus) | — | — | — | — |
| **Dialog** | trap (see lifecycle) | — | — | closes TOPMOST only | — | — | Enter / trigger |
| **Toolbar / Radio** | roving | move within group | activates | — | first / last | — | — |

**Orientation gate (universal)**: a vertical list ignores Left/Right; a horizontal list (menubar / tabs) ignores Up/Down. PageUp/PageDown jump by a viewport.

---

## Typeahead Contract

Any list of **> ~7 items** SHOULD support type-to-focus:

- Collect printable keystrokes into a buffer; **reset after ~500ms idle**.
- Move focus to the first item whose **visible text starts with the buffer** (prefix match).
- Pressing one repeated letter cycles same-initial items.
- **Skip disabled items.**
- **Suppressed** when an inner text input owns focus (combobox already filters by typing).

---

## Dialog / Overlay Focus-Lifecycle Checklist

A modal dialog MUST satisfy each item (DESIGN.md overlay specs confirm every one):

1. **Focus-in on open**, resolution ORDER: explicit `initialFocus` target → first `[autofocus]`/`[data-autofocus]` element → first tabbable → the dialog container itself.
2. **Trap Tab / Shift+Tab inside** while open (boundary sentinels) OR mark everything outside as `inert`.
3. **Esc closes the TOPMOST layer only** (nested dialogs close one layer at a time).
4. **Restore focus to the trigger on close — UNLESS** the close came from an outside click (matches native `<dialog>`).
5. Expose **`role=dialog` + `aria-labelledby`(title) + `aria-describedby`(body) + a reachable dismiss control** (hidden dismiss button for SR users). Container `tabindex=-1` (focusable, not in tab order).

Non-modal popovers / menus follow the same restore + Esc rules **without** the inert/trap.

---

## ARIA Role + Live-State Contract per Widget

Each widget has a non-negotiable `role` plus STATE attributes that must update live. `aria-disabled` keeps an item **focusable-but-skipped** (preferred over removing it).

| Widget | role | live state attributes |
|--------|------|----------------------|
| **Combobox** | `combobox` | `aria-autocomplete`(none/list/inline/both), `aria-haspopup=listbox`, `aria-expanded`, `aria-controls`(→listbox id), `aria-activedescendant`(→active option id) |
| **Menu** | `menu` + items `menuitem`/`menuitemradio`/`menuitemcheckbox` | `aria-haspopup`, `aria-orientation`; submenu trigger `aria-expanded` + `aria-haspopup` |
| **Listbox / Select** | `listbox` + `option` (groups `group`) | `aria-selected`, `aria-multiselectable`; trigger `aria-haspopup` + `aria-controls` |
| **Tabs** | `tablist` + `tab` + `tabpanel` | `aria-selected`, `aria-controls`(→panel), `aria-orientation`; panel `aria-labelledby`(→tab) |
| **Composite item** | (per widget) | `aria-setsize` / `aria-posinset` (position), `aria-disabled` |

Common live states across widgets: `aria-expanded` (expanded/collapsed), `aria-selected` / `aria-checked` (selection), `aria-activedescendant` (active-option pointer), `aria-controls` (control linkage), `aria-labelledby` / `aria-label` (label linkage), `aria-orientation`, `aria-disabled`.
