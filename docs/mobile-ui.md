# Mobile UI conventions

KDust is moving from a desktop-only layout to a mobile-friendly one in
incremental lots. This file is the single source of truth for the
breakpoints and patterns adopted along the way.

## Breakpoints

We rely on Tailwind's defaults (no custom breakpoint in
`tailwind.config.ts`):

| Token | Min width | Typical device |
|-------|-----------|----------------|
| (none) | 0 px | phone portrait (target: 375 px / iPhone SE) |
| `sm:` | 640 px | large phone landscape / small tablet |
| `md:` | 768 px | tablet portrait |
| `lg:` | 1024 px | desktop |
| `xl:` | 1280 px | wide desktop |

**Floor target**: 375 px (iPhone SE 2). 320 px is not a goal.

## Mobile-first rule

New Tailwind class lists MUST start with the mobile (smallest)
variant, then grow with `sm:` / `md:` / `lg:`.

```tsx
// GOOD
<div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3" />
// BAD (legacy desktop-first)
<div className="grid grid-cols-3 md:grid-cols-1 gap-3" />
```

Legacy desktop-first patterns are tolerated but should be migrated
opportunistically when a file is touched.

## Navigation (L1 — done 2026-05-01)

- Below `md` (<768 px), the horizontal NavItem list is hidden and
  surfaced through a left-side burger drawer (`MobileNavDrawer.tsx`).
- ProjectSwitcher, HeaderIcons (logs badge) and UserMenu stay in the
  top bar at every width — they are 1-tap critical.
- Drawer specs: `w-[85vw] max-w-[320px]`, slide-in (`translate-x`),
  body scroll-lock while open, Escape closes, route change closes.
- Touch targets in the drawer: `h-12` (48 px) per item.

## Touch target floor

Any interactive element added in mobile-visible chrome must be at
least `40 × 40 px` (`w-10 h-10` or `h-10 px-3`). Inline buttons in
dense desktop tables are exempt because they live in `md:`-scoped
layouts.

## Roadmap

| Lot | Scope | Status |
|-----|-------|--------|
| L1 | Nav burger drawer | done (2026-05-01) |
| L2 | Dense pages: dashboard, settings/usage, run/[id], task/[id] | TODO |
| L3 | Tables & lists: settings/projects, agents, secrets, /logs | TODO |
| L4 | Chat: conv-list drawer, sticky composer | TODO |
