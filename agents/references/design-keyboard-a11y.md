# Keyboard A11y — Focus Models, Per-Widget Key Contract, Dialog Lifecycle, ARIA State

> By-hand keyboard-accessibility contract per ARIA-APG. The designer specs which attributes and keys a widget needs, never the React/Vue wiring (downstream codegen owns that).

## Focus Model — the binary rule

| Condition | Focus model | DOM focus | Active item | Tab stops |
|-----------|-------------|-----------|-------------|-----------|
| a text input must keep DOM focus to keep typing (combobox, search, editable command palette) | aria-activedescendant (virtual focus) | stays on the input/container | `aria-activedescendant` (an id) references it | items are not individually tab-focused |
| every other composite | roving tabindex | real DOM focus moves with arrow keys | exactly one item has `tabindex=0`, the rest `tabindex=-1` | the widget is a single tab stop in the page |

- Getting this wrong breaks either typing (combobox with roving) or the single-tab-stop rule (menu with activedescendant).

## Per-Component Key Reference Table

Each widget's key contract is fixed.

| Widget | Focus model | Arrow keys | Enter/Space | Esc | Home/End | Typeahead | Open trigger |
|--------|-------------|------------|-------------|-----|----------|-----------|--------------|
| Menu | roving | Up/Down move; Right opens submenu, Left closes submenu | activates item | closes + restores focus to trigger | first / last | yes | ArrowDown→first / ArrowUp→last; Enter/Space opens + focuses first |
| Listbox | roving | Up/Down navigate (2-D arrows for grid) | toggles selection | — | first / last | yes | — |
| Select | roving (popup) | Up/Down navigate | Enter selects + closes + focus returns to trigger | closes | first / last | yes | Enter opens |
| Combobox | aria-activedescendant | Up/Down navigate (updates `aria-activedescendant`) | Enter selects | closes | — | n/a (typing filters) | ArrowDown opens |
| Tabs | roving | follow `aria-orientation` (horizontal→Left/Right, vertical→Up/Down; RTL flips) | Enter only in manual-activation mode (else select-on-focus) | — | — | — | — |
| Dialog | trap (see lifecycle) | — | — | closes topmost only | — | — | Enter / trigger |
| Toolbar / Radio | roving | move within group | activates | — | first / last | — | — |

- **Orientation gate (universal)**: for moving between items, a vertical list ignores Left/Right and a horizontal list (menubar / tabs) ignores Up/Down; a row's own open/close keys (Menu submenu Right/Left) stand.
- PageUp/PageDown jump by a viewport.

## Typeahead Contract

Any option or item list (listbox, select, menu, tree) of > ~7 items SHOULD support type-to-focus; a tablist is not one:

- Collect printable keystrokes into a buffer; reset after ~500ms idle.
- Move focus to the first item whose visible text starts with the buffer.
- Pressing one repeated letter cycles same-initial items.
- Skip disabled items.
- Suppressed when an inner text input owns focus.

## Dialog / Overlay Focus-Lifecycle Checklist

A modal dialog MUST satisfy each item below.
DESIGN.md overlay specs confirm every item below.

- **Focus-in on open**, in order: explicit `initialFocus` target → first `[autofocus]`/`[data-autofocus]` element → first tabbable → the dialog container itself.
- **Trap Tab / Shift+Tab inside** while open (boundary sentinels), or mark everything outside as `inert`.
- **Esc closes the topmost layer only**.
- **Restore focus to the trigger on close**, unless the close came from an outside click (matches native `<dialog>`).
- Expose `role=dialog` + `aria-labelledby`(title) + `aria-describedby`(body) + a reachable dismiss control (hidden dismiss button for SR users).
- Container `tabindex=-1`.

Non-modal popovers / menus follow the same restore + Esc rules without the inert/trap.

## ARIA Role + Live-State Contract per Widget

- Each widget has a required `role`.
- Each widget's state attributes must update live.
- `aria-disabled` keeps an item focusable-but-skipped (preferred over removing it).

| Widget | role | live state attributes |
|--------|------|----------------------|
| Combobox | `combobox` | `aria-autocomplete`(none/list/inline/both), `aria-haspopup=listbox`, `aria-expanded` |
| Combobox linkage | (same element) | `aria-controls`(→listbox id), `aria-activedescendant`(→active option id) |
| Menu | `menu` + items `menuitem`/`menuitemradio`/`menuitemcheckbox` | `aria-haspopup`, `aria-orientation`; submenu trigger `aria-expanded` + `aria-haspopup` |
| Listbox / Select | `listbox` + `option` (groups `group`) | `aria-selected`, `aria-multiselectable`; trigger `aria-haspopup` + `aria-controls` |
| Tabs | `tablist` + `tab` + `tabpanel` | `aria-selected`, `aria-controls`(→panel), `aria-orientation`; panel `aria-labelledby`(→tab) |
| Composite item | (per widget) | `aria-setsize` / `aria-posinset` (position), `aria-disabled` |

- Common across widgets: `aria-expanded` · `aria-selected` / `aria-checked` · `aria-activedescendant` · `aria-controls` · `aria-labelledby` / `aria-label` · `aria-orientation` · `aria-disabled`
