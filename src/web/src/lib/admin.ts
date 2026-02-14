'use client';

const ADMIN_KEY_STORAGE = 'gomomo_admin_key';

/** Base API URL for admin calls. */
export const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

/** Read the admin key from localStorage (client-only). */
export function getAdminKey(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(ADMIN_KEY_STORAGE) ?? '';
}

/** Store the admin key in localStorage. */
export function setAdminKey(key: string): void {
  localStorage.setItem(ADMIN_KEY_STORAGE, key);
}

/** Clear the admin key. */
export function clearAdminKey(): void {
  localStorage.removeItem(ADMIN_KEY_STORAGE);
}

/** Build fetch headers with admin auth. */
export function adminHeaders(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'X-Admin-Key': getAdminKey(),
  };
}

/** Fetch wrapper that adds admin headers and handles common errors. */
export async function adminFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...adminHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  return res;
}
