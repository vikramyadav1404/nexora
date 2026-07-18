import { baseURL } from '../services/api';

// local uploads are paths like /uploads/... — prefix them when API lives on another host
export function mediaUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url) || url.startsWith('data:') || url.startsWith('blob:')) {
    return url;
  }
  if (url.startsWith('/') && baseURL) {
    return baseURL.replace(/\/$/, '') + url;
  }
  return url;
}

export default mediaUrl;
