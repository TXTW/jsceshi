import {Plugin} from 'obsidian';
import type {WebDAVSettings} from './settings';

export interface RemoteFileInfo {
  path: string;
  href: string;
  lastModified: number; // ms
  size: number;
  etag?: string;
  isDir: boolean;
}

export class WebDAVClient {
  plugin: Plugin;
  settings: WebDAVSettings;
  baseUrl: string;
  headers: Record<string, string>;

  constructor(plugin: Plugin, settings: WebDAVSettings) {
    this.plugin = plugin;
    this.settings = settings;
    this.baseUrl = (settings.webdavUrl || '').replace(/\/+$/, '');
    this.headers = {};
    if (settings.username || settings.password) {
      const token = btoa(`${settings.username}:${settings.password}`);
      this.headers['Authorization'] = `Basic ${token}`;
    }
  }

  private encodePath(p: string) {
    // encode each segment, keep '/'
    return p.split('/').map(encodeURIComponent).join('/');
  }

  private makeUrl(remotePath: string) {
    const parts = [] as string[];
    if (this.baseUrl) parts.push(this.baseUrl);
    if (this.settings.webdavPath) parts.push(this.settings.webdavPath.replace(/^\/+|\/+$/g, ''));
    if (remotePath) parts.push(remotePath.replace(/^\/+/, ''));
    const url = parts.join('/');
    return url;
  }

  async propfind(remoteDir = ''): Promise<Record<string, RemoteFileInfo>> {
    const url = this.makeUrl(remoteDir);
    const body = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/><d:getcontentlength/><d:getetag/></d:prop></d:propfind>`;
    const headers: Record<string, string> = Object.assign({'Depth': '1', 'Content-Type': 'application/xml; charset="utf-8"'}, this.headers);
    const res = await fetch(url, {method: 'PROPFIND', headers, body});
    if (!res.ok) {
      throw new Error(`PROPFIND failed: ${res.status} ${res.statusText}`);
    }
    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'application/xml');
    const responses = Array.from(doc.getElementsByTagName('response'));
    const result: Record<string, RemoteFileInfo> = {};
    const basePath = new URL(url).pathname.replace(/\/+$/, '');
    for (const r of responses) {
      const hrefEl = r.getElementsByTagName('href')[0];
      if (!hrefEl) continue;
      let href = hrefEl.textContent || '';
      try { href = decodeURIComponent(href); } catch (e) {}
      // normalize
      const hrefPath = new URL(href, this.baseUrl).pathname;
      let rel = hrefPath.replace(basePath, '');
      rel = rel.replace(/^\/+/, '');
      if (!rel) continue; // skip the collection itself

      const prop = r.getElementsByTagName('prop')[0];
      let lastModified = 0;
      let size = 0;
      let etag = undefined;
      if (prop) {
        const lm = prop.getElementsByTagName('getlastmodified')[0];
        if (lm && lm.textContent) lastModified = Date.parse(lm.textContent);
        const gl = prop.getElementsByTagName('getcontentlength')[0];
        if (gl && gl.textContent) size = Number(gl.textContent) || 0;
        const ge = prop.getElementsByTagName('getetag')[0];
        if (ge && ge.textContent) etag = ge.textContent;
      }

      const isDir = href.endsWith('/');
      result[rel] = {path: rel, href, lastModified: lastModified || 0, size, etag, isDir};
    }
    return result;
  }

  async getFile(remotePath: string): Promise<{content: string; headers: Headers}> {
    const url = this.makeUrl(remotePath);
    const res = await fetch(url, {method: 'GET', headers: this.headers});
    if (!res.ok) throw new Error(`GET ${remotePath} failed ${res.status}`);
    const text = await res.text();
    return {content: text, headers: res.headers};
  }

  async putFile(remotePath: string, content: string): Promise<void> {
    const url = this.makeUrl(remotePath);
    const res = await fetch(url, {method: 'PUT', headers: Object.assign({'Content-Type': 'text/plain; charset=utf-8'}, this.headers), body: content});
    if (res.status === 409) {
      // try to create parent collections
      const parent = remotePath.split('/').slice(0, -1).join('/');
      if (parent) await this.ensureRemoteDirs(parent);
      const retry = await fetch(url, {method: 'PUT', headers: Object.assign({'Content-Type': 'text/plain; charset=utf-8'}, this.headers), body: content});
      if (!retry.ok) throw new Error(`PUT retry failed ${retry.status}`);
      return;
    }
    if (!res.ok) throw new Error(`PUT ${remotePath} failed ${res.status}`);
  }

  async deleteFile(remotePath: string): Promise<void> {
    const url = this.makeUrl(remotePath);
    const res = await fetch(url, {method: 'DELETE', headers: this.headers});
    if (!res.ok) throw new Error(`DELETE ${remotePath} failed ${res.status}`);
  }

  async ensureRemoteDirs(remoteDir: string) {
    const parts = remoteDir.replace(/^\/+|\/+$/g, '').split('/');
    let path = '';
    for (const p of parts) {
      path = path ? `${path}/${p}` : p;
      const url = this.makeUrl(path) + '/';
      try {
        // try MKCOL on this path
        // some servers return 405 if exists
        const res = await fetch(url, {method: 'MKCOL', headers: this.headers});
        if (res.status === 201 || res.status === 405 || res.status === 405) {
          // created or already exists
        }
      } catch (e) {
        // ignore
      }
    }
  }
}

export default WebDAVClient;
