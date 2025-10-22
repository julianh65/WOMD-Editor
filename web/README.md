# Waymo Scenario Studio

A Vite + React based playground for inspecting and editing Waymo Open Motion Dataset (WOMD) scenarios. The current goal is to enable loading JSON exports, visualising them from a top-down perspective, and interactively editing actors, road geometry, and trajectories.

## Getting started

1. Install dependencies (requires Node.js 18+):

   ```bash
   npm install
   ```

2. Start the development server:

   ```bash
   npm run dev
   ```

   Use `npm run dev:host` if you need LAN access.

3. Build for production:

   ```bash
   npm run build
   ```

4. Preview the production bundle:

   ```bash
   npm run preview
   ```

## Project structure

- `src/`
  - `components/` – Application shell and layout primitives.
  - `features/` – Feature domains such as the viewer, editor, and scenario library.
  - `lib/` – Utility helpers, parsers, and data loading utilities.
  - `state/` – Global state management (scenario registry, selection, etc.).
  - `styles/` – Global and feature-level stylesheets.
  - `types/` – Shared TypeScript types for WOMD scenario data.

## Next steps

- Implement actual rendering of agents, drivable areas, and map geometry on the viewer canvas.
- Add timeline playback controls and per-frame filtering.
- Build editing tools for trajectories, road edges, and scenario metadata.
- Add import/export bridges for native WOMD TFRecord structures.
