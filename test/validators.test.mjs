// Unit tests for the loop scripts' parsers and validators.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateJsonLd, extractJsonLdBlocks } from '../loops/aeo-setup/jsonld-validate.mjs';
import { checkLlmsTxt, checkAgentsMd, parseRobots, robotsAllows, checkSitemapXml } from '../loops/aeo-setup/aeo-check.mjs';
import { satisfies, minOfRange } from '../loops/dependency-upgrade/verify-version.mjs';
import { parseChecklist } from '../loops/idea-to-mvp/checklist.mjs';
import { parseRubric, gates, extractJson, normaliseJudges } from '../loops/launch-post/score.mjs';

const ctx = 'https://schema.org';

describe('JSON-LD validator', () => {
  test('valid Organization + WebSite graph has no errors', () => {
    const r = validateJsonLd({ '@context': ctx, '@graph': [
      { '@type': 'Organization', name: 'A', url: 'https://a.com', logo: 'https://a.com/l.png', sameAs: ['https://x.com/a'] },
      { '@type': 'WebSite', name: 'A', url: 'https://a.com', potentialAction: { '@type': 'SearchAction', target: 'https://a.com/s?q={search_term_string}', 'query-input': 'required name=search_term_string' } },
    ] });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.types.sort(), ['Organization', 'SearchAction', 'WebSite']);
  });

  test('missing or wrong @context, missing @type', () => {
    assert.match(validateJsonLd({ '@type': 'Person', name: 'x' }).errors[0], /@context/);
    assert.match(validateJsonLd({ '@context': 'https://example.org', '@type': 'Person', name: 'x' }).errors[0], /@context/);
    assert.match(validateJsonLd({ '@context': ctx, name: 'x' }).errors[0], /missing "@type"/);
    assert.deepEqual(validateJsonLd({ '@context': { '@vocab': 'https://schema.org/' }, '@type': 'Person', name: 'x' }).errors, []);
  });

  test('Article requires headline + ISO datePublished; author needs a name', () => {
    const r = validateJsonLd({ '@context': ctx, '@type': 'BlogPosting', datePublished: 'last week', author: { '@type': 'Person' } });
    assert.ok(r.errors.some((e) => /missing "headline"/.test(e)));
    assert.ok(r.errors.some((e) => /datePublished" must be an ISO 8601/.test(e)));
    assert.ok(r.errors.some((e) => /author.*missing "name"/.test(e)));
  });

  test('Product offers: numeric price and ISO currency', () => {
    const bad = validateJsonLd({ '@context': ctx, '@type': 'Product', name: 'P', offers: { '@type': 'Offer', price: '$19', priceCurrency: 'dollars' } });
    assert.ok(bad.errors.some((e) => /"price" must be a number/.test(e)));
    assert.ok(bad.errors.some((e) => /ISO 4217/.test(e)));
    const none = validateJsonLd({ '@context': ctx, '@type': 'Product', name: 'P' });
    assert.ok(none.errors.some((e) => /needs "offers", "review" or "aggregateRating"/.test(e)));
    const ok = validateJsonLd({ '@context': ctx, '@type': 'Product', name: 'P', image: 'https://a.com/p.png', offers: { '@type': 'Offer', price: 19.5, priceCurrency: 'EUR', availability: 'https://schema.org/InStock' } });
    assert.deepEqual(ok.errors, []);
  });

  test('FAQPage questions need name + acceptedAnswer.text', () => {
    const r = validateJsonLd({ '@context': ctx, '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Q?', acceptedAnswer: { '@type': 'Answer' } }, { '@type': 'Question' }] });
    assert.ok(r.errors.some((e) => /Answer missing "text"/.test(e)));
    assert.ok(r.errors.some((e) => /Question missing "name"/.test(e)));
  });

  test('BreadcrumbList positions and absolute item URLs', () => {
    const r = validateJsonLd({ '@context': ctx, '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: '/home' },
      { '@type': 'ListItem', position: 'two', name: 'Blog', item: 'https://a.com/blog' },
      { '@type': 'ListItem', position: 3, name: 'Post' },
    ] });
    assert.ok(r.errors.some((e) => /"item" must be an absolute URL/.test(e)));
    assert.ok(r.errors.some((e) => /"position" must be an integer/.test(e)));
    assert.ok(!r.errors.some((e) => /\[2\].*missing "item"/.test(e)), 'last crumb may omit item');
  });

  test('LocalBusiness needs an address; Event needs startDate + location', () => {
    assert.ok(validateJsonLd({ '@context': ctx, '@type': 'Restaurant', name: 'R' }).errors.some((e) => /missing "address"/.test(e)));
    const ev = validateJsonLd({ '@context': ctx, '@type': 'Event', name: 'E' });
    assert.ok(ev.errors.some((e) => /missing "startDate"/.test(e)));
    assert.ok(ev.errors.some((e) => /missing "location"/.test(e)));
  });

  test('extracts ld+json blocks regardless of attribute order and quoting', () => {
    const html = '<script>var x</script><script id="a" type="application/ld+json">{"a":1}</script><SCRIPT type=application/ld+json>{"b":2}</SCRIPT>';
    assert.deepEqual(extractJsonLdBlocks(html), ['{"a":1}', '{"b":2}']);
  });
});

describe('llms.txt, AGENTS.md, robots.txt, sitemap', () => {
  test('llms.txt: valid file passes; structure errors are specific', () => {
    const ok = checkLlmsTxt('# Site\n\n> Summary.\n\n## Docs\n\n- [Start](https://a.com/start): how to begin\n');
    assert.deepEqual(ok.errors, []);
    const bad = checkLlmsTxt('Intro\n# A\n# B\n## Docs\n- Start page https://a.com\n- [Rel](docs/x)\n');
    assert.ok(bad.errors.some((e) => /first line must be/.test(e)));
    assert.ok(bad.errors.some((e) => /exactly one "# " H1/.test(e)));
    assert.ok(bad.errors.some((e) => /list items must be/.test(e)));
    assert.ok(bad.errors.some((e) => /must be an absolute URL or start with \//.test(e)));
    assert.ok(checkLlmsTxt('<html><body>404</body></html>').errors.some((e) => /looks like HTML/.test(e)));
  });

  test('AGENTS.md: the UntilShip block alone does not count', () => {
    const block = '<!-- untilship:start -->\n## UntilShip loops\n\nLots of text `cmd` here to pad it out. '.padEnd(400, 'x') + '\n<!-- untilship:end -->\n';
    assert.ok(checkAgentsMd(block).errors.length > 0);
    assert.deepEqual(checkAgentsMd(`# Repo\n\n## Build\n\n\`\`\`bash\nnpm run build\n\`\`\`\n\n## Test\n\nRun \`npm test\`. ${'Conventions apply. '.repeat(10)}`).errors, []);
    assert.match(checkAgentsMd(null).errors[0], /not found/);
  });

  test('robots.txt: RFC 9309 group selection and longest-match', () => {
    const p = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nUser-agent: ClaudeBot\nAllow: /\nDisallow: /private\n\nSitemap: https://a.com/sitemap.xml');
    assert.equal(robotsAllows(p, 'GPTBot').allowed, true);
    assert.equal(robotsAllows(p, 'claudebot').allowed, true, 'tokens are case-insensitive');
    assert.equal(robotsAllows(p, 'PerplexityBot').allowed, false, 'falls back to *');
    assert.equal(robotsAllows(p, 'GPTBot', '/private/x').allowed, false);
    assert.deepEqual(p.sitemaps, ['https://a.com/sitemap.xml']);
    const tie = parseRobots('User-agent: *\nDisallow: /\nAllow: /');
    assert.equal(robotsAllows(tie, 'GPTBot').allowed, true, 'allow wins a tie');
    assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow:'), 'GPTBot').allowed, true, 'empty disallow allows all');
    assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow: /*'), 'GPTBot').allowed, false, 'wildcards');
  });

  test('sitemap XML: urlset with absolute locs', () => {
    assert.deepEqual(checkSitemapXml('<urlset><url><loc>https://a.com/</loc></url></urlset>').errors, []);
    assert.ok(checkSitemapXml('<urlset><url><loc>/rel</loc></url></urlset>').errors.some((e) => /absolute/.test(e)));
    assert.ok(checkSitemapXml('<html></html>').errors.some((e) => /not a sitemap/.test(e)));
  });
});

describe('dependency-upgrade version logic', () => {
  test('satisfies() covers the target forms the loop documents', () => {
    const cases = [
      ['19.1.2', '19', true], ['18.3.1', '19', false], ['19.1.2', '19.1', true], ['19.2.0', '19.1', false],
      ['19.1.2', '^19.0.0', true], ['20.0.0', '^19.0.0', false], ['0.2.5', '^0.2.1', true], ['0.3.0', '^0.2.1', false],
      ['19.1.5', '~19.1.0', true], ['19.2.0', '~19.1.0', false], ['21.0.0', '>=19', true], ['18.9.9', '>=19', false],
      ['19.0.0-rc.1', '^19.0.0', false], ['2.0.0', '2.0.0', true],
    ];
    for (const [v, t, want] of cases) assert.equal(satisfies(v, t), want, `${v} vs ${t}`);
  });

  test('minOfRange reads the lower bound of declared ranges', () => {
    assert.equal(minOfRange('^19.1.0'), '19.1.0');
    assert.equal(minOfRange('19.x'), '19.0.0');
    assert.equal(minOfRange('>=2.1 <3'), '2.1.0');
    assert.equal(minOfRange('workspace:*'), null);
  });
});

describe('checklist + launch-post scoring', () => {
  test('checklist parser: next-line and inline checks, fenced examples ignored', () => {
    const items = parseChecklist('```\n- [ ] example\n  check: nope\n```\n- [ ] A\n  check: node a.mjs\n- [x] B check: `node b.mjs`\n- [ ] C without check\n');
    assert.deepEqual(items.map((i) => [i.title, i.check]), [['A', 'node a.mjs'], ['B', 'node b.mjs'], ['C without check', null]]);
  });

  test('rubric weights must sum to 100', () => {
    assert.equal(parseRubric('- a (60): x\n- b (40): y').length, 2);
    assert.throws(() => parseRubric('- a (60): x\n- b (30): y'), /add up to 90/);
  });

  test('gates catch hype, placeholders, length and missing link', () => {
    const brief = 'Link: https://x.com';
    const g = Object.fromEntries(gates('# T\n\nWe are thrilled to share this game-changer. TODO', brief, { minWords: 5, maxWords: 50 }).map((x) => [x.name, x.ok]));
    assert.equal(g['no hype words'], false);
    assert.equal(g['no placeholders'], false);
    assert.equal(g.link, false);
    assert.equal(g.length, true);
    assert.equal(gates('# T\n\none two three four five six https://x.com', brief, { minWords: 5, maxWords: 50 }).every((x) => x.ok), true);
  });

  test('judge output: JSON is found inside prose; missing criteria are errors', () => {
    const o = extractJson('Sure! {"note": "x"} and then {"judges": [{"name": "a", "scores": {"a": 7}}]} bye');
    assert.equal(o.judges.length, 1);
    const crit = parseRubric('- a (50): x\n- b (50): y');
    const n = normaliseJudges(o.judges, crit);
    assert.match(n.errors[0], /missing or invalid score for "b"/);
    assert.equal(normaliseJudges([{ name: 'z', scores: { a: 10, b: 5 } }], crit).judges[0].total, 75);
  });
});
