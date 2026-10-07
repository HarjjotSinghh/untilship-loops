---
name: untilship-aeo-setup
description: "UntilShip loop: AEO setup. You want AI answer engines (ChatGPT, Claude, Perplexity, Google AI features) to be able to crawl, understand and cite your site. Keeps working until llms.txt is well-formed, AGENTS.md exists, every JSON-LD block validates, robots.txt lets the chosen AI crawlers in, and the sitemap is reachable; a hook checks this, not the model."
---

# AEO setup (UntilShip loop)

## How this loop is enforced (read this first)

- `untilship-check` in this file means `node .untilship/bin/untilship-check.cjs`.
- Enforcement is a `Stop` hook in `.codex/hooks.json`. When you end your turn it runs the stop condition; if that fails, Codex continues the turn with the failing output as a new prompt.
- You cannot mark this loop done. Only the check can: `node ".untilship/loops/aeo-setup/aeo-check.mjs" --site-dir "public" --base-url "<base_url>" --crawlers "GPTBot,OAI-SearchBot,ChatGPT-User,ClaudeBot,Claude-User,Claude-SearchBot,PerplexityBot,Perplexity-User,Google-Extended,Applebot-Extended"` (from `.untilship/loops/aeo-setup/loop.md`).
- Editing `.untilship/`, the hook config, or the loop's protected files fails the lap.
- `node .untilship/bin/untilship-check.cjs peek` runs the check without using a lap. `node .untilship/bin/untilship-check.cjs status` shows the lap count.
- The run ends after 8 laps as `blocked`, with a report in `.untilship/runs/<run-id>/report.md`.
- If the human tells you to stop: `node .untilship/bin/untilship-check.cjs abort "reason"`.

Make a site legible to AI answer engines: a well-formed `llms.txt`, an `AGENTS.md`, valid
JSON-LD structured data, a `robots.txt` that admits the AI crawlers you choose, and a
reachable sitemap. Every one of these is checked by a script (`aeo-check.mjs`, with a
bundled zero-dependency JSON-LD validator), so the loop ends on facts, not on the agent's
say-so.

What this loop does not do: guarantee citations or rankings. It removes the technical
reasons an answer engine would skip or misread your site.

## Trigger

A marketing site, docs site or product site that ships static files from a folder
(`public/`, `static/`, `out/`, `dist/`). Set `site_dir` to the folder that is served at `/`.
If the site is generated at build time, build it first and point `site_dir` at the output,
or put the files in the source folder that is copied verbatim.

```bash
node .untilship/bin/untilship-check.cjs start aeo-setup --set site_dir=public --set base_url=https://example.com
```

`base_url` is optional. Without it the sitemap is checked as a local file only and the report
says so. With it, the check fetches `/llms.txt` and the sitemap over HTTP.
To choose crawlers: `--set crawlers=GPTBot,ClaudeBot,PerplexityBot`.

## Steps

1. Run `node .untilship/bin/untilship-check.cjs peek` to see the current state of all five checks.
2. **llms.txt** (`<site_dir>/llms.txt`, format from llmstxt.org): one `# Site name` line,
   a `> one-sentence summary`, then `## Sections` whose items are
   `- [Page title](https://absolute/url): what the reader gets there`. Link the pages an
   answer engine should read first: product, pricing, docs, about, key guides.
3. **AGENTS.md** (repo root): how to work in this repo: setup, build, test, deploy, and
   conventions. At least two `##` sections and a command in a code block.
4. **JSON-LD**: on the home page add `Organization` (name, url, logo, sameAs) and
   `WebSite` (name, url). Add the right type per page: `Article`/`BlogPosting` (headline,
   datePublished, author), `Product` or `SoftwareApplication` (name, offers), `FAQPage`,
   `BreadcrumbList`. Use only facts that are true and visible on the page.
5. **robots.txt**: allow `/` for each chosen crawler (a `User-agent: *` group with
   `Allow: /` is enough if nothing disallows them more specifically) and add a
   `Sitemap: https://.../sitemap.xml` line.
6. **sitemap.xml**: a `<urlset>` (or `<sitemapindex>`) with absolute `<loc>` URLs for every
   public page.
7. End your turn. The Stop hook runs all five checks.

## Stop when

`aeo-check.mjs` exits 0. It fails on any error; warnings are listed in the report but do not
block. Checks: llms.txt structure and links; AGENTS.md present and substantive; every
`application/ld+json` block parses, has a schema.org `@context`, and passes the
type-specific required fields (home page must carry `Organization` or `WebSite`);
robots.txt allows `/` for each crawler under RFC 9309 matching rules; sitemap present
(and reachable over HTTP when `base_url` is set) with at least one `<loc>`.

## On blocked

After 8 laps the run stops as `blocked`. Typical causes: the framework generates
`robots.txt` or the sitemap at build time (check the generated output, not the source), or
a CDN/WAF blocks AI crawlers regardless of robots.txt (outside this repo; tell the human).
Write `.untilship/runs/<run-id>/blockers.md` on the final lap.

## Report

`.untilship/runs/<run-id>/report.md` lists each check per lap with its errors and warnings.
