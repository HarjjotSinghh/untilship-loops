#!/usr/bin/env node
// Zero-dependency JSON-LD validator for the schema.org types sites use most.
//
// It checks structure, not truth: @context, @type, required properties per type, URL and
// date formats, and nested entities (author, offers, address, ...). Rules follow schema.org
// definitions and Google Search Central's structured-data requirements. "error" means the
// entity is broken or missing what makes it meaningful; "warning" means a recommended
// property for rich results is missing.
//
//   node jsonld-validate.mjs file.json|file.html [...]
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ORG_TYPES = ['Organization', 'Corporation', 'NGO', 'NewsMediaOrganization', 'OnlineStore', 'OnlineBusiness', 'EducationalOrganization', 'GovernmentOrganization', 'MedicalOrganization', 'SportsOrganization'];
const LOCAL_BUSINESS = ['LocalBusiness', 'Store', 'Restaurant', 'ProfessionalService', 'FoodEstablishment', 'HealthAndBeautyBusiness', 'AutomotiveBusiness', 'LodgingBusiness', 'FinancialService', 'LegalService', 'MedicalBusiness', 'HomeAndConstructionBusiness'];
const ARTICLE_TYPES = ['Article', 'BlogPosting', 'NewsArticle', 'TechArticle', 'Report', 'ScholarlyArticle'];
const APP_TYPES = ['SoftwareApplication', 'WebApplication', 'MobileApplication', 'VideoGame'];
const KNOWN = new Set([...ORG_TYPES, ...LOCAL_BUSINESS, ...ARTICLE_TYPES, ...APP_TYPES,
  'WebSite', 'WebPage', 'AboutPage', 'ContactPage', 'FAQPage', 'QAPage', 'CollectionPage', 'ItemPage', 'ProfilePage',
  'Product', 'Offer', 'AggregateOffer', 'AggregateRating', 'Rating', 'Review', 'Person', 'PostalAddress', 'ImageObject',
  'BreadcrumbList', 'ListItem', 'Question', 'Answer', 'SearchAction', 'EntryPoint', 'Event', 'Place', 'VirtualLocation',
  'HowTo', 'HowToStep', 'HowToSection', 'VideoObject', 'Brand', 'ContactPoint', 'ItemList', 'Course', 'Recipe', 'Thing']);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const CURRENCY = /^[A-Z]{3}$/;

function isAbsUrl(v) { try { const u = new URL(String(v)); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } }
function typesOf(node) { const t = node && node['@type']; return t === undefined ? [] : (Array.isArray(t) ? t : [t]).map(String).map((x) => x.replace(/^https?:\/\/schema\.org\//, '').replace(/^schema:/, '')); }
function asArray(v) { return v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]); }
function has(node, k) { const v = node[k]; return v !== undefined && v !== null && !(typeof v === 'string' && !v.trim()) && !(Array.isArray(v) && !v.length); }
function text(v) { if (typeof v === 'string') return v; if (v && typeof v === 'object' && typeof v['@value'] === 'string') return v['@value']; return null; }

function contextOk(ctx) {
  const ok = (c) => (typeof c === 'string' && /^https?:\/\/schema\.org\/?$/.test(c)) ||
    (c && typeof c === 'object' && !Array.isArray(c) && typeof c['@vocab'] === 'string' && /schema\.org/.test(c['@vocab']));
  return Array.isArray(ctx) ? ctx.some(ok) : ok(ctx);
}

export function validateJsonLd(doc) {
  const errors = [];
  const warnings = [];
  const types = [];
  const err = (p, m) => errors.push(`${p}: ${m}`);
  const warn = (p, m) => warnings.push(`${p}: ${m}`);

  const checkUrlProp = (node, k, p, required = false) => {
    if (!has(node, k)) { if (required) err(p, `missing "${k}"`); return; }
    for (const v of asArray(node[k])) {
      const u = typeof v === 'object' && v !== null ? (v.url || v['@id'] || v.contentUrl) : v;
      if (!isAbsUrl(u)) err(p, `"${k}" must be an absolute http(s) URL, got ${JSON.stringify(u)}`);
    }
  };
  const checkDate = (node, k, p, required = false) => {
    if (!has(node, k)) { if (required) err(p, `missing "${k}"`); return; }
    if (!ISO_DATE.test(String(text(node[k]) ?? ''))) err(p, `"${k}" must be an ISO 8601 date, got ${JSON.stringify(node[k])}`);
  };
  const needName = (node, p, k = 'name') => { if (!has(node, k)) err(p, `missing "${k}"`); };
  const nested = (node, k, p, allowed, { required = false, needsName = true } = {}) => {
    if (!has(node, k)) { if (required) err(p, `missing "${k}"`); return []; }
    const out = [];
    asArray(node[k]).forEach((v, i) => {
      const pp = `${p}.${k}${Array.isArray(node[k]) ? `[${i}]` : ''}`;
      if (typeof v === 'string') { if (needsName) warn(pp, `is a plain string; prefer a typed object (${allowed[0]})`); return; }
      if (!v || typeof v !== 'object') { err(pp, 'must be an object'); return; }
      if (v['@id'] && Object.keys(v).length === 1) return; // reference to a node defined elsewhere
      const t = typesOf(v);
      if (!t.length) err(pp, `missing "@type" (expected ${allowed.join(' or ')})`);
      else if (allowed.length && !t.some((x) => allowed.includes(x))) warn(pp, `@type ${t.join(',')} is unusual here (expected ${allowed.join(' or ')})`);
      out.push([v, pp]);
      visit(v, pp, false);
    });
    return out;
  };

  function checkOffer(o, p) {
    const t = typesOf(o);
    if (t.includes('AggregateOffer')) {
      if (!has(o, 'lowPrice')) err(p, 'AggregateOffer missing "lowPrice"');
      if (!has(o, 'priceCurrency')) err(p, 'AggregateOffer missing "priceCurrency"');
    } else {
      if (!has(o, 'price') && !(o.priceSpecification && has(o.priceSpecification, 'price'))) err(p, 'Offer missing "price"');
      else if (has(o, 'price') && !/^\d+(\.\d+)?$/.test(String(o.price))) err(p, `"price" must be a number like 19.99 (no currency symbol), got ${JSON.stringify(o.price)}`);
      if (!has(o, 'priceCurrency') && !(o.priceSpecification && has(o.priceSpecification, 'priceCurrency'))) err(p, 'Offer missing "priceCurrency"');
    }
    if (has(o, 'priceCurrency') && !CURRENCY.test(String(o.priceCurrency))) err(p, `"priceCurrency" must be ISO 4217 (e.g. USD), got ${JSON.stringify(o.priceCurrency)}`);
    if (has(o, 'availability') && !/^https?:\/\/schema\.org\/\w+$/.test(String(o.availability))) warn(p, '"availability" should be a schema.org URL like https://schema.org/InStock');
  }

  function checkRating(r, p) {
    if (!has(r, 'ratingValue')) err(p, 'missing "ratingValue"');
    if (typesOf(r).includes('AggregateRating') && !has(r, 'ratingCount') && !has(r, 'reviewCount')) err(p, 'AggregateRating needs "ratingCount" or "reviewCount"');
  }

  function visit(node, p, topLevel) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) { err(p, 'must be a JSON object'); return; }
    if (Array.isArray(node['@graph'])) {
      if (topLevel && !contextOk(node['@context'])) err(p, '"@context" must be "https://schema.org"');
      node['@graph'].forEach((n, i) => visit(n, `${p}.@graph[${i}]`, false));
      return;
    }
    if (topLevel && !contextOk(node['@context'])) err(p, '"@context" must be "https://schema.org"');
    const t = typesOf(node);
    if (!t.length) { if (topLevel || !node['@id']) err(p, 'missing "@type"'); return; }
    types.push(...t);
    const label = `${p}<${t.join(',')}>`;
    const is = (list) => t.some((x) => list.includes(x));
    for (const x of t) if (!KNOWN.has(x)) warn(label, `type "${x}" is not validated by this tool`);

    if (is(ORG_TYPES) || is(LOCAL_BUSINESS)) {
      needName(node, label);
      if (!has(node, 'url')) warn(label, 'add "url"'); else checkUrlProp(node, 'url', label);
      if (has(node, 'logo')) checkUrlProp(node, 'logo', label); else warn(label, 'add "logo" (absolute image URL)');
      if (has(node, 'sameAs')) checkUrlProp(node, 'sameAs', label);
      nested(node, 'contactPoint', label, ['ContactPoint'], { needsName: false });
    }
    if (is(LOCAL_BUSINESS)) {
      if (!has(node, 'address')) err(label, 'LocalBusiness missing "address"');
      else nested(node, 'address', label, ['PostalAddress'], { needsName: false });
    }
    if (t.includes('WebSite')) {
      needName(node, label);
      checkUrlProp(node, 'url', label, true);
      for (const [a, ap] of nested(node, 'potentialAction', label, ['SearchAction'], { needsName: false })) {
        if (!typesOf(a).includes('SearchAction')) continue;
        const target = typeof a.target === 'string' ? a.target : a.target && (a.target.urlTemplate || '');
        if (!target || !String(target).includes('{search_term_string}')) err(ap, 'SearchAction "target" must contain {search_term_string}');
        const qi = a['query-input'];
        if (!qi || !/name=search_term_string/.test(typeof qi === 'string' ? qi : JSON.stringify(qi))) err(ap, 'SearchAction needs "query-input": "required name=search_term_string"');
      }
    }
    if (is(['WebPage', 'AboutPage', 'ContactPage', 'CollectionPage', 'ItemPage', 'ProfilePage'])) {
      if (!has(node, 'name') && !has(node, 'headline')) warn(label, 'add "name"');
      if (has(node, 'url')) checkUrlProp(node, 'url', label);
      nested(node, 'breadcrumb', label, ['BreadcrumbList'], { needsName: false });
    }
    if (is(ARTICLE_TYPES)) {
      if (!has(node, 'headline')) err(label, 'missing "headline"');
      else if (String(text(node.headline) || '').length > 110) warn(label, `"headline" is ${String(node.headline).length} chars; Google truncates past 110`);
      checkDate(node, 'datePublished', label, true);
      checkDate(node, 'dateModified', label);
      if (!has(node, 'author')) warn(label, 'add "author" (Person or Organization with name)');
      for (const [a, ap] of nested(node, 'author', label, ['Person', 'Organization'])) needName(a, ap);
      if (!has(node, 'image')) warn(label, 'add "image"'); else checkUrlProp(node, 'image', label);
      for (const [pub, pp] of nested(node, 'publisher', label, ['Organization', 'Person'])) needName(pub, pp);
    }
    if (t.includes('Product')) {
      needName(node, label);
      if (!has(node, 'offers') && !has(node, 'review') && !has(node, 'aggregateRating')) err(label, 'Product needs "offers", "review" or "aggregateRating"');
      for (const [o, op] of nested(node, 'offers', label, ['Offer', 'AggregateOffer'], { needsName: false })) checkOffer(o, op);
      for (const [r, rp] of nested(node, 'aggregateRating', label, ['AggregateRating'], { needsName: false })) checkRating(r, rp);
      if (has(node, 'image')) checkUrlProp(node, 'image', label); else warn(label, 'add "image"');
      for (const [b, bp] of nested(node, 'brand', label, ['Brand', 'Organization'])) needName(b, bp);
    }
    if (is(APP_TYPES)) {
      needName(node, label);
      if (!has(node, 'offers')) warn(label, 'add "offers" (price 0 for free) for rich results');
      for (const [o, op] of nested(node, 'offers', label, ['Offer', 'AggregateOffer'], { needsName: false })) checkOffer(o, op);
      if (!has(node, 'applicationCategory')) warn(label, 'add "applicationCategory"');
      if (!has(node, 'operatingSystem')) warn(label, 'add "operatingSystem"');
      for (const [r, rp] of nested(node, 'aggregateRating', label, ['AggregateRating'], { needsName: false })) checkRating(r, rp);
    }
    if (t.includes('FAQPage')) {
      const qs = nested(node, 'mainEntity', label, ['Question'], { required: true, needsName: false });
      if (has(node, 'mainEntity') && !qs.length) err(label, '"mainEntity" must list Question objects');
      for (const [q, qp] of qs) {
        if (!has(q, 'name')) err(qp, 'Question missing "name" (the question text)');
        const ans = asArray(q.acceptedAnswer);
        if (!ans.length) err(qp, 'Question missing "acceptedAnswer"');
        ans.forEach((a, i) => { if (!a || typeof a !== 'object' || !has(a, 'text')) err(`${qp}.acceptedAnswer[${i}]`, 'Answer missing "text"'); });
      }
    }
    if (t.includes('BreadcrumbList')) {
      const items = asArray(node.itemListElement);
      if (!items.length) err(label, 'missing "itemListElement"');
      items.forEach((it, i) => {
        const ip = `${label}.itemListElement[${i}]`;
        if (!it || typeof it !== 'object') { err(ip, 'must be a ListItem object'); return; }
        if (!Number.isInteger(Number(it.position)) || Number(it.position) < 1) err(ip, '"position" must be an integer starting at 1');
        else if (Number(it.position) !== i + 1) warn(ip, `position ${it.position} is out of order (expected ${i + 1})`);
        const itemObj = it.item && typeof it.item === 'object' ? it.item : null;
        if (!has(it, 'name') && !(itemObj && has(itemObj, 'name'))) err(ip, 'ListItem missing "name"');
        const url = itemObj ? (itemObj['@id'] || itemObj.url) : it.item;
        if (url === undefined) { if (i < items.length - 1) err(ip, 'ListItem missing "item" (URL); only the last crumb may omit it'); }
        else if (!isAbsUrl(url)) err(ip, `"item" must be an absolute URL, got ${JSON.stringify(url)}`);
      });
    }
    if (t.includes('Person') && !topLevel) needName(node, label);
    if (t.includes('Person') && topLevel) { needName(node, label); if (has(node, 'sameAs')) checkUrlProp(node, 'sameAs', label); }
    if (t.includes('Event')) {
      needName(node, label);
      checkDate(node, 'startDate', label, true);
      checkDate(node, 'endDate', label);
      if (!has(node, 'location')) err(label, 'Event missing "location"');
    }
    if (t.includes('HowTo')) { needName(node, label); if (!has(node, 'step')) err(label, 'HowTo missing "step"'); }
    if (t.includes('Review')) { if (!has(node, 'author')) err(label, 'Review missing "author"'); for (const [r, rp] of nested(node, 'reviewRating', label, ['Rating'], { needsName: false })) checkRating(r, rp); }
  }

  const docs = Array.isArray(doc) ? doc : [doc];
  docs.forEach((d, i) => visit(d, docs.length > 1 ? `$[${i}]` : '$', true));
  return { errors, warnings, types: Array.from(new Set(types)) };
}

/** Extract every <script type="application/ld+json"> body from HTML. */
export function extractJsonLdBlocks(html) {
  const blocks = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/type\s*=\s*["']?application\/ld\+json["']?/i.test(m[1])) blocks.push(m[2].trim());
  }
  return blocks;
}

export function validateText(raw) {
  try { return validateJsonLd(JSON.parse(raw)); } catch (e) { return { errors: [`$: not valid JSON (${e.message})`], warnings: [], types: [] }; }
}

const isMain = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  let bad = 0;
  for (const f of process.argv.slice(2)) {
    const raw = readFileSync(f, 'utf8');
    const blocks = /\.html?$/i.test(f) ? extractJsonLdBlocks(raw) : [raw];
    if (!blocks.length) console.log(`${f}: no JSON-LD blocks`);
    blocks.forEach((b, i) => {
      const r = validateText(b);
      console.log(`${f}#${i + 1} [${r.types.join(', ') || 'no type'}]: ${r.errors.length} error(s), ${r.warnings.length} warning(s)`);
      r.errors.forEach((e) => console.log('  ERROR ' + e));
      r.warnings.forEach((w) => console.log('  warn  ' + w));
      if (r.errors.length) bad++;
    });
  }
  process.exit(bad ? 1 : 0);
}
