/** CodeMirror editor for the right-panel file preview (lazy: keeps CM out of
 * the initial bundle; the panel only needs it after the user picks 编辑). */

import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { useIsDark } from "../../lib/theme";

interface FileEditorProps {
	path: string;
	value: string;
	onChange: (value: string) => void;
}

export default function FileEditor({ path, value, onChange }: FileEditorProps) {
	const isDark = useIsDark();
	const isMarkdown = /\.(md|markdown|mdx)$/i.test(path);
	return (
		<CodeMirror
			value={value}
			onChange={onChange}
			extensions={isMarkdown ? [markdown()] : []}
			theme={isDark ? "dark" : "light"}
			height="100%"
			style={{ height: "100%" }}
			basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true }}
		/>
	);
}
