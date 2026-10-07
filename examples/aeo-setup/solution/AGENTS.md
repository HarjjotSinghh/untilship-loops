# AGENTS.md: tally-site

Static marketing site for Tally. Everything served lives in `public/`.

## Setup and preview

```bash
npx serve public
```

## Conventions

- Every page carries JSON-LD that matches its visible content.
- Update `public/sitemap.xml` and `public/llms.txt` when you add a page.
- Run `node .untilship/loops/aeo-setup/aeo-check.mjs --site-dir public` before you push.
