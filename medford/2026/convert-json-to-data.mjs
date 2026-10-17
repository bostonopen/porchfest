// Converts the Medford Porchfest 2026 schedule snapshot (data.json) into data.js.
// Source map: https://medfordporchfest.com/map.html
// Data: https://medfordporchfest.com/data/schedule.json (the file the official map loads),
// minus acts listed in https://medfordporchfest.com/data/cancellations.json or marked cancelled.
// Every porch already has lat/lng, so no geocoding is needed.
import fs from 'fs/promises';

const inputPath = new URL('./data.json', import.meta.url);
const outputPath = new URL('./data.js', import.meta.url);
// From cancellations.json at download time.
const cancelledBandIds = new Set(['-Omuun1ktJ4Ovr-fMe-e']);

function parseTime(text) {
  const match = String(text || '').match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  if (match[3].toUpperCase() === 'PM' && hour !== 12) hour += 12;
  if (match[3].toUpperCase() === 'AM' && hour === 12) hour = 0;
  return { hour, minute: match[2] };
}

const isTrue = value => value === true || value === 'true';

async function runConversion() {
  const snapshot = JSON.parse(await fs.readFile(inputPath, 'utf8'));
  const bands = {}, porches = {}, gigs = {};
  const bandIdBySourceId = new Map();
  let porchCounter = 0, bandCounter = 0, gigCounter = 0;
  const skipped = [];

  const sorted = [...snapshot.porches].sort((a, b) => (a.porchNumber || 999) - (b.porchNumber || 999));
  for (const porch of sorted) {
    const acts = (porch.bands || []).filter(b => !cancelledBandIds.has(b.id) && !isTrue(b.isCancelled));
    const address = String(porch.address || '').replace(/[\s,]+(West\s+)?Medford\b.*$/i, '').replace(/\s+/g, ' ').trim();
    if (!acts.length) { skipped.push(`${address} (no performances)`); continue; }
    if (!porch.lat || !porch.lng) { skipped.push(`${address} (no coordinates)`); continue; }

    porchCounter += 1;
    const porchId = `porch_${String(porchCounter).padStart(4, '0')}`;
    porches[porchId] = {
      address: `${address}${porch.apt ? ` ${porch.apt}` : ''}, Medford, MA`,
      lat: String(porch.lat), lng: String(porch.lng),
      porchnum: porch.porchNumber ? String(porch.porchNumber) : '', _id: porchId,
    };

    for (const act of acts) {
      const time = parseTime(act.assignedTime);
      if (!time) { skipped.push(`${act.name} at ${address} (no time)`); continue; }
      let bandId = bandIdBySourceId.get(act.id);
      if (!bandId) {
        bandCounter += 1;
        bandId = `band_${String(bandCounter).padStart(4, '0')}`;
        bandIdBySourceId.set(act.id, bandId);
        const links = act.links || {};
        bands[bandId] = {
          actname: String(act.name || '').trim(), genre: act.genre || '', other_genre: '',
          website: links.website || '', facebook: links.facebook || '', instagram: links.instagram || '',
          bandcamp: links.bandcamp || '', spotify: links.spotify || '', apple: '',
          otheronline: links.youtube || links.soundcloud || '',
          description: String(act.bio || '').trim(), image: act.image || '', _id: bandId,
        };
      }
      gigCounter += 1;
      const gigId = `gig_${String(gigCounter).padStart(5, '0')}`;
      gigs[gigId] = {
        bandid: bandId, porchid: porchId, starthour: String(time.hour), startminute: time.minute,
        duration: String(Number(act.setLength) || 60), _id: gigId,
      };
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
