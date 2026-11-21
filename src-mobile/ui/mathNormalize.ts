/**
 * Zero-dependency CommonMark-aware math normalizer for remark-math.
 *
 * - balanced `$$…$$` (no blank line inside) → fenced block on its own lines
 * - a lone `$$` (unclosed, e.g. mid-stream) → escaped, shown as text
 * - CommonMark fenced code blocks, indented code blocks (including inside blockquotes and lists),
 *   and inline code spans stay byte-for-byte intact
 * - single-dollar spans follow the pandoc rule — opening `$` not followed by whitespace,
 *   closing `$` not preceded by whitespace and not followed by a digit — and become inline `$$…$$`.
 *   Single-dollar math is off globally in remark-math so `$5 and $6` / `$5-$10` stay prose.
 */

const MATH_RE = /\$\$((?:(?!\n[ \t]*\n)[\s\S])+?)\$\$|\$\$/g;
const INLINE_RE = /(?<![$\\])\$(?![\s$])((?:\\.|[^$\n\\])+?)(?<![\s\\])\$(?![$\d])/g;

interface Range {
	from: number;
	to: number;
}

interface Cursor {
	pos: number;
	col: number;
	/** Virtual spaces remaining from a partially consumed tab character. */
	pad: number;
}

type Container = { kind: "quote" } | { kind: "list"; indent: number };

type LeafBlock =
	| { kind: "paragraph" }
	| { kind: "fenced"; char: "`" | "~"; len: number; depth: number; start: number; end: number }
	| { kind: "indented"; depth: number; start: number; end: number };

function normalizeSegment(segment: string): string {
	if (!segment.includes("$")) return segment;
	const display = segment.replace(MATH_RE, (match, body: string | undefined) => {
		if (body !== undefined) return `\n\n$$\n${body.trim()}\n$$\n\n`;
		return match.startsWith("$$") ? "\\$\\$" : match;
	});
	return display.replace(INLINE_RE, (match, body: string | undefined) =>
		body !== undefined ? `$$${body}$$` : match,
	);
}

function peekIndent(text: string, end: number, cur: Cursor): { cols: number; nextPos: number; blank: boolean } {
	let cols = cur.pad;
	let p = cur.pos;
	let col = cur.col + cur.pad;
	while (p < end) {
		const ch = text.charCodeAt(p);
		if (ch === 32) {
			cols++;
			col++;
			p++;
		} else if (ch === 9) {
			const w = 4 - (col % 4);
			cols += w;
			col += w;
			p++;
		} else {
			return { cols, nextPos: p, blank: false };
		}
	}
	return { cols, nextPos: p, blank: true };
}

function consumeCols(text: string, end: number, cur: Cursor, maxCols: number): number {
	let taken = 0;
	if (cur.pad > 0) {
		const use = Math.min(cur.pad, maxCols);
		cur.pad -= use;
		cur.col += use;
		taken += use;
	}
	while (taken < maxCols && cur.pos < end) {
		const ch = text.charCodeAt(cur.pos);
		if (ch === 32) {
			cur.pos++;
			cur.col++;
			taken++;
		} else if (ch === 9) {
			const w = 4 - (cur.col % 4);
			const use = Math.min(w, maxCols - taken);
			cur.pos++;
			cur.col += use;
			cur.pad = w - use;
			taken += use;
		} else {
			break;
		}
	}
	return taken;
}

function isSpaceOrTab(ch: number): boolean {
	return ch === 32 || ch === 9;
}

function isThematicBreak(text: string, pos: number, end: number): boolean {
	if (pos >= end) return false;
	const marker = text.charCodeAt(pos);
	if (marker !== 42 && marker !== 45 && marker !== 95) return false; // * - _
	let count = 0;
	for (let p = pos; p < end; p++) {
		const ch = text.charCodeAt(p);
		if (ch === marker) count++;
		else if (!isSpaceOrTab(ch)) return false;
	}
	return count >= 3;
}

function isAtxHeading(text: string, pos: number, end: number): boolean {
	let hashes = 0;
	let p = pos;
	while (p < end && text.charCodeAt(p) === 35 && hashes < 7) {
		hashes++;
		p++;
	}
	return hashes >= 1 && hashes <= 6 && (p === end || isSpaceOrTab(text.charCodeAt(p)));
}

function matchFenceOpener(text: string, pos: number, end: number): { char: "`" | "~"; len: number } | null {
	if (pos >= end) return null;
	const ch = text.charCodeAt(pos);
	if (ch !== 96 && ch !== 126) return null; // ` or ~
	let p = pos;
	while (p < end && text.charCodeAt(p) === ch) p++;
	const len = p - pos;
	if (len < 3) return null;
	if (ch === 96) {
		// CommonMark: backtick fence info strings cannot contain backticks.
		for (let i = p; i < end; i++) {
			if (text.charCodeAt(i) === 96) return null;
		}
	}
	return { char: ch === 96 ? "`" : "~", len };
}

function isFenceCloser(text: string, pos: number, end: number, char: "`" | "~", minLen: number): boolean {
	if (pos >= end) return false;
	const target = char.charCodeAt(0);
	let p = pos;
	while (p < end && text.charCodeAt(p) === target) p++;
	if (p - pos < minLen) return false;
	while (p < end) {
		if (!isSpaceOrTab(text.charCodeAt(p))) return false;
		p++;
	}
	return true;
}

interface ListMarkerMatch {
	markerLen: number;
	ordered: boolean;
	isOne: boolean;
}

function matchListMarker(text: string, pos: number, end: number): ListMarkerMatch | null {
	if (pos >= end) return null;
	const ch = text.charCodeAt(pos);
	if (ch === 45 || ch === 43 || ch === 42) {
		// - + *
		const next = pos + 1;
		if (next === end || isSpaceOrTab(text.charCodeAt(next))) {
			return { markerLen: 1, ordered: false, isOne: false };
		}
		return null;
	}
	if (ch >= 48 && ch <= 57) {
		let p = pos;
		while (p < end && p - pos < 9 && text.charCodeAt(p) >= 48 && text.charCodeAt(p) <= 57) p++;
		if (p === end) return null;
		const delim = text.charCodeAt(p);
		if (delim !== 46 && delim !== 41) return null; // . or )
		const after = p + 1;
		if (after === end || isSpaceOrTab(text.charCodeAt(after))) {
			return {
				markerLen: after - pos,
				ordered: true,
				isOne: p - pos === 1 && ch === 49,
			};
		}
	}
	return null;
}

function canInterruptParagraph(text: string, pos: number, end: number): boolean {
	if (pos >= end) return true;
	const ch = text.charCodeAt(pos);
	if (ch === 62) return true; // >
	if (isThematicBreak(text, pos, end)) return true;
	if (isAtxHeading(text, pos, end)) return true;
	if (matchFenceOpener(text, pos, end)) return true;
	const list = matchListMarker(text, pos, end);
	if (list) {
		// CommonMark: empty list items and ordered lists not starting at 1 cannot interrupt paragraphs.
		if (list.ordered && !list.isOne) return false;
		let p = pos + list.markerLen;
		while (p < end && isSpaceOrTab(text.charCodeAt(p))) p++;
		return p < end;
	}
	return false;
}

/** Collect CommonMark fenced & indented code block ranges across containers (quotes & lists). */
function collectCodeBlockRanges(text: string): Range[] {
	const ranges: Range[] = [];
	const containers: Container[] = [];
	let leaf: LeafBlock | null = null;

	const closeLeaf = () => {
		if (leaf && (leaf.kind === "fenced" || leaf.kind === "indented")) {
			ranges.push({ from: leaf.start, to: leaf.end });
		}
		leaf = null;
	};

	let pos = 0;
	while (pos < text.length) {
		const lineStart = pos;
		const nl = text.indexOf("\n", pos);
		const lineEnd = nl === -1 ? text.length : nl + 1;
		const contentEnd = nl === -1 ? text.length : nl > lineStart && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
		pos = lineEnd;

		const cur: Cursor = { pos: lineStart, col: 0, pad: 0 };
		const matchLimit = leaf && (leaf.kind === "fenced" || leaf.kind === "indented") ? leaf.depth : containers.length;
		let matched = 0;

		for (let k = 0; k < matchLimit; k++) {
			const c = containers[k];
			const info = peekIndent(text, contentEnd, cur);
			if (c.kind === "quote") {
				if (!info.blank && info.cols <= 3 && text.charCodeAt(info.nextPos) === 62) {
					consumeCols(text, contentEnd, cur, info.cols);
					cur.pos++; // '>'
					cur.col++;
					if (cur.pos < contentEnd && isSpaceOrTab(text.charCodeAt(cur.pos))) {
						consumeCols(text, contentEnd, cur, 1);
					}
					matched++;
				} else {
					break;
				}
			} else {
				if (info.blank) {
					matched++;
				} else if (info.cols >= c.indent) {
					consumeCols(text, contentEnd, cur, c.indent);
					matched++;
				} else {
					break;
				}
			}
		}

		// Handle active fenced code block.
		if (leaf?.kind === "fenced") {
			if (matched < leaf.depth) {
				closeLeaf();
				containers.length = matched;
			} else {
				const info = peekIndent(text, contentEnd, cur);
				if (!info.blank && info.cols <= 3 && isFenceCloser(text, info.nextPos, contentEnd, leaf.char, leaf.len)) {
					leaf.end = contentEnd;
					closeLeaf();
					containers.length = matched;
					continue;
				}
				leaf.end = contentEnd;
				continue;
			}
		}

		// Handle active indented code block.
		if (leaf?.kind === "indented") {
			if (matched < leaf.depth) {
				closeLeaf();
				containers.length = matched;
			} else {
				const info = peekIndent(text, contentEnd, cur);
				if (info.blank) {
					continue;
				}
				if (info.cols >= 4) {
					leaf.end = contentEnd;
					continue;
				}
				closeLeaf();
				containers.length = matched;
			}
		}

		// No active code leaf: handle container closure & new block openers.
		const peekAfterMatch = peekIndent(text, contentEnd, cur);
		if (peekAfterMatch.blank) {
			containers.length = matched;
			leaf = null;
			continue;
		}

		if (matched < containers.length) {
			if (leaf?.kind !== "paragraph") {
				containers.length = matched;
			} else if (peekAfterMatch.cols <= 3 && canInterruptParagraph(text, peekAfterMatch.nextPos, contentEnd)) {
				containers.length = matched;
				leaf = null;
			}
		}

		// Open nested containers and/or a new leaf block on this line.
		while (true) {
			const info = peekIndent(text, contentEnd, cur);
			if (info.blank) {
				leaf = null;
				break;
			}

			// Indented code block (cannot interrupt a paragraph).
			if (info.cols >= 4 && leaf?.kind !== "paragraph") {
				leaf = { kind: "indented", depth: containers.length, start: cur.pos, end: contentEnd };
				break;
			}

			if (info.cols <= 3) {
				const ch = text.charCodeAt(info.nextPos);

				// Blockquote opener.
				if (ch === 62) {
					leaf = null;
					consumeCols(text, contentEnd, cur, info.cols);
					cur.pos++; // '>'
					cur.col++;
					if (cur.pos < contentEnd && isSpaceOrTab(text.charCodeAt(cur.pos))) {
						consumeCols(text, contentEnd, cur, 1);
					}
					containers.push({ kind: "quote" });
					continue;
				}

				// Fenced code opener.
				const fence = matchFenceOpener(text, info.nextPos, contentEnd);
				if (fence) {
					leaf = {
						kind: "fenced",
						char: fence.char,
						len: fence.len,
						depth: containers.length,
						start: info.nextPos,
						end: contentEnd,
					};
					break;
				}

				// Thematic break (must precede unordered list marker check).
				if (isThematicBreak(text, info.nextPos, contentEnd)) {
					leaf = null;
					break;
				}

				// ATX heading.
				if (isAtxHeading(text, info.nextPos, contentEnd)) {
					leaf = null;
					break;
				}

				// List item opener.
				const list = matchListMarker(text, info.nextPos, contentEnd);
				if (list) {
					const afterMarkerStart = info.nextPos + list.markerLen;
					const afterCur: Cursor = {
						pos: afterMarkerStart,
						col: cur.col + info.cols + list.markerLen,
						pad: 0,
					};
					const post = peekIndent(text, contentEnd, afterCur);
					const canStart =
						leaf?.kind !== "paragraph" || (!post.blank && (!list.ordered || list.isOne));
					if (canStart) {
						leaf = null;
						const baseCol = cur.col;
						consumeCols(text, contentEnd, cur, info.cols);
						cur.pos += list.markerLen;
						cur.col += list.markerLen;
						const extraCols = post.blank || post.cols > 4 ? 1 : post.cols;
						if (!post.blank) consumeCols(text, contentEnd, cur, extraCols);
						const itemIndent = cur.col - baseCol + (post.blank ? 1 : 0);
						containers.push({ kind: "list", indent: itemIndent });
						continue;
					}
				}
			}

			leaf = { kind: "paragraph" };
			break;
		}
	}

	closeLeaf();
	return ranges;
}

/** Find the end of the current paragraph starting from `from` (stops at a blank line, including blank quote lines). */
function findParagraphEnd(segment: string, from: number): number {
	let p = from;
	while (p < segment.length) {
		const nl = segment.indexOf("\n", p);
		if (nl === -1) return segment.length;
		let line = nl + 1;
		while (line < segment.length) {
			const ch = segment.charCodeAt(line);
			if (ch === 32 || ch === 9 || ch === 62) {
				line++;
			} else {
				break;
			}
		}
		if (line >= segment.length) return nl;
		const nextCh = segment.charCodeAt(line);
		if (nextCh === 10 || nextCh === 13) return nl;
		p = nl + 1;
	}
	return segment.length;
}

function isEscaped(segment: string, pos: number): boolean {
	let slashes = 0;
	for (let i = pos - 1; i >= 0 && segment.charCodeAt(i) === 92; i--) slashes++;
	return (slashes & 1) === 1;
}

/** Normalize prose while keeping CommonMark inline backtick code spans byte-for-byte intact. */
function normalizeProse(segment: string): string {
	if (!segment.includes("$")) return segment;
	if (!segment.includes("`")) return normalizeSegment(segment);

	let out = "";
	let proseStart = 0;
	let i = 0;
	while (i < segment.length) {
		const open = segment.indexOf("`", i);
		if (open === -1) break;
		if (isEscaped(segment, open)) {
			i = open + 1;
			continue;
		}
		let openEnd = open;
		while (openEnd < segment.length && segment.charCodeAt(openEnd) === 96) openEnd++;
		const tickLen = openEnd - open;
		const limit = findParagraphEnd(segment, openEnd);

		let closeEnd = -1;
		let search = openEnd;
		while (search < limit) {
			const hit = segment.indexOf("`", search);
			if (hit === -1 || hit >= limit) break;
			let runEnd = hit;
			while (runEnd < limit && segment.charCodeAt(runEnd) === 96) runEnd++;
			if (runEnd - hit === tickLen) {
				closeEnd = runEnd;
				break;
			}
			search = runEnd;
		}

		if (closeEnd !== -1) {
			out += normalizeSegment(segment.slice(proseStart, open));
			out += segment.slice(open, closeEnd);
			proseStart = closeEnd;
			i = closeEnd;
		} else {
			i = openEnd;
		}
	}

	return out + normalizeSegment(segment.slice(proseStart));
}

export function normalizeMath(text: string): string {
	if (!text.includes("$")) return text;
	// Without a code delimiter, tab, or four spaces, CommonMark cannot contain code.
	if (!/[`~\t]| {4}/.test(text)) return normalizeSegment(text);

	const blocks = collectCodeBlockRanges(text);
	if (blocks.length === 0) return normalizeProse(text);

	let out = "";
	let cursor = 0;
	for (const block of blocks) {
		out += normalizeProse(text.slice(cursor, block.from));
		out += text.slice(block.from, block.to);
		cursor = block.to;
	}
	return out + normalizeProse(text.slice(cursor));
}
