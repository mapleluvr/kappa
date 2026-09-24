import { type Component, visibleWidth } from "@mapleluvr/kappa-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CirnoArtHeader, pickCirnoArt, renderCirnoArt } from "../src/modes/interactive/components/cirno-art.ts";
import { CIRNO_ART_SOURCES } from "../src/modes/interactive/components/cirno-art-data.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

/** 把一行 ANSI 展开成逐字符的颜色状态，用来做「透明格子必须真的透明」这类机械检查 */
interface PaintedCell {
	char: string;
	fg: string | undefined;
	bg: string | undefined;
}

function paint(line: string): PaintedCell[] {
	const cells: PaintedCell[] = [];
	let fg: string | undefined;
	let bg: string | undefined;
	const sgr = /\x1b\[([0-9;]*)m/g;
	let cursor = 0;
	let match = sgr.exec(line);
	while (cursor < line.length) {
		if (match && match.index === cursor) {
			const codes = match[1]!.split(";").map((part) => Number.parseInt(part === "" ? "0" : part, 10));
			for (let i = 0; i < codes.length; i++) {
				const code = codes[i]!;
				if (code === 0) {
					fg = undefined;
					bg = undefined;
				} else if (code === 39) {
					fg = undefined;
				} else if (code === 49) {
					bg = undefined;
				} else if (code === 38 || code === 48) {
					const rgb = `${codes[i + 2]};${codes[i + 3]};${codes[i + 4]}`;
					if (code === 38) fg = rgb;
					else bg = rgb;
					i += 4;
				}
			}
			cursor = match.index + match[0].length;
			match = sgr.exec(line);
			continue;
		}
		cells.push({ char: line[cursor]!, fg, bg });
		cursor += 1;
	}
	return cells;
}

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

/** 头部右侧那段文字的位置，用固定行数的假组件代替真实的 ExpandableText */
class FakeText implements Component {
	readonly lines: string[];
	expanded = false;
	widths: number[] = [];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	invalidate(): void {}

	render(width: number): string[] {
		this.widths.push(width);
		return this.lines.map((line) => line.slice(0, width));
	}
}

const LONG_LINE = "escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more";

function headerText(): FakeText {
	return new FakeText([LONG_LINE, "", "Kappa can explain its own features."]);
}

/** 组件从 process.stdout.rows 读终端高度，测试里直接改这个值 */
function withRows<T>(rows: number | undefined, run: () => T): T {
	const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
	try {
		return run();
	} finally {
		if (descriptor) {
			Object.defineProperty(process.stdout, "rows", descriptor);
		} else {
			Reflect.deleteProperty(process.stdout, "rows");
		}
	}
}

describe("cirno startup art", () => {
	beforeEach(() => {
		initTheme("dark");
	});

	afterEach(() => {
		withRows(undefined, () => {});
	});

	it("never renders a line wider than the requested width", () => {
		const text = headerText();
		const header = new CirnoArtHeader(text);
		for (let width = 8; width <= 200; width++) {
			for (const rows of [20, 30, 34, 44, 60]) {
				withRows(rows, () => {
					for (const line of header.render(width)) {
						expect(visibleWidth(line)).toBeLessThanOrEqual(width);
					}
				});
			}
		}
		for (const source of CIRNO_ART_SOURCES) {
			for (const mode of ["truecolor", "256color"] as const) {
				for (const line of renderCirnoArt(source, mode)) {
					expect(visibleWidth(line)).toBe(source.pixels);
				}
			}
		}
	});

	it("picks the largest art that fits the width and leaves room below", () => {
		// 图宽上限 32；右侧要留 3 空列 + 至少 44 列文字
		expect(pickCirnoArt(200, 60)?.pixels).toBe(32);
		expect(pickCirnoArt(79, 60)?.pixels).toBe(32);
		expect(pickCirnoArt(78, 60)?.pixels).toBe(24);
		expect(pickCirnoArt(71, 60)?.pixels).toBe(24);
		expect(pickCirnoArt(70, 60)).toBeUndefined();

		// 高度：16 行的图要 34 行终端，12 行的图要 30 行
		expect(pickCirnoArt(200, 60)?.pixels).toBe(32);
		expect(pickCirnoArt(200, 34)?.pixels).toBe(32);
		expect(pickCirnoArt(200, 33)?.pixels).toBe(24);
		expect(pickCirnoArt(200, 30)?.pixels).toBe(24);
		expect(pickCirnoArt(200, 29)).toBeUndefined();
	});

	it("emits the escape sequence family of the active color mode", () => {
		const source = CIRNO_ART_SOURCES[1]!;
		const truecolor = renderCirnoArt(source, "truecolor").join("\n");
		expect(truecolor).toContain("\x1b[38;2;");
		expect(truecolor).not.toContain("\x1b[38;5;");

		const palette = renderCirnoArt(source, "256color").join("\n");
		expect(palette).toContain("\x1b[38;5;");
		expect(palette).not.toContain("\x1b[38;2;");
	});

	it("never paints a transparent cell with the previous cell's color", () => {
		for (const source of CIRNO_ART_SOURCES) {
			for (const mode of ["truecolor", "256color"] as const) {
				for (const line of renderCirnoArt(source, mode)) {
					for (const cell of paint(line)) {
						if (cell.char === " ") {
							expect([cell.char, cell.fg, cell.bg]).toEqual([" ", undefined, undefined]);
						}
					}
				}
			}
		}
	});

	it("keeps the header text three columns right of the art and narrows its layout width", () => {
		withRows(44, () => {
			const text = headerText();
			const header = new CirnoArtHeader(text);

			const lines = header.render(120);
			expect(lines).toHaveLength(16);
			// 右侧文字按 120 - 32 - 3 的宽度排版，只渲染一次
			expect(text.widths).toEqual([85]);

			// 第一行左侧是图、接着 3 空列、然后是文字
			expect(stripAnsi(lines[0]!).slice(32, 35)).toBe("   ");
			expect(stripAnsi(lines[0]!)).toContain("escape interrupt");

			// 第二行文字是空的，这一行就该只有 32 格图，右侧不留尾巴
			expect(stripAnsi(lines[1]!)).toHaveLength(32);

			// 第三行又有文字，仍然从第 36 列开始
			expect(stripAnsi(lines[2]!).slice(32, 35)).toBe("   ");
			expect(stripAnsi(lines[2]!)).toContain("Kappa can explain");
			expect(visibleWidth(lines[2]!)).toBeLessThanOrEqual(120);
		});
	});

	it("falls back to a smaller art on short terminals and drops it when there is no room", () => {
		withRows(34, () => {
			const text = headerText();
			const lines = new CirnoArtHeader(text).render(120);
			expect(lines).toHaveLength(16);
			expect(text.widths).toEqual([85]);
		});

		withRows(30, () => {
			const text = headerText();
			const lines = new CirnoArtHeader(text).render(120);
			expect(lines).toHaveLength(12);
			expect(text.widths).toEqual([93]);
		});

		withRows(29, () => {
			const text = headerText();
			const lines = new CirnoArtHeader(text).render(120);
			expect(lines).toHaveLength(3);
			expect(text.widths).toEqual([120]);
		});
	});

	it("uses the same 24-row fallback as ProcessTerminal when stdout has no rows", () => {
		const previousLines = process.env.LINES;
		process.env.LINES = "24";
		try {
			withRows(undefined, () => {
				const text = headerText();
				const lines = new CirnoArtHeader(text).render(120);
				expect(lines).toHaveLength(3);
				expect(text.widths).toEqual([120]);
			});
		} finally {
			if (previousLines === undefined) delete process.env.LINES;
			else process.env.LINES = previousLines;
		}
	});

	it("preserves a low-saturation tint in 256-color mode", () => {
		const source = { pixels: 4, hex: "505a50".repeat(16) };
		const line = renderCirnoArt(source, "256color")[0]!;
		expect(line).toContain("\x1b[38;5;59m");
		expect(line).not.toContain("\x1b[38;5;240m");
	});

	it("forwards expansion to the wrapped header text", () => {
		const text = headerText();
		const header = new CirnoArtHeader(text);
		header.setExpanded(true);
		expect(text.expanded).toBe(true);
		withRows(44, () => {
			expect(header.render(120)).toHaveLength(16);
		});
	});
});
