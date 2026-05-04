import {Plugin} from 'obsidian';

export class Logger {
  plugin: Plugin;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
  }

  private logPath() {
    return `.obsidian/plugins/${this.plugin.manifest.id}/sync.log`;
  }

  async append(line: string) {
    try {
      const path = this.logPath();
      const adapter = (this.plugin as any).app.vault.adapter;
      // ensure folder exists
      const dir = `.obsidian/plugins/${this.plugin.manifest.id}`;
      try { if (adapter.mkdir) await adapter.mkdir(dir); } catch (e) { }

      const exists = await adapter.exists(path).catch(() => false);
      const entry = `[${new Date().toISOString()}] ${line}\n`;
      if (!exists) {
        await adapter.write(path, entry);
      } else {
        try {
          const prev = await adapter.read(path);
          await adapter.write(path, prev + entry);
        } catch (e) {
          // fallback: overwrite with only entry
          await adapter.write(path, entry);
        }
      }
    } catch (e) {
      // best-effort logging
      console.error('Logger append failed', e);
    }
  }

  async read(): Promise<string> {
    try {
      const path = this.logPath();
      const adapter = (this.plugin as any).app.vault.adapter;
      const exists = await adapter.exists(path).catch(() => false);
      if (!exists) return '';
      return await adapter.read(path);
    } catch (e) {
      return '';
    }
  }
}

export default Logger;
