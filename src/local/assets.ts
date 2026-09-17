import { localDB } from './db/local.ts';

/**
 * Asset resolution.
 *
 * Maps and sprites reference textures by a URL-ish string. Three flavors work:
 *   - `assets/foo.png`  → resolved against the app base (works from any subpath)
 *   - `http(s)://…`, `data:…`, `blob:…` → used verbatim
 *   - `image:<id>`      → a tileset the user uploaded, kept in IndexedDB as a data URL
 */

const objectUrls = new Map<string, string>();

export function resolveAssetUrl(url: string): string {
  if (!url) return '';
  if (/^(https?:|data:|blob:|\.\/|\/)\S*/.test(url) && !url.startsWith('image:')) {
    if (url.startsWith('/ai-town/')) {
      // Legacy path used by the hosted Convex demo; the local build serves at "/".
      return resolveAssetUrl(url.replace('/ai-town/', ''));
    }
    return url;
  }
  if (url.startsWith('image:')) {
    const doc = localDB.get<{ dataUrl: string }>('images', url.slice('image:'.length));
    return doc?.dataUrl ?? '';
  }
  const relative = url.replace(/^\.\//, '').replace(/^\/+/, '');
  if (typeof document !== 'undefined' && document.baseURI) {
    try {
      return new URL(relative, document.baseURI).href;
    } catch {
      return relative;
    }
  }
  return relative;
}

export function appAssetUrl(file: string): string {
  return `assets/${file}`;
}

export async function readImageFile(file: File): Promise<{ dataUrl: string; mime: string }> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const mime = file.type || guessMime(file.name);
  return { dataUrl: `data:${mime};base64,${btoa(binary)}`, mime };
}

function guessMime(name: string): string {
  if (/\.jpe?g$/i.test(name)) return 'image/jpeg';
  if (/\.webp$/i.test(name)) return 'image/webp';
  if (/\.gif$/i.test(name)) return 'image/gif';
  return 'image/png';
}

/** Stores an uploaded tileset and returns its `image:<id>` reference. */
export async function saveUploadedImage(file: File, name?: string): Promise<string> {
  const id = `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const { dataUrl, mime } = await readImageFile(file);
  const dimensions = await imageSize(dataUrl);
  localDB.put('images', {
    _id: id,
    name: name ?? file.name,
    mime,
    dataUrl,
    width: dimensions.width,
    height: dimensions.height,
  });
  return `image:${id}`;
}

export type ImageDoc = {
  _id: string;
  name: string;
  mime: string;
  dataUrl: string;
  width: number;
  height: number;
  _creationTime: number;
};

export function listUploadedImages(): ImageDoc[] {
  return localDB.all<ImageDoc>('images');
}

export function imageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve({ width: 0, height: 0 });
    image.src = resolveAssetUrl(url);
  });
}

export function revokeAllObjectUrls() {
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear();
}
