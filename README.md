# Prakruthivanam DailyOps

Store management app for Prakruthivanam organic store, Hyderabad. React + Vite + Supabase.

- **This branch (`source`)**: the actual application source code.
- **`main` branch**: built static output only (`index.html` + `assets/`), served directly by GitHub Pages at [dailyops.prakruthivanam.in](https://dailyops.prakruthivanam.in).

## Develop

```
npm install
npm run dev
```

## Deploy

```
npm run build
```

Then copy `dist/index.html` and `dist/assets/` into a checkout of `main` (replacing the existing `assets/` folder), commit, and push `main`. GitHub Pages redeploys automatically.
