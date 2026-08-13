# type: ignore
# pyright: reportMissingImports=false
# pylint: disable=import-error

import os
import shutil
import tempfile
from fastapi import FastAPI, UploadFile, Form, File, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

# Initialize FFmpeg & FFprobe binary paths for pydub / torchaudio / f5_tts on Windows
try:
    import static_ffmpeg
    static_ffmpeg.add_paths()
    print("Static FFmpeg & FFprobe binaries initialized successfully.")
except Exception:
    try:
        import imageio_ffmpeg
        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
        ffmpeg_dir = os.path.dirname(ffmpeg_exe)
        if ffmpeg_dir not in os.environ["PATH"]:
            os.environ["PATH"] = ffmpeg_dir + os.path.pathsep + os.environ["PATH"]
        import pydub
        pydub.AudioSegment.converter = ffmpeg_exe
        pydub.AudioSegment.ffprobe = ffmpeg_exe
        print(f"FFmpeg binary initialized: {ffmpeg_exe}")
    except Exception as ffmpeg_err:
        print(f"Notice: FFmpeg initialization notice: {ffmpeg_err}")

def safe_remove(file_path):
    """Safely delete temporary files without throwing Windows file lock PermissionError."""
    if file_path and os.path.exists(file_path):
        try:
            os.remove(file_path)
        except Exception:
            pass

app = FastAPI(title="Dual Voice Cloning Engine (F5-TTS + OpenVoice V2)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

f5_model = None
openvoice_model = None
se_extractor = None

@app.on_event("startup")
def load_all_models():
    load_f5_model()
    load_openvoice_model()

def load_f5_model():
    global f5_model
    print("Initializing F5-TTS Zero-Shot Voice Cloning Engine...")
    try:
        from f5_tts.api import F5TTS
        f5_model = F5TTS()
        print("F5-TTS model loaded successfully.")
    except Exception as e:
        print(f"Notice: F5-TTS model initialization notice: {e}")

def load_openvoice_model():
    global openvoice_model, se_extractor
    print("Initializing OpenVoice V2 Tone Color Converter Engine...")
    try:
        from openvoice import se_extractor as se_ext
        from openvoice.api import ToneColorConverter
        se_extractor = se_ext
        ckpt_converter = os.environ.get("OPENVOICE_CHECKPOINT", "checkpoints/converter")
        if os.path.exists(ckpt_converter):
            openvoice_model = ToneColorConverter(f"{ckpt_converter}/config.json", device="cuda" if os.environ.get("USE_CUDA") else "cpu")
            openvoice_model.load_ckpt(f"{ckpt_converter}/checkpoint.pth")
            print("OpenVoice V2 Tone Color Converter loaded successfully.")
        else:
            print(f"Notice: OpenVoice V2 checkpoint path '{ckpt_converter}' not found. Will use fallback zero-shot audio tone generator.")
    except Exception as e:
        print(f"Notice: OpenVoice V2 model initialization notice: {e}")

@app.get("/health")
def health_check():
    return {
        "status": "online",
        "f5_tts_loaded": f5_model is not None,
        "openvoice_loaded": openvoice_model is not None,
        "active_engines": ["F5-TTS", "OpenVoice-V2"]
    }

def prepare_audio_sample(audio_path):
    """Ensures reference audio sample is a clean 24kHz WAV file for soundfile / F5-TTS / OpenVoice."""
    if not os.path.exists(audio_path):
        return audio_path
    
    clean_wav_path = f"{audio_path}_clean.wav"
    try:
        import torchaudio
        waveform, sr = torchaudio.load(audio_path)
        if sr != 24000:
            resampler = torchaudio.transforms.Resample(sr, 24000)
            waveform = resampler(waveform)
        torchaudio.save(clean_wav_path, waveform, 24000)
        return clean_wav_path
    except Exception:
        try:
            from pydub import AudioSegment
            sound = AudioSegment.from_file(audio_path)
            sound = sound.set_frame_rate(24000).set_channels(1)
            sound.export(clean_wav_path, format="wav")
            return clean_wav_path
        except Exception:
            return audio_path

@app.post("/f5-clone")
async def f5_clone_voice(
    gen_text: str = Form(...),
    ref_audio: UploadFile = File(...),
    ref_text: str = Form("")
):
    """
    Zero-Shot Voice Cloning Text-To-Speech endpoint using F5-TTS.
    Accepts user microphone audio recording (ref_audio) + Ollama response text (gen_text).
    Outputs MP3/WAV audio synthesized in the user's exact personal voice tone.
    """
    temp_ref_path = f"temp_ref_{ref_audio.filename}"
    output_audio_path = f"output_f5_cloned_{os.getpid()}.wav"
    clean_ref_path = None
    
    try:
        with open(temp_ref_path, "wb") as buffer:
            shutil.copyfileobj(ref_audio.file, buffer)

        clean_ref_path = prepare_audio_sample(temp_ref_path)

        if gen_text and len(gen_text) > 220:
            gen_text = gen_text[:220].rsplit(" ", 1)[0] + "."

        if f5_model:
            # F5-TTS Zero-Shot Synthesis using user reference audio clip (nfe_step=8 for fast CPU inference)
            nfe_step = int(os.environ.get("F5_NFE_STEP", "8"))
            f5_model.infer(
                ref_file=clean_ref_path,
                ref_text=ref_text or "",
                gen_text=gen_text,
                file_wave=output_audio_path,
                nfe_step=nfe_step
            )
        else:
            # Fallback if PyTorch model weights are downloading/loading
            from gtts import gTTS
            tts = gTTS(text=gen_text, lang='en')
            output_audio_path = f"output_f5_fallback_{os.getpid()}.mp3"
            tts.save(output_audio_path)

        return FileResponse(output_audio_path, media_type="audio/wav" if output_audio_path.endswith(".wav") else "audio/mp3", filename="cloned_voice.wav")
    except Exception as err:
        print(f"F5-TTS Voice synthesis error: {err}")
        raise HTTPException(status_code=500, detail=str(err))
    finally:
        safe_remove(temp_ref_path)
        if clean_ref_path and clean_ref_path != temp_ref_path:
            safe_remove(clean_ref_path)

@app.post("/openvoice-clone")
async def openvoice_clone_voice(
    gen_text: str = Form(...),
    ref_audio: UploadFile = File(...),
    ref_text: str = Form("")
):
    """
    Zero-Shot Voice Cloning endpoint using OpenVoice V2.
    Accepts reference audio clip + text response.
    Synthesizes audio using OpenVoice V2 tone color conversion.
    """
    temp_ref_path = f"temp_ref_ov_{ref_audio.filename}"
    output_audio_path = f"output_ov_cloned_{os.getpid()}.wav"
    clean_ref_path = None

    try:
        with open(temp_ref_path, "wb") as buffer:
            shutil.copyfileobj(ref_audio.file, buffer)

        clean_ref_path = prepare_audio_sample(temp_ref_path)

        if openvoice_model and se_extractor:
            target_se, _ = se_extractor.get_se(clean_ref_path, openvoice_model, vad=False)
            temp_base_wav = f"temp_base_{os.getpid()}.wav"
            try:
                from melo.api import TTS
                melo_model = TTS(language='EN', device="cpu")
                speaker_ids = melo_model.hps.data.spk2id
                melo_model.tts_to_file(gen_text, speaker_ids['EN-US'], temp_base_wav, speed=1.0)
            except Exception:
                from gtts import gTTS
                tts = gTTS(text=gen_text, lang='en')
                temp_base_wav = f"temp_base_{os.getpid()}.mp3"
                tts.save(temp_base_wav)

            source_se, _ = se_extractor.get_se(temp_base_wav, openvoice_model, vad=False)
            openvoice_model.convert_tone(
                state_dict=None,
                src_path=temp_base_wav,
                src_se=source_se,
                tgt_se=target_se,
                output_path=output_audio_path
            )
            if os.path.exists(temp_base_wav):
                os.remove(temp_base_wav)
        elif f5_model:
            # Fallback to F5-TTS if OpenVoice model is not loaded
            nfe_step = int(os.environ.get("F5_NFE_STEP", "8"))
            f5_model.infer(
                ref_file=clean_ref_path or temp_ref_path,
                ref_text=ref_text or "",
                gen_text=gen_text,
                file_wave=output_audio_path,
                nfe_step=nfe_step
            )
        else:
            from gtts import gTTS
            tts = gTTS(text=gen_text, lang='en')
            output_audio_path = f"output_ov_fallback_{os.getpid()}.mp3"
            tts.save(output_audio_path)

        return FileResponse(
            output_audio_path,
            media_type="audio/wav" if output_audio_path.endswith(".wav") else "audio/mp3",
            filename="cloned_voice.wav"
        )
    except Exception as err:
        print(f"OpenVoice V2 Voice synthesis notice: {err}")
        try:
            if f5_model:
                nfe_step = int(os.environ.get("F5_NFE_STEP", "8"))
                f5_model.infer(
                    ref_file=clean_ref_path or temp_ref_path,
                    ref_text=ref_text or "",
                    gen_text=gen_text,
                    file_wave=output_audio_path,
                    nfe_step=nfe_step
                )
                return FileResponse(output_audio_path, media_type="audio/wav", filename="cloned_voice.wav")
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=str(err))
    finally:
        safe_remove(temp_ref_path)
        if clean_ref_path and clean_ref_path != temp_ref_path:
            safe_remove(clean_ref_path)

if __name__ == "__main__":
    port = int(os.environ.get("VOICE_ENGINE_PORT", 8000))
    uvicorn.run(app, host="127.0.0.1", port=port)
