import axios from "axios";

const STAGING_API  = "https://backend-staging.onrender.com";
const PROD_API     = "https://backend-ai-sub.onrender.com";

const API_BASE =
  // Canonical name; NEXT_PUBLIC_API_BASE kept as a deprecated fallback so
  // already-deployed environments keep working (see docs/ENVIRONMENT.md).
  process.env.NEXT_PUBLIC_API_URL ||
  process.env.NEXT_PUBLIC_API_BASE ||
  (process.env.NEXT_PUBLIC_APP_ENV === "staging" ? STAGING_API : PROD_API);

const api = axios.create({
  baseURL: API_BASE,
  withCredentials: true, // This ensures cookies are sent with requests
  headers: {
    "Content-Type": "application/json",
  },
});

/** Read the csrf-token cookie set by the backend and attach it as a header. */
function getCsrfToken(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie.match(/(?:^|;\s*)csrf-token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

const MUTATING_METHODS = new Set(["post", "put", "patch", "delete"]);

// Attach x-csrf-token header on all mutating requests
api.interceptors.request.use((config) => {
  if (config.method && MUTATING_METHODS.has(config.method.toLowerCase())) {
    const token = getCsrfToken();
    if (token) {
      config.headers = config.headers ?? {};
      config.headers["x-csrf-token"] = token;
    }
  }
  return config;
});

// Add response interceptor to log auth errors
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      console.debug("401 Unauthorized - user not authenticated");
    }
    return Promise.reject(error);
  }
);

// Simple wrappers to normalize responses and errors
export async function apiGet(path: string, config = {}) {
  const res = await api.get(path, config as any);
  return res.data;
}

export async function apiPost(path: string, data?: any, config = {}) {
  const res = await api.post(path, data, config as any);
  return res.data;
}

export async function apiPut(path: string, data?: any, config = {}) {
  const res = await api.put(path, data, config as any);
  return res.data;
}

export async function apiPatch(path: string, data?: any, config = {}) {
  const res = await api.patch(path, data, config as any);
  return res.data;
}

export async function apiDelete(path: string, config = {}) {
  const res = await api.delete(path, config as any);
  return res.data;
}

export default api;
