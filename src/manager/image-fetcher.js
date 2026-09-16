/**
 * Photo downloads.
 *
 * Unlike the API calls, these run from the manager page rather than the Vinted tab.
 * Photos are public CDN bytes with no session involved, host_permissions lets the
 * extension page read them cross-origin, and fetching here keeps multi-megabyte
 * blobs out of chrome.runtime messages — which would otherwise have to be base64'd
 * through the service worker.
 *
 * The CDN gets its own limiter: it is static asset hosting, not the API, and a
 * browser loading a listing page pulls its photos in parallel anyway. It is still
 * bounded, just less tightly than the 4 req/s we hold the API to.
 */
(() => {
  const VB = (globalThis.VB ||= {});
  const SCOPE = 'images';

  const cdnLimiter = new VB.RateLimiter({
    capacity: 6,
    refillPerSecond: 6,
    minIntervalMs: 80,
    jitterMs: 40,
  });

  /**
   * Download one image.
   *
   * @param {{index: number, originalUrl: string, localPath: string}} image
   * @returns {Promise<{ok: true, value: {name: string, blob: Blob}} | {ok: false, code: string, message: string}>}
   */
  async function fetchOne(image) {
    await cdnLimiter.acquire();
    let res;
    try {
      // No credentials: these are public assets and sending cookies to the CDN
      // would be pointless.
      res = await fetch(image.originalUrl, { credentials: 'omit', cache: 'no-store' });
    } catch (err) {
      return VB.fail(VB.ERR.HTTP, 'Image ' + image.index + ' network error: ' + String(err));
    }
    if (!res.ok) {
      return VB.fail(VB.ERR.HTTP, 'Image ' + image.index + ' returned HTTP ' + res.status, {
        status: res.status,
      });
    }

    const type = res.headers.get('content-type') || '';
    const blob = await res.blob();

    // A CDN that answers a dead URL with an HTML error page would otherwise be
    // written to disk as "1.jpg" and the backup would look complete.
    if (!type.startsWith('image/') && blob.type && !blob.type.startsWith('image/')) {
      return VB.fail(
        VB.ERR.NOT_JSON,
        'Image ' + image.index + ' was not an image (' + (type || 'unknown type') + ')'
      );
    }
    if (blob.size === 0) {
      return VB.fail(VB.ERR.HTTP, 'Image ' + image.index + ' came back empty');
    }

    const name = image.localPath.slice(image.localPath.lastIndexOf('/') + 1);
    return VB.done({ name, blob, bytes: blob.size });
  }

  /**
   * Download every image for a listing, retrying each a bounded number of times.
   *
   * All-or-nothing on purpose: the design goal is that a listing is not backed up
   * unless all of its photos are. A single unrecoverable image fails the listing
   * rather than leaving a folder that silently has four photos out of five.
   *
   * @param {Array<object>} images from the snapshot
   * @param {(done: number, total: number) => void} [onProgress]
   */
  async function fetchAll(images, onProgress) {
    const out = [];
    let totalBytes = 0;

    for (const image of images) {
      let last = null;
      for (let attempt = 0; attempt <= VB.constants.LIMITS.imageRetries; attempt += 1) {
        if (attempt > 0) {
          const backoff = 600 * attempt;
          await new Promise((r) => setTimeout(r, backoff));
          VB.log.warn(
            SCOPE,
            'Retrying image ' + image.index + ' (attempt ' + (attempt + 1) + ')',
            last && last.message
          );
        }
        last = await fetchOne(image);
        if (last.ok) break;
      }
      if (!last.ok) return last;
      out.push({ name: last.value.name, blob: last.value.blob });
      totalBytes += last.value.bytes;
      if (onProgress) onProgress(out.length, images.length);
    }

    return VB.done({ files: out, totalBytes });
  }

  VB.imageFetcher = { fetchOne, fetchAll };
})();
