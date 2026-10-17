# Prysm Note design system

An instrument, not a dashboard. The interface should feel calm, precise and quiet, with a single
accent that marks action and attention and nothing else.

## Where the tokens live

- `src/app/globals.css` holds the default (Warm Graphite) token block and the shared classes.
- `src/app/themes.css` holds the alternate themes.
- `src/design-tokens.json` holds the runtime palette that `ThemeProvider` applies as inline CSS
  variables. It is the source of truth at runtime, so a palette change must land in both the JSON
  and the CSS or the two will disagree.
- `tailwind.config.ts` maps the tokens to utility names. Never hardcode a hex value in a component.

## Color

| Token | Role |
|---|---|
| `--bg-base` | app background |
| `--bg-surface` | panels, headers, cards |
| `--bg-elevated` | inputs, raised rows, menus |
| `--bg-hover` | hover state for rows and surfaces |
| `--border` | every hairline divider |
| `--text-primary` / `--text-secondary` / `--text-muted` | three text levels, no more |
| `--accent` / `--accent-hover` | primary action, active nav, focus ring, today marker |
| `--on-gradient` | text placed on an accent fill |
| `--danger` / `--success` / `--warning` / `--info` | state only, never decoration |

The default theme is Prysm Plum: a deep violet ink (`#0F0C15` base) with a soft violet accent
`#9B7BFF`. Themes live in `src/design-tokens.json` and are chosen in Settings, never in the app
chrome. Each preset keeps the same token meanings and tunes its own accent to its surface
(Paper `#6B4BA8`, Parchment `#8A5A2B`, Fog `#3E6DA6`, and so on), so the accent always means action,
active nav, focus and today.

## Type

- UI: IBM Plex Sans. Numerals on counts, dates, times and money use `tabular-nums` (the `.tnum`
  helper) so columns of numbers do not jitter.
- Timeline and code: IBM Plex Mono.
- Three weights only: 400 body, 500 emphasis, 600 headings. Sizes come from Tailwind steps plus the
  existing `.text-fluid` helpers. Day names in the timeline are uppercase, 10 to 11px, tracked.

## Shape and elevation

Radius scale: `rounded` 4px, `rounded-md` 6px, `rounded-lg` 8px, `rounded-xl` 12px. `rounded-2xl`
and anything larger are retired for surfaces; `rounded-full` is reserved for avatars, badges, dots
and segmented controls.

Two elevation levels: `--shadow-sm` for resting surfaces, `--shadow-lg` for menus, modals and the
task drawer. There is no third level and no glow.

## Never

1. Never use a gradient as a background, button or text fill. The `--grad-*` tokens resolve to
   the flat accent for legacy call sites only. The one allowed gradient is the single-stop fade
   mask on the timeline edge.
2. Never use `backdrop-blur`, glass panels or glow shadows.
3. Never introduce a second button system. Use `.btn` / `.btn-primary` for plain elements and
   `ui/Button` when you need variants; both share one radius and one focus ring.
4. Never style an input outside `.input-field` or `ui/Input` (and `ui/Select` for dropdowns).
5. Never set a raw hex color in a component. Add a token instead.
6. Never use more than the three text levels or the four state colors.
7. Never animate anything except `opacity` and `transform`.

## Component recipes

- Header bar: `flex items-center gap-3 border-b border-border bg-surface px-4 py-2 shrink-0`.
- Card: `.card`, which is `bg-surface`, one hairline border, `--radius-xl`, `--shadow-sm`.
- Segmented control: `rounded-full bg-elevated p-0.5` with pills `rounded-full px-2.5 py-0.5
  text-[11px]`; active is `bg-accent font-semibold text-[var(--on-gradient)]`.
- Empty state: centered column, icon in a `rounded-xl bg-accent/10 text-accent` box, a
  `text-sm font-semibold text-primary` title, `text-xs text-secondary` copy, `.btn-gradient` CTA.
- Sidebar row: `.sidebar-item`, active state is an accent tint plus a 2px accent left rail, never a
  solid accent block.

## The timeline is the signature

Hairline day rules, mono numerals, a 2px accent today marker without a glow, and task bars with a
2px priority edge on a 14% priority tint over `bg-elevated`. Bars are flat: no blur, no brightness
filter on hover, no full-saturation color blocks.

## Reviewing a change

Run `npm run ui:audit` from the repo root. It fails on retired patterns (blur, gradient fills,
`shadow-2xl`, `rounded-2xl`, legacy indigo hexes, em dashes, raw hex in components). It is a grep
gate, not a renderer check, so still load the app and look at it in the default theme plus the
light theme.
