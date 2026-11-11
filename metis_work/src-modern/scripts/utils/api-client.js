/**
 * ApnaSchool Unified API Client
 *
 * Connects Web Portal and Android Mobile Apps to the exact same backend and database.
 * Supports httpOnly session cookies on Web and Bearer token / cookies on Android.
 */

export const AUTH_TOKEN_KEY = 'APNASCHOOL_AUTH_TOKEN';
export const SERVER_URL_KEY = 'APNASCHOOL_SERVER_URL';

export function isNativeApp() {
  return Boolean(
    window.Capacitor?.isNativePlatform?.() ||
      (window.Capacitor?.getPlatform?.() && window.Capacitor.getPlatform() !== 'web'),
  );
}

export function getAuthToken() {
  if (!isNativeApp()) {
    clearAuthToken();
    return '';
  }
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setAuthToken(token) {
  if (!isNativeApp()) {
    clearAuthToken();
    return;
  }
  try {
    if (token) {
      localStorage.setItem(AUTH_TOKEN_KEY, token);
    } else {
      localStorage.removeItem(AUTH_TOKEN_KEY);
    }
  } catch {
    // ignore local storage restrictions
  }
}

export function clearAuthToken() {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
  } catch {
    // ignore
  }
}

export function getApiBaseUrl() {
  // Highest priority: explicit runtime override (web or native).
  const runtime =
    (typeof window !== 'undefined' && window.APNASCHOOL_SERVER_URL) ||
    (() => {
      try {
        return localStorage.getItem(SERVER_URL_KEY);
      } catch {
        return null;
      }
    })();
  if (runtime) return String(runtime).replace(/\/$/, '');

  // HTML meta (set per deploy without rebuilding JS).
  try {
    const meta = document.querySelector('meta[name="apnaschool-api-base"]');
    const content = meta?.getAttribute('content')?.trim();
    if (content) return content.replace(/\/$/, '');
  } catch {
    // document may be unavailable in non-browser contexts
  }

  if (!isNativeApp()) {
    // Vite build-time inject for web: VITE_API_URL=https://api.example.com
    const envUrl = import.meta.env?.VITE_API_URL;
    if (envUrl) return String(envUrl).replace(/\/$/, '');
    // Same-origin relative paths when frontend is reverse-proxied to the API.
    return '';
  }

  // Native emulator default only — never use on a physical device in production.
  return 'http://10.0.2.2:3001';
}

export function apiUrl(path) {
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  const base = getApiBaseUrl();
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (!base) return cleanPath;
  return `${base}${cleanPath}`;
}

export class ApiError extends Error {
  constructor(message, status = 0, code = '') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export async function api(path, options = {}) {
  const url = apiUrl(path);
  const token = getAuthToken();

  const headers = {
    Accept: 'application/json',
    ...(options.headers || {}),
  };
  if (isNativeApp()) {
    headers['X-ApnaSchool-Client'] = 'native';
  }

  if (options.body && typeof options.body === 'string' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  } else if (
    options.body &&
    typeof options.body === 'object' &&
    !(options.body instanceof FormData) &&
    !(options.body instanceof Blob) &&
    !headers['Content-Type']
  ) {
    headers['Content-Type'] = 'application/json';
  }

  if (token && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response;
  try {
    response = await fetch(url, {
      credentials: 'include',
      ...options,
      headers,
    });
  } catch (err) {
    const base = getApiBaseUrl();
    throw new ApiError(
      `Network error: Could not reach ApnaSchool API server at ${base || 'server'}. Ensure the backend server is running and reachable.`,
      0,
      'NETWORK_ERROR',
    );
  }

  let payload = {};
  const isJson = response.headers.get('content-type')?.includes('application/json');
  if (isJson) {
    payload = await response.json().catch(() => ({}));
  }

  if (!response.ok) {
    if (response.status === 401) {
      clearAuthToken();
    }
    const message =
      payload?.error?.message ||
      payload?.message ||
      (response.status === 401
        ? 'Please sign in to continue.'
        : response.status === 403
          ? 'You do not have permission to perform this action.'
          : `Request failed (${response.status})`);
    const code = payload?.error?.code || payload?.code || '';
    throw new ApiError(message, response.status, code);
  }

  return payload;
}
