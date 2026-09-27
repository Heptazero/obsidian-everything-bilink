import { App, PluginSettingTab, Setting, type Plugin } from "obsidian";

export type SelectionStyle = "underline" | "background" | "box";
export type RectStyle = "box" | "background";
/** How to fill a gap where the selection skipped non-selectable content (a formula). */
export type FormulaRecovery = "auto" | "auto+picker" | "off";

export type RectCopyMode = "embed" | "link";

export interface BilinkSettings {
	selectionStyle: SelectionStyle;
	rectStyle: RectStyle;
	rectCopyMode: RectCopyMode;
	/** Empty = follow the theme's accent color. */
	highlightColor: string;
	useThemeColor: boolean;
	underlineThickness: number;
	/** Percent up from the rect's bottom edge — tune by eye per font/zoom taste. */
	underlineOffset: number;
	/** Alias shown for the jump link itself (the "↗"). */
	jumpLabel: string;
	selectionTemplate: string;
	quoteTemplate: string;
	linkOnlyTemplate: string;
	blockRefTemplate: string;
	blockLinkOnlyTemplate: string;
	outlineTemplate: string;
	formulaRecovery: FormulaRecovery;
}

export const DEFAULT_SETTINGS: BilinkSettings = {
	selectionStyle: "underline",
	rectStyle: "box",
	rectCopyMode: "embed",
	highlightColor: "#e0ac00",
	useThemeColor: true,
	underlineThickness: 2,
	underlineOffset: 10,
	jumpLabel: "↗",
	selectionTemplate: "{{text}}{{link}}",
	quoteTemplate: "> {{text}}{{link}}\\n",
	linkOnlyTemplate: "{{link}}",
	blockRefTemplate: "> {{text}}{{link}}\\n",
	blockLinkOnlyTemplate: "{{link}}",
	outlineTemplate: "{{indent}}- {{link}}",
	formulaRecovery: "auto",
};

/**
 * Substitutes `{{name}}` placeholders and turns a literal `\n` into a real
 * newline — settings text fields are single-line, so an escape is the only way
 * to express a trailing line break in a template.
 */
export function applyTemplate(template: string, vars: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "").replace(/\\n/g, "\n");
}

/**
 * Read-modify-write of `data.json` — merges onto whatever is currently on disk
 * rather than writing a bare `{settings}` object, so a leftover key from a
 * removed feature (or one a future feature adds) isn't silently wiped out by
 * an unrelated settings save.
 */
export async function patchPluginData(plugin: Plugin, patch: Record<string, unknown>): Promise<void> {
	const existing = ((await plugin.loadData()) as Record<string, unknown> | null) ?? {};
	await plugin.saveData({ ...existing, ...patch });
}

export async function loadSettings(plugin: Plugin): Promise<BilinkSettings> {
	const data = (await plugin.loadData()) as { settings?: Partial<BilinkSettings> } | null;
	return { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
}

export function saveSettings(plugin: Plugin, settings: BilinkSettings): Promise<void> {
	return patchPluginData(plugin, { settings });
}

/**
 * Pushes the style-affecting settings onto `document.body` as data attributes +
 * CSS custom properties, which styles.css keys off. Doing it this way means a
 * style change repaints instantly without re-rendering any highlight.
 */
export function applyStyleSettings(settings: BilinkSettings): void {
	const body = document.body;
	body.dataset.bilinkSelStyle = settings.selectionStyle;
	body.dataset.bilinkRectStyle = settings.rectStyle;
	// A CSS variable can itself hold a `var()` reference, so "follow the theme"
	// needs no separate branch in the stylesheet.
	body.style.setProperty("--bilink-color", settings.useThemeColor ? "var(--interactive-accent)" : settings.highlightColor);
	body.style.setProperty("--bilink-underline-thickness", `${settings.underlineThickness}px`);
	body.style.setProperty("--bilink-underline-offset", `${settings.underlineOffset}%`);
}

export function clearStyleSettings(): void {
	const body = document.body;
	delete body.dataset.bilinkSelStyle;
	delete body.dataset.bilinkRectStyle;
	body.style.removeProperty("--bilink-color");
	body.style.removeProperty("--bilink-underline-thickness");
	body.style.removeProperty("--bilink-underline-offset");
}

const TEMPLATE_HELP = "可用变量:{{text}} 选中文字、{{link}} 跳转链接、{{file}} 文件名、{{page}} 页码;\\n 表示换行。";

export class BilinkSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		plugin: Plugin,
		private settings: BilinkSettings,
		private onChange: () => void
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const commit = () => this.onChange();

		containerEl.createEl("h3", { text: "PDF 上的标记样式" });

		new Setting(containerEl)
			.setName("选区标记样式")
			.setDesc("下划线更贴合阅读;背景高亮更醒目,但跨公式的选区会把空白也涂上。")
			.addDropdown((d) =>
				d
					.addOptions({ underline: "下划线", background: "背景高亮", box: "边框" })
					.setValue(this.settings.selectionStyle)
					.onChange((v) => {
						this.settings.selectionStyle = v as SelectionStyle;
						commit();
					})
			);

		new Setting(containerEl).setName("框选标记样式").addDropdown((d) =>
			d
				.addOptions({ box: "边框", background: "背景高亮" })
				.setValue(this.settings.rectStyle)
				.onChange((v) => {
					this.settings.rectStyle = v as RectStyle;
					commit();
				})
		);

		new Setting(containerEl)
			.setName("框选粘贴为")
			.setDesc("图片嵌入可直接预览裁剪画面;仅链接不出图,格式见下方「[PDF] 仅链接」模板。")
			.addDropdown((d) =>
				d
					.addOptions({ embed: "图片嵌入", link: "仅链接" })
					.setValue(this.settings.rectCopyMode)
					.onChange((v) => {
						this.settings.rectCopyMode = v as RectCopyMode;
						commit();
					})
			);

		new Setting(containerEl)
			.setName("使用主题强调色")
			.setDesc("关闭后可以自定义标记颜色。")
			.addToggle((t) =>
				t.setValue(this.settings.useThemeColor).onChange((v) => {
					this.settings.useThemeColor = v;
					commit();
					this.display(); // show/hide the color picker below
				})
			);

		if (!this.settings.useThemeColor) {
			new Setting(containerEl).setName("标记颜色").addColorPicker((c) =>
				c.setValue(this.settings.highlightColor).onChange((v) => {
					this.settings.highlightColor = v;
					commit();
				})
			);
		}

		new Setting(containerEl)
			.setName("下划线粗细")
			.addSlider((s) =>
				s
					.setLimits(1, 6, 1)
					.setValue(this.settings.underlineThickness)
					.setDynamicTooltip()
					.onChange((v) => {
						this.settings.underlineThickness = v;
						commit();
					})
			);

		new Setting(containerEl)
			.setName("下划线偏移")
			.setDesc("普通行往上抬这么多贴近文字;跨公式的行反过来往下让开同样的量,避免盖住公式。")
			.addSlider((s) =>
				s
					.setLimits(0, 40, 1)
					.setValue(this.settings.underlineOffset)
					.setDynamicTooltip()
					.onChange((v) => {
						this.settings.underlineOffset = v;
						commit();
					})
			);

		containerEl.createEl("h3", { text: "复制文本格式" });

		new Setting(containerEl)
			.setName("跳转链接文字")
			.setDesc("留空则显示文件名。")
			.addText((t) =>
				t.setValue(this.settings.jumpLabel).onChange((v) => {
					this.settings.jumpLabel = v;
					commit();
				})
			);

		const template = (name: string, key: keyof BilinkSettings, desc?: string) =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(`${desc ?? ""} ${TEMPLATE_HELP}`.trim())
				.addText((t) =>
					t.setValue(String(this.settings[key])).onChange((v) => {
						(this.settings as unknown as Record<string, string>)[key as string] = v;
						commit();
					})
				);

		template("[PDF 选区] 单行", "selectionTemplate");
		template("[PDF 选区] 引用块", "quoteTemplate");
		template("[PDF] 仅链接", "linkOnlyTemplate", "PDF 选区和框选的「仅链接」共用这份模板,不含原文。");
		template("[笔记块引用] 引用块", "blockRefTemplate");
		template("[笔记块引用] 仅链接", "blockLinkOnlyTemplate");
		template("[PDF] 大纲", "outlineTemplate", "额外变量:{{indent}} 层级缩进、{{title}} 标题。");

		containerEl.createEl("h3", { text: "其他" });

		new Setting(containerEl)
			.setName("选区跨公式时")
			.setDesc(
				"PDF 的公式通常不在文字层里,选中一段跨公式的文字会漏掉它。自动回填会在同名 _md.md 里按前后文定位补上;手动挑选会在自动失败时弹窗让你选。"
			)
			.addDropdown((d) =>
				d
					.addOptions({ auto: "只自动回填(失败就留空)", "auto+picker": "自动失败时弹窗手动挑选", off: "不处理" })
					.setValue(this.settings.formulaRecovery)
					.onChange((v) => {
						this.settings.formulaRecovery = v as FormulaRecovery;
						commit();
					})
			);
	}
}
