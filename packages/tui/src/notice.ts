import { flattenDisplayText, truncateDisplayLine } from "./display-text.ts";

export type TuiNoticeLevel = "info" | "warning" | "error";

/** Presentation-safe notice value. Callers own lifecycle; TUI only displays it. */
export interface TuiNotice {
	readonly level: TuiNoticeLevel;
	readonly code: string;
	readonly message: string;
	readonly timestamp: number;
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
