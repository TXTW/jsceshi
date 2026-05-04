import {App, PluginSettingTab, Setting, TFile, Notice} from "obsidian";
import type WebDAVSyncPlugin from "./main";

export type ConflictStrategy = 'ask' | 'keep-local' | 'keep-remote' | 'smart';

export interface WebDAVSettings {
	webdavUrl: string;
	webdavPath: string;
	username: string;
	password: string;
	autoSyncIntervalSec: number;
	idleDelaySec: number;
	conflictStrategy: ConflictStrategy;
	enableRealtime: boolean;
	enableLogging: boolean;
	includeAttachments: boolean;
	// store last sync metadata per file (serialized map)
	lastSyncMap: Record<string, number>;
}

export const DEFAULT_SETTINGS: WebDAVSettings = {
	webdavUrl: '',
	webdavPath: '',
	username: '',
	password: '',
	autoSyncIntervalSec: 300,
	idleDelaySec: 10,
	conflictStrategy: 'ask',
	enableRealtime: true,
	enableLogging: true,
	includeAttachments: false,
	lastSyncMap: {}
};

export class WebDAVSettingTab extends PluginSettingTab {
	plugin: WebDAVSyncPlugin;

	constructor(app: App, plugin: WebDAVSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		containerEl.createEl('h3', {text: 'Obsidian WebDAV 同步 设置'});

		new Setting(containerEl)
			.setName('WebDAV 服务器 URL')
			.setDesc('例如 https://example.com/remote.php/dav/files/用户名/')
			.addText(text => text
				.setPlaceholder('WebDAV 基础 URL')
				.setValue(this.plugin.settings.webdavUrl)
				.onChange(async (value) => {
					this.plugin.settings.webdavUrl = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('远程根路径（可选）')
			.setDesc('将 Obsidian 笔记同步到这个子路径下')
			.addText(text => text
				.setPlaceholder('例如 obsidian')
				.setValue(this.plugin.settings.webdavPath)
				.onChange(async (value) => {
					this.plugin.settings.webdavPath = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('用户名')
			.addText(text => text
				.setPlaceholder('用户名')
				.setValue(this.plugin.settings.username)
				.onChange(async (value) => {
					this.plugin.settings.username = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('密码')
			.setDesc('将以明文保存到插件设置（Obsidian 插件沙箱）。如需更安全存储请使用系统凭据管理器。')
			.addText(text => text
				.setPlaceholder('密码')
				.setValue(this.plugin.settings.password)
				.onChange(async (value) => {
					this.plugin.settings.password = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('自动同步间隔（秒）')
			.setDesc('每隔指定秒数执行一次全量/增量检查并同步')
			.addText(text => text
				.setPlaceholder('300')
				.setValue(String(this.plugin.settings.autoSyncIntervalSec))
				.onChange(async (value) => {
					const v = Number(value) || 0;
					this.plugin.settings.autoSyncIntervalSec = Math.max(5, v);
					await this.plugin.saveSettings();
					this.plugin.setupAutoSyncInterval();
				}));

		new Setting(containerEl)
			.setName('停止编辑后延迟同步（秒）')
			.setDesc('编辑停止后等待指定秒数再自动同步（防止频繁触发）')
			.addText(text => text
				.setPlaceholder('10')
				.setValue(String(this.plugin.settings.idleDelaySec))
				.onChange(async (value) => {
					const v = Number(value) || 0;
					this.plugin.settings.idleDelaySec = Math.max(1, v);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('冲突处理策略')
			.setDesc('当云端与本地同时更改时的默认策略（ask 会弹窗提示）')
			.addDropdown(drop => drop
				.addOption('ask', '询问')
				.addOption('keep-local', '保留本地')
				.addOption('keep-remote', '保留云端')
				.addOption('smart', '智能合并/保留备份')
				.setValue(this.plugin.settings.conflictStrategy)
				.onChange(async (value: any) => {
					this.plugin.settings.conflictStrategy = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('实时同步')
			.setDesc('文件保存/修改后是否自动触发同步')
			.addToggle(tg => tg
				.setValue(this.plugin.settings.enableRealtime)
				.onChange(async (v) => {
					this.plugin.settings.enableRealtime = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('是否包含附件')
			.setDesc('是否也同步非 markdown 的附件文件（图片等）')
			.addToggle(tg => tg
				.setValue(this.plugin.settings.includeAttachments)
				.onChange(async (v) => {
					this.plugin.settings.includeAttachments = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('启用日志')
			.setDesc('将操作记录到 `.obsidian/plugins/<id>/sync.log`')
			.addToggle(tg => tg
				.setValue(this.plugin.settings.enableLogging)
				.onChange(async (v) => {
					this.plugin.settings.enableLogging = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('即时操作')
			.addButton(btn => btn
				.setButtonText('立即同步')
				.setTooltip('立即执行一次同步')
				.onClick(() => {
					// trigger sync in plugin
					// plugin may expose syncNow
					// @ts-ignore
					this.plugin.syncNow();
				}))
			.addButton(btn => btn
				.setButtonText('打开日志')
				.setTooltip('打开同步日志文件（如果存在）')
				.onClick(async () => {
					const logPath = `.obsidian/plugins/${this.plugin.manifest.id}/sync.log`;
					// @ts-ignore
					const f = this.app.vault.getAbstractFileByPath(logPath) as TFile | null;
					if (f) {
						// @ts-ignore
						this.app.workspace.openFile(f);
					} else {
						new Notice('日志文件未找到');
					}
				}));
	}
}
