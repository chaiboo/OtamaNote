import os
import tempfile
import uuid
import numpy as np
import librosa
from flask import Flask, render_template, request, jsonify
import yt_dlp

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB limit

UPLOAD_DIR = tempfile.mkdtemp()

# Otamatone models and their note ranges.
# Unlike Stylophone, the Otamatone has a CONTINUOUS pitch ribbon — so we
# model each instrument by its low/high note and display position as a
# percentage along the stem (0% = top/head, 100% = bottom/tip).
OTAMATONE_MODELS = {
    "neo": {
        "name": "Otamatone Neo",
        "description": "Standard 2-octave Otamatone — the classic singing tadpole",
        "low": "C4",
        "high": "C6",
    },
    "deluxe": {
        "name": "Otamatone Deluxe",
        "description": "Extended 3-octave Otamatone with wider range",
        "low": "C3",
        "high": "C6",
    },
}

NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
NATURAL_IDX = {0, 2, 4, 5, 7, 9, 11}  # C D E F G A B — the notes labeled on the otamatone stem
NOTE_TO_MIDI = {}
for octave in range(0, 9):
    for i, name in enumerate(NOTE_NAMES):
        NOTE_TO_MIDI[f"{name}{octave}"] = 12 + octave * 12 + i


def snap_to_natural(midi):
    """Snap a midi number to the nearest natural (C/D/E/F/G/A/B). On ties, prefer lower."""
    for d in range(0, 7):
        for sign in ((-1, 1) if d > 0 else (1,)):
            cand = midi + d * sign
            if cand % 12 in NATURAL_IDX:
                return cand
    return midi


def midi_to_note_name(midi):
    midi = int(round(midi))
    octave = (midi - 12) // 12
    idx = (midi - 12) % 12
    if 0 <= idx < 12 and 0 <= octave <= 8:
        return f"{NOTE_NAMES[idx]}{octave}"
    return None


def auto_transpose(melody_notes, low_midi, high_midi):
    """Shift melody by whole octaves to center it in the Otamatone's range."""
    if not melody_notes:
        return melody_notes, 0

    center = (low_midi + high_midi) / 2
    midis = [NOTE_TO_MIDI[n["note"]] for n in melody_notes if n["note"] in NOTE_TO_MIDI]
    if not midis:
        return melody_notes, 0

    median = float(np.median(midis))
    octave_shift = round((center - median) / 12) * 12

    if octave_shift == 0:
        return melody_notes, 0

    transposed = []
    for n in melody_notes:
        midi = NOTE_TO_MIDI.get(n["note"])
        if midi is None:
            continue
        new_name = midi_to_note_name(midi + octave_shift)
        if new_name:
            transposed.append({**n, "note": new_name})

    return transposed, octave_shift


def map_to_position(note_name, low_midi, high_midi):
    """Map a note to (snapped_note, percent_along_stem).

    Otamatone stem: 0% = bottom (low note), 100% = top (high note).
    Clamps out-of-range notes to the nearest endpoint, then snaps to the
    nearest natural (C/D/E/F/G/A/B) — sharps/flats aren't labeled on the stem.
    """
    midi = NOTE_TO_MIDI.get(note_name)
    if midi is None:
        return None, None
    clamped = max(low_midi, min(high_midi, midi))
    snapped = snap_to_natural(clamped)
    snapped = max(low_midi, min(high_midi, snapped))
    span = max(1, high_midi - low_midi)
    percent = round(((snapped - low_midi) / span) * 100, 1)
    return midi_to_note_name(snapped), percent


def extract_melody(audio_path, max_duration=120):
    """Extract dominant melody using Spotify's basic-pitch ML model."""
    from basic_pitch.inference import predict

    model_output, midi_data, note_events = predict(
        audio_path,
        onset_threshold=0.5,
        frame_threshold=0.3,
        minimum_note_length=120,
        maximum_frequency=2100,
        minimum_frequency=130,
    )

    notes = [n for n in note_events if n[0] < max_duration]
    if not notes:
        return []

    MELODY_LOW, MELODY_HIGH = 60, 84  # C4–C6
    melody_notes = [n for n in notes if MELODY_LOW <= n[2] <= MELODY_HIGH] or notes

    durations = [n[1] - n[0] for n in melody_notes]
    if durations:
        dur_median = float(np.median(durations))
        melody_notes = [n for n in melody_notes if (n[1] - n[0]) >= dur_median * 0.7]

    melody_notes.sort(key=lambda n: n[0])

    # Group notes within 100ms
    groups = []
    i = 0
    while i < len(melody_notes):
        group = [melody_notes[i]]
        j = i + 1
        while j < len(melody_notes) and melody_notes[j][0] - melody_notes[i][0] < 0.1:
            group.append(melody_notes[j])
            j += 1
        groups.append(group)
        i = j

    melody = []
    prev_midi = None
    prev_time = 0
    for group in groups:
        t = group[0][0]
        if prev_midi is None or (t - prev_time) > 1.0:
            best = max(group, key=lambda n: n[1] - n[0])
        else:
            def score(n):
                d = abs(n[2] - prev_midi)
                return d if d <= 7 else d * 2
            best = min(group, key=score)

        prev_time = t
        prev_midi = best[2]
        name = midi_to_note_name(best[2])
        if name and (not melody or melody[-1]["note"] != name):
            melody.append({
                "time": round(float(best[0]), 3),
                "note": name,
                "_midi": int(best[2]),
            })

    # Octave-jump cleanup
    if len(melody) >= 3:
        for i in range(1, len(melody) - 1):
            curr = melody[i]["_midi"]
            prev = melody[i - 1]["_midi"]
            nxt = melody[i + 1]["_midi"]
            for shift in (12, -12):
                shifted = curr + shift
                if (abs(shifted - prev) + abs(shifted - nxt) <
                        abs(curr - prev) + abs(curr - nxt)):
                    name = midi_to_note_name(shifted)
                    if name:
                        melody[i]["_midi"] = shifted
                        melody[i]["note"] = name

    cleaned = []
    for n in melody:
        entry = {"time": n["time"], "note": n["note"]}
        if not cleaned or cleaned[-1]["note"] != entry["note"]:
            cleaned.append(entry)
    return cleaned


def download_youtube_audio(url):
    file_id = str(uuid.uuid4())
    ydl_opts = {
        'format': 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
        'outtmpl': os.path.join(UPLOAD_DIR, f"{file_id}.%(ext)s"),
        'postprocessors': [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'wav',
            'preferredquality': '192',
        }],
        'quiet': True,
        'no_warnings': True,
        'cookiesfrombrowser': ('chrome',),
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        title = info.get('title', 'Unknown')

    import glob
    files = glob.glob(os.path.join(UPLOAD_DIR, f"{file_id}.*"))
    output_path = next((f for f in files if f.endswith('.wav')), files[0] if files else None)
    if not output_path:
        raise RuntimeError("Failed to download audio")
    return output_path, title


@app.route('/')
def index():
    return render_template('index.html', models=OTAMATONE_MODELS)


@app.route('/api/models')
def get_models():
    return jsonify(OTAMATONE_MODELS)


@app.route('/api/convert', methods=['POST'])
def convert():
    model_id = request.form.get('model', 'neo')
    youtube_url = request.form.get('youtube_url', '').strip()
    audio_file = request.files.get('audio_file')
    max_duration = min(int(request.form.get('max_duration', 60)), 120)

    if model_id not in OTAMATONE_MODELS:
        return jsonify({"error": "Unknown Otamatone model"}), 400

    model = OTAMATONE_MODELS[model_id]
    low_midi = NOTE_TO_MIDI[model["low"]]
    high_midi = NOTE_TO_MIDI[model["high"]]

    audio_path = None
    title = "Uploaded Audio"

    try:
        if youtube_url:
            audio_path, title = download_youtube_audio(youtube_url)
        elif audio_file:
            ext = os.path.splitext(audio_file.filename)[1] or '.wav'
            audio_path = os.path.join(UPLOAD_DIR, f"{uuid.uuid4()}{ext}")
            audio_file.save(audio_path)
            title = audio_file.filename
        else:
            return jsonify({"error": "Provide a YouTube URL or upload an audio file"}), 400

        melody = extract_melody(audio_path, max_duration=max_duration)
        if not melody:
            return jsonify({"error": "Could not detect a clear melody. Try a simpler track or a different segment."}), 400

        melody, octave_shift = auto_transpose(melody, low_midi, high_midi)

        result = []
        for n in melody:
            played_note, percent = map_to_position(n["note"], low_midi, high_midi)
            if played_note is None:
                continue
            if result and result[-1]["note"] == played_note:
                continue
            result.append({
                "time": n["time"],
                "original_note": n["note"],
                "note": played_note,
                "percent": percent,
            })

        transposed_msg = ""
        if octave_shift != 0:
            direction = "up" if octave_shift > 0 else "down"
            n_oct = abs(octave_shift) // 12
            transposed_msg = f"Transposed {direction} {n_oct} octave{'s' if n_oct != 1 else ''} to fit"

        return jsonify({
            "title": title,
            "model": model["name"],
            "model_id": model_id,
            "low": model["low"],
            "high": model["high"],
            "notes": result,
            "transposed": transposed_msg,
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        if audio_path and os.path.exists(audio_path):
            os.remove(audio_path)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    debug = os.environ.get('FLASK_DEBUG', '0') == '1'
    app.run(debug=debug, host='0.0.0.0', port=port)
