// repo/k8sJobApp/web/app/api.ts

let apiToken: string | null = null;

export function setApiToken(token: string | null) {
  apiToken = token;
}

export async function apiFetch(endpoint: string, options: RequestInit = {}): Promise<unknown> {
  let apiBase = '';
  if (typeof window !== 'undefined' && window.location.protocol === 'file:') {
    apiBase = 'http://localhost:3010';
  }
  
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (apiToken) {
    headers.set('Authorization', `Bearer ${apiToken}`);
  }

  const res = await fetch(`${apiBase}${endpoint}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (res.status === 401) {
    setApiToken(null);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('unauthorized'));
    }
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    let errorMessage = `HTTP Error ${res.status}`;
    try {
      if (errorText) {
        const errorData = JSON.parse(errorText);
        if (errorData.error) {
          errorMessage = errorData.error;
        }
      }
    } catch {}
    throw new Error(errorMessage);
  }

  const contentType = res.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return res.json();
  }
  return res.text();
}
