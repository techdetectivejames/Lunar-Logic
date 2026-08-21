'use strict';

// Public domain congress-legislators dataset (unitedstates/congress-legislators).
// Used to resolve each House member's political party for the congressional trades table.
const CURRENT_URL = 'https://raw.githubusercontent.com/unitedstates/congress-legislators/gh-pages/legislators-current.json';
const HISTORICAL_URL = 'https://raw.githubusercontent.com/unitedstates/congress-legislators/gh-pages/legislators-historical.json';
const REFRESH_MS = 24 * 60 * 60 * 1000; // membership/party data changes rarely; refresh daily

const PARTY_ABBR = {
  Democrat: 'D',
  Republican: 'R',
  Independent: 'I',
  Libertarian: 'L',
};

const HONORIFIC_TOKENS = new Set([
  'mr', 'mrs', 'ms', 'mx', 'dr', 'hon', 'honorable', 'rep', 'representative',
  'md', 'jd', 'esq', 'facs', 'phd', 'jr', 'sr', 'ii', 'iii', 'iv',
]);

let cache = { nameMap: null, districtMap: null, time: 0 };
let inflight = null;

function stripDiacritics(str) {
  return str.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

// Reduces a raw name string to a "first-token last-token" key, dropping
// honorifics, suffixes, quoted nicknames, and middle initials along the way.
function nameKey(rawName) {
  if (!rawName) return null;
  const cleaned = stripDiacritics(String(rawName))
    .replace(/"[^"]*"/g, ' ')
    .replace(/[.,]/g, ' ')
    .toLowerCase();

  const tokens = cleaned
    .split(/\s+/)
    .filter((tok) => tok && !HONORIFIC_TOKENS.has(tok) && tok.length > 1);

  if (!tokens.length) return null;
  if (tokens.length === 1) return tokens[0];
  return `${tokens[0]} ${tokens[tokens.length - 1]}`;
}

function partyAbbr(party) {
  if (!party) return null;
  return PARTY_ABBR[party] || party[0].toUpperCase();
}

function latestRepTerm(terms) {
  let latest = null;
  for (const term of terms || []) {
    if (term.type !== 'rep') continue;
    if (!latest || String(term.start) > String(latest.start)) latest = term;
  }
  return latest;
}

function indexLegislators(list, nameMap, districtMap) {
  for (const legislator of list || []) {
    const term = latestRepTerm(legislator.terms);
    if (!term) continue;
    const party = partyAbbr(term.party);
    if (!party) continue;

    const name = legislator.name || {};
    const keys = new Set([
      nameKey(`${name.first || ''} ${name.last || ''}`),
      nameKey(name.official_full),
    ].filter(Boolean));

    for (const key of keys) {
      const existing = nameMap.get(key);
      if (!existing || String(term.start) > String(existing.start)) {
        nameMap.set(key, { party, start: term.start });
      }
    }

    if (term.state && term.district != null) {
      const districtKey = `${term.state}${term.district}`;
      const existing = districtMap.get(districtKey);
      if (!existing || String(term.start) > String(existing.start)) {
        districtMap.set(districtKey, { party, start: term.start });
      }
    }
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Legislators request failed (${res.status})`);
  return res.json();
}

async function loadMaps() {
  if (cache.nameMap && Date.now() - cache.time < REFRESH_MS) return cache;
  if (inflight) return inflight;

  inflight = (async () => {
    const nameMap = new Map();
    const districtMap = new Map();
    try {
      const [current, historical] = await Promise.all([
        fetchJson(CURRENT_URL),
        fetchJson(HISTORICAL_URL),
      ]);
      // current members indexed first so they win ties against stale historical terms
      indexLegislators(current, nameMap, districtMap);
      indexLegislators(historical, nameMap, districtMap);
    } catch {
      // leave whatever partial data we gathered; lookups simply miss on failure
    }
    cache = { nameMap, districtMap, time: Date.now() };
    return cache;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

// Resolves a House member's party ('D' | 'R' | 'I' | ...) from their disclosed
// name and/or their district code (e.g. "HI01"), preferring the name match.
async function getParty({ representative, district } = {}) {
  const { nameMap, districtMap } = await loadMaps();

  const key = nameKey(representative);
  if (key) {
    const hit = nameMap.get(key);
    if (hit) return hit.party;
  }

  const m = /^([A-Z]{2})0*(\d+)$/.exec(String(district || '').toUpperCase());
  if (m) {
    const districtKey = `${m[1]}${parseInt(m[2], 10)}`;
    const hit = districtMap.get(districtKey);
    if (hit) return hit.party;
  }

  return null;
}

module.exports = { getParty };
