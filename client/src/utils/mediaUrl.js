import { baseURL } from '../services/api';

/**
 * Resolve avatar/media URLs for local /uploads paths when API is on another origin.
 * Supabase / absolute URLs pass through unchanged.
 * @param {string} [url]
 * @returns {string}
 */
export function mediaUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url) || url.startsWith('data:') || url.startsWith('blob:')) {
    return url;
  }
  if (url.startsWith('/') && baseURL) {
    return `${baseURL.replace(/\/$/, '')}${url}`;
  }
  return url;
}

export default mediaUrl;
