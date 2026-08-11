---
name: Testing URL-backed page state (wouter + jsdom)
description: Two harness traps that make URL-driven page state and responsive UI report false results in vitest.
---

## 1. A memory Router needs the search hook too, or the query string vanishes

`memoryLocation()` keeps the path and the search string **separately** and returns a matching
`searchHook` alongside `hook`. Pass only `hook` to `<Router>` and `useSearch()` silently falls
through to the real browser location, so every query parameter reads as absent — the page renders
its no-filter default and the test "passes" while proving nothing.

```tsx
const nav = memoryLocation({ path: "/invoices?aging=days60", record: true });
<Router hook={nav.hook} searchHook={nav.searchHook}>…</Router>
```

**Why:** a page whose filters live in the URL is *entirely* driven by that hook. Getting it wrong
does not error, it just quietly reports the default view.

**Also:** do not hand-split the URL yourself. `nav.hook()` already returns the path with the query
stripped, so `url.split("?")[1]` is always `undefined`. And check the installed version before
reading `node_modules/wouter` — a stale hoisted copy can be several minors behind the real one and
send you fixing a bug that does not exist.

## 2. jsdom renders the desktop AND mobile variants at once

Tailwind's `hidden md:block` is a CSS rule, and jsdom applies no media queries. Both branches of a
responsive layout mount, so any `data-testid` shared between them resolves to two elements and
`getByTestId` throws "Found multiple elements".

**How to apply:** when adding a testid to markup that exists in both variants, suffix one of them
(`ar-flags-1` / `ar-flags-mobile-1`). For pre-existing shared ids, take
`screen.getAllByTestId(id)[0]` — the desktop copy is first in the DOM.

## 3. Radix menus do not open on `fireEvent.click`

`DropdownMenuTrigger` opens on `pointerdown`, which jsdom does not synthesise from a click. Fire
`pointerDown` first, then `click`, then wait for `role="menu"`.
