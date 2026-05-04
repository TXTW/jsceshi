import {App, Notice, Plugin, TFile} from 'obsidian';
import {DEFAULT_SETTINGS, WebDAVSettings, WebDAVSettingTab} from './settings';
import WebDAVClient from './webdav';
import {Logger} from './logger';
import {ConflictModal, ConflictItem} from './conflict-modal';

const TIME_SKEW_MS = 2000; // tolerance for mtime comparisons

export default class WebDAVSyncPlugin extends Plugin {
	settings: WebDAVSettings;
	client: WebDAVClient | null = null;
	logger: Logger | null = null;
	idleTimer: number | null = null;
	autoTimer: number | null = null;
	syncInProgress = false;
	conflicts: ConflictItem[] = [];

	async onload() {
		await this.loadSettings();
		this.logger = new Logger(this);
		this.client = new WebDAVClient(this, this.settings);

		this.addSettingTab(new WebDAVSettingTab(this.app, this));

		this.addCommand({
			id: 'webdav-sync-now',
			name: 'WebDAV: 立即同步',
			callback: () => {
				// @ts-ignore
				this.syncNow();
			}
		});

		this.addCommand({
			id: 'webdav-toggle-realtime',
			name: 'WebDAV: 切换实时同步',
			callback: async () => {
				this.settings.enableRealtime = !this.settings.enableRealtime;
				await this.saveSettings();
				new Notice(`实时同步: ${this.settings.enableRealtime ? '开启' : '关闭'}`);
			}
		});

		this.addCommand({
			id: 'webdav-show-conflicts',
			name: 'WebDAV: 显示冲突',
			callback: () => {
				if (this.conflicts.length === 0) new Notice('当前无冲突');
				else new ConflictModal(this.app, this.conflicts, async (path, action) => await this.resolveConflict(path, action)).open();
			}
		});

		// Vault events
		this.registerEvent(this.app.vault.on('create', (f) => this.onVaultChange(f)));
		this.registerEvent(this.app.vault.on('modify', (f) => this.onVaultChange(f)));
		this.registerEvent(this.app.vault.on('delete', (f) => this.onVaultChange(f)));
		this.registerEvent(this.app.vault.on('rename', (f) => this.onVaultChange(f)));

		this.setupAutoSyncInterval();

		// initial log
		await this.logger.append('Plugin loaded');
	}

	onunload() {
		if (this.idleTimer) window.clearTimeout(this.idleTimer);
		if (this.autoTimer) window.clearInterval(this.autoTimer);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<WebDAVSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	setupAutoSyncInterval() {
		if (this.autoTimer) {
			window.clearInterval(this.autoTimer);
			this.autoTimer = null;
		}
		if (this.settings.autoSyncIntervalSec > 0) {
			this.autoTimer = window.setInterval(() => {
				// @ts-ignore
				this.syncNow();
			}, Math.max(5, this.settings.autoSyncIntervalSec) * 1000);
		}
	}

	onVaultChange(file: any) {
		if (!this.settings.enableRealtime) return;
		// only care about files (TFile)
		if (!file || !file.path) return;
		// schedule idle sync
		if (this.idleTimer) window.clearTimeout(this.idleTimer);
		this.idleTimer = window.setTimeout(() => {
			// @ts-ignore
			this.syncNow();
		}, Math.max(1, this.settings.idleDelaySec) * 1000);
	}

	private isCandidate(path: string) {
		if (!path) return false;
		if (path.startsWith('.obsidian')) return false;
		if (path.endsWith('.md')) return true;
		if (this.settings.includeAttachments) return true;
		return false;
	}

	async syncNow() {
		if (this.syncInProgress) return;
		this.syncInProgress = true;
		await this.logger.append('开始同步');
		try {
			if (!this.client) this.client = new WebDAVClient(this, this.settings);
			const remoteIndex = await this.client.propfind(this.settings.webdavPath || '');

			const localFiles = this.app.vault.getFiles().filter(f => this.isCandidate(f.path));
			const localMap: Record<string, TFile> = {};
			for (const f of localFiles) localMap[f.path] = f;

			const remoteMap = remoteIndex; // keys are relative paths

			const allPaths = new Set<string>([...Object.keys(localMap), ...Object.keys(remoteMap)]);

			const newConflicts: ConflictItem[] = [];

			for (const p of allPaths) {
				const local = localMap[p];
				const remote = remoteMap[p];
				const lastSync = this.settings.lastSyncMap?.[p] || 0;
				const localMtime = local && (local.stat ? (local.stat.mtime || 0) : 0) || 0;
				const remoteMtime = remote ? (remote.lastModified || 0) : 0;
				const changedLocal = local && localMtime > lastSync + TIME_SKEW_MS;
				const changedRemote = remote && remoteMtime > lastSync + TIME_SKEW_MS;

				if (changedLocal && changedRemote) {
					// both changed -> conflict
					await this.logger.append(`冲突: ${p}`);
					const localContent = local ? await this.app.vault.read(local) : null;
					const remoteContent = remote ? (await this.client.getFile(p)).content : null;
					newConflicts.push({path: p, localContent, remoteContent, localMtime, remoteMtime});
					if (this.settings.conflictStrategy === 'keep-local') {
						await this.uploadLocal(p, local!);
					} else if (this.settings.conflictStrategy === 'keep-remote') {
						await this.downloadRemote(p, remote!);
					} else if (this.settings.conflictStrategy === 'smart') {
						// attempt simple smart merge
						const merged = this.simpleSmartMerge(localContent || '', remoteContent || '');
						if (merged.confident) {
							await this.writeLocal(p, merged.content);
							await this.client.putFile(p, merged.content);
							this.settings.lastSyncMap[p] = Date.now();
						} else {
							// fallback: keep both backups
							await this.keepBothBackup(p, local!, remote!);
						}
					} else {
						// ask later in modal
					}
				} else if (changedLocal) {
					// local changed only -> upload
					await this.logger.append(`上传: ${p}`);
					await this.uploadLocal(p, local!);
				} else if (changedRemote) {
					// remote changed only -> download
					await this.logger.append(`下载: ${p}`);
					await this.downloadRemote(p, remote!);
				} else {
					// no changes
				}
			}

			if (newConflicts.length > 0) {
				this.conflicts = newConflicts;
				if (this.settings.conflictStrategy === 'ask') {
					new ConflictModal(this.app, this.conflicts, async (path, action) => await this.resolveConflict(path, action)).open();
				}
			} else {
				this.conflicts = [];
			}

			await this.saveSettings();
			await this.logger.append('同步完成');
			new Notice('WebDAV 同步完成');
		} catch (e: any) {
			console.error(e);
			await this.logger.append('同步出错: ' + String(e));
			new Notice('WebDAV 同步出错: ' + (e && e.message ? e.message : String(e)));
		} finally {
			this.syncInProgress = false;
		}
	}

	private async uploadLocal(path: string, file: TFile) {
		try {
			const content = await this.app.vault.read(file);
			await this.client!.putFile(path, content);
			this.settings.lastSyncMap = this.settings.lastSyncMap || {};
			this.settings.lastSyncMap[path] = Date.now();
			await this.logger!.append(`已上传 ${path}`);
		} catch (e) {
			await this.logger!.append(`上传失败 ${path}: ${String(e)}`);
		}
	}

	private async downloadRemote(path: string, remoteInfo: any) {
		try {
			const {content} = await this.client!.getFile(path);
			// write local
			await this.writeLocal(path, content);
			this.settings.lastSyncMap = this.settings.lastSyncMap || {};
			this.settings.lastSyncMap[path] = Date.now();
			await this.logger!.append(`已下载 ${path}`);
		} catch (e) {
			await this.logger!.append(`下载失败 ${path}: ${String(e)}`);
		}
	}

	private async writeLocal(path: string, content: string) {
		try {
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing && existing instanceof TFile) {
				await this.app.vault.modify(existing as TFile, content);
			} else {
				await this.app.vault.create(path, content);
			}
		} catch (e) {
			// try to ensure folder exists by creating parents
			await this.ensureLocalParent(path);
			try {
				await this.app.vault.create(path, content);
			} catch (e2) {
				console.error('writeLocal failed', e2);
			}
		}
	}

	private async ensureLocalParent(path: string) {
		const parts = path.split('/');
		parts.pop();
		let cur = '';
		for (const p of parts) {
			cur = cur ? `${cur}/${p}` : p;
			const f = this.app.vault.getAbstractFileByPath(cur);
			if (!f) {
				try { await this.app.vault.createFolder(cur); } catch (e) {}
			}
		}
	}

	private simpleSmartMerge(a: string, b: string): {confident: boolean; content: string} {
		// very simple heuristics: if one contains the other, choose longer; otherwise mark not confident
		if (a === b) return {confident: true, content: a};
		if (!a) return {confident: true, content: b};
		if (!b) return {confident: true, content: a};
		if (a.includes(b)) return {confident: true, content: a};
		if (b.includes(a)) return {confident: true, content: b};
		// fallback: produce combined file with separators
		const merged = `<!-- MERGED START -->\n\n${a}\n\n<!-- REMOTE CONTENT -->\n\n${b}\n\n<!-- MERGED END -->`;
		return {confident: false, content: merged};
	}

	private async keepBothBackup(path: string, local: TFile, remote: any) {
		const ts = Date.now();
		const localName = `${path}.local-conflict-${ts}`;
		const remoteName = `${path}.remote-conflict-${ts}`;
		try {
			// rename local
			try { await this.app.vault.rename(local, localName); } catch (e) { }
			// write remote content to remoteName
			const remoteContent = (await this.client!.getFile(path)).content;
			await this.client!.putFile(remoteName, remoteContent);
			await this.logger!.append(`冲突保存: 本地->${localName} 云端->${remoteName}`);
		} catch (e) {
			await this.logger!.append(`冲突保存失败 ${path}: ${String(e)}`);
		}
	}

	async resolveConflict(path: string, action: 'keep-local' | 'keep-remote' | 'keep-both' | 'smart') {
		const localFile = this.app.vault.getAbstractFileByPath(path) as TFile | null;
		try {
			if (action === 'keep-local') {
				if (localFile) await this.uploadLocal(path, localFile);
			} else if (action === 'keep-remote') {
				const remoteIndex = await this.client!.propfind(this.settings.webdavPath || '');
				const remote = remoteIndex[path];
				if (remote) await this.downloadRemote(path, remote);
			} else if (action === 'keep-both') {
				const remoteIndex = await this.client!.propfind(this.settings.webdavPath || '');
				const remote = remoteIndex[path];
				if (localFile && remote) await this.keepBothBackup(path, localFile, remote);
			} else if (action === 'smart') {
				const remoteIndex = await this.client!.propfind(this.settings.webdavPath || '');
				const remote = remoteIndex[path];
				const localContent = localFile ? await this.app.vault.read(localFile) : '';
				const remoteContent = remote ? (await this.client!.getFile(path)).content : '';
				const merged = this.simpleSmartMerge(localContent, remoteContent);
				if (merged.confident) {
					await this.writeLocal(path, merged.content);
					await this.client!.putFile(path, merged.content);
					this.settings.lastSyncMap[path] = Date.now();
				} else {
					await this.keepBothBackup(path, localFile!, remote);
				}
			}
			// remove from conflicts list
			this.conflicts = this.conflicts.filter(c => c.path !== path);
			await this.saveSettings();
			await this.logger!.append(`已解决冲突 ${path} -> ${action}`);
			new Notice(`冲突已处理: ${path}`);
		} catch (e) {
			await this.logger!.append(`解决冲突失败 ${path}: ${String(e)}`);
			new Notice('解决冲突失败: ' + String(e));
		}
	}
}

