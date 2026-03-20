# LivePortrait Avatar System Design

**Date**: 2026-03-20
**Status**: Draft
**Author**: Claude Opus 4.6 + Human

## Overview

Real-time avatar system that animates a user-supplied face photo using MHH-EI emotional intelligence output and Qwen3-TTS percy voice audio. The system splits across three hosts:

| Host | Role | Key Workload |
|------|------|-------------|
| **ASUS Laptop** (Intel, 16GB RAM) | Primary runtime | Agent Zero + avatar renderer + MHH-EI engine |
| **ai.matthewstevens.org** | TTS server | Qwen3-TTS percy voice at :8880/v1 |
| **Scaleway GPU** (fr-par) | Avatar processing | LivePortrait face prep + optional HQ rendering |

## Architecture

```
┌────────────────────┐    WAV audio   ┌─────────────────────────────────┐
│ai.matthewstevens.org│──────────────▶│       ASUS Laptop (16GB)        │
│                    │   (percy)      │                                 │
│  Qwen3-TTS :8880   │               │  ┌─────────────┐ ┌───────────┐  │
└────────────────────┘               │  │ Agent Zero  │ │ MHH-EI    │  │
                                     │  │ (Python)    │→│ Webb Eq.  │  │
┌────────────────────┐  face model   │  └──────┬──────┘ └─────┬─────┘  │
│  Scaleway GPU      │─────────────▶│         │ text         │ emotion │
│  (fr-par, L4)      │  (one-time)   │         ▼              ▼        │
│                    │               │  ┌────────────────────────────┐  │
│  LivePortrait API  │               │  │   Avatar Renderer          │  │
│  - POST /prepare   │               │  │   (enhanced avatar-test)   │  │
│  - POST /animate   │               │  │   - audio playback         │  │
│  - GET /health     │               │  │   - lip sync (visemes)     │  │
└────────────────────┘               │  │   - emotion expressions    │  │
                                     │  │   - idle animations        │  │
                                     │  └────────────────────────────┘  │
                                     └─────────────────────────────────┘
```

## Component 1: Scaleway LivePortrait API (`liveportrait-api`)

### Purpose
One-time (or on-demand) processing of a user's face photo into a rigged face model with expression basis vectors. Optional high-quality neural rendering mode.

### Endpoints

#### `POST /prepare`
- **Input**: User face photo (PNG/JPG, any resolution)
- **Processing**: LivePortrait extracts face region, computes neutral expression keypoints, generates expression basis vectors (52 ARKit-compatible blend shapes)
- **Output**: JSON face model containing:
  - `face_region`: bounding box + alignment matrix
  - `neutral_keypoints`: 478 landmark coordinates at rest
  - `expression_basis`: 52 blend shape displacement vectors
  - `source_image_cropped`: base64 aligned face crop (256x256)
  - `stitching_params`: parameters for seamless face compositing
- **Latency**: 5-15 seconds (one-time per photo)
- **Storage**: Face model cached in Scaleway Object Storage (`s3://sanmarcsoft-avatar-models/`)

#### `POST /animate` (optional HQ mode)
- **Input**: face model ID + expression coefficients array + audio WAV
- **Processing**: LivePortrait renders photorealistic animated frames
- **Output**: MP4 video or MJPEG frame stream
- **Latency**: 2-5 seconds per utterance
- **Use case**: Pre-rendered clips, presentations, saved content

#### `GET /health`
- Returns server status, GPU memory, model loaded state

### Infrastructure (Pulumi TypeScript)
- **Instance**: Scaleway GPU Instance (L4, fr-par-2)
- **Image**: Nix-built OCI image via `pkgs.dockerTools.buildLayeredImage`
- **Registry**: `rg.fr-par.scw.cloud/sanmarcsoft/liveportrait-api`
- **Push**: `skopeo copy docker-archive:<image> docker://rg.fr-par.scw.cloud/sanmarcsoft/liveportrait-api:<tag>`
- **State**: `s3://sanmarcsoft-pulumi-state` (fr-par)
- **Model weights**: Downloaded at build time, baked into OCI image layer

### LivePortrait Model Details
- Repository: KwaiVGI/LivePortrait
- Weights: ~400MB (appearance + motion + stitching modules)
- Framework: PyTorch (ONNX export available for edge deployment)
- GPU memory: ~2-4GB VRAM at inference

## Component 2: Avatar Bridge (Agent Zero Python module)

### Purpose
Orchestrates the pipeline on the ASUS laptop: receives agent text response, calls percy TTS, extracts viseme timing, computes MHH-EI emotion state, and feeds everything to the avatar renderer.

### Module: `python/helpers/avatar_bridge.py`

```python
class AvatarBridge:
    """Bridges Agent Zero output to the avatar renderer via WebSocket."""

    async def process_response(self, text: str, emotion_state: dict) -> None:
        # 1. Call Qwen3-TTS percy for audio
        audio_wav = await self.synthesize_percy(text)

        # 2. Extract viseme timing from audio
        visemes = self.extract_visemes(audio_wav)

        # 3. Package and send to renderer
        await self.ws_broadcast({
            "type": "animate",
            "audio": base64_encode(audio_wav),
            "emotion": emotion_state,  # {type: "happiness", severity: 3}
            "visemes": visemes,         # [{viseme: "aa", start: 0.0, duration: 0.12}, ...]
        })

    async def synthesize_percy(self, text: str) -> bytes:
        """Call Qwen3-TTS percy on ai.matthewstevens.org."""
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "http://ai.matthewstevens.org:8880/v1/audio/speech",
                json={"model": "qwen3-tts", "voice": "percy", "input": text},
                headers={"Authorization": "Bearer prime-mouth"},
            )
            return resp.content  # WAV bytes

    async def prepare_face(self, image_path: str) -> dict:
        """One-time: send user photo to Scaleway LivePortrait for face model extraction."""
        async with httpx.AsyncClient(timeout=30.0) as client:
            with open(image_path, "rb") as f:
                resp = await client.post(
                    f"{SCALEWAY_LIVEPORTRAIT_URL}/prepare",
                    files={"image": ("face.png", f, "image/png")},
                )
            return resp.json()  # face model
```

### Viseme Extraction
- Use `rhubarb-lip-sync` (CPU, ~50MB) to map percy audio WAV → phoneme-to-viseme timing
- Falls back to amplitude-based mapping if rhubarb unavailable
- Output: array of `{viseme, start_ms, duration_ms}` matching the VIS definitions already in avatar-test.html

### WebSocket Server
- Runs on the ASUS laptop alongside Agent Zero
- Avatar renderer (browser) connects to `ws://localhost:<port>/avatar`
- Messages: `animate` (audio + emotion + visemes), `set_face` (face model from /prepare), `set_emotion` (real-time emotion updates)

## Component 3: Avatar Renderer (Enhanced avatar-test.html)

### Purpose
Browser-based avatar display that receives real-time animation data over WebSocket. Extends the existing `avatar-test.html` which already has:
- MediaPipe Face Landmarker (478 landmarks + blend shapes)
- 12 emotion definitions with blend shape multipliers (EMO map)
- 10 viseme definitions with mouth open/width/shape params (VIS map)
- Idle animations (blink, breathe, sway)
- Vector background with scanlines/glitch effects

### Enhancements needed
1. **WebSocket client** — connects to avatar bridge, receives `animate` messages
2. **Audio playback** — plays percy WAV from base64, synchronized with viseme timeline
3. **Viseme sequencer** — steps through viseme array in sync with audio playback position
4. **Emotion transitions** — smooth blend between emotion states using lerp (already partially implemented)
5. **Auto-connect** — on page load, connects to Agent Zero's avatar WebSocket

### MHH-EI Emotion Mapping
The Webb Equation output (EP ∆ P = ER) maps to the existing EMO definitions:

| ER Valence | ER Intensity | Avatar Emotion | Blend Shape Effect |
|------------|-------------|----------------|-------------------|
| Positive, low | 1-2 | neutral → happiness | slight smile |
| Positive, high | 4-5 | happiness/pride/love | full smile, eye crinkle |
| Negative, low | 1-2 | worry/sadness | slight brow furrow |
| Negative, high | 4-5 | anger/fear/disgust | strong expression |
| Surprise | any | surprise/curiosity | wide eyes, raised brows |

Severity (1-5) maps to blend shape intensity multiplier (already the `sev` slider in avatar-test.html).

## Data Flow (per utterance)

```
1. User speaks → Agent Zero processes on ASUS laptop
2. Agent generates text response + MHH-EI emotion state
3. ASUS → ai.matthewstevens.org:8880/v1/audio/speech (percy TTS)
4. ai.matthewstevens.org → ASUS: WAV audio bytes
5. ASUS: extract viseme timing from WAV (rhubarb or amplitude)
6. ASUS → browser (WebSocket): {audio, emotion, visemes}
7. Browser: play audio + animate face in sync
```

## Initial Face Setup (one-time per user)

```
1. User uploads face photo via avatar-test.html UI
2. Browser → ASUS (WebSocket): {type: "prepare", image: base64}
3. ASUS → Scaleway /prepare: face photo
4. Scaleway: LivePortrait extracts face model
5. Scaleway → ASUS: face model JSON
6. ASUS: cache face model locally
7. ASUS → browser (WebSocket): {type: "set_face", model: ...}
8. Browser: use face model for higher-quality landmark deformation
```

## Build & Deploy

### Scaleway LivePortrait API
```bash
# Build OCI image (on ai.matthewstevens.org, x86_64-linux target)
nix build .#packages.x86_64-linux.oci-image

# Push to Scaleway registry (no Docker daemon)
skopeo copy docker-archive:result docker://rg.fr-par.scw.cloud/sanmarcsoft/liveportrait-api:testing

# Deploy via Pulumi
cd infra && pulumi up --stack testing
```

### Agent Zero Avatar Bridge
- New Python module added to agent-zero
- No separate container — runs in the existing Agent Zero process
- Dependencies: `httpx`, `websockets` (already in agent-zero deps)
- Optional: `rhubarb-lip-sync` binary for high-quality viseme extraction

## Testing Plan

1. **Unit**: avatar_bridge.py — mock TTS endpoint, verify viseme extraction
2. **Integration**: WebSocket round-trip — send animate message, verify browser receives and plays
3. **E2E**: Full pipeline — type message in Agent Zero, verify avatar speaks with correct emotion
4. **Performance**: Measure latency from text input to first audio frame on ASUS laptop
5. **Face prep**: Upload photo, verify Scaleway returns valid face model

## Open Questions

1. What GPU tier on Scaleway? L4 (cheapest with decent VRAM) vs H100 (overkill but fast)
2. Should Scaleway LivePortrait instance be always-on or spin up on demand (serverless container)?
3. Rhubarb lip sync vs amplitude-based — rhubarb gives better results but adds ~50MB binary dependency
4. Face model caching strategy — local file on ASUS laptop or Scaleway Object Storage?
