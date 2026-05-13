"""
droidcity_ Voice Studio — FastAPI Backend
==========================================
Run:
    python api.py

Then open: http://localhost:7860
"""

import gc
import json
import shutil
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

import torch
import soundfile as sf
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# Heavy import — only loaded when needed
Qwen3TTSModel = None
whisper_model = None


# ============================================================
# Configuration
# ============================================================

MODEL_BASE         = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
MODEL_CUSTOM_VOICE = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
MODEL_VOICE_DESIGN = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"

DATA_DIR = Path("voice_studio_data")
VOICES_DIR = DATA_DIR / "voices"
OUTPUTS_DIR = DATA_DIR / "outputs"
UPLOADS_DIR = DATA_DIR / "uploads"
VOICES_INDEX = DATA_DIR / "voices.json"

PRESET_SPEAKERS = [
    "Aiden", "Dylan", "Eric", "Ono_anna", "Ryan",
    "Serena", "Sohee", "Uncle_fu", "Vivian",
]

LANGUAGES = ["English", "Chinese", "Japanese", "Korean",
             "German", "French", "Spanish", "Italian",
             "Portuguese", "Russian"]


def init_dirs():
    DATA_DIR.mkdir(exist_ok=True)
    VOICES_DIR.mkdir(exist_ok=True)
    OUTPUTS_DIR.mkdir(exist_ok=True)
    UPLOADS_DIR.mkdir(exist_ok=True)
    if not VOICES_INDEX.exists():
        VOICES_INDEX.write_text("{}")


# ============================================================
# Model swap (only one in VRAM at a time)
# ============================================================

CURRENT_MODEL = None
CURRENT_MODEL_ID = None


def get_model(model_id: str):
    global CURRENT_MODEL, CURRENT_MODEL_ID, Qwen3TTSModel

    if CURRENT_MODEL_ID == model_id and CURRENT_MODEL is not None:
        return CURRENT_MODEL

    if CURRENT_MODEL is not None:
        print(f"  unloading {CURRENT_MODEL_ID}")
        del CURRENT_MODEL
        CURRENT_MODEL = None
        CURRENT_MODEL_ID = None
        gc.collect()
        torch.cuda.empty_cache()
        torch.cuda.synchronize()

    if Qwen3TTSModel is None:
        from qwen_tts import Qwen3TTSModel as _Model
        Qwen3TTSModel = _Model

    use_cuda = torch.cuda.is_available()
    device = "cuda:0" if use_cuda else "cpu"
    dtype = torch.bfloat16 if use_cuda else torch.float32

    print(f"  loading {model_id} on {device} ({dtype})")
    t0 = time.time()
    model = Qwen3TTSModel.from_pretrained(
        model_id, device_map=device, dtype=dtype,
    )
    print(f"  loaded in {time.time() - t0:.1f}s")

    CURRENT_MODEL = model
    CURRENT_MODEL_ID = model_id
    return model


# ============================================================
# Voice library helpers
# ============================================================

def load_voices() -> dict:
    init_dirs()
    return json.loads(VOICES_INDEX.read_text())


def save_voices(voices: dict):
    VOICES_INDEX.write_text(json.dumps(voices, indent=2))


# ============================================================
# Request models
# ============================================================

class GenerateCloneRequest(BaseModel):
    voice_name: str
    script: str
    language: str = "English"
    temperature: float = 0.6
    top_p: float = 0.95
    top_k: int = 50
    num_takes: int = 3


class GeneratePresetRequest(BaseModel):
    speaker: str
    script: str
    language: str = "English"
    instruction: Optional[str] = None
    temperature: float = 0.7
    top_p: float = 0.95
    top_k: int = 50


class GenerateDesignRequest(BaseModel):
    script: str
    instruction: str
    language: str = "English"
    temperature: float = 0.8
    top_p: float = 0.95
    top_k: int = 50


class GenerateBatchRequest(BaseModel):
    voice_name: str
    scripts: list[str]
    language: str = "English"
    temperature: float = 0.6
    top_p: float = 0.95
    top_k: int = 50


# ============================================================
# FastAPI app
# ============================================================

app = FastAPI(title="droidcity_ Voice Studio")


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "cuda": torch.cuda.is_available(),
        "current_model": CURRENT_MODEL_ID,
    }


@app.get("/api/config")
def config():
    return {
        "preset_speakers": PRESET_SPEAKERS,
        "languages": LANGUAGES,
    }


# ===== Voice library =====

@app.get("/api/voices")
def list_voices():
    voices = load_voices()
    # Return without absolute paths exposed
    return [
        {
            "name": name,
            "transcript": v["transcript"],
            "created_at": v["created_at"],
        }
        for name, v in voices.items()
    ]


@app.get("/api/voices/{name}/audio")
def get_voice_audio(name: str):
    voices = load_voices()
    if name not in voices:
        raise HTTPException(404, f"Voice '{name}' not found")
    audio_path = voices[name]["audio_path"]
    if not Path(audio_path).exists():
        raise HTTPException(404, "Audio file missing")
    return FileResponse(audio_path, media_type="audio/wav")


@app.post("/api/voices")
async def add_voice(
    name: str = Form(...),
    transcript: str = Form(...),
    audio: UploadFile = File(...),
):
    name = name.strip()
    transcript = transcript.strip()

    if not name:
        raise HTTPException(400, "Voice name is required")
    if not transcript:
        raise HTTPException(400, "Transcript is required")

    voices = load_voices()
    if name in voices:
        raise HTTPException(400, f"Voice '{name}' already exists")

    # Save uploaded file
    suffix = Path(audio.filename).suffix or ".wav"
    dst = VOICES_DIR / f"{name}{suffix}"
    with open(dst, "wb") as f:
        shutil.copyfileobj(audio.file, f)

    voices[name] = {
        "audio_path": str(dst),
        "transcript": transcript,
        "created_at": datetime.now().isoformat(),
    }
    save_voices(voices)

    return {"name": name, "transcript": transcript}


@app.delete("/api/voices/{name}")
def delete_voice(name: str):
    voices = load_voices()
    if name not in voices:
        raise HTTPException(404, f"Voice '{name}' not found")

    p = Path(voices[name]["audio_path"])
    if p.exists():
        p.unlink()
    del voices[name]
    save_voices(voices)
    return {"deleted": name}


# ===== Generation: outputs =====

@app.get("/api/output/{filename}")
def get_output(filename: str):
    """Serve a generated audio file by filename."""
    # Security: only allow files inside OUTPUTS_DIR
    candidate = OUTPUTS_DIR / filename
    try:
        candidate.resolve().relative_to(OUTPUTS_DIR.resolve())
    except ValueError:
        raise HTTPException(403, "Forbidden path")
    if not candidate.exists():
        raise HTTPException(404, "Not found")
    return FileResponse(candidate, media_type="audio/wav", filename=filename)


# ===== Generation: clone =====

@app.post("/api/generate/clone")
def generate_clone(req: GenerateCloneRequest):
    voices = load_voices()
    if req.voice_name not in voices:
        raise HTTPException(404, f"Voice '{req.voice_name}' not found")
    if not req.script.strip():
        raise HTTPException(400, "Script is empty")

    v = voices[req.voice_name]
    try:
        model = get_model(MODEL_BASE)
    except Exception as e:
        raise HTTPException(500, f"Model load failed: {e}")

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    takes = []
    last_err = "unknown"

    for i in range(int(req.num_takes)):
        try:
            wavs, sr = model.generate_voice_clone(
                text=req.script,
                language=req.language,
                ref_audio=v["audio_path"],
                ref_text=v["transcript"],
                temperature=req.temperature,
                top_p=req.top_p,
                top_k=int(req.top_k),
            )
            filename = f"{req.voice_name}_{timestamp}_take{i+1}.wav"
            out_path = OUTPUTS_DIR / filename
            sf.write(out_path, wavs[0], sr)
            takes.append({
                "filename": filename,
                "url": f"/api/output/{filename}",
                "take": i + 1,
            })
        except Exception as e:
            import traceback
            traceback.print_exc()
            print(f"  take {i+1} failed: {e}")
            last_err = str(e)

    if not takes:
        raise HTTPException(500, f"All takes failed — {last_err}")

    return {"takes": takes, "count": len(takes)}


# ===== Generation: preset =====

@app.post("/api/generate/preset")
def generate_preset(req: GeneratePresetRequest):
    if not req.script.strip():
        raise HTTPException(400, "Script is empty")
    if req.speaker not in PRESET_SPEAKERS:
        raise HTTPException(400, f"Unknown speaker: {req.speaker}")

    try:
        model = get_model(MODEL_CUSTOM_VOICE)
    except Exception as e:
        raise HTTPException(500, f"Model load failed: {e}")

    try:
        kwargs = dict(
            text=req.script,
            language=req.language,
            speaker=req.speaker,
            temperature=req.temperature,
            top_p=req.top_p,
            top_k=int(req.top_k),
        )
        if req.instruction and req.instruction.strip():
            kwargs["instruct"] = req.instruction.strip()

        wavs, sr = model.generate_custom_voice(**kwargs)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"preset_{req.speaker}_{timestamp}.wav"
        out_path = OUTPUTS_DIR / filename
        sf.write(out_path, wavs[0], sr)
        return {
            "filename": filename,
            "url": f"/api/output/{filename}",
        }
    except Exception as e:
        raise HTTPException(500, f"Generation failed: {e}")


# ===== Generation: design =====

@app.post("/api/generate/design")
def generate_design(req: GenerateDesignRequest):
    if not req.script.strip():
        raise HTTPException(400, "Script is empty")
    if not req.instruction.strip():
        raise HTTPException(400, "Voice description is required")

    try:
        model = get_model(MODEL_VOICE_DESIGN)
    except Exception as e:
        raise HTTPException(500, f"Model load failed: {e}")

    try:
        wavs, sr = model.generate_voice_design(
            text=req.script,
            language=req.language,
            instruct=req.instruction.strip(),
            temperature=req.temperature,
            top_p=req.top_p,
            top_k=int(req.top_k),
        )
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"design_{timestamp}.wav"
        out_path = OUTPUTS_DIR / filename
        sf.write(out_path, wavs[0], sr)
        return {
            "filename": filename,
            "url": f"/api/output/{filename}",
        }
    except Exception as e:
        raise HTTPException(500, f"Generation failed: {e}")


# ===== Generation: batch =====

@app.post("/api/generate/batch")
def generate_batch(req: GenerateBatchRequest):
    if not req.voice_name:
        raise HTTPException(400, "Voice name required")

    voices = load_voices()
    if req.voice_name not in voices:
        raise HTTPException(404, f"Voice '{req.voice_name}' not found")

    scripts = [s.strip() for s in req.scripts if s.strip()]
    if not scripts:
        raise HTTPException(400, "No scripts provided")

    v = voices[req.voice_name]
    try:
        model = get_model(MODEL_BASE)
    except Exception as e:
        raise HTTPException(500, f"Model load failed: {e}")

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    clips = []

    for i, script in enumerate(scripts):
        try:
            wavs, sr = model.generate_voice_clone(
                text=script,
                language=req.language,
                ref_audio=v["audio_path"],
                ref_text=v["transcript"],
                temperature=req.temperature,
                top_p=req.top_p,
                top_k=int(req.top_k),
            )
            filename = f"batch_{req.voice_name}_{timestamp}_{i+1:02d}.wav"
            out_path = OUTPUTS_DIR / filename
            sf.write(out_path, wavs[0], sr)
            clips.append({
                "filename": filename,
                "url": f"/api/output/{filename}",
                "script": script,
                "index": i + 1,
            })
        except Exception as e:
            print(f"  clip {i+1} failed: {e}")
            clips.append({
                "filename": None,
                "url": None,
                "script": script,
                "index": i + 1,
                "error": str(e),
            })

    succeeded = sum(1 for c in clips if c["filename"])
    return {"clips": clips, "succeeded": succeeded, "total": len(scripts)}


# ===== Transcription (WhisperX) =====

def get_whisper():
    global whisper_model
    if whisper_model is None:
        import whisperx
        print("  loading whisperX base model...")
        t0 = time.time()
        device = "cuda" if torch.cuda.is_available() else "cpu"
        compute_type = "float16" if device == "cuda" else "int8"
        whisper_model = whisperx.load_model(
            "base", device=device, compute_type=compute_type,
        )
        print(f"  whisperX loaded in {time.time() - t0:.1f}s")
    return whisper_model


@app.post("/api/transcribe")
async def transcribe_audio(audio: UploadFile = File(...)):
    """Transcribe uploaded audio using WhisperX (local, faster-whisper backend)."""
    if not audio.filename:
        raise HTTPException(400, "Audio file is required")

    suffix = Path(audio.filename).suffix.lower() or ".wav"
    tmp_path = UPLOADS_DIR / f"transcribe_{uuid.uuid4().hex[:8]}{suffix}"

    try:
        import whisperx

        with open(tmp_path, "wb") as f:
            shutil.copyfileobj(audio.file, f)

        device = "cuda" if torch.cuda.is_available() else "cpu"
        audio_arr = whisperx.load_audio(str(tmp_path))
        model = get_whisper()
        result = model.transcribe(audio_arr, batch_size=16)

        segments = result.get("segments", [])
        transcript = " ".join(seg["text"].strip() for seg in segments).strip()
        language = result.get("language", "unknown")

        return {"transcript": transcript, "language": language}
    except Exception as e:
        raise HTTPException(500, f"Transcription failed: {e}")
    finally:
        if tmp_path.exists():
            tmp_path.unlink()


# ============================================================
# Static frontend (mounted last so /api/* takes precedence)
# ============================================================

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


# ============================================================
# Main
# ============================================================

if __name__ == "__main__":
    import uvicorn

    init_dirs()
    print("\n" + "=" * 60)
    print("  droidcity_ · Voice Studio")
    print("=" * 60)
    print(f"  Data: {DATA_DIR.resolve()}")
    print(f"  URL:  http://127.0.0.1:7860")
    print("=" * 60 + "\n") #Hello and welcome to Droid city. here we will learn how to build an AI voice Clone in 10mins. No bullshit straight to topic!

    uvicorn.run(app, host="127.0.0.1", port=7860, log_level="info")