import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, errorMessage, postRaw } from "../../../core/api";
import { getNativeBridge } from "../../../core/nativeBridge";
import { toast } from "../../../ui";

export function useVoiceInput({
	onTranscribed,
}: {
	onTranscribed: (text: string) => void;
}) {
	const [recording, setRecording] = useState(false);
	const [transcribing, setTranscribing] = useState(false);
	const mediaRecorderRef = useRef<MediaRecorder | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const chunksRef = useRef<Blob[]>([]);
	const nativeRecordingRef = useRef(false);
	const alive = useRef(false);
	const generation = useRef(0);
	const busy = useRef(false);
	const transcription = useRef<AbortController | null>(null);
	const callback = useRef(onTranscribed);
	callback.current = onTranscribed;
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
			generation.current++;
			transcription.current?.abort();
			if (nativeRecordingRef.current) {
				nativeRecordingRef.current = false;
				void getNativeBridge()?.audio?.cancelRecording().catch(() => {});
			}
			const recorder = mediaRecorderRef.current;
			if (recorder) {
				recorder.onstop = null;
				recorder.ondataavailable = null;
				if (recorder.state !== "inactive") recorder.stop();
			}
			for (const track of streamRef.current?.getTracks() ?? []) track.stop();
			streamRef.current = null;
			mediaRecorderRef.current = null;
			chunksRef.current = [];
			busy.current = false;
		};
	}, []);

	const stopRecording = useCallback(() => {
		const nativeAudio = getNativeBridge()?.audio;
		if (nativeAudio && nativeRecordingRef.current) {
			nativeRecordingRef.current = false;
			busy.current = true;
			setRecording(false);
			setTranscribing(true);
			const epoch = generation.current;
			const current = () => alive.current && generation.current === epoch;
			void (async () => {
				try {
					const data = await nativeAudio.stopAndTranscribe();
					if (!current()) return;
					const text = typeof data?.text === "string" ? data.text.trim() : "";
					if (text) {
						callback.current(text);
						toast("语音识别成功", { kind: "success" });
					} else {
						toast("未识别到清晰语音，请重试");
					}
				} catch (err) {
					if (current()) toast(`语音识别失败：${errorMessage(err)}`, { kind: "error" });
				} finally {
					if (current()) {
						busy.current = false;
						setTranscribing(false);
					}
				}
			})();
			return;
		}
		if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
			busy.current = true;
			mediaRecorderRef.current.stop();
		}
		if (streamRef.current) {
			streamRef.current.getTracks().forEach((track) => track.stop());
			streamRef.current = null;
		}
		setRecording(false);
	}, []);

	const startRecording = useCallback(async () => {
		if (!alive.current || busy.current || nativeRecordingRef.current || mediaRecorderRef.current?.state === "recording") return;
		const nativeAudio = getNativeBridge()?.audio;
		if (nativeAudio) {
			busy.current = true;
			const epoch = generation.current;
			const current = () => alive.current && generation.current === epoch;
			try {
				await nativeAudio.startRecording();
				if (!current()) {
					void nativeAudio.cancelRecording().catch(() => {});
					return;
				}
				nativeRecordingRef.current = true;
				busy.current = false;
				setRecording(true);
			} catch (err: unknown) {
				if (!current()) return;
				nativeRecordingRef.current = false;
				busy.current = false;
				setRecording(false);
				const e = err as { name?: string; message?: string };
				if (e.name === "NotAllowedError" || e.name === "PermissionDeniedError") {
					toast("麦克风权限被拒绝，请在系统或浏览器设置中允许", { kind: "error" });
				} else {
					toast(`无法启动麦克风录音：${errorMessage(err)}`, { kind: "error" });
				}
			}
			return;
		}
		if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
			toast("当前环境不支持录音（需安全上下文 HTTPS 或 localhost）", { kind: "error" });
			return;
		}

		busy.current = true;
		const epoch = generation.current;
		const current = () => alive.current && generation.current === epoch;
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			if (!current()) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			streamRef.current = stream;
			chunksRef.current = [];

			const mimeTypes = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg", "audio/wav"];
			const mimeType =
				typeof MediaRecorder !== "undefined"
					? mimeTypes.find((t) => typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported(t)) || ""
					: "";

			const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
			mediaRecorderRef.current = recorder;

			recorder.ondataavailable = (e) => {
				if (e.data && e.data.size > 0) {
					chunksRef.current.push(e.data);
				}
			};

			recorder.onstop = async () => {
				if (!current()) return;
				const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || "audio/webm" });
				chunksRef.current = [];
				if (blob.size === 0) { busy.current = false; return; }
				const ctl = new AbortController();
				transcription.current = ctl;
				busy.current = true;

				setTranscribing(true);
				try {
					const data = await postRaw<{ text?: string }>(
						"/voice/transcribe",
						blob,
						blob.type || "audio/webm",
						{ signal: ctl.signal },
					);
					if (!current() || ctl.signal.aborted) return;
					const text = typeof data?.text === "string" ? data.text.trim() : "";
					if (text) {
						callback.current(text);
						toast("语音识别成功", { kind: "success" });
					} else {
						toast("未识别到清晰语音，请重试");
					}
				} catch (err) {
					if (current() && !ctl.signal.aborted) {
						const detail =
							err instanceof ApiError && err.status >= 400 && err.status !== 401 && err.message === `HTTP ${err.status}`
								? `语音识别服务响应异常 (${err.status})`
								: errorMessage(err);
						toast(`语音识别失败：${detail}`, { kind: "error" });
					}
				} finally {
					if (current()) { busy.current = false; transcription.current = null; setTranscribing(false); }
				}
			};

			recorder.start();
			busy.current = false;
			setRecording(true);
		} catch (err: unknown) {
			if (!current()) return;
			for (const track of streamRef.current?.getTracks() ?? []) track.stop();
			streamRef.current = null;
			mediaRecorderRef.current = null;
			busy.current = false;
			const e = err as { name?: string; message?: string };
			if (e.name === "NotAllowedError" || e.name === "PermissionDeniedError") {
				toast("麦克风权限被拒绝，请在系统或浏览器设置中允许", { kind: "error" });
			} else if (e.name === "NotFoundError" || e.name === "DevicesNotFoundError") {
				toast("未检测到可用的麦克风设备", { kind: "error" });
			} else {
				toast(`无法启动麦克风录音：${errorMessage(err)}`, { kind: "error" });
			}
		}
	}, []);

	const toggleRecording = useCallback(async () => {
		if (nativeRecordingRef.current || mediaRecorderRef.current?.state === "recording") {
			stopRecording();
		} else {
			await startRecording();
		}
	}, [startRecording, stopRecording]);

	return {
		recording,
		transcribing,
		toggleRecording,
		stopRecording,
	};
}
