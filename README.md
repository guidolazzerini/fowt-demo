# Floating Offshore Wind Turbine Browser Demo

Interactive browser-based demo of simplified floating offshore wind turbine dynamics and control.

The app is built with Vite, React, and TypeScript. The simulation runs in a Web Worker and communicates with the React UI through a central simulation hook.

## Scope

This is an educational/control-oriented demo, not a high-fidelity aero-hydro-servo-elastic solver.

Implemented model features:

- steady Cp/Ct/Cq aerodynamic lookup table;
- rigid rotor-speed dynamics;
- one-degree-of-freedom platform pitch dynamics;
- above-rated collective pitch PI controller;
- constant, gust, and random/turbulent wind modes;
- optional floating-feedback term proportional to platform pitch rate;
- start/stop/reset controls;
- live instantaneous, moving-average, and moving-standard-deviation values;
- lightweight time-history plots.

PixiJS graphics are intentionally not part of the current deployed interface.

## Requirements

- Node.js 20.19+ or 22.12+
- npm

## Install

```bash
npm ci
```

Do not commit `node_modules/`. If a zipped copy of the project contains `node_modules/`, remove it and run `npm ci` again so the native optional dependencies match your operating system.

## Development

```bash
npm run dev
```

## Quality checks

```bash
npm run lint
npm run build
```

## Local production preview

```bash
npm run preview
```

Then open the local preview URL shown in the terminal, usually `http://localhost:4173`.

Before deploying, check that:

- the app loads without a white screen;
- the simulation worker loads without a 404 or MIME error;
- `iea15mw-aero-v1.json` loads successfully;
- start, stop, reset, wind modes, PI sliders, and floating-feedback settings still work.

## Static deployment

Recommended host: Netlify.

The repository includes `netlify.toml`:

```toml
[build]
  command = "npm run build"
  publish = "dist"

[build.environment]
  NODE_VERSION = "22"
```

Equivalent Netlify UI settings:

- build command: `npm run build`
- publish directory: `dist`
- Node version: `22`

The aerodynamic table is stored in `public/iea15mw-aero-v1.json`. Vite copies files from `public/` to the root of `dist/` during the production build. The app references this asset through `import.meta.env.BASE_URL`, so it also works if the app is later deployed under a non-root base path.

## Notes for GitHub Pages

For GitHub Pages repository deployment, set the Vite base path in `vite.config.ts`:

```ts
export default defineConfig({
  plugins: [react()],
  base: "/fowt-demo/",
});
```

Use the repository name in place of `fowt-demo` if different.

## Main project structure

```text
src/app/                 React app-level logic and useSimulation hook
src/sim/                 Physics, controller, wind model, worker messages
src/ui/                  Controls, status cards, and plots
public/iea15mw-aero-v1.json  Aerodynamic coefficient table
```

Deployed with Netlify continuous deployment.
