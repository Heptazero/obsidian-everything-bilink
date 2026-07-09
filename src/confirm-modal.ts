import { App, Modal, Setting } from "obsidian";

/** Minimal yes/no confirmation dialog. Resolves nothing; calls onConfirm on accept. */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private message: string,
		private confirmText: string,
		private onConfirm: () => void
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("p", { text: this.message });
		new Setting(this.contentEl)
			.addButton((b) =>
				b
					.setButtonText(this.confirmText)
					.setWarning()
					.onClick(() => {
						this.close();
						this.onConfirm();
					})
			)
			.addButton((b) => b.setButtonText("取消").onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
