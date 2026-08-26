# 001 - Make overlays and feedback accessible

- **Status**: TODO
- **Commit**: unavailable - this workspace has no usable Git metadata
- **Severity**: MEDIUM
- **Category**: accessibility, cohesion, spatial consistency
- **Estimated scope**: 3 files, small CSS and component changes

## Problem

The workflow node library and run/artifact detail panel appear and disappear instantly. They
are occasional, spatially meaningful surfaces, so this abrupt change makes it harder to retain
context. The only current global animation is an infinite opacity pulse, and there is no
`prefers-reduced-motion` fallback.

```css
/* src/app/canvas.css:1 - current */
.node-library { position: absolute; z-index: 10; top: 43px; right: 18px; }
.detail-overlay { position: fixed; inset: 0; z-index: 50; display: flex; justify-content: flex-end; }
.detail-panel { width: min(620px, 88vw); height: 100%; }

/* src/app/styles.css:2 - current */
.node-status.running i { animation:pulse 1s infinite }
@keyframes pulse { 50% { opacity:.35 } }
```

## Target

Use CSS transitions for the node library and the right-side detail panel. They must use only
`opacity` and `transform`, preserve pointer interaction as soon as they are visible, and keep
the panel path symmetric. Global timing tokens must make the values consistent.

```css
:root {
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
  --ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
}

.node-library {
  opacity: 1;
  transform: scale(1);
  transform-origin: top right;
  transition: opacity 160ms var(--ease-out), transform 160ms var(--ease-out);
}

.detail-overlay { opacity: 1; transition: opacity 200ms var(--ease-out); }
.detail-panel {
  transform: translateX(0);
  transition: transform 240ms var(--ease-drawer);
}

@media (prefers-reduced-motion: reduce) {
  .node-library, .detail-overlay, .detail-panel { transition: opacity 160ms ease; transform: none; }
  .node-status.running i { animation: none; opacity: 1; }
}
```

## Repo conventions to follow

- Keep CSS in `src/app/styles.css` and `src/app/canvas.css`; no additional dependency or motion
  runtime is needed.
- `DetailPanel` is rendered from `src/app/page.tsx`; preserve its existing click-to-dismiss
  behavior and stop-propagation on the panel itself.
- Use CSS state classes or `@starting-style` if exit state needs component state. Do not use a
  keyframe for user-triggered overlays because it cannot retarget on rapid interaction.

## Steps

1. Add the three easing variables to the existing `:root` declaration in `src/app/styles.css`.
2. Add a 100-160ms `transform: scale(.97)` press feedback transition to primary buttons and
   node cards only. Do not apply it to navigation, text fields, or the high-frequency canvas
   selection tool.
3. In `src/app/page.tsx`, let `DetailPanel` retain a short closing state before removing its
   element so the panel returns on the same rightward route that it entered. Escape must close
   it too, and focus must return to the initiating row/button.
4. In `src/app/canvas.css`, animate the node library from `opacity: 0` and `scale(.97)` at its
   top-right trigger origin over 160ms. Keep the add-node button immediately clickable.
5. In `src/app/canvas.css`, animate the detail scrim opacity for 200ms and its right panel with
   `translateX(100%)` to `translateX(0)` for 240ms using `--ease-drawer`. The exit uses the
   same route.
6. Add one `prefers-reduced-motion: reduce` override in `src/app/styles.css` / `canvas.css`:
   retain opacity state feedback, remove positional transforms, and disable the running pulse.

## Boundaries

- Do not add Framer Motion, GSAP, or another animation package.
- Do not animate workflow navigation, keyboard actions, or list loading.
- Do not animate layout properties such as `left`, `top`, `width`, `height`, or `padding`.
- Do not change the current native Electron window/title bar behavior.

## Verification

- **Mechanical**: run `npm test`, `npm run build`, and `npm run electron:compile` successfully.
- **Feel check**: open and close an Artifact detail panel and a Run detail panel. The panel must
  enter from, and leave toward, the right edge without blocking the close button.
- **Feel check**: open and close the node library repeatedly; no transition restarts from zero
  or delays its buttons.
- **Accessibility**: enable reduced motion in macOS or browser rendering preferences. The
  surfaces must cross-fade without sliding; a running node stays legible without pulsing.
- **Done when**: all selected occasional overlays explain location without making routine work
  feel slower.
