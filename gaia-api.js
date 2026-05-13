/**
 * gaia-api.js
 * Browser-side Gaia DR3 TAP bridge for GitHub Pages demos.
 *
 * Important: this module does not generate fake stars. It fetches real Gaia rows.
 *
 * Why this file exists:
 * GitHub Pages is static, so it cannot run a backend proxy. Browser requests to
 * ESA Gaia TAP usually fail because of CORS. This bridge therefore tries direct
 * ESA requests first, then several public CORS bridges. For targets above 10k,
 * it splits the request into independent RA sky slices so every page remains
 * small enough for public bridges.
 *
 * For production 50k–1M runs, use the Node proxy version. Public CORS bridges
 * are rate-limited and may fail without warning.
 */

export const GAIA_TAP_SYNC_ENDPOINT = 'https://gea.esac.esa.int/tap-server/tap/sync';
export const GAIA_BUFFER_STRIDE = Object.freeze({ POSITION: 3, HR: 2, PHOTOMETRY: 5 });

export function formatTelemetryNumber(value) {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--:--';
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function degreesToRadians(degrees) {
  return degrees * Math.PI / 180;
}

export function distanceParsecFromParallaxMas(parallaxMas) {
  return 1000 / parallaxMas;
}

export function absoluteMagnitudeG(apparentG, parallaxMas) {
  return apparentG + 5 + 5 * Math.log10(parallaxMas / 1000);
}

export function raDecParallaxToCartesian(raDeg, decDeg, parallaxMas, scale = 1) {
  const distancePc = distanceParsecFromParallaxMas(parallaxMas);
  const ra = degreesToRadians(raDeg);
  const dec = degreesToRadians(decDeg);
  const cosDec = Math.cos(dec);

  return {
    x: distancePc * cosDec * Math.cos(ra) * scale,
    y: distancePc * cosDec * Math.sin(ra) * scale,
    z: distancePc * Math.sin(dec) * scale,
    distancePc
  };
}

export class GaiaDataError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'GaiaDataError';
    this.cause = cause;
  }
}

function normaliseLimit(limit) {
  return Math.max(1, Math.min(10000, Number(limit) || 10000));
}

function makeWhereClause(extraCondition = '') {
  const extra = extraCondition ? `\nAND ${extraCondition}` : '';
  return `WHERE parallax > 2
AND parallax_over_error > 20
AND bp_rp IS NOT NULL
AND phot_g_mean_mag IS NOT NULL${extra}`;
}

export function buildGaiaQuery(limit = 10000, mode = 'single page', extraCondition = '') {
  const safeLimit = normaliseLimit(limit);
  return `SELECT TOP ${safeLimit} ra, dec, parallax, bp_rp, phot_g_mean_mag
FROM gaiadr3.gaia_source
${makeWhereClause(extraCondition)}`;
}

function buildTapParams(query, format = 'csv') {
  const params = new URLSearchParams();
  params.set('REQUEST', 'doQuery');
  params.set('LANG', 'ADQL');
  params.set('FORMAT', format);
  params.set('QUERY', query);
  return params;
}

function buildTapGetUrl(query, format = 'csv') {
  return `${GAIA_TAP_SYNC_ENDPOINT}?${buildTapParams(query, format).toString()}`;
}

function buildBridgeUrls(query, format = 'csv') {
  const directGet = buildTapGetUrl(query, format);
  return [
    { label: 'ESA TAP DIRECT GET', url: directGet },
    { label: 'ALLORIGINS CORS BRIDGE', url: `https://api.allorigins.win/raw?url=${encodeURIComponent(directGet)}` },
    { label: 'CORSPROXY.IO BRIDGE', url: `https://corsproxy.io/?${encodeURIComponent(directGet)}` },
    { label: 'ISOMORPHIC-GIT CORS BRIDGE', url: `https://cors.isomorphic-git.org/${directGet}` },
    { label: 'CODETABS CORS BRIDGE', url: `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(directGet)}` }
  ];
}

function makeSkySliceSegments(targetRows, pageSize) {
  const pages = Math.max(1, Math.ceil(targetRows / pageSize));

  // 10k mode: use the same simple query that already worked for the user.
  if (pages === 1) {
    return [{ label: 'single Gaia sample', condition: '' }];
  }

  // For 50k/100k/1M, split by RA. These slices are disjoint, so no duplicated sky
  // wedge is deliberately requested. The payload stays near 10k rows per request.
  const segments = [];
  const width = 360 / pages;
  for (let i = 0; i < pages; i++) {
    const raMin = i * width;
    const raMax = (i + 1) * width;
    const condition = i === pages - 1
      ? `ra >= ${raMin.toFixed(8)} AND ra <= 360`
      : `ra >= ${raMin.toFixed(8)} AND ra < ${raMax.toFixed(8)}`;
    segments.push({
      label: `RA ${raMin.toFixed(1)}–${raMax.toFixed(1)}°`,
      condition
    });
  }
  return segments;
}

export class GaiaDataBridge {
  constructor(options = {}) {
    this.targetRows = Math.max(1, Math.min(1000000, Number(options.targetRows ?? 10000)));
    this.pageSize = Math.max(1000, Math.min(10000, Number(options.pageSize ?? 10000)));
    this.format = options.format ?? 'csv';
    this.positionScale = options.positionScale ?? 1;
    this.signal = options.signal ?? null;
    this.onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    this.syncTimeoutMs = options.syncTimeoutMs ?? 120000;
    this.workingRouteLabel = null;
  }

  async fetchStars() {
    const targetRows = this.targetRows;
    const pageSize = Math.min(this.pageSize, targetRows);

    const positions = new Float32Array(targetRows * GAIA_BUFFER_STRIDE.POSITION);
    const hr = new Float32Array(targetRows * GAIA_BUFFER_STRIDE.HR);
    const photometry = new Float32Array(targetRows * GAIA_BUFFER_STRIDE.PHOTOMETRY);
    const telemetry = this.#newTelemetry();

    this.#emitProgress({
      phase: 'INITIALIZING GAIA BRIDGE',
      progress: 1,
      parsedRows: 0,
      acceptedRows: 0,
      rejectedRows: 0
    });

    const segments = makeSkySliceSegments(targetRows, pageSize);
    let acceptedTotal = 0;
    let consecutiveFailures = 0;
    const errors = [];

    for (let segmentIndex = 0; segmentIndex < segments.length && acceptedTotal < targetRows; segmentIndex++) {
      this.#throwIfAborted();

      const segment = segments[segmentIndex];
      const rowsNeeded = Math.min(pageSize, targetRows - acceptedTotal);
      const query = buildGaiaQuery(rowsNeeded, segment.label, segment.condition);
      const pageNumber = segmentIndex + 1;
      const totalPages = segments.length;

      this.#emitProgress({
        phase: `PAGE ${pageNumber}/${totalPages}: REQUESTING ${segment.label}`,
        progress: Math.min(96, (acceptedTotal / targetRows) * 100),
        parsedRows: telemetry.parsedRows,
        acceptedRows: acceptedTotal,
        loadedRows: acceptedTotal,
        rejectedRows: telemetry.rejectedRows
      });

      try {
        const csv = await this.#fetchPageWithFallbackRoutes(query, pageNumber);
        const rows = await this.#parsePage(csv, telemetry);

        if (rows.length === 0) {
          throw new GaiaDataError(`Page ${pageNumber} returned zero valid stars.`);
        }

        for (const row of rows) {
          if (acceptedTotal >= targetRows) break;

          const p3 = acceptedTotal * 3;
          positions[p3] = row.x;
          positions[p3 + 1] = row.y;
          positions[p3 + 2] = row.z;

          const h2 = acceptedTotal * 2;
          hr[h2] = row.bpRp;
          hr[h2 + 1] = row.absoluteG;

          const p5 = acceptedTotal * 5;
          photometry[p5] = row.ra;
          photometry[p5 + 1] = row.dec;
          photometry[p5 + 2] = row.parallax;
          photometry[p5 + 3] = row.gMag;
          photometry[p5 + 4] = row.distancePc;

          acceptedTotal += 1;
        }

        telemetry.acceptedRows = acceptedTotal;
        consecutiveFailures = 0;

        this.#emitProgress({
          phase: `PACKED PAGE ${pageNumber}/${totalPages} / ${acceptedTotal.toLocaleString()} STARS READY`,
          progress: Math.min(99, (acceptedTotal / targetRows) * 100),
          parsedRows: telemetry.parsedRows,
          acceptedRows: acceptedTotal,
          loadedRows: acceptedTotal,
          rejectedRows: telemetry.rejectedRows
        });

      } catch (error) {
        consecutiveFailures += 1;
        errors.push(`page ${pageNumber}: ${error?.message || error}`);

        this.#emitProgress({
          phase: `PAGE ${pageNumber}/${totalPages} FAILED / CONTINUING TO NEXT SKY SLICE`,
          progress: Math.min(96, ((segmentIndex + 1) / totalPages) * 100),
          parsedRows: telemetry.parsedRows,
          acceptedRows: acceptedTotal,
          loadedRows: acceptedTotal,
          rejectedRows: telemetry.rejectedRows
        });

        // If the first page fails, do not burn through all pages pointlessly.
        // That means the public CORS route is down in the user's current browser.
        if (acceptedTotal === 0 && consecutiveFailures >= 2) {
          throw new GaiaDataError(`All usable browser routes failed at startup. ${errors.join(' | ')}`);
        }
      }

      await this.#yieldToMainThread(350);
    }

    if (acceptedTotal === 0) {
      throw new GaiaDataError(`No Gaia rows could be loaded. Public CORS bridges are likely blocked or down. ${errors.join(' | ')}`);
    }

    if (acceptedTotal < targetRows) {
      this.#emitProgress({
        phase: `PARTIAL DATASET READY / ${acceptedTotal.toLocaleString()} OF ${targetRows.toLocaleString()} STARS`,
        progress: 100,
        parsedRows: telemetry.parsedRows,
        acceptedRows: acceptedTotal,
        loadedRows: acceptedTotal,
        rejectedRows: telemetry.rejectedRows
      });
    }

    this.#emitProgress({
      phase: 'GAIA GPU BUFFERS READY',
      progress: 100,
      parsedRows: telemetry.parsedRows,
      acceptedRows: acceptedTotal,
      loadedRows: acceptedTotal,
      rejectedRows: telemetry.rejectedRows
    });

    return {
      count: acceptedTotal,
      positions: positions.subarray(0, acceptedTotal * 3),
      hr: hr.subarray(0, acceptedTotal * 2),
      photometry: photometry.subarray(0, acceptedTotal * 5),
      stride: GAIA_BUFFER_STRIDE,
      telemetry,
      source: 'ESA Gaia DR3',
      generatedAt: new Date().toISOString()
    };
  }

  async #fetchPageWithFallbackRoutes(query, pageNumber) {
    const errors = [];
    const routes = [];

    if (!this.workingRouteLabel) routes.push({ label: 'ESA TAP DIRECT POST', type: 'post' });

    const bridgeRoutes = buildBridgeUrls(query, this.format);
    if (this.workingRouteLabel) {
      const preferred = bridgeRoutes.find(route => route.label === this.workingRouteLabel);
      if (preferred) routes.push(preferred);
      for (const route of bridgeRoutes) if (route.label !== this.workingRouteLabel) routes.push(route);
    } else {
      routes.push(...bridgeRoutes);
    }

    for (const route of routes) {
      try {
        this.#throwIfAborted();
        this.#emitProgress({ phase: `PAGE ${pageNumber}: TRYING ${route.label}`, progress: 3 });

        let text;
        if (route.type === 'post') text = await this.#fetchViaDirectPost(query, pageNumber);
        else text = await this.#fetchViaGet(route.url, route.label, pageNumber);

        this.workingRouteLabel = route.label;
        return text;
      } catch (error) {
        errors.push(`${route.label}: ${error?.message || error}`);
        this.#emitProgress({ phase: `PAGE ${pageNumber}: ${route.label} FAILED`, progress: 5 });
        await this.#yieldToMainThread(250);
      }
    }

    throw new GaiaDataError(`All browser routes failed on page ${pageNumber}. ${errors.join(' | ')}`);
  }

  async #fetchViaDirectPost(query, pageNumber) {
    const controller = this.#createLinkedAbortController(this.syncTimeoutMs);
    const response = await fetch(GAIA_TAP_SYNC_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Accept': 'text/csv,text/plain,*/*'
      },
      body: buildTapParams(query, this.format),
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store'
    });

    if (!response.ok) throw new GaiaDataError(`Gaia TAP returned HTTP ${response.status}`);

    return await this.#readResponseTextWithProgress(response, {
      phase: `PAGE ${pageNumber}: DOWNLOADING DIRECT POST`,
      startProgress: 8,
      endProgress: 58
    });
  }

  async #fetchViaGet(url, label, pageNumber) {
    const controller = this.#createLinkedAbortController(this.syncTimeoutMs);
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'text/csv,text/plain,*/*' },
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store'
    });

    if (!response.ok) throw new GaiaDataError(`${label} returned HTTP ${response.status}`);

    return await this.#readResponseTextWithProgress(response, {
      phase: `PAGE ${pageNumber}: DOWNLOADING VIA ${label}`,
      startProgress: 8,
      endProgress: 58
    });
  }

  async #readResponseTextWithProgress(response, options) {
    const total = Number(response.headers.get('content-length')) || 0;

    if (!response.body || !response.body.getReader) {
      const text = await response.text();
      this.#validateResponseText(text);
      this.#emitProgress({ phase: options.phase, progress: options.endProgress });
      return text;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    let received = 0;
    let syntheticProgress = options.startProgress;

    while (true) {
      this.#throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(decoder.decode(value, { stream: true }));
      received += value.byteLength;

      let progress;
      if (total > 0) {
        progress = options.startProgress + (received / total) * (options.endProgress - options.startProgress);
      } else {
        syntheticProgress = Math.min(options.endProgress - 2, syntheticProgress + 0.8);
        progress = syntheticProgress;
      }

      this.#emitProgress({
        phase: `${options.phase} / ${(received / 1024 / 1024).toFixed(1)} MB`,
        progress
      });

      await this.#yieldToMainThread(0);
    }

    chunks.push(decoder.decode());
    const text = chunks.join('');
    this.#validateResponseText(text);
    this.#emitProgress({ phase: options.phase, progress: options.endProgress });
    return text;
  }

  #validateResponseText(text) {
    if (!text || text.trim().length < 20) throw new GaiaDataError('Gaia TAP returned an empty response.');

    const trimmed = text.trim();
    const sample = trimmed.slice(0, 1800).toLowerCase();

    if (sample.includes('<html') || sample.includes('<!doctype html')) {
      throw new GaiaDataError('Gaia TAP returned HTML instead of CSV.');
    }
    if (sample.includes('error') && sample.includes('exception')) {
      throw new GaiaDataError('Gaia TAP returned a service exception.');
    }
    if (trimmed.startsWith('{') && sample.includes('error')) {
      throw new GaiaDataError('A CORS bridge returned an error JSON response.');
    }
    if (trimmed.startsWith('<')) {
      throw new GaiaDataError('Gaia TAP returned XML/VOTable, but this app expects CSV.');
    }

    const firstLine = trimmed.split(/\r?\n/, 1)[0].toLowerCase();
    if (!firstLine.includes('ra') || !firstLine.includes('dec') || !firstLine.includes('parallax')) {
      throw new GaiaDataError('Response did not look like the expected Gaia CSV table.');
    }
  }

  async #parsePage(csvText, telemetry) {
    const lines = csvText.split(/\r?\n/);
    if (lines.length < 2) throw new GaiaDataError('Gaia CSV contained no data rows.');

    const header = this.#parseCsvLine(lines[0]).map(v => v.trim().toLowerCase());
    const indices = this.#resolveColumnIndices(header);
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
      this.#throwIfAborted();

      const line = lines[i];
      if (!line || !line.trim()) continue;

      telemetry.parsedRows += 1;

      const cols = this.#parseCsvLine(line);
      const ra = Number(cols[indices.ra]);
      const dec = Number(cols[indices.dec]);
      const parallax = Number(cols[indices.parallax]);
      const bpRp = Number(cols[indices.bp_rp]);
      const gMag = Number(cols[indices.phot_g_mean_mag]);

      if (!Number.isFinite(ra) || !Number.isFinite(dec) || !Number.isFinite(parallax) || !Number.isFinite(bpRp) || !Number.isFinite(gMag) || parallax <= 0) {
        telemetry.rejectedRows += 1;
        continue;
      }

      const cart = raDecParallaxToCartesian(ra, dec, parallax, this.positionScale);
      const absoluteG = absoluteMagnitudeG(gMag, parallax);

      if (!Number.isFinite(cart.x) || !Number.isFinite(cart.y) || !Number.isFinite(cart.z) || !Number.isFinite(cart.distancePc) || !Number.isFinite(absoluteG)) {
        telemetry.rejectedRows += 1;
        continue;
      }

      telemetry.minDistancePc = Math.min(telemetry.minDistancePc, cart.distancePc);
      telemetry.maxDistancePc = Math.max(telemetry.maxDistancePc, cart.distancePc);
      telemetry.minMG = Math.min(telemetry.minMG, absoluteG);
      telemetry.maxMG = Math.max(telemetry.maxMG, absoluteG);
      telemetry.minBpRp = Math.min(telemetry.minBpRp, bpRp);
      telemetry.maxBpRp = Math.max(telemetry.maxBpRp, bpRp);

      rows.push({
        ra,
        dec,
        parallax,
        bpRp,
        gMag,
        absoluteG,
        distancePc: cart.distancePc,
        x: cart.x,
        y: cart.y,
        z: cart.z
      });

      if (i % 3000 === 0) {
        this.#emitProgress({
          phase: `PARSING PAGE / ${rows.length.toLocaleString()} VALID STARS`,
          progress: 62,
          parsedRows: telemetry.parsedRows,
          acceptedRows: telemetry.acceptedRows + rows.length,
          loadedRows: telemetry.acceptedRows + rows.length,
          rejectedRows: telemetry.rejectedRows
        });
        await this.#yieldToMainThread(0);
      }
    }

    return rows;
  }

  #newTelemetry() {
    return {
      parsedRows: 0,
      acceptedRows: 0,
      rejectedRows: 0,
      minDistancePc: Infinity,
      maxDistancePc: -Infinity,
      minMG: Infinity,
      maxMG: -Infinity,
      minBpRp: Infinity,
      maxBpRp: -Infinity
    };
  }

  #resolveColumnIndices(header) {
    const required = ['ra', 'dec', 'parallax', 'bp_rp', 'phot_g_mean_mag'];
    const indices = {};
    for (const col of required) {
      const idx = header.indexOf(col);
      if (idx === -1) throw new GaiaDataError(`Gaia CSV is missing required column "${col}".`);
      indices[col] = idx;
    }
    return indices;
  }

  #parseCsvLine(line) {
    const out = [];
    let current = '';
    let quoted = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = !quoted;
        }
      } else if (ch === ',' && !quoted) {
        out.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    out.push(current);
    return out;
  }

  #emitProgress(payload) {
    this.onProgress({
      parsedRows: payload.parsedRows,
      acceptedRows: payload.acceptedRows,
      loadedRows: payload.loadedRows,
      rejectedRows: payload.rejectedRows,
      phase: payload.phase ?? 'PROCESSING',
      progress: Math.max(0, Math.min(100, Number(payload.progress ?? 0)))
    });
  }

  #createLinkedAbortController(timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();

    if (this.signal) {
      if (this.signal.aborted) controller.abort();
      else this.signal.addEventListener('abort', abort, { once: true });
    }

    controller.signal.addEventListener('abort', () => {
      clearTimeout(timeout);
      if (this.signal) this.signal.removeEventListener('abort', abort);
    }, { once: true });

    return controller;
  }

  #throwIfAborted() {
    if (this.signal?.aborted) throw new DOMException('Gaia data request was aborted.', 'AbortError');
  }

  #yieldToMainThread(ms = 0) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Compatibility aliases for older app.js/index versions.
export async function fetchGaiaDR3Stars(options = {}) {
  const bridge = new GaiaDataBridge(options);
  return await bridge.fetchStars();
}

export function estimateGpuMemoryBytes(dataset) {
  if (!dataset) return 0;
  return (dataset.positions?.byteLength || 0) + (dataset.hr?.byteLength || 0) + (dataset.photometry?.byteLength || 0);
}
