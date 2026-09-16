import assert from "node:assert";
import { describe, it } from "node:test";
import { renderTuiNotice, type TuiNotice } from "../src/index.ts";
import { visibleWidth } from "../src/utils.ts";

function compactionWarning(overrides: Partial<TuiNotice> = {}): TuiNotice {
	return {
		level: "warning",
		code: "compaction.warning",
		message: "context is approaching the compaction threshold",
		timestamp: 1_700_000_000_000,
		...overrides,
	};
}

describe("renderTuiNotice", () => {
	it("renders a compaction.warning notice as a single truncated line", () => {
		const lines = renderTuiNotice(compactionWarning(), 80);
		assert.strictEqual(lines.length, 1);
		assert.ok(lines[0].includes("compaction.warning"));
		assert.ok(lines[0].includes("warning"));
		assert.ok(lines[0].includes("context is approaching the compaction threshold"));
		assert.strictEqual(visibleWidth(lines[0]), 80);
	});

	it("returns no lines for a null notice", () => {
		assert.deepStrictEqual(renderTuiNotice(null, 80), []);
	});

	it("returns no lines for non-positive width", () => {
		const notice = compactionWarning();
		assert.deepStrictEqual(renderTuiNotice(notice, 0), []);
		assert.deepStrictEqual(renderTuiNotice(notice, -4), []);
	});

	it("stays within a narrow width", () => {
		const lines = renderTuiNotice(compactionWarning(), 8);
		assert.strictEqual(lines.length, 1);
		assertSafeNoticeLine(lines[0], 8);
		assert.strictEqual(lines[0].length, 8);
	});

	it("truncates extra-long messages deterministically", () => {
		const notice = compactionWarning({ message: "overflow ".repeat(200) });
		const first = renderTuiNotice(notice, 40);
		const second = renderTuiNotice(notice, 40);
		assert.deepStrictEqual(first, second);
		assert.strictEqual(first.length, 1);
		assert.strictEqual(visibleWidth(first[0]), 40);
		assert.ok(first[0].includes("..."));
	});

	it("flattens multiline messages into one display line", () => {
		const lines = renderTuiNotice(
			compactionWarning({
				message: "first line\nsecond line\r\nthird\tline",
			}),
			120,
		);
		assert.strictEqual(lines.length, 1);
		assert.strictEqual(lines[0].includes("\n"), false);
		assert.strictEqual(lines[0].includes("\r"), false);
		assert.ok(lines[0].includes("first line"));
		assert.ok(lines[0].includes("second line"));
		assert.ok(lines[0].includes("third line"));
	});

	it("strips terminal escapes and control characters to a single safe line", () => {
		const lines = renderTuiNotice(
			compactionWarning({
				code: "compaction\x1b[2J.warning",
				message: "keep\x1b[2Jthis\x1b[Htext\x07more\fnext\u2028line\u2029end\r\nand last",
			}),
			120,
		);
		assert.strictEqual(lines.length, 1);
		const line = lines[0];
		assertSafeNoticeLine(line, 120);
		assert.strictEqual(line.includes("[2J"), false);
		assert.strictEqual(line.includes("\f"), false);
		assert.strictEqual(line.includes("\u2028"), false);
		assert.strictEqual(line.includes("\u2029"), false);
		assert.strictEqual(line.trimEnd(), "[warning] compaction.warning  keepthistext more next line end and last");
	});

	it("flattens unicode format and bidi controls", () => {
		const lines = renderTuiNotice(
			compactionWarning({
				code: "compaction\u200B.warning",
				message: "keep\u202Esecret\u202C text\u2066hidden\u2069end",
			}),
			120,
		);
		assert.strictEqual(lines.length, 1);
		const line = lines[0];
		assertSafeNoticeLine(line, 120);
		assert.strictEqual(line.includes("\u200B"), false);
		assert.strictEqual(line.includes("\u202E"), false);
		assert.strictEqual(line.includes("\u202C"), false);
		assert.strictEqual(line.includes("\u2066"), false);
		assert.strictEqual(line.includes("\u2069"), false);
		assert.ok(line.includes("secret"));
		assert.ok(line.includes("hidden"));
	});

	it("does not re-inject ANSI reset or escapes when truncating", () => {
		const lines = renderTuiNotice(compactionWarning({ message: "overflow ".repeat(200) }), 40);
		assert.strictEqual(lines.length, 1);
		const line = lines[0];
		assertSafeNoticeLine(line, 40);
		assert.strictEqual(line.length, 40);
		assert.ok(line.includes("..."));
		assert.strictEqual(line.includes("\x1b[0m"), false);
	});

	it("strips complete CSI with any final 0x40-0x7E without leaving payload", () => {
		const lines = renderTuiNotice(
			compactionWarning({
				code: "compaction\x1b[2A.warning",
				message: "keep\x1b[2Asecret\x1b[?25lhidden\x1b[48;2;1;2;3mcolor\x1b[1;1Hpos",
			}),
			160,
		);
		assert.strictEqual(lines.length, 1);
		const line = lines[0];
		assertSafeNoticeLine(line, 160);
		assert.strictEqual(line.includes("[2A"), false);
		assert.strictEqual(line.includes("?25"), false);
		assert.strictEqual(line.includes("48;2;1;2;3"), false);
		assert.strictEqual(line.includes("[1;1H"), false);
		assert.ok(line.includes("[warning] compaction.warning  keepsecrethiddencolorpos"));
	});

	it("strips CSI whose final is 0x40-0x7E even when intermediate bytes precede parameters and width truncates", () => {
		const lines = renderTuiNotice(
			compactionWarning({
				code: "pre\x1b[ 31m\x1b[3 1m.warning",
				message: `\x9b 31m${"overflow ".repeat(20)}`,
			}),
			40,
		);
		assert.strictEqual(lines.length, 1);
		const line = lines[0];
		assertSafeNoticeLine(line, 40);
		assert.strictEqual(line.includes("31m"), false);
		assert.strictEqual(line.includes("[ 31"), false);
		assert.strictEqual(line.includes("[3 1"), false);
	});

	it("strips DCS/OSC/APC/PM/SOS terminated by BEL or ST without leaving payload", () => {
		const st = "\x1b\\";
		const lines = renderTuiNotice(
			compactionWarning({
				message: [
					"keep",
					"\x1b]8;;https://evil.example\x07",
					"oscbel",
					"\x1b]0;window-title",
					st,
					"oscst",
					"\x1bP1$r1 q",
					st,
					"dcs",
					"\x1b_apc-payload\x07",
					"apc",
					"\x1b^pm-payload",
					st,
					"pm",
					"\x1bXsos-payload\x07",
					"sos",
				].join(""),
			}),
			200,
		);
		assert.strictEqual(lines.length, 1);
		const line = lines[0];
		assertSafeNoticeLine(line, 200);
		assert.strictEqual(line.includes("https://evil.example"), false);
		assert.strictEqual(line.includes("window-title"), false);
		assert.strictEqual(line.includes("1$r1 q"), false);
		assert.strictEqual(line.includes("apc-payload"), false);
		assert.strictEqual(line.includes("pm-payload"), false);
		assert.strictEqual(line.includes("sos-payload"), false);
		assert.ok(line.includes("[warning] compaction.warning  keeposcbeloscstdcsapcpmsos"));
	});

	it("swallows remaining payload of unterminated DCS/OSC/APC/PM/SOS even when truncated", () => {
		const leaks = [
			"https://evil.example",
			"unterminated",
			"OSCUNTERM",
			"DCSUNTERM",
			"APCUNTERM",
			"PMUNTERM",
			"SOSUNTERM",
		];
		const cases: Array<{ code?: string; message: string }> = [
			{ code: "pre\x1b]8;;https://evil.example/unterminated", message: "keep" },
			{ message: "keep\x1b]8;;https://evil.example/OSCUNTERM" },
			{ message: "keep\x1bP1$rDCSUNTERM" },
			{ message: "keep\x1b_APCUNTERM" },
			{ message: "keep\x1b^PMUNTERM" },
			{ message: "keep\x1bXSOSUNTERM" },
			{ message: "keep\x9dOSCUNTERM" },
			{ message: "keep\x90DCSUNTERM" },
			{ message: "keep\x9fAPCUNTERM" },
			{ message: "keep\x9ePMUNTERM" },
			{ message: "keep\x98SOSUNTERM" },
		];
		for (const testCase of cases) {
			const lines = renderTuiNotice(compactionWarning(testCase), 40);
			assert.strictEqual(lines.length, 1);
			const line = lines[0];
			assertSafeNoticeLine(line, 40);
			for (const leak of leaks) {
				assert.strictEqual(line.includes(leak), false);
			}
			assert.ok(line.includes("keep"));
		}
	});

	it("strips C1 CSI/DCS/OSC/APC/PM/SOS forms without leaving payload", () => {
		const lines = renderTuiNotice(
			compactionWarning({
				message: [
					"keep",
					"\x9b31m",
					"red",
					"\x9d8;;https://c1.example\x07",
					"osc",
					"\x90dcs-body\x9c",
					"dcs",
					"\x9fapc-body\x07",
					"apc",
					"\x9epm-body\x9c",
					"pm",
					"\x98sos-body\x07",
					"sos",
				].join(""),
			}),
			200,
		);
		assert.strictEqual(lines.length, 1);
		const line = lines[0];
		assertSafeNoticeLine(line, 200);
		assert.strictEqual(line.includes("31m"), false);
		assert.strictEqual(line.includes("https://c1.example"), false);
		assert.strictEqual(line.includes("dcs-body"), false);
		assert.strictEqual(line.includes("apc-body"), false);
		assert.strictEqual(line.includes("pm-body"), false);
		assert.strictEqual(line.includes("sos-body"), false);
		assert.ok(line.includes("[warning] compaction.warning  keepredoscdcsapcpmsos"));
	});

	it("truncates wide unicode without injecting escapes", () => {
		const lines = renderTuiNotice(compactionWarning({ message: "中文😀".repeat(50) }), 20);
		assert.strictEqual(lines.length, 1);
		const line = lines[0];
		assertSafeNoticeLine(line, 20);
		assert.ok(line.includes("..."));
	});
});

function assertSafeNoticeLine(line: string, width: number): void {
	assert.strictEqual(/[\u0000-\u001F\u007F-\u009F]/.test(line), false);
	assert.strictEqual(line.includes("\n"), false);
	assert.strictEqual(line.includes("\r"), false);
	assert.strictEqual(visibleWidth(line), width);
}
