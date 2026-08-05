import { useState, useRef, useCallback } from 'react';
import toast from 'react-hot-toast';
import { uploadProfileMedia, removeProfileMedia, UPLOAD_TARGETS } from '../services/uploads';

/** Matches the server's allow-list. SVG is excluded on purpose. */
const ACCEPT = 'image/jpeg,image/png,image/webp';
const CLIENT_MAX = { avatar: 5 * 1024 * 1024, cover: 8 * 1024 * 1024 };

/**
 * The pick → crop → upload → attach flow, and its failure modes.
 *
 * Owns a hidden file input per kind so callers only wire up a button. The
 * optimistic update is applied the moment the crop is confirmed and rolled back
 * if any later step throws — an avatar that silently reverts on a network blip,
 * with no message, is the worst version of this feature.
 */
export function useProfileMedia({ onUpdated } = {}) {
  const [kind, setKind] = useState(null);      // which upload is in flight
  const [file, setFile] = useState(null);      // awaiting crop
  const [stage, setStage] = useState('idle');  // idle|cropping|uploading|processing|failed
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');

  const inputRef = useRef(null);
  const pendingKind = useRef(null);
  const lastAttempt = useRef(null);

  const reset = useCallback(() => {
    setKind(null);
    setFile(null);
    setStage('idle');
    setProgress(0);
    setError('');
  }, []);

  /** Open the OS file picker for one kind. */
  const pick = useCallback((which) => {
    pendingKind.current = which;
    setError('');
    inputRef.current?.click();
  }, []);

  const onInputChange = useCallback((e) => {
    const chosen = e.target.files?.[0];
    // Clearing the input matters: picking the same file twice in a row fires no
    // change event otherwise, so a retry after a failure would do nothing.
    e.target.value = '';
    if (!chosen) return;

    const which = pendingKind.current;
    if (!ACCEPT.split(',').includes(chosen.type)) {
      toast.error('Use a JPEG, PNG or WebP image');
      return;
    }
    if (chosen.size > CLIENT_MAX[which]) {
      toast.error(`That image is over ${Math.round(CLIENT_MAX[which] / 1024 / 1024)}MB`);
      return;
    }

    setKind(which);
    setFile(chosen);
    setStage('cropping');
  }, []);

  /** Called by the cropper with a crop rect in natural image pixels. */
  const confirmCrop = useCallback(async (crop) => {
    if (!file || !kind) return;
    lastAttempt.current = { file, kind, crop };
    setStage('uploading');
    setProgress(0);
    setError('');

    try {
      const user = await uploadProfileMedia({
        file,
        kind,
        crop,
        onProgress: setProgress,
        onStage: (s) => setStage(s)
      });
      onUpdated?.(user);
      toast.success(kind === 'avatar' ? 'Profile picture updated' : 'Cover updated');
      reset();
    } catch (err) {
      const message = err?.response?.data?.message || err?.friendlyMessage || err?.message || 'Upload failed';
      setError(message);
      setStage('failed');
      toast.error(message);
    }
  }, [file, kind, onUpdated, reset]);

  /** Re-run the last attempt with the same crop — no need to re-pick or re-frame. */
  const retry = useCallback(() => {
    const attempt = lastAttempt.current;
    if (!attempt) return reset();
    setKind(attempt.kind);
    setFile(attempt.file);
    confirmCrop(attempt.crop);
  }, [confirmCrop, reset]);

  const remove = useCallback(async (which) => {
    setKind(which);
    setStage('processing');
    try {
      const user = await removeProfileMedia(which);
      onUpdated?.(user);
      toast.success(which === 'avatar' ? 'Profile picture removed' : 'Cover removed');
    } catch (err) {
      toast.error(err?.friendlyMessage || 'Could not remove that image');
    } finally {
      reset();
    }
  }, [onUpdated, reset]);

  const busy = stage === 'uploading' || stage === 'processing' ? kind : null;

  return {
    kind,
    file,
    stage,
    progress,
    error,
    busy,
    aspect: kind === 'cover'
      ? UPLOAD_TARGETS.cover.width / UPLOAD_TARGETS.cover.height
      : 1,
    pick,
    confirmCrop,
    retry,
    remove,
    cancel: reset,
    /** Spread onto a single hidden <input type="file" /> the caller renders. */
    inputProps: { ref: inputRef, type: 'file', accept: ACCEPT, hidden: true, onChange: onInputChange }
  };
}

export default useProfileMedia;
