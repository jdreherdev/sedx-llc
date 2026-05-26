# sedx.llc

Marketing site for SEDX, LLC (operating as RLTW) — a static landing page that
catalogs every app in the suite and the unified privacy policy.

## Structure

- `index.html` — app catalog (Military & Service, Professional & Civilian)
- `privacy.html` — unified privacy policy covering all apps
- `icons/` — 72×72 app icon assets, copied from each app's `assets/icon.png`
- `badges/` — official Google Play and Apple App Store badge assets
- `CNAME` — custom domain pointer for GitHub Pages

## Hosting

Served by GitHub Pages from the `main` branch. The `CNAME` file pins the site
to `sedx.llc`. DNS for `sedx.llc` is managed at Spaceship:

- Four apex `A` records pointing to GitHub Pages:
  - `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
- One `CNAME` on `www` → `jdreherdev.github.io.`

## Updating

1. When an app ships to Play, replace its `<a class="btn btn-soon">` with the
   official Google Play badge linked to its Play Store URL (see existing
   Ranger Handbook / Cadet Handbook cards as a template).
2. When an app's icon is redesigned, re-copy `assets/icon.png` from the app
   into `icons/<name>.png`.
3. Push to `main`; GitHub Pages redeploys automatically.

## Contact

rltw.dev@gmail.com
