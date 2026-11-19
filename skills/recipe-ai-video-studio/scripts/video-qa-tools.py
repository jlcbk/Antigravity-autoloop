#!/usr/bin/env python3
"""
Zero-dependency AI Video QA & Post-Production Helper CLI (`video-qa-tools.py`).

Wraps system `ffmpeg` and `ffprobe` using only Python 3 standard library modules
to enforce deterministic visual quality gates before and after video generation:
  - `wireframe-grid` (`grid`): Overlay 38.2% / 61.8% golden-ratio guide lines.
  - `grayscale`: Convert frame/wireframe to pure luminance grayscale to check
    subject-vs-background value separation.
  - `mobile-preview` (`mobile`): Downscale frame to 360px mobile width preview.
  - `enforce-size`: Center-crop + Lanczos scale image to exact target WxH pixels.
  - `diff-frames` (`diff`): Verify 100% identical dimensions between first & last
    frames, compute SSIM/PSNR, and output an amplified pixel-difference image to
    catch unintended wall color shifts or static prop size drift.
  - `extract-cuts` (`cuts`): Decode full-resolution frames around every edit cut
    point (default: 3 frames before and 3 frames after each cut) for Stage 8
    zero-context blind review.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


def find_binary(name: str) -> str:
    extra_dirs = [
        str(Path.home() / ".local" / "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
    ]
    path_env = os.environ.get("PATH", "")
    search_path = os.pathsep.join([*extra_dirs, path_env])
    found = shutil.which(name, path=search_path)
    if not found:
        raise RuntimeError(
            f"Required binary '{name}' not found in PATH ({search_path})."
        )
    return found


def probe_media(target: Path) -> Dict[str, Any]:
    ffprobe = find_binary("ffprobe")
    cmd = [
        ffprobe,
        "-v",
        "error",
        "-show_entries",
        "stream=index,codec_type,width,height,r_frame_rate,nb_frames,duration:format=duration",
        "-of",
        "json",
        str(target),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return json.loads(res.stdout)


def get_video_dimensions_and_fps(target: Path) -> Tuple[int, int, float, float]:
    info = probe_media(target)
    streams = info.get("streams", [])
    vstream = next(
        (s for s in streams if s.get("codec_type") == "video"),
        streams[0] if streams else {},
    )
    width = int(vstream.get("width", 0))
    height = int(vstream.get("height", 0))
    fps_raw = str(vstream.get("r_frame_rate", "24/1"))
    if "/" in fps_raw:
        num, den = fps_raw.split("/", 1)
        fps = float(num) / float(den) if float(den) != 0 else 24.0
    else:
        fps = float(fps_raw or 24.0)
    duration = float(
        vstream.get("duration")
        or info.get("format", {}).get("duration")
        or 0.0
    )
    return width, height, fps, duration


def cmd_wireframe_grid(args: argparse.Namespace) -> int:
    ffmpeg = find_binary("ffmpeg")
    inp = Path(args.input).resolve()
    out = Path(args.output).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    width, height, _, _ = get_video_dimensions_and_fps(inp)
    x1 = round(width * 0.382)
    x2 = round(width * 0.618)
    y1 = round(height * 0.382)
    y2 = round(height * 0.618)
    thickness = max(2, round(min(width, height) * 0.0025))

    vf = ",".join(
        [
            f"drawbox=x={x1}:y=0:w={thickness}:h=ih:color=yellow@0.85:t=fill",
            f"drawbox=x={x2}:y=0:w={thickness}:h=ih:color=yellow@0.85:t=fill",
            f"drawbox=x=0:y={y1}:w=iw:h={thickness}:color=cyan@0.75:t=fill",
            f"drawbox=x=0:y={y2}:w=iw:h={thickness}:color=cyan@0.75:t=fill",
        ]
    )
    subprocess.run(
        [ffmpeg, "-y", "-v", "error", "-i", str(inp), "-vf", vf, "-frames:v", "1", str(out)],
        check=True,
    )

    result: Dict[str, Any] = {
        "ok": True,
        "command": "wireframe-grid",
        "input": str(inp),
        "output": str(out),
        "dimensions": {"width": width, "height": height},
        "goldenLines": {"x38": x1, "x62": x2, "y38": y1, "y62": y2},
    }

    if args.also_gray:
        gray_out = out.with_name(out.stem + "_gray" + out.suffix)
        subprocess.run(
            [
                ffmpeg,
                "-y",
                "-v",
                "error",
                "-i",
                str(inp),
                "-vf",
                "format=gray",
                "-frames:v",
                "1",
                str(gray_out),
            ],
            check=True,
        )
        result["grayscaleOutput"] = str(gray_out)

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def cmd_grayscale(args: argparse.Namespace) -> int:
    ffmpeg = find_binary("ffmpeg")
    inp = Path(args.input).resolve()
    out = Path(args.output).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    subprocess.run(
        [
            ffmpeg,
            "-y",
            "-v",
            "error",
            "-i",
            str(inp),
            "-vf",
            "format=gray",
            "-frames:v",
            "1",
            str(out),
        ],
        check=True,
    )

    stats_proc = subprocess.run(
        [
            ffmpeg,
            "-v",
            "info",
            "-i",
            str(out),
            "-vf",
            "signalstats,metadata=print:file=-",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    combined = stats_proc.stdout + "\n" + stats_proc.stderr
    ylow = _extract_float(combined, r"lavfi\.signalstats\.YLOW=([0-9.]+)")
    yavg = _extract_float(combined, r"lavfi\.signalstats\.YAVG=([0-9.]+)")
    yhigh = _extract_float(combined, r"lavfi\.signalstats\.YHIGH=([0-9.]+)")
    dynamic_span = (
        round(yhigh - ylow, 2)
        if (yhigh is not None and ylow is not None)
        else None
    )

    result = {
        "ok": True,
        "command": "grayscale",
        "input": str(inp),
        "output": str(out),
        "luminance": {
            "yLow10Pct": ylow,
            "yAvg": yavg,
            "yHigh90Pct": yhigh,
            "p10ToP90Span": dynamic_span,
            "lowContrastWarning": bool(
                dynamic_span is not None and dynamic_span < 45.0
            ),
        },
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def cmd_mobile_preview(args: argparse.Namespace) -> int:
    ffmpeg = find_binary("ffmpeg")
    inp = Path(args.input).resolve()
    out = Path(args.output).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    target_w = int(args.width)

    subprocess.run(
        [
            ffmpeg,
            "-y",
            "-v",
            "error",
            "-i",
            str(inp),
            "-vf",
            f"scale={target_w}:-2:flags=lanczos",
            "-frames:v",
            "1",
            str(out),
        ],
        check=True,
    )
    w, h, _, _ = get_video_dimensions_and_fps(out)
    print(
        json.dumps(
            {
                "ok": True,
                "command": "mobile-preview",
                "input": str(inp),
                "output": str(out),
                "previewDimensions": {"width": w, "height": h},
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def cmd_enforce_size(args: argparse.Namespace) -> int:
    ffmpeg = find_binary("ffmpeg")
    inp = Path(args.input).resolve()
    out = Path(args.output).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    m = re.match(r"^(\d+)x(\d+)$", args.size.strip().lower())
    if not m:
        raise ValueError("--size must look like WIDTHxHEIGHT, e.g. 1920x1080")
    tw, th = int(m.group(1)), int(m.group(2))

    vf = (
        f"scale={tw}:{th}:force_original_aspect_ratio=increase:flags=lanczos,"
        f"crop={tw}:{th}"
    )
    subprocess.run(
        [ffmpeg, "-y", "-v", "error", "-i", str(inp), "-vf", vf, "-frames:v", "1", str(out)],
        check=True,
    )
    print(
        json.dumps(
            {
                "ok": True,
                "command": "enforce-size",
                "input": str(inp),
                "output": str(out),
                "dimensions": {"width": tw, "height": th},
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def cmd_diff_frames(args: argparse.Namespace) -> int:
    ffmpeg = find_binary("ffmpeg")
    first = Path(args.first).resolve()
    last = Path(args.last).resolve()
    out = Path(args.output).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    w1, h1, _, _ = get_video_dimensions_and_fps(first)
    w2, h2, _, _ = get_video_dimensions_and_fps(last)
    same_size = (w1 == w2) and (h1 == h2)
    if not same_size:
        print(
            json.dumps(
                {
                    "ok": False,
                    "command": "diff-frames",
                    "error": "DIMENSION_MISMATCH",
                    "message": (
                        f"First frame ({w1}x{h1}) and last frame ({w2}x{h2}) "
                        "must have identical pixel dimensions before submission."
                    ),
                    "first": {"path": str(first), "width": w1, "height": h1},
                    "last": {"path": str(last), "width": w2, "height": h2},
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 2

    # Amplify per-pixel difference 3x so subtle wall color drift or prop resize stands out visually
    subprocess.run(
        [
            ffmpeg,
            "-y",
            "-v",
            "error",
            "-i",
            str(first),
            "-i",
            str(last),
            "-filter_complex",
            "[0:v]format=rgb24[a];[1:v]format=rgb24[b];[a][b]blend=all_mode=difference,lutrgb=r='clip(val*3,0,255)':g='clip(val*3,0,255)':b='clip(val*3,0,255)'",
            "-frames:v",
            "1",
            str(out),
        ],
        check=True,
    )

    metrics_proc = subprocess.run(
        [
            ffmpeg,
            "-i",
            str(first),
            "-i",
            str(last),
            "-lavfi",
            "[0:v][1:v]ssim;[0:v][1:v]psnr",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    stderr_text = metrics_proc.stderr
    ssim_all = _extract_float(stderr_text, r"SSIM .* All:([0-9.]+)")
    psnr_avg = _extract_float(stderr_text, r"PSNR .* average:([0-9.]+|inf)")

    identical_warning = bool(ssim_all is not None and ssim_all > 0.998)
    print(
        json.dumps(
            {
                "ok": True,
                "command": "diff-frames",
                "first": str(first),
                "last": str(last),
                "diffImage": str(out),
                "dimensions": {"width": w1, "height": h1},
                "metrics": {
                    "ssim": ssim_all,
                    "psnrAverage": psnr_avg,
                    "nearlyIdenticalNoMotionWarning": identical_warning,
                },
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def cmd_extract_cuts(args: argparse.Namespace) -> int:
    ffmpeg = find_binary("ffmpeg")
    video = Path(args.video).resolve()
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    width, height, fps, duration = get_video_dimensions_and_fps(video)
    window = max(1, int(args.window))
    frame_step = 1.0 / fps if fps > 0 else 1.0 / 24.0

    cuts: List[float] = []
    if args.cuts:
        for part in args.cuts.split(","):
            part = part.strip()
            if part:
                cuts.append(float(part))

    extracted: List[Dict[str, Any]] = []

    # 1. Sample anchor frames across the video for story comprehension
    sample_count = max(2, int(args.samples))
    for idx in range(sample_count):
        t = min(
            max(0.0, (duration * (idx + 0.5)) / sample_count),
            max(0.0, duration - frame_step),
        )
        frame_no = round(t * fps)
        out_file = out_dir / f"sample_{idx + 1:02d}_f{frame_no:05d}_{t:.3f}s.png"
        _extract_single_frame(ffmpeg, video, t, out_file)
        extracted.append(
            {
                "kind": "sample",
                "timestampSec": round(t, 4),
                "approxFrame": frame_no,
                "file": str(out_file),
            }
        )

    # 2. Extract exact N frames before and N frames after every cut point
    for cut_idx, cut_t in enumerate(cuts, start=1):
        for offset in range(-window, window + 1):
            if offset == 0:
                tag = "at_cut"
            elif offset < 0:
                tag = f"minus_{abs(offset)}"
            else:
                tag = f"plus_{offset}"
            t = min(max(0.0, cut_t + offset * frame_step), max(0.0, duration - frame_step / 2))
            frame_no = round(t * fps)
            out_file = (
                out_dir
                / f"cut{cut_idx:02d}_{tag}_f{frame_no:05d}_{t:.3f}s.png"
            )
            _extract_single_frame(ffmpeg, video, t, out_file)
            extracted.append(
                {
                    "kind": "cut_window",
                    "cutIndex": cut_idx,
                    "cutTimestampSec": cut_t,
                    "frameOffset": offset,
                    "timestampSec": round(t, 4),
                    "approxFrame": frame_no,
                    "file": str(out_file),
                }
            )

    manifest_path = out_dir / "frames_manifest.json"
    manifest = {
        "ok": True,
        "command": "extract-cuts",
        "video": str(video),
        "dimensions": {"width": width, "height": height},
        "fps": round(fps, 4),
        "durationSec": round(duration, 4),
        "windowFrames": window,
        "cutsSec": cuts,
        "framesCount": len(extracted),
        "frames": extracted,
    }
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


def _extract_single_frame(
    ffmpeg: str, video: Path, timestamp: float, out_file: Path
) -> None:
    subprocess.run(
        [
            ffmpeg,
            "-y",
            "-v",
            "error",
            "-ss",
            f"{timestamp:.4f}",
            "-i",
            str(video),
            "-frames:v",
            "1",
            str(out_file),
        ],
        check=True,
    )


def _extract_float(text: str, pattern: str) -> Optional[float]:
    m = re.search(pattern, text)
    if not m:
        return None
    raw = m.group(1)
    if raw == "inf":
        return 99.99
    try:
        return float(raw)
    except ValueError:
        return None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="video-qa-tools.py",
        description="Deterministic QA & frame-audit utilities for recipe-ai-video-studio.",
    )
    sub = parser.add_subparsers(dest="subcommand", required=True)

    p_grid = sub.add_parser(
        "wireframe-grid",
        aliases=["grid"],
        help="Overlay 38.2% and 61.8% golden-ratio composition guide lines.",
    )
    p_grid.add_argument("--input", "-i", required=True, help="Input image path")
    p_grid.add_argument("--output", "-o", required=True, help="Output annotated PNG")
    p_grid.add_argument(
        "--also-gray",
        action="store_true",
        help="Also emit <output>_gray.png luminance check image",
    )
    p_grid.set_defaults(func=cmd_wireframe_grid)

    p_gray = sub.add_parser(
        "grayscale",
        help="Convert image to grayscale and measure luminance separation.",
    )
    p_gray.add_argument("--input", "-i", required=True, help="Input image path")
    p_gray.add_argument("--output", "-o", required=True, help="Output grayscale PNG")
    p_gray.set_defaults(func=cmd_grayscale)

    p_mob = sub.add_parser(
        "mobile-preview",
        aliases=["mobile"],
        help="Downscale frame to mobile screen width to test silhouette readability.",
    )
    p_mob.add_argument("--input", "-i", required=True, help="Input image path")
    p_mob.add_argument("--output", "-o", required=True, help="Output preview PNG")
    p_mob.add_argument("--width", type=int, default=360, help="Preview width in px")
    p_mob.set_defaults(func=cmd_mobile_preview)

    p_size = sub.add_parser(
        "enforce-size",
        help="Lanczos scale + center-crop frame to exact WxH pixel dimensions.",
    )
    p_size.add_argument("--input", "-i", required=True, help="Input image path")
    p_size.add_argument("--output", "-o", required=True, help="Output PNG")
    p_size.add_argument(
        "--size",
        default="1920x1080",
        help="Target pixel size, e.g. 1920x1080 or 1080x1920",
    )
    p_size.set_defaults(func=cmd_enforce_size)

    p_diff = sub.add_parser(
        "diff-frames",
        aliases=["diff"],
        help="Verify matching dimensions and render amplified pixel diff between first & last frame.",
    )
    p_diff.add_argument("--first", required=True, help="First frame image path")
    p_diff.add_argument("--last", required=True, help="Last frame image path")
    p_diff.add_argument(
        "--output", "-o", required=True, help="Output amplified difference PNG"
    )
    p_diff.set_defaults(func=cmd_diff_frames)

    p_cuts = sub.add_parser(
        "extract-cuts",
        aliases=["cuts"],
        help="Extract sample frames plus N frames before/after every cut point for blind review.",
    )
    p_cuts.add_argument("--video", "-v", required=True, help="Master video path")
    p_cuts.add_argument("--out-dir", "-o", required=True, help="Output directory")
    p_cuts.add_argument(
        "--cuts",
        default="",
        help="Comma-separated cut timestamps in seconds, e.g. '3.2,7.5,12.0'",
    )
    p_cuts.add_argument(
        "--window",
        type=int,
        default=3,
        help="Frames to extract before and after each cut (default: 3)",
    )
    p_cuts.add_argument(
        "--samples",
        type=int,
        default=8,
        help="Uniform full-resolution story sample frames across video",
    )
    p_cuts.set_defaults(func=cmd_extract_cuts)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return int(args.func(args))
    except Exception as exc:  # noqa: BLE001
        print(
            json.dumps(
                {"ok": False, "error": type(exc).__name__, "message": str(exc)},
                ensure_ascii=False,
                indent=2,
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
