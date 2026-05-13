/**
 * gaia-api.js
 * Robust Gaia DR3 TAP bridge for the Galactic Explorer starter.
 *
 * This module does not generate fake stars.
 * It tries:
 *   1. ESA TAP direct POST
 *   2. ESA TAP direct GET
 *   3. AllOrigins raw CORS bridge
 *   4. corsproxy.io bridge
 *
 * If all routes fail, the caller receives a normal JavaScript Error.
 */

export const GAIA_TAP_SYNC_ENDPOINT = "https://gea.esac.esa.int/tap-server/tap/sync";

export function buildGaiaQuery(limit = 50000) {
  const safeLimit = Math.max(1, Math.min(1000000, Number(limit) || 50000));

  return `SELECT TOP ${safeLimit} ra, dec, parallax, bp_rp, phot_g_mean_mag
FROM gaiadr3.gaia_source
WHERE parallax > 2
AND parallax_over_error > 20
AND bp_rp IS NOT NULL`;
}

export const GAIA_BUFFER_STRIDE = Object.freeze({
  POSITION: 3,
  HR: 2,
  PHOTOMETRY: 5
});

export function formatTelemetryNumber(value) {
  const n = Number(value) || 0;

  if (Math.abs(n) >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}K`;

  return String(Math.round(n));
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "--:--";

  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
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
    this.name = "GaiaDataError";
    this.cause = cause;
  }
}

function buildTapParams(query, format = "csv") {
  const params = new URLSearchParams();
  params.set("REQUEST", "doQuery");
  params.set("LANG", "ADQL");
  params.set("FORMAT", format);
  params.set("QUERY", query);
  return params;
}

function buildTapGetUrl(query, format = "csv") {
  return `${GAIA_TAP_SYNC_ENDPOINT}?${buildTapParams(query, format).toString()}`;
}

function buildBridgeUrls(query, format = "csv") {
  const directGet = buildTapGetUrl(query, format);

  return [
    {
      label: "ESA TAP DIRECT GET",
      url: directGet
    },
    {
      label: "ALLORIGINS CORS BRIDGE",
      url: `https://api.allorigins.win/raw?url=${encodeURIComponent(directGet)}`
    },
    {
      label: "CORSPROXY.IO BRIDGE",
      url: `https://corsproxy.io/?${encodeURIComponent(directGet)}`
    }
  ];
}

export class GaiaDataBridge {
  constructor(options = {}) {
    this.targetRows = options.targetRows ?? 50000;
    this.query = options.query ?? buildGaiaQuery(this.targetRows);
    this.format = options.format ?? "csv";
    this.positionScale = options.positionScale ?? 1;
    this.signal = options.signal ?? null;
    this.onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
    this.tapMode = options.tapMode ?? "auto";
    this.preferAsync = options.preferAsync ?? false;
    this.syncTimeoutMs = options.syncTimeoutMs ?? 120000;
  }

  async fetchMillionStars() {
    const started = performance.now();

    this.#emitProgress({
      phase: "INITIALIZING GAIA BRIDGE",
      progress: 1,
      parsedRows: 0,
      acceptedRows: 0,
      rejectedRows: 0
    });

    const responseText = await this.#fetchWithFallbackRoutes();

    this.#emitProgress({
      phase: "PARSING GAIA CSV",
      progress: 62
    });

    const dataset = await this.#parseAndPackCsv(responseText);

    dataset.telemetry.elapsedMs = performance.now() - started;
    dataset.query = this.query;
    dataset.source = "ESA Gaia DR3";
    dataset.generatedAt = new Date().toISOString();

    this.#emitProgress({
      phase: "GAIA GPU BUFFERS READY",
      progress: 100,
      parsedRows: dataset.telemetry.parsedRows,
      acceptedRows: dataset.count,
      loadedRows: dataset.count,
      rejectedRows: dataset.telemetry.rejectedRows
    });

    return dataset;
  }

  async #fetchWithFallbackRoutes() {
    const errors = [];

    // Route 1: direct POST to ESA TAP.
    try {
      this.#emitProgress({
        phase: "TRYING ESA TAP DIRECT POST",
        progress: 4
      });

      return await this.#fetchViaDirectPost();

    } catch (error) {
      errors.push(`ESA TAP DIRECT POST: ${error?.message || error}`);
      this.#emitProgress({
        phase: `DIRECT POST FAILED / TRYING GET ROUTES`,
        progress: 7
      });
      await this.#yieldToMainThread();
    }

    // Routes 2-4: direct GET and proxy GET routes.
    const routes = buildBridgeUrls(this.query, this.format);

    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];

      try {
        this.#throwIfAborted();

        this.#emitProgress({
          phase: `TRYING ${route.label}`,
          progress: 8 + i * 4
        });

        const response = await fetch(route.url, {
          method: "GET",
          headers: {
            "Accept": "text/csv,text/plain,*/*"
          },
          signal: this.signal,
          credentials: "omit",
          cache: "no-store"
        });

        if (!response.ok) {
          throw new GaiaDataError(`${route.label} returned HTTP ${response.status}`);
        }

        const text = await this.#readResponseTextWithProgress(response, {
          phase: `DOWNLOADING VIA ${route.label}`,
          startProgress: 14 + i * 5,
          endProgress: 58
        });

        return text;

      } catch (error) {
        errors.push(`${route.label}: ${error?.message || error}`);
        this.#emitProgress({
          phase: `${route.label} FAILED`,
          progress: 10 + i * 4
        });
        await this.#yieldToMainThread();
      }
    }

    throw new GaiaDataError(
      `All Gaia TAP browser routes failed. ${errors.join(" | ")}`
    );
  }

  async #fetchViaDirectPost() {
    this.#throwIfAborted();

    const controller = this.#createLinkedAbortController(this.syncTimeoutMs);
    const params = buildTapParams(this.query, this.format);

    const response = await fetch(GAIA_TAP_SYNC_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "Accept": "text/csv,text/plain,*/*"
      },
      body: params,
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store"
    });

    if (!response.ok) {
      throw new GaiaDataError(`Gaia TAP returned HTTP ${response.status}`);
    }

    return await this.#readResponseTextWithProgress(response, {
      phase: "DOWNLOADING GAIA CSV / DIRECT POST",
      startProgress: 10,
      endProgress: 58
    });
  }

  async #readResponseTextWithProgress(response, options) {
    const total = Number(response.headers.get("content-length")) || 0;

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

      await this.#yieldToMainThread();
    }

    chunks.push(decoder.decode());

    const text = chunks.join("");
    this.#validateResponseText(text);

    this.#emitProgress({
      phase: options.phase,
      progress: options.endProgress
    });

    return text;
  }

  #validateResponseText(text) {
    if (!text || text.trim().length < 20) {
      throw new GaiaDataError("Gaia TAP returned an empty response.");
    }

    const trimmed = text.trim();
    const sample = trimmed.slice(0, 1400).toLowerCase();

    if (sample.includes("<html") || sample.includes("<!doctype html")) {
      throw new GaiaDataError("Gaia TAP returned an HTML page instead of catalogue CSV data. This is usually browser CORS, proxy, or service-response related.");
    }

    if (sample.includes("error") && sample.includes("exception")) {
      throw new GaiaDataError("Gaia TAP returned a service exception.");
    }

    if (trimmed.startsWith("{") && sample.includes("error")) {
      throw new GaiaDataError("A CORS bridge returned an error JSON response.");
    }

    if (trimmed.startsWith("<")) {
      throw new GaiaDataError("Gaia TAP returned XML/VOTable, but this starter bridge expects CSV.");
    }

    const firstLine = trimmed.split(/\r?\n/, 1)[0].toLowerCase();
    if (!firstLine.includes("ra") || !firstLine.includes("dec") || !firstLine.includes("parallax")) {
      throw new GaiaDataError("Response did not look like the expected Gaia CSV table.");
    }
  }

  async #parseAndPackCsv(csvText) {
    const targetRows = this.targetRows;

    const positions = new Float32Array(targetRows * GAIA_BUFFER_STRIDE.POSITION);
    const hr = new Float32Array(targetRows * GAIA_BUFFER_STRIDE.HR);
    const photometry = new Float32Array(targetRows * GAIA_BUFFER_STRIDE.PHOTOMETRY);

    const telemetry = {
      parsedRows: 0,
      acceptedRows: 0,
      rejectedRows: 0,
      minDistancePc: Number.POSITIVE_INFINITY,
      maxDistancePc: Number.NEGATIVE_INFINITY,
      minMG: Number.POSITIVE_INFINITY,
      maxMG: Number.NEGATIVE_INFINITY,
      minBpRp: Number.POSITIVE_INFINITY,
      maxBpRp: Number.NEGATIVE_INFINITY
    };

    const lines = csvText.split(/\r?\n/);

    if (lines.length < 2) {
      throw new GaiaDataError("Gaia CSV contained no data rows.");
    }

    const header = this.#parseCsvLine(lines[0]).map(value => value.trim().toLowerCase());
    const indices = this.#resolveColumnIndices(header);

    const totalLines = Math.max(1, lines.length - 1);
    let accepted = 0;

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

      if (
        !Number.isFinite(ra) ||
        !Number.isFinite(dec) ||
        !Number.isFinite(parallax) ||
        !Number.isFinite(bpRp) ||
        !Number.isFinite(gMag) ||
        parallax <= 0
      ) {
        telemetry.rejectedRows += 1;
        continue;
      }

      const cart = raDecParallaxToCartesian(ra, dec, parallax, this.positionScale);
      const absoluteG = absoluteMagnitudeG(gMag, parallax);

      if (
        !Number.isFinite(cart.x) ||
        !Number.isFinite(cart.y) ||
        !Number.isFinite(cart.z) ||
        !Number.isFinite(cart.distancePc) ||
        !Number.isFinite(absoluteG)
      ) {
        telemetry.rejectedRows += 1;
        continue;
      }

      const p3 = accepted * 3;
      positions[p3] = cart.x;
      positions[p3 + 1] = cart.y;
      positions[p3 + 2] = cart.z;

      const h2 = accepted * 2;
      hr[h2] = bpRp;
      hr[h2 + 1] = absoluteG;

      const p5 = accepted * 5;
      photometry[p5] = ra;
      photometry[p5 + 1] = dec;
      photometry[p5 + 2] = parallax;
      photometry[p5 + 3] = gMag;
      photometry[p5 + 4] = cart.distancePc;

      telemetry.minDistancePc = Math.min(telemetry.minDistancePc, cart.distancePc);
      telemetry.maxDistancePc = Math.max(telemetry.maxDistancePc, cart.distancePc);
      telemetry.minMG = Math.min(telemetry.minMG, absoluteG);
      telemetry.maxMG = Math.max(telemetry.maxMG, absoluteG);
      telemetry.minBpRp = Math.min(telemetry.minBpRp, bpRp);
      telemetry.maxBpRp = Math.max(telemetry.maxBpRp, bpRp);

      accepted += 1;
      telemetry.acceptedRows = accepted;

      if (accepted >= targetRows) break;

      if (i % 3000 === 0) {
        this.#emitProgress({
          phase: `PACKING FLOAT32 BUFFERS / ${accepted.toLocaleString()} STARS`,
          progress: 62 + Math.min(34, (i / totalLines) * 34),
          parsedRows: telemetry.parsedRows,
          acceptedRows: accepted,
          loadedRows: accepted,
          rejectedRows: telemetry.rejectedRows
        });

        await this.#yieldToMainThread();
      }
    }

    if (accepted === 0) {
      throw new GaiaDataError("No valid Gaia rows survived physical validation.");
    }

    return {
      count: accepted,
      positions: positions.subarray(0, accepted * 3),
      hr: hr.subarray(0, accepted * 2),
      photometry: photometry.subarray(0, accepted * 5),
      stride: GAIA_BUFFER_STRIDE,
      telemetry
    };
  }

  #resolveColumnIndices(header) {
    const required = ["ra", "dec", "parallax", "bp_rp", "phot_g_mean_mag"];
    const indices = {};

    for (const column of required) {
      const index = header.indexOf(column);

      if (index === -1) {
        throw new GaiaDataError(`Gaia CSV is missing required column "${column}".`);
      }

      indices[column] = index;
    }

    return indices;
  }

  #parseCsvLine(line) {
    const out = [];
    let current = "";
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
      } else if (ch === "," && !quoted) {
        out.push(current);
        current = "";
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
      phase: payload.phase ?? "PROCESSING",
      progress: Math.max(0, Math.min(100, Number(payload.progress ?? 0)))
    });
  }

  #createLinkedAbortController(timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const abort = () => controller.abort();

    if (this.signal) {
      if (this.signal.aborted) {
        controller.abort();
      } else {
        this.signal.addEventListener("abort", abort, { once: true });
      }
    }

    controller.signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      if (this.signal) this.signal.removeEventListener("abort", abort);
    }, { once: true });

    return controller;
  }

  #throwIfAborted() {
    if (this.signal?.aborted) {
      throw new DOMException("Gaia data request was aborted.", "AbortError");
    }
  }

  #yieldToMainThread() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }
}

export async function fetchGaiaDR3Stars(options = {}) {
  const bridge = new GaiaDataBridge(options);
  return await bridge.fetchMillionStars();
}

export function estimateGpuMemoryBytes(dataset) {
  if (!dataset) return 0;
  return (
    (dataset.positions?.byteLength || 0) +
    (dataset.hr?.byteLength || 0) +
    (dataset.photometry?.byteLength || 0)
  );
}
