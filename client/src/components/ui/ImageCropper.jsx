import { useState, useRef, useEffect, useCallback } from 'react';
import { X, ZoomIn, RotateCcw } from 'lucide-react';

/**
 * Drag-and-zoom cropper.
 *
 * Deliberately not a dependency. react-easy-crop is ~15KB for pan, zoom and a
 * crop rectangle, all of which is a transform and some arithmetic — and this
 * project has no other UI library to be consistent with.
 *
 * The image is drawn to fill a fixed-aspect frame; the user pans and zooms it
 * behind that frame, and what shows through is the crop. Output is reported in
 * natural image pixels so the caller can render it at full resolution.
 */
export default function ImageCropper({
  file,
  aspect = 1,
  title = 'Crop image',
  onCancel,
  onConfirm,
  confirmLabel = 'Save'
}) {
  const [img, setImg] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const frameRef = useRef(null);
  const dragStart = useRef({ x: 0, y: 0, ox: 0, oy: 0 });

  useEffect(() => {
    if (!file) return undefined;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => setImg(image);
    image.src = url;
    return () => {
      // Deferred by a tick on purpose. Revoking synchronously invalidates the
      // URL while the <img> using it is still in the tree for the final unmount
      // frame, which Chrome reports as ERR_FILE_NOT_FOUND in the console.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    };
  }, [file]);

  // Reset framing whenever a different image arrives.
  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, [img]);

  const startDrag = (clientX, clientY) => {
    setDragging(true);
    dragStart.current = { x: clientX, y: clientY, ox: offset.x, oy: offset.y };
  };

  const moveDrag = useCallback((clientX, clientY) => {
    setOffset({
      x: dragStart.current.ox + (clientX - dragStart.current.x),
      y: dragStart.current.oy + (clientY - dragStart.current.y)
    });
  }, []);

  // Listening on window rather than the element means the drag survives the
  // pointer leaving the frame, which is exactly when people drag hardest.
  useEffect(() => {
    if (!dragging) return undefined;
    const onMove = (e) => {
      const point = e.touches?.[0] || e;
      moveDrag(point.clientX, point.clientY);
    };
    const onUp = () => setDragging(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };
  }, [dragging, moveDrag]);

  /**
   * Convert what is visible in the frame back into source-image pixels.
   *
   * The image is laid out with `cover` semantics — scaled so the smaller edge
   * fills the frame — then zoomed and panned. Inverting that gives the crop.
   */
  const computeCrop = () => {
    const frame = frameRef.current;
    if (!frame || !img) return null;

    const fw = frame.clientWidth;
    const fh = frame.clientHeight;
    const base = Math.max(fw / img.naturalWidth, fh / img.naturalHeight);
    const scale = base * zoom;

    const drawnW = img.naturalWidth * scale;
    const drawnH = img.naturalHeight * scale;

    // Top-left of the drawn image relative to the frame.
    const left = (fw - drawnW) / 2 + offset.x;
    const top = (fh - drawnH) / 2 + offset.y;

    const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

    const x = clamp(-left / scale, 0, img.naturalWidth);
    const y = clamp(-top / scale, 0, img.naturalHeight);
    const width = clamp(fw / scale, 1, img.naturalWidth - x);
    const height = clamp(fh / scale, 1, img.naturalHeight - y);

    return { x, y, width, height };
  };

  const reset = () => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  };

  return (
    <div className="cropper-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="cropper-panel">
        <div className="cropper-head">
          <strong>{title}</strong>
          <button type="button" className="cropper-close" onClick={onCancel} aria-label="Cancel">
            <X size={18} />
          </button>
        </div>

        <div
          ref={frameRef}
          className={`cropper-frame ${aspect === 1 ? 'is-square' : 'is-wide'}`}
          onPointerDown={(e) => {
            e.preventDefault();
            startDrag(e.clientX, e.clientY);
          }}
          style={{ cursor: dragging ? 'grabbing' : 'grab' }}
        >
          {img && (
            <img
              src={img.src}
              alt=""
              draggable={false}
              className="cropper-image"
              style={{
                transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${zoom})`
              }}
            />
          )}
          <div className={`cropper-mask ${aspect === 1 ? 'is-square' : 'is-wide'}`} aria-hidden="true" />
        </div>

        <div className="cropper-controls">
          <ZoomIn size={16} aria-hidden="true" />
          <input
            type="range"
            min="1"
            max="4"
            step="0.01"
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            aria-label="Zoom"
          />
          <button type="button" className="btn btn-sm btn-secondary" onClick={reset}>
            <RotateCcw size={14} /> Reset
          </button>
        </div>

        <p className="cropper-hint">Drag to reposition · scroll the slider to zoom</p>

        <div className="cropper-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!img}
            onClick={() => onConfirm(computeCrop())}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
