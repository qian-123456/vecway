/** Pure terminal helpers: key sequences, SSE chunk decoding, reconnect policy, input batching. */

export interface KeySpec {
	id: string;
	label: string;
	seq: string;
}

/** On-screen key bar, in display order (the sticky Ctrl modifier is rendered after Esc). */
export const TERMINAL_KEYS: readonly KeySpec[] = [
	{ id: "tab", label: "Tab", seq: "\t" },
	{ id: "esc", label: "Esc", seq: "\x1b" },
	{ id: "left", label: "←", seq: "\x1b[D" },
	{ id: "up", label: "↑", seq: "\x1b[A" },
	{ id: "down", label: "↓", seq: "\x1b[B" },
	{ id: "right", label: "→", seq: "\x1b[C" },
	{ id: "ctrl-c", label: "Ctrl+C", seq: "\x03" },
	{ id: "ctrl-d", label: "Ctrl+D", seq: "\x04" },
	{ id: "enter", label: "Enter", seq: "\r" },
];

/** Control-code for `Ctrl+<ch>`; null when the character has no control mapping. */
export function ctrlSequence(ch: string): string | null {
	if (ch.length !== 1) return null;
	const c = ch.charCodeAt(0);
	if (c >= 0x61 && c <= 0x7a) return String.fromCharCode(c - 0x60); // a-z
	if (c >= 0x41 && c <= 0x5a) return String.fromCharCode(c - 0x40); // A-Z
	if (c >= 0x5b && c <= 0x5f) return String.fromCharCode(c - 0x40); // [ \ ] ^ _
	if (ch === " " || ch === "@") return "\x00";
	if (ch === "?") return "\x7f";
	return null;
}

/**
 * Apply the sticky Ctrl modifier to typed data. Only a single typed character is
 * transformed (IME/paste strings pass through untouched).
 */
export function applyCtrl(data: string, ctrl: boolean): { data: string; consumed: boolean } {
	if (!ctrl) return { data, consumed: false };
	const seq = ctrlSequence(data);
	return seq === null ? { data, consumed: false } : { data: seq, consumed: true };
}

/** Decode one base64 `data` SSE payload into bytes. Throws on malformed input. */
export function decodeChunk(b64: string): Uint8Array {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

/** Parse the `exit` SSE payload; `null` = process ended without a code. */
export function parseExit(raw: string): number | null {
	try {
		const code = (JSON.parse(raw) as { code?: unknown }).code;
		return typeof code === "number" ? code : null;
	} catch {
		return null;
	}
}

export const MAX_RETRIES = 5;

/** Delay before reconnect attempt `attempt` (1-based); null once retries are exhausted. */
export function reconnectDelay(attempt: number): number | null {
	return attempt > MAX_RETRIES ? null : 1500 * attempt;
}

/** Terminal-limit error text from the server (429 "最多同时…"). */
export function isTerminalLimit(message: string): boolean {
	return /最多同时/.test(message);
}

/** The PTY is gone (reaped after the detach grace period or closed). */
export function isTerminalGone(status: number): boolean {
	return status === 404 || status === 410;
}

/**
 * Serialises input to the server: data pushed while a request is in flight is
 * concatenated and sent in the next request, preserving order.
 */
export class InputQueue {
	private pending = "";
	private busy = false;
	constructor(
		private readonly send: (data: string) => Promise<unknown>,
		private readonly onError: (e: unknown) => void,
	) {}
	push(data: string): void {
		this.pending += data;
		if (!this.busy) void this.drain();
	}
	clear(): void {
		this.pending = "";
	}
	private async drain(): Promise<void> {
		this.busy = true;
		try {
			while (this.pending) {
				const data = this.pending;
				this.pending = "";
				try {
					await this.send(data);
				} catch (e) {
					this.onError(e);
				}
			}
		} finally {
			this.busy = false;
		}
	}
}

export interface TerminalBlock {
	id: string;
	text: string;
	command?: string;
	lineCount: number;
}

// ANSI CSI, OSC, 2-byte ESC, and carriage-return/control cleanup for readable block capture.
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_ESC_RE = /\x1b[@-Z\\-_]/g;
const CTRL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Strip ANSI escape sequences and normalize carriage-return line overwrites into clean text. */
export function stripAnsi(raw: string): string {
	const noEsc = raw
		.replace(ANSI_OSC_RE, "")
		.replace(ANSI_CSI_RE, "")
		.replace(ANSI_ESC_RE, "")
		.replace(/\r\n/g, "\n");
	const lines = noEsc.split("\n").map((line) => {
		if (!line.includes("\r")) return line;
		const parts = line.split("\r");
		for (let i = parts.length - 1; i >= 0; i--) {
			if (parts[i] !== "") return parts[i];
		}
		return "";
	});
	return lines.join("\n").replace(CTRL_CHAR_RE, "");
}

const PROMPT_PATTERNS = [
	// Common shell prompts with a command after %, $, #, >, ❯, ➜, λ
	/^(?:[^\s].*?\s)?(?:[$#%]|[❯➜λ])\s+(\S.*)$/,
	/^(?:[❯➜λ]|[$#%])\s+(\S.*)$/,
];

const BARE_PROMPT_RE = /^(?:(?:[^\s].*?\s)?(?:[$#%]|[❯➜λ]))\s*$/;

function matchPromptCommand(line: string): string | null {
	const trimmed = line.trimEnd();
	if (!trimmed) return null;
	for (const re of PROMPT_PATTERNS) {
		const m = trimmed.match(re);
		if (m && m[1]) return m[1].trim();
	}
	return null;
}

/**
 * Segment stripped terminal text into indivisible command/output unit blocks.
 * Commands and their entire output (including blank lines inside output) remain one atomic block
 * until the next shell prompt; streams without prompts split cleanly at blank-line boundaries.
 */
export function segmentTerminalBlocks(text: string, maxBlocks = 60): TerminalBlock[] {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const blocks: Array<{ lines: string[]; command?: string; hasPrompt: boolean }> = [];
	let cur: { lines: string[]; command?: string; hasPrompt: boolean } | null = null;

	const flush = () => {
		if (!cur) return;
		let start = 0;
		let end = cur.lines.length;
		while (start < end && cur.lines[start].trim() === "") start++;
		while (end > start && (cur.lines[end - 1].trim() === "" || (!cur.hasPrompt && BARE_PROMPT_RE.test(cur.lines[end - 1])))) {
			end--;
		}
		// Also strip a trailing bare prompt line attached right before the next prompt.
		if (end > start && BARE_PROMPT_RE.test(cur.lines[end - 1])) {
			end--;
			while (end > start && cur.lines[end - 1].trim() === "") end--;
		}
		const sliced = cur.lines.slice(start, end);
		if (sliced.length > 0) {
			blocks.push({ lines: sliced, command: cur.command, hasPrompt: cur.hasPrompt });
		}
		cur = null;
	};

	for (const line of lines) {
		const cmd = matchPromptCommand(line);
		if (cmd !== null) {
			flush();
			cur = { lines: [line], command: cmd, hasPrompt: true };
			continue;
		}
		if (!cur) {
			if (line.trim() === "" || BARE_PROMPT_RE.test(line)) continue;
			cur = { lines: [line], hasPrompt: false };
			continue;
		}
		if (!cur.hasPrompt && line.trim() === "") {
			flush();
			continue;
		}
		cur.lines.push(line);
	}
	flush();

	const recent = blocks.length > maxBlocks ? blocks.slice(-maxBlocks) : blocks;
	return recent.map((b, idx) => ({
		id: `blk-${idx}`,
		text: b.lines.join("\n"),
		...(b.command ? { command: b.command } : {}),
		lineCount: b.lines.length,
	}));
}
