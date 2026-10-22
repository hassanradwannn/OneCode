#!/usr/bin/env python3
"""Local-only Linux dictation helper for OneCode.

Audio is read from the default PulseAudio/PipeWire source as 16 kHz mono PCM and fed directly
to PocketSphinx in memory. No audio file is created and raw audio is never written to stdout.
Stdout is reserved for OneCode's bounded JSON-line DictationEvent protocol.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import select
import shutil
import subprocess
import sys
from pathlib import Path


def emit(payload: dict[str, object]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def parent_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def runtime_root(value: str | None) -> Path | None:
    candidates = [value, os.environ.get("ONECODE_DICTATION_RUNTIME")]
    sibling = Path(__file__).resolve().parent / "runtime"
    if sibling.is_dir():
        candidates.append(str(sibling))
    for candidate in candidates:
        if not candidate:
            continue
        root = Path(candidate).resolve()
        if not root.is_dir():
            raise RuntimeError("Bundled Linux speech recognition runtime is missing. Reinstall OneCode.")
        return root
    return None


def activate_runtime(root: Path | None) -> None:
    if root is None:
        return
    python = root / "python"
    lib = root / "lib"
    manifest = root / "runtime.json"
    if not python.is_dir() or not lib.is_dir() or not manifest.is_file():
        raise RuntimeError("Bundled Linux speech recognition runtime is incomplete. Reinstall OneCode.")
    # Load the exact private libraries before importing the CPython extension.  This avoids
    # depending on a system python3-pocketsphinx installation or a global LD_LIBRARY_PATH.
    try:
        ctypes.CDLL(str(lib / "libsphinxbase.so.3"), mode=ctypes.RTLD_GLOBAL)
        ctypes.CDLL(str(lib / "libpocketsphinx.so.3"), mode=ctypes.RTLD_GLOBAL)
    except OSError as error:
        raise RuntimeError("Bundled Linux speech recognition libraries could not load on this system.") from error
    sys.path.insert(0, str(python))


def model_files(runtime: Path | None) -> tuple[str, str, str]:
    if runtime is not None:
        roots = [runtime / "model" / "en-us"]
    else:
        roots = [
            Path("/usr/share/pocketsphinx/model/en-us"),
            Path("/usr/local/share/pocketsphinx/model/en-us"),
        ]
    for candidate in roots:
        hmm = candidate / "en-us"
        lm = candidate / "en-us.lm.bin"
        dictionary = candidate / "cmudict-en-us.dict"
        if hmm.is_dir() and lm.is_file() and dictionary.is_file():
            return str(hmm), str(lm), str(dictionary)
    if runtime is not None:
        raise RuntimeError("Bundled PocketSphinx English model is incomplete. Reinstall OneCode.")
    raise RuntimeError("PocketSphinx English model is missing. Install the pocketsphinx-en-us package for a source checkout.")


def make_decoder(root: Path | None):
    activate_runtime(root)
    try:
        from pocketsphinx import Decoder
    except Exception as error:  # pragma: no cover - exact import text varies by distro build
        if root is not None:
            raise RuntimeError("Bundled PocketSphinx requires the Ubuntu 22.04 Python 3.10 ABI. Reinstall OneCode or use a supported Linux build.") from error
        raise RuntimeError("PocketSphinx is missing. Install python3-pocketsphinx and pocketsphinx-en-us for a source checkout.") from error

    hmm, lm, dictionary = model_files(root)
    config = Decoder.default_config()
    config.set_string("-hmm", hmm)
    config.set_string("-lm", lm)
    config.set_string("-dict", dictionary)
    config.set_string("-logfn", os.devnull)
    config.set_float("-samprate", 16000.0)
    return Decoder(config)


def capture_command() -> list[str]:
    parec = shutil.which("parec")
    if not parec:
        raise RuntimeError("Microphone capture is unavailable. Install pulseaudio-utils (parec).")
    return [parec, "--raw", "--rate=16000", "--format=s16le", "--channels=1"]


def run(parent_pid: int, stop_file: str, root: Path | None) -> int:
    decoder = make_decoder(root)
    command = capture_command()
    capture: subprocess.Popen[bytes] | None = None
    listening = False
    last_partial = ""
    try:
        if not parent_alive(parent_pid):
            return 0
        capture = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
        if capture.stdout is None:
            raise RuntimeError("Microphone capture did not provide an audio stream.")
        os.set_blocking(capture.stdout.fileno(), False)
        decoder.start_utt()
        emit({"type": "status", "status": "listening", "engine": "pocketsphinx"})
        while parent_alive(parent_pid) and not os.path.exists(stop_file):
            if capture.poll() is not None:
                raise RuntimeError("Microphone capture stopped unexpectedly.")
            readable, _, _ = select.select([capture.stdout], [], [], 0.25)
            if not readable:
                continue
            chunk = os.read(capture.stdout.fileno(), 4096)
            if not chunk:
                continue
            decoder.process_raw(chunk, False, False)
            now_listening = bool(decoder.get_in_speech())
            hypothesis = decoder.hyp()
            text = hypothesis.hypstr.strip() if hypothesis and hypothesis.hypstr else ""
            if text and text != last_partial:
                last_partial = text
                emit({"type": "partial", "text": text})
            if listening and not now_listening:
                decoder.end_utt()
                hypothesis = decoder.hyp()
                text = hypothesis.hypstr.strip() if hypothesis and hypothesis.hypstr else ""
                if text:
                    emit({"type": "final", "text": text})
                decoder.start_utt()
                last_partial = ""
            listening = now_listening

        decoder.end_utt()
        hypothesis = decoder.hyp()
        text = hypothesis.hypstr.strip() if hypothesis and hypothesis.hypstr else ""
        if text:
            emit({"type": "final", "text": text})
        return 0
    finally:
        if capture is not None and capture.poll() is None:
            capture.terminate()
            try:
                capture.wait(timeout=1.5)
            except subprocess.TimeoutExpired:
                capture.kill()
                capture.wait(timeout=1.0)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--parent-pid", type=int)
    parser.add_argument("--stop-file")
    parser.add_argument("--runtime-root")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    root = runtime_root(args.runtime_root)
    if args.check:
        make_decoder(root)
        capture_command()
        emit({"ok": True, "engine": "pocketsphinx", "audio": "parec", "runtime": "bundled" if root else "system"})
        return 0
    if not args.parent_pid or not args.stop_file or not os.path.isabs(args.stop_file):
        raise RuntimeError("Dictation helper requires an absolute stop file and parent PID.")
    return run(args.parent_pid, args.stop_file, root)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception as error:
        emit({"type": "error", "message": str(error)[:240] or "Linux speech recognition failed"})
        emit({"type": "status", "status": "stopped"})
        raise SystemExit(1)
