// Converts the Arlington Porchfest 2026 Google My Maps export (data.kml) into data.js.
// Source: https://arlingtonporchfest.org/arlington-porchfest-interactive-map/
// KML: https://www.google.com/maps/d/kml?mid=1xMg3ezL9Ji6dJp9nAXp7A-NPvGYIv6g&forcekml=1
// Unlike Brookline, every porch in the Arlington KML already carries a
// Latitude/Longitude, so no geocoding is needed. Pass --geocode to geocode
// (Nominatim) any porch that is missing coordinates.
// Performances look like "Band A @ 12pm 1p; Band B @ 2p" (hourly slots).
import fs from 'fs/promises';
import https from 'node:https';

const inputPath = new URL('./data.kml', import.meta.url);
const outputPath = new URL('./data.js', import.meta.url);
const shouldGeocode = process.argv.includes('--geocode');

// Performance strings the generic parser can't handle cleanly.
const manualPerformances = new Map([
  ['Edith M Fox Library, Mass Ave', [
    { actname: 'Good Trouble Brass Band', hours: [14] },
    { actname: 'Revolutionary Snake Ensemble Quartet', hours: [15] },
  ]],
  ['334 Mass Ave', [{ actname: 'Lunatic Neighbor (Garage Band After Party, presented by Arlington Commission for Arts and Culture)', hours: [18] }]],
]);

function decodeXml(value) {
  return String(value || '')
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\uFEFF/g, '')
    .trim();
}

function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ ok: response.statusCode < 300, body }));
    }).on('error', reject);
  });
}

async function geocodeAddress(address) {
  const q = `${address}, Arlington, MA`;
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;
  const response = await getJson(url, { 'User-Agent': 'a-better-porchfest-bot/1.0 (arlington conversion)' });
  await new Promise(resolve => setTimeout(resolve, 1100));
  const results = response.ok ? JSON.parse(response.body) : [];
  return results.length ? { lat: String(results[0].lat), lng: String(results[0].lon) } : null;
}

function toHour(text) {
  const hour = Number(text);
  return hour === 12 ? 12 : hour < 9 ? hour + 12 : hour;
}

function parsePerformances(value) {
  const results = [];
  const pattern = /\s*(.+?)\s*@\s*((?:\d{1,2}\s*(?:pm|p)\b\s*)+)(?:;\s*|$)/gi;
  let match;
  while ((match = pattern.exec(value)) !== null) {
    const hours = [...match[2].matchAll(/(\d{1,2})/g)].map(m => toHour(m[1]));
    results.push({ actname: match[1].replace(/[,;]\s*$/, '').trim(), hours });
  }
  return results;
}

// Merge consecutive hourly slots into one longer gig.
function hoursToSlots(hours) {
  const slots = [];
  for (const hour of [...new Set(hours)].sort((a, b) => a - b)) {
    const last = slots[slots.length - 1];
    if (last && last.start + last.length === hour) last.length += 1;
    else slots.push({ start: hour, length: 1 });
  }
  return slots;
}

async function runConversion() {
  const xml = await fs.readFile(inputPath, 'utf8');
  const bands = {}, porches = {}, gigs = {};
  const bandIdByName = new Map();
  let porchCounter = 0, bandCounter = 0, gigCounter = 0;
  const skipped = [];

  for (const [, placemark] of xml.matchAll(/<Placemark>([\s\S]*?)<\/Placemark>/g)) {
    const data = {};
    for (const [, key, value] of placemark.matchAll(/<Data name="([^"]+)">\s*<value>([\s\S]*?)<\/value>/g)) {
      data[decodeXml(key)] = decodeXml(value);
    }
    const address = data['Porch Address'];
    if (!address) continue; // restrooms, water stations, HQ
    const performances = manualPerformances.get(address) || parsePerformances(data['Performance'] || '');
    if (!performances.length) { skipped.push(`${address} (no performances listed)`); continue; }

    let lat = data['Latitude'], lng = data['Longitude'];
    if ((!lat || !lng) && shouldGeocode) ({ lat, lng } = (await geocodeAddress(address)) || {});
    if (!lat || !lng) { skipped.push(`${address} (no coordinates)`); continue; }

    porchCounter += 1;
    const porchId = `porch_${String(porchCounter).padStart(4, '0')}`;
    porches[porchId] = { address: `${address}, Arlington, MA`, lat, lng, porchnum: '', _id: porchId };

    for (const { actname, hours } of performances) {
      let bandId = bandIdByName.get(actname);
      if (!bandId) {
        bandCounter += 1;
        bandId = `band_${String(bandCounter).padStart(4, '0')}`;
        bandIdByName.set(actname, bandId);
        bands[bandId] = {
          actname, genre: data['Genre'] || '', other_genre: '', website: '', facebook: '',
          instagram: '', bandcamp: '', spotify: '', apple: '', otheronline: '',
          description: '', image: '', _id: bandId,
        };
      }
      for (const slot of hoursToSlots(hours)) {
        gigCounter += 1;
        const gigId = `gig_${String(gigCounter).padStart(5, '0')}`;
        gigs[gigId] = {
          bandid: bandId, porchid: porchId, starthour: String(slot.start), startminute: '00',
          duration: String(slot.length * 60), _id: gigId,
        };
      }
    }
  }

  const output = `const bands = ${JSON.stringify(bands, null, 4)};\n\nconst porches = ${JSON.stringify(porches, null, 4)};\n\nconst gigs = ${JSON.stringify(gigs, null, 4)};\n`;
  await fs.writeFile(outputPath, output, 'utf8');
  console.log(`Bands: ${Object.keys(bands).length}`);
  console.log(`Porches: ${Object.keys(porches).length}`);
  console.log(`Gigs: ${Object.keys(gigs).length}`);
  console.log(`Skipped: ${skipped.length ? skipped.join('; ') : 'none'}`);
}

runConversion();
