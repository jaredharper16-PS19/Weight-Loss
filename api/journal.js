// Weight Journal cloud storage.
// Every save writes a NEW private file under journal/ (never overwrites),
// and the newest one is the current journal. The last 50 are kept as history.
import { put, list, get, del } from '@vercel/blob';

const PREFIX = 'journal/';
const KEEP = 50;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

function cleanEntry(e) {
  if (!e || typeof e !== 'object' || !DATE_RE.test(e.date)) return null;
  const w = Number(e.weight);
  if (!isFinite(w) || w <= 0 || w > 1000) return null;
  const s = (v) => (typeof v === 'string' ? v.slice(0, 500) : '');
  return { date: e.date, weight: w, dose: s(e.dose), mood: s(e.mood), side: s(e.side), notes: s(e.notes) };
}

function cleanSettings(x) {
  if (!x) return null;
  const a = Number(x.startWeight), b = Number(x.goalWeight);
  if (!isFinite(a) || !isFinite(b) || a <= 0 || b <= 0 || a > 1000 || b > 1000) return null;
  return { startWeight: a, goalWeight: b };
}

async function allVersions() {
  const blobs = [];
  let cursor;
  do {
    const page = await list({ prefix: PREFIX, cursor, limit: 1000 });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs.sort((a, b) => a.pathname.localeCompare(b.pathname));
}

async function loadLatest() {
  const versions = await allVersions();
  if (!versions.length) return { state: { entries: [], settings: null, deleted: {} }, versions };
  const latest = versions[versions.length - 1];
  const res = await get(latest.pathname, { access: 'private', useCache: false });
  if (!res || res.statusCode !== 200) throw new Error('Could not read journal');
  const text = await new Response(res.stream).text();
  const data = JSON.parse(text);
  return {
    state: {
      entries: Array.isArray(data.entries) ? data.entries : [],
      settings: data.settings || null,
      deleted: data.deleted && typeof data.deleted === 'object' ? data.deleted : {},
      savedAt: data.savedAt || null,
    },
    versions,
  };
}

async function saveNew(state, versions) {
  const savedAt = new Date().toISOString();
  const body = { app: 'weight-journal', version: 1, savedAt, ...state };
  body.entries = body.entries.slice().sort((a, b) => a.date.localeCompare(b.date));
  const name = PREFIX + savedAt.replace(/[:.]/g, '-') + '.json';
  await put(name, JSON.stringify(body), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
  });
  const old = versions.slice(0, Math.max(0, versions.length + 1 - KEEP));
  if (old.length) await del(old.map((b) => b.url));
  return body;
}

export async function GET() {
  try {
    const { state } = await loadLatest();
    return json(state);
  } catch (err) {
    return json({ error: 'Could not load journal' }, 500);
  }
}

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'Bad request' }, 400);

  try {
    const { state, versions } = await loadLatest();
    const byDate = new Map(state.entries.map((e) => [e.date, e]));
    const deleted = { ...state.deleted };
    let settings = state.settings;
    let changed = false;

    if (body.op === 'upsert') {
      const e = cleanEntry(body.entry);
      if (!e) return json({ error: 'Invalid entry' }, 400);
      byDate.set(e.date, e);
      delete deleted[e.date];
      changed = true;
    } else if (body.op === 'delete') {
      if (!DATE_RE.test(body.date)) return json({ error: 'Invalid date' }, 400);
      if (byDate.has(body.date)) { byDate.delete(body.date); changed = true; }
      deleted[body.date] = new Date().toISOString();
    } else if (body.op === 'settings') {
      const s = cleanSettings(body.settings);
      if (!s) return json({ error: 'Invalid settings' }, 400);
      settings = s;
      changed = true;
    } else if (body.op === 'merge') {
      // Adds entries the server doesn't have yet. With overwrite (a backup
      // import), the incoming version replaces same-date entries.
      const list = Array.isArray(body.entries) ? body.entries.slice(0, 5000) : [];
      for (const raw of list) {
        const e = cleanEntry(raw);
        if (!e) continue;
        if (body.overwrite) {
          byDate.set(e.date, e); delete deleted[e.date]; changed = true;
        } else if (!byDate.has(e.date) && !deleted[e.date]) {
          byDate.set(e.date, e); changed = true;
        }
      }
      const s = cleanSettings(body.settings);
      if (s && (!settings || body.overwrite)) { settings = s; changed = true; }
    } else {
      return json({ error: 'Unknown action' }, 400);
    }

    if (!changed) return json(state);
    const saved = await saveNew({ entries: [...byDate.values()], settings, deleted }, versions);
    return json(saved);
  } catch (err) {
    return json({ error: 'Could not save journal' }, 500);
  }
}
