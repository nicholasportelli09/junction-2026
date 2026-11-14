# Voice checked live on the hosted backend; one limit fixed

**Summary:** Voice works on the hosted backend in every recording format a phone or browser sends and in three languages; the one defect found was a size limit above what the host accepts, now lowered to 4 MB.
**Author:** Nicholas (Claude Code) · **Branch:** fix/voice-recording-limit · **Lane:** agent

## Done
- `tests/gauntlet/voice-formats.mjs`: a live voice check that makes its own clips (macOS `say` and `ffmpeg`) and runs speech to text, whole voice turns, bad input and text to speech. `node tests/gauntlet/voice-formats.mjs [base] [stt,turn,edge,tts]`.
- `MAX_AUDIO_BYTES` is 4 MB (was 5). The host refuses a body over 4.5 MB before our code runs, in plain text, so a 4.5 to 5 MB recording never got our sentence.
- Tests: `tests/unit/voice-limits.test.ts` (4). 338 unit tests pass.
- Docs: "Voice: what the backend takes" at the end of `docs/FRONTEND_INTEGRATION_CONTRACT.md`.

## Decisions
- Nothing else in the voice code changed. Affects: a client that records should stop before 4 MB; compressed speech never gets near it.

## Learned / gotchas
- Measured on https://sisu-api.vercel.app, 14 Nov about 22:10, 35 of 36 checks before the fix: speech to text 14 of 14 (AAC/MP4, Opus/WebM, Opus/Ogg, WAV, MP3, missing content type; English, Finnish and Swedish detected; "three hundred euro" heard as 300), about 0.5 to 0.9 s each. Voice turns 6 of 6, first sentence 1.1 to 2.3 s, answers in the language spoken. Silence, noise, a quarter-second clip and a non-audio file each get a readable sentence. Text to speech: first audio about 0.3 s, five sentences at once in under 1.5 s.
- The same six voice turns pass through the frontend's address (sisu-demo.vercel.app forwards `/api` to the backend).
- This key cannot read the ElevenLabs account, so `/api/health/ready` cannot say how much voice credit is left. Check the ElevenLabs dashboard before judging.
- Not checked: the microphone and audio playback in a real phone browser.
