/**
 * 启动头部里的色块图：cirno.png 的半块还原，排在那几行启动文字左侧。
 *
 * 每个终端格装两个纵向像素（终端字格宽高约 1:2，半块像素近似正方形）：
 *   █  上下同色，或色差 ≤ FLAT_DELTA（取均值）
 *   ▀  上半有色、下半是背景      ▄  下半有色、上半是背景
 *   空格  上下都是背景（不上色，透出主题底色）
 * 上下都不同色时用前景 + 背景两个真彩值分别还原。同一行里样式相同的连续格子合并成一段，
 * 否则 24 行要发上千个 SGR。
 *
 * 数据保存在 cirno-art-data.ts 中，渲染逻辑由本组件处理。
 */

import type { Component } from "@mapleluvr/kappa-tui";
import { type Theme, theme } from "../theme/theme.ts";
import { CIRNO_ART_SOURCES, type CirnoArtSource } from "./cirno-art-data.ts";

/** 与 theme.getColorMode() 同一个联合类型，但不额外改动主题模块的导出面 */
type ArtColorMode = ReturnType<Theme["getColorMode"]>;

/** 上下两半色差在这个范围内就当成同色，合并成 █ + 均值（省掉背景色那一段序列） */
const FLAT_DELTA = 10;
/** 近黑且通道差异小的采样点判成背景；瞳孔也是近黑但偏蓝，通道差更大，不会被吃掉 */
const BG_MAX = 48;
const BG_SPREAD = 14;
/** 头部左侧并排时图宽上限：文字要放在右侧，所以不再用竖排时代的 48 档 */
const MAX_ART_PIXELS = 32;
/** 图与右侧文字之间的空列 */
const ART_GAP = 3;
/** 右侧文字至少保留的列数，不够就再降一档或干脆不画图 */
const MIN_TEXT_WIDTH = 44;
/** 头部下面还有说明、加载项、警告、编辑器与页脚，再加上启动前终端里已经有的行，留够才不会被顶掉 */
const ART_HEIGHT_RESERVE = 18;
/** 拿不到终端高度时（测试、重定向）按这个行数算 */
const DEFAULT_ROWS = 30;

const RESET = "\x1b[0m";
/** 透明段要把前景/背景显式置回默认，否则空格会沿用上一段落的颜色 */
const FG_DEFAULT = "\x1b[39m";
const BG_DEFAULT = "\x1b[49m";

interface Cell {
	char: string;
	fg?: string;
	bg?: string;
}

interface Rgb {
	r: number;
	g: number;
	b: number;
}

function hexToRgb(hex: string): Rgb {
	const cleaned = hex.startsWith("#") ? hex.slice(1) : hex;
	if (cleaned.length !== 6) throw new Error(`cirno 色块图数据里的色值不合法: ${hex}`);
	return {
		r: Number.parseInt(cleaned.slice(0, 2), 16),
		g: Number.parseInt(cleaned.slice(2, 4), 16),
		b: Number.parseInt(cleaned.slice(4, 6), 16),
	};
}

/** 6x6x6 色立方 + 24 级灰阶斜坡，取加权距离最近的一个；与主题内部的换算法等价 */
const CUBE_VALUES = [0, 95, 135, 175, 215, 255];

function nearestCubeIndex(value: number): number {
	let best = 0;
	for (let i = 1; i < CUBE_VALUES.length; i++) {
		if (Math.abs(CUBE_VALUES[i]! - value) < Math.abs(CUBE_VALUES[best]! - value)) best = i;
	}
	return best;
}

function rgbTo256({ r, g, b }: Rgb): number {
	const cubeIndex = 16 + 36 * nearestCubeIndex(r) + 6 * nearestCubeIndex(g) + nearestCubeIndex(b);
	const gray = Math.round((r * 0.299 + g * 0.587 + b * 0.114 - 8) / 10);
	const grayIndex = Math.max(0, Math.min(23, gray));
	const grayValue = 8 + grayIndex * 10;
	const cubeDistance =
		(r - CUBE_VALUES[nearestCubeIndex(r)]!) ** 2 +
		(g - CUBE_VALUES[nearestCubeIndex(g)]!) ** 2 +
		(b - CUBE_VALUES[nearestCubeIndex(b)]!) ** 2;
	const grayDistance = (r - grayValue) ** 2 + (g - grayValue) ** 2 + (b - grayValue) ** 2;
	return grayDistance < cubeDistance ? 232 + grayIndex : cubeIndex;
}

function isBackground(hex: string): boolean {
	const { r, g, b } = hexToRgb(hex);
	const max = Math.max(r, g, b);
	return max < BG_MAX && max - Math.min(r, g, b) < BG_SPREAD;
}

function near(top: string, bottom: string): boolean {
	const a = hexToRgb(top);
	const b = hexToRgb(bottom);
	return Math.abs(a.r - b.r) <= FLAT_DELTA && Math.abs(a.g - b.g) <= FLAT_DELTA && Math.abs(a.b - b.b) <= FLAT_DELTA;
}

function meanHex(top: string, bottom: string): string {
	const a = hexToRgb(top);
	const b = hexToRgb(bottom);
	return [a.r + b.r, a.g + b.g, a.b + b.b]
		.map((value) =>
			Math.round(value / 2)
				.toString(16)
				.padStart(2, "0"),
		)
		.join("");
}

function cellFor(top: string, bottom: string): Cell {
	const topIsBg = isBackground(top);
	const bottomIsBg = isBackground(bottom);
	if (topIsBg && bottomIsBg) return { char: " " };
	if (topIsBg) return { char: "▄", fg: bottom };
	if (bottomIsBg) return { char: "▀", fg: top };
	if (near(top, bottom)) return { char: "█", fg: meanHex(top, bottom) };
	return { char: "▀", fg: top, bg: bottom };
}

function fgAnsi(hex: string, mode: ArtColorMode): string {
	const { r, g, b } = hexToRgb(hex);
	return mode === "truecolor" ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${rgbTo256({ r, g, b })}m`;
}

function bgAnsi(hex: string, mode: ArtColorMode): string {
	const { r, g, b } = hexToRgb(hex);
	return mode === "truecolor" ? `\x1b[48;2;${r};${g};${b}m` : `\x1b[48;5;${rgbTo256({ r, g, b })}m`;
}

/** 采样网格 → 每格的上下两个像素 → 半块字符 */
function parseGrid(source: CirnoArtSource): Cell[][] {
	const { pixels, hex } = source;
	if (hex.length !== pixels * pixels * 6) {
		throw new Error(`cirno 色块图数据与边长不符: ${pixels}px 需要 ${pixels * pixels * 6} 字符，实际 ${hex.length}`);
	}
	const at = (x: number, y: number) => hex.slice((y * pixels + x) * 6, (y * pixels + x) * 6 + 6);
	const rows: Cell[][] = [];
	for (let y = 0; y < pixels; y += 2) {
		const row: Cell[] = [];
		for (let x = 0; x < pixels; x++) {
			row.push(cellFor(at(x, y), at(x, y + 1)));
		}
		rows.push(row);
	}
	return rows;
}

const GRID_CACHE = new Map<number, Cell[][]>();

function gridFor(source: CirnoArtSource): Cell[][] {
	let grid = GRID_CACHE.get(source.pixels);
	if (!grid) {
		grid = parseGrid(source);
		GRID_CACHE.set(source.pixels, grid);
	}
	return grid;
}

function rowToAnsi(row: Cell[], mode: ArtColorMode): string {
	let line = "";
	let runText = "";
	let runFg: string | undefined;
	let runBg: string | undefined;
	// 当前已经发出的颜色：透明段必须显式置回默认，否则空格会沿用上一段的底色
	let paintedFg: string | undefined;
	let paintedBg: string | undefined;
	const flush = () => {
		if (runText.length === 0) return;
		if (runFg !== paintedFg) {
			line += runFg !== undefined ? fgAnsi(runFg, mode) : FG_DEFAULT;
			paintedFg = runFg;
		}
		if (runBg !== paintedBg) {
			line += runBg !== undefined ? bgAnsi(runBg, mode) : BG_DEFAULT;
			paintedBg = runBg;
		}
		line += runText;
		runText = "";
		runFg = undefined;
		runBg = undefined;
	};
	for (const cell of row) {
		if (runText.length > 0 && (cell.fg !== runFg || cell.bg !== runBg)) flush();
		runText += cell.char;
		runFg = cell.fg;
		runBg = cell.bg;
	}
	flush();
	return line.length > 0 ? `${line}${RESET}` : line;
}

/**
 * 挑选头部左侧要用的档位：从大到小取第一个放得下的。
 *
 * - 图占 `pixels` 列，右侧还要留下 `ART_GAP` 空列加上至少 `MIN_TEXT_WIDTH` 列给头部文字
 * - 图占 `pixels/2` 行，下面还要留下说明、加载项、编辑器与页脚的行
 * - 图宽上限 `MAX_ART_PIXELS`：并排时不会再给 48 档，那是竖排时代的尺寸
 */
export function pickCirnoArt(width: number, rows: number = DEFAULT_ROWS): CirnoArtSource | undefined {
	const limit = Math.min(MAX_ART_PIXELS, width - ART_GAP - MIN_TEXT_WIDTH);
	return CIRNO_ART_SOURCES.find((source) => source.pixels <= limit && source.pixels / 2 <= rows - ART_HEIGHT_RESERVE);
}

/**
 * 渲染一个档位：`source.pixels` 列宽、`pixels/2` 行，左对齐。
 * 每行可见宽正好是 `source.pixels`（全透明的行是空串，由调用方决定怎么占位）。
 */
export function renderCirnoArt(source: CirnoArtSource, mode: ArtColorMode): string[] {
	return gridFor(source).map((row) => rowToAnsi(row, mode));
}

/** 整行透明的行渲染出来是空串，并排时要拿空格占住图的列宽 */
function lineAt(lines: string[], index: number, artWidth: number): string {
	const line = lines[index];
	return line === undefined || line.length === 0 ? " ".repeat(artWidth) : line;
}

/**
 * 启动头部：左边半块色块图，右边接原来的头部文字（`kappa v0.85.1` + 按键说明 + 加载项）。
 *
 * 文字的排版宽度由图的档位决定：图占 `pixels + ART_GAP` 列，剩下的给文字。
 * 所以文字会自己折行，而合并后每行可见宽仍是 ≤ 组件拿到的 width（主屏对超宽行会抛错）。
 * `setExpanded` 转发给包住的文字组件，ctrl+o 展开仍然生效（interactive-mode 用 isExpandable 判定）。
 */
export class CirnoArtHeader implements Component {
	private readonly text: Component;

	constructor(text: Component) {
		this.text = text;
	}

	setExpanded(expanded: boolean): void {
		const target = this.text as { setExpanded?: (value: boolean) => void };
		target.setExpanded?.(expanded);
	}

	invalidate(): void {
		this.text.invalidate?.();
	}

	render(width: number): string[] {
		const rows = process.stdout.rows ?? DEFAULT_ROWS;
		const source = pickCirnoArt(width, rows);
		if (!source) return this.text.render(width);
		const textWidth = Math.max(1, width - source.pixels - ART_GAP);
		const artLines = renderCirnoArt(source, theme.getColorMode());
		const textLines = this.text.render(textWidth);
		const gap = " ".repeat(ART_GAP);
		const count = Math.max(artLines.length, textLines.length);
		const lines: string[] = [];
		for (let i = 0; i < count; i++) {
			const left = lineAt(artLines, i, source.pixels);
			const right = textLines[i];
			lines.push(right === undefined || right.length === 0 ? left : `${left}${gap}${right}`);
		}
		return lines;
	}
}
