import api from './api';

/**
 * Profile media upload.
 *
 * Three steps, and the middle one deliberately does not go through our API:
 *
 *   1. POST /api/uploads/presign  → a short-lived URL for one specific object
 *   2. PUT straight to storage    → the bytes never touch Express
 *   3. PATCH /api/users/me/:kind  → we send only the key; the server verifies it
 *
 * Step 2 is what makes large covers possible at all. Vercel caps a serverless
 * request body at ~4.5MB, so routing an 8MB image through the API would fail
 * before any of our code ran.
 */

/** Longest edge we ever render, so anything bigger is wasted bytes. */
const TARGET = {
  avatar: { width: 512, height: 512 },
  cover: { width: 1500, height: 500 }
};

const OUTPUT_TYPE = 'image/webp';
const OUTPUT_QUALITY = 0.85;

export class UploadError extends Error {
  constructor(message, { stage } = {}) {
    super(message);
    this.stage = stage;
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new UploadError('That file could not be read as an image', { stage: 'read' }));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new UploadError('Could not encode the image', { stage: 'encode' }))),
      OUTPUT_TYPE,
      OUTPUT_QUALITY
    );
  });
}

/**
 * Crop and downscale in the browser before anything is uploaded.
 *
 * Doing this client-side is not only about bandwidth. It means the object that
 * lands in the bucket is already the size we serve, so the server's derivative
 * work is one small thumbnail rather than resizing a 12MP phone photo — which
 * matters because there is no job queue to defer that work to.
 *
 * `crop` is in natural image pixels: { x, y, width, height }.
 */
export async function renderCrop(file, kind, crop) {
  const img = await loadImage(file);
  const target = TARGET[kind];

  const source = crop || {
    x: 0,
    y: 0,
    width: img.naturalWidth,
    height: img.naturalHeight
  };

  // Never upscale — a 200px source stays 200px rather than turning blurry.
  const scale = Math.min(1, target.width / source.width, target.height / source.height);
  const outW = Math.max(1, Math.round(source.width * scale));
  const outH = Math.max(1, Math.round(source.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, source.x, source.y, source.width, source.height, 0, 0, outW, outH);

  const blob = await canvasToBlob(canvas);
  return { blob, width: outW, height: outH, previewUrl: canvas.toDataURL(OUTPUT_TYPE, OUTPUT_QUALITY) };
}

/**
 * PUT the blob to the signed URL.
 *
 * Content-Type must be exactly what was signed and nothing else may be added —
 * storage recomputes the signature over the headers, and an extra one is a 403
 * that reads like a permissions problem but is really a header mismatch.
 */
function putToStorage(signedUrl, blob, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', signedUrl, true);
    xhr.setRequestHeader('Content-Type', contentType);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new UploadError(`Upload rejected by storage (${xhr.status})`, { stage: 'put' }));
    };
    xhr.onerror = () => reject(new UploadError('Network error during upload', { stage: 'put' }));
    xhr.ontimeout = () => reject(new UploadError('Upload timed out', { stage: 'put' }));
    xhr.send(blob);
  });
}

/**
 * Full flow. Returns the updated user object from the attach response.
 *
 * `onStage` reports 'uploading' | 'processing' so the caller can show which
 * half of the wait it is in — the PUT has a progress bar, the attach does not.
 */
export async function uploadProfileMedia({ file, kind, crop, onProgress, onStage }) {
  if (!TARGET[kind]) throw new UploadError(`Unknown media kind: ${kind}`);

  onStage?.('cropping');
  const { blob, previewUrl } = await renderCrop(file, kind, crop);

  onStage?.('uploading');
  const { data: ticket } = await api.post('/api/uploads/presign', {
    kind,
    mimeType: OUTPUT_TYPE,
    size: blob.size
  });

  // Demo mode has no bucket; the server takes the bytes as a data URL instead.
  if (ticket.demo) {
    onProgress?.(100);
    onStage?.('processing');
    const { data } = await api.patch(`/api/users/me/${kind}`, {
      key: ticket.key,
      dataUrl: previewUrl
    });
    return data.user;
  }

  await putToStorage(ticket.signedUrl, blob, ticket.contentType, onProgress);

  onStage?.('processing');
  const { data } = await api.patch(`/api/users/me/${kind}`, { key: ticket.key });
  return data.user;
}

export async function removeProfileMedia(kind) {
  const { data } = await api.delete(`/api/users/me/${kind}`);
  return data.user;
}

export { TARGET as UPLOAD_TARGETS };
