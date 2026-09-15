import { getGraphemeSegmenter, visibleWidth } from "./utils.ts";

export type TuiNoticeLevel = "info" | "warning" | "error";

/** Presentation-safe notice value. Callers own lifecycle; TUI only displays it. */
export interface TuiNotice {
	readonly level: TuiNoticeLevel;
	readonly code: string;
	readonly message: string;
	readonly timestamp: number;
}

const DISPLAY_CONTROLS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;
const ELLIPSIS = "...";

function flattenDisplayText(value: string): string {
	return stripNoticeSequences(value).replace(DISPLAY_CONTROLS, " ");
}

/** Remove complete CSI and string sequences, including C1 forms, so payloads cannot leak. */
function stripNoticeSequences(value: string): string {
	let result = "";
	let i = 0;
	while (i < value.length) {
		const end = noticeSequenceEnd(value, i);
		if (end !== null) {
			i = end;
			continue;
		}
		result += value[i];
		i++;
	}
	return result;
}

function noticeSequenceEnd(value: string, i: number): number | null {
	const code = value.charCodeAt(i);
	if (code === 0x1b) {
		if (i + 1 >= value.length) {
			return null;
		}
		const next = value.charCodeAt(i + 1);
		if (next === 0x5b) {
			return skipCsi(value, i + 2);
		}
		if (next === 0x50 || next === 0x58 || next === 0x5d || next === 0x5e || next === 0x5f) {
			return skipStringSequence(value, i + 2);
		}
		return null;
	}
	if (code === 0x9b) {
		return skipCsi(value, i + 1);
	}
	if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
		return skipStringSequence(value, i + 1);
	}
	return null;
}

function skipCsi(value: string, i: number): number {
	while (i < value.length) {
		const code = value.charCodeAt(i);
		if (code >= 0x20 && code <= 0x3f) {
			i++;
			continue;
		}
		if (code >= 0x40 && code <= 0x7e) {
			return i + 1;
		}
		return i;
	}
	return i;
}

function skipStringSequence(value: string, i: number): number {
	while (i < value.length) {
		const code = value.charCodeAt(i);
		if (code === 0x07 || code === 0x9c) {
			return i + 1;
		}
		if (code === 0x1b && value.charCodeAt(i + 1) === 0x5c) {
			return i + 2;
		}
		i++;
	}
	return i;
}

function padToWidth(text: string, width: number, maxWidth: number): string {
	return width < maxWidth ? `${text}${" ".repeat(maxWidth - width)}` : text;
}

function truncateDisplayLine(text: string, maxWidth: number): string {
	const width = visibleWidth(text);
	if (width <= maxWidth) {
		return padToWidth(text, width, maxWidth);
	}

	const ellipsisWidth = visibleWidth(ELLIPSIS);
	if (ellipsisWidth >= maxWidth) {
		let clipped = "";
		let clippedWidth = 0;
		for (const { segment } of getGraphemeSegmenter().segment(ELLIPSIS)) {
			const segmentWidth = visibleWidth(segment);
			if (clippedWidth + segmentWidth > maxWidth) {
				break;
			}
			clipped += segment;
			clippedWidth += segmentWidth;
		}
		return padToWidth(clipped, clippedWidth, maxWidth);
	}

	const targetWidth = maxWidth - ellipsisWidth;
	let result = "";
	let keptWidth = 0;
	for (const { segment } of getGraphemeSegmenter().segment(text)) {
		const segmentWidth = visibleWidth(segment);
		if (keptWidth + segmentWidth > targetWidth) {
			break;
		}
		result += segment;
		keptWidth += segmentWidth;
	}
	return padToWidth(`${result}${ELLIPSIS}`, keptWidth + ellipsisWidth, maxWidth);
}

/**
 * Render a notice as a single truncated terminal line.
 * `code` is displayed as an opaque input value. This function does not start or control a worker.
 */
export function renderTuiNotice(notice: TuiNotice | null, width: number): string[] {
	if (notice == null) {
		return [];
	}

	const maxWidth = Math.trunc(width);
	if (!Number.isFinite(maxWidth) || maxWidth <= 0) {
		return [];
	}

	const level = flattenDisplayText(notice.level);
	const code = flattenDisplayText(notice.code);
	const message = flattenDisplayText(notice.message);
	const text = `[${level}] ${code}  ${message}`;
	return [truncateDisplayLine(text, maxWidth)];
}
