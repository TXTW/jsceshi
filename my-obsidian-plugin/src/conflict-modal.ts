import {App, Modal, Setting, ButtonComponent} from 'obsidian';

export type ConflictItem = {
  path: string;
  localContent: string | null;
  remoteContent: string | null;
  localMtime?: number;
  remoteMtime?: number;
};

export class ConflictModal extends Modal {
  conflicts: ConflictItem[];
  onResolve: (path: string, action: 'keep-local' | 'keep-remote' | 'keep-both' | 'smart') => Promise<void>;

  constructor(app: App, conflicts: ConflictItem[], onResolve: (path: string, action: 'keep-local' | 'keep-remote' | 'keep-both' | 'smart') => Promise<void>) {
    super(app);
    this.conflicts = conflicts;
    this.onResolve = onResolve;
  }

  onOpen() {
    const {contentEl} = this;
    contentEl.empty();
    contentEl.createEl('h3', {text: `发现 ${this.conflicts.length} 个冲突`});
    for (const c of this.conflicts) {
      const row = contentEl.createDiv({cls: 'webdav-conflict-row'});
      row.createEl('strong', {text: c.path});
      const details = row.createDiv({cls: 'webdav-conflict-details'});
      details.createEl('div', {text: `本地时间: ${c.localMtime ? new Date(c.localMtime).toLocaleString() : 'N/A'}`});
      details.createEl('div', {text: `云端时间: ${c.remoteMtime ? new Date(c.remoteMtime).toLocaleString() : 'N/A'}`});

      const btns = row.createDiv({cls: 'webdav-conflict-actions'});
      const keepLocal = new ButtonComponent(btns).setButtonText('保留本地');
      keepLocal.onClick(async () => { await this.onResolve(c.path, 'keep-local'); this.render(); });
      const keepRemote = new ButtonComponent(btns).setButtonText('保留云端');
      keepRemote.onClick(async () => { await this.onResolve(c.path, 'keep-remote'); this.render(); });
      const keepBoth = new ButtonComponent(btns).setButtonText('保留双方（重命名备份）');
      keepBoth.onClick(async () => { await this.onResolve(c.path, 'keep-both'); this.render(); });
      const smart = new ButtonComponent(btns).setButtonText('智能');
      smart.onClick(async () => { await this.onResolve(c.path, 'smart'); this.render(); });
    }
    contentEl.createEl('div', {text: '完成选择后关闭此窗口。'});
  }

  onClose() {
    const {contentEl} = this;
    contentEl.empty();
  }
}

export default ConflictModal;
