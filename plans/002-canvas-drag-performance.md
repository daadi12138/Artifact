# 002 - Keep workflow dragging on the compositor

- **Status**: TODO
- **Commit**: unavailable - this workspace has no usable Git metadata
- **Severity**: MEDIUM
- **Category**: performance, direct manipulation
- **Estimated scope**: 2 files, focused interaction change

## Problem

Every pointer movement currently runs a React `setNodes` update. That rerenders every node and
all SVG edge paths while also changing positional layout properties. A large workflow will feel
disconnected from the pointer and unnecessarily schedule a workflow persistence timer.

```tsx
/* src/app/page.tsx:97 - current */
const move = (event: React.PointerEvent) => {
  const drag = props.dragRef.current;
  if (!drag) return;
  const canvas = event.currentTarget.getBoundingClientRect();
  props.onMove(current => current.map(node => node.id === drag.id
    ? { ...node, x: Math.max(14, event.clientX - canvas.left - drag.dx),
        y: Math.max(20, event.clientY - canvas.top - drag.dy) }
    : node));
}
```

## Target

The selected node follows the pointer one-to-one during the gesture through a direct
`transform: translate3d(...)`. On pointer release, persist the final `x`/`y` once to React
state and the existing workflow save flow. Edge paths may update only at release in this first
pass; that is preferable to rerendering the complete graph per pointer event.

```tsx
// target behavior, representative
nodeElement.style.transform = `translate3d(${nextX - node.x}px, ${nextY - node.y}px, 0)`;
// pointer release only
setNodes(current => current.map(node => node.id === drag.id
  ? { ...node, x: drag.finalX, y: drag.finalY }
  : node));
```

## Repo conventions to follow

- Keep this logic inside `WorkflowView` in `src/app/page.tsx`; the codebase currently has no
  separate canvas component.
- Preserve `PointerEvent` and `setPointerCapture` use in the node `onPointerDown` handler.
- The existing 450ms workflow auto-save effect must observe only the final committed position.

## Steps

1. Extend the drag ref shape in `HomePage` with `startX`, `startY`, `finalX`, `finalY`, and a
   reference to the dragged element; preserve its pointer offset (`dx` / `dy`).
2. On node pointer down, record the node's current logical coordinate and capture the pointer.
3. On pointer move, calculate bounded coordinates, update `finalX`/`finalY`, and set the
   dragged element's direct `translate3d` transform. Do not call React state setters here.
4. On pointer up or pointer cancel, clear the direct transform and make exactly one `setNodes`
   update to persist `finalX`/`finalY`; then clear the drag ref.
5. Add `will-change: transform` only while dragging via a `.dragging` class; remove it when the
   gesture ends. Keep the current `touch-action: none` and grabbing cursor.
6. Verify that Shift-click edge creation is still a click operation and does not start a drag.

## Boundaries

- Do not add a canvas library or a spring library.
- Do not add inertia, snapping, or a positional animation after drop. Workflow editing is a
  precision desktop task and must stop exactly under the pointer.
- Do not persist positions on every pointer event.

## Verification

- **Mechanical**: run `npm test`, `npm run build`, and `npm run electron:compile` successfully.
- **Feel check**: drag a node diagonally across the canvas and quickly reverse direction. It must
  stay attached to the initial grab point, never jump, and settle at the released position.
- **Regression check**: reload the page and confirm the final node position was persisted by the
  existing workflow API.
- **Done when**: React does not update the node list during pointer move, and the UI remains
  direct with a larger workflow.
