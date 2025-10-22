# Agent Log – Waymo Scenario Studio

## Mission
Deliver a visual, browser-based scenario authoring environment for the Waymo Open Motion Dataset (WOMD) so RL researchers can inspect, create, and precisely edit agents, map geometry, and temporal data before exporting training-ready JSON.

## Current Surface (v0.2)
- React + Vite + TypeScript single-page app with global scenario store.
- Scenario registry supports blank scenarios and JSON import; frames derived from parsed object trajectories.
- Viewer renders agents top-down with playback, zoom/pan, per-agent trajectories, expert colouring, label toggles, and road overlays.
- Timeline scrubber exposes frame index, play/pause, speed control, and keyboard shortcut (`space`).
- Scenario sidebar + details panel manage naming, export, trajectory visibility, and label toggle.

## Editing Vision
1. **Trajectory Editing** – Select an agent, inspect its path, insert/delete/move control points with smooth interpolation, adjust headings/speeds per frame.
2. **Agent Lifecycle** – Add or duplicate agents, configure dimensions/type/expert flag, define spawn & despawn frames, copy/paste trajectories across scenarios.
3. **Road Geometry** – Draw, split, merge, or delete road edges and drivable areas with snapping and type metadata (`ROAD_EDGE`, `ROAD_LINE`, etc.).
4. **Frame Tooling** – Keyframe annotations for events (e.g., speed limits, traffic lights), batch operations across frame ranges, undo/redo history.
5. **Data Integrity** – Preserve raw payload compatibility, validate constraints (e.g., monotonic timestamps, legal bounding boxes) before export.

## Technical Constraints & Resources
- Sample data stored as JSON derived from Waymo TFRecords; parser currently normalises `objects -> agents` and `roads` into simplified model (`src/lib/scenarioParser.ts`).
- Canvas rendering pipeline lives in `ScenarioViewer.tsx`; editing overlays must share transform/zoom state for accurate hit-testing.
- Global store (`scenarioStore.tsx`) owns scenario registry, frames, playback, visibility; edit operations must remain pure and undo-friendly.
- No backend – all editing occurs client-side; export should mirror importable JSON.

## Proposed Milestones
1. **Selection & Inspect (M1)**
   - Hover/selection states for agents & road edges.
   - Sidebar listing updates with selected entity metadata.
   - Read-only overlays for trajectories with start/end markers.
2. **Trajectory Editor MVP (M2)**
   - Draggable control points with frame snapping.
   - Ability to insert/remove points, update heading/speed, auto-recompute derived frames.
   - Undo/redo stack scoped to scenario edits.
3. **Agent Management (M3)**
   - Create/delete agents, set type/dimensions/expert flag.
   - Trajectory templating from existing agents, duplicate agent across frames.
4. **Road Geometry Tools (M4)**
   - Polyline editor with vertex drag + type switching.
   - Snapping/grid aids and map-layer toggles.
5. **Validation & Export (M5)**
   - Live validation warnings (e.g., overlapping IDs, gaps in trajectory timestamps).
   - Deterministic JSON export compatible with training pipelines.

## Immediate Priorities for Editing Sprint
- Finalise interaction model (selection, handles, keyboard modifiers) + mock UI states.
- Decide data structure for editable trajectories (e.g., keyframes vs. per-frame array) and map editing (immutable updates).
- Introduce dedicated editing state slice (selected entity, tool mode, undo stack) while keeping playback responsive.
- Implement selection overlay + bounding boxes as groundwork for editing tools.
- Add tests or sanity checks ensuring edits sync with timeline & exporter.

## Known Challenges / Open Questions
- How to handle high-frequency trajectories efficiently (interpolation, performance) when manipulating individual frames.
- UX for vehicle orientation when editing (heading vs. spline tangents).
- Whether to support multi-agent editing simultaneously and collision detection feedback.
- Strategy for persisting undo/redo history and diffing for export.

## Reference Notes
- Canvas transform utilities live in `ScenarioViewer.tsx`; reuse them for hit-testing edit controls.
- Scenario parser currently filters invalid/despawned points; editors must decide whether to expose these to users.
- Space-bar restarts playback from frame 0 when at end; timeline slider remains source of truth for frame index.

Other todos:
1. Add ability to set episode length manually
2. Add some instructions / documentation
3. Make it straight export as .bin
4. after recording a driving path we need the initial angle of the car to be facing the direction that we go for both record and drive

Fixes
1. When rotating an agent if it has a path we should probably keep that path locked so that the path rotates as well

---
Last updated: Transform gizmo, undo stack, and UI polish (Editing sprint, Week 3)._
---
