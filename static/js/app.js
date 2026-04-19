document.addEventListener('DOMContentLoaded', () => {

    const state = {
        model: 'neo',
        tab: 'youtube',
        file: null,
        notes: [],        // [{time, note, percent, original_note}]
        lowMidi: 60,
        highMidi: 84,
        playbackId: null,
    };

    let models = {};

    // ─── Web Audio — Otamatone synth (vocal-ish) ───
    let audioCtx = null;
    function ensureAudio() {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        return audioCtx;
    }

    const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
    function noteToMidi(noteName) {
        const m = noteName.match(/^([A-G][b#]?)(\d+)$/);
        if (!m) return 69;
        const idx = NOTE_NAMES.indexOf(m[1]);
        if (idx < 0) return 69;
        return 12 + parseInt(m[2]) * 12 + idx;
    }
    function noteToFreq(noteName) {
        return 440 * Math.pow(2, (noteToMidi(noteName) - 69) / 12);
    }

    // Otamatone's signature sound: sawtooth carrier with vibrato and a
    // resonant low-pass sweep that mimics the "mouth wah"
    function playNote(noteName, duration = 0.35) {
        const ctx = ensureAudio();
        const freq = noteToFreq(noteName);
        const now = ctx.currentTime;

        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = freq;

        // Vibrato LFO
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 6;
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = freq * 0.012;
        lfo.connect(lfoGain);
        lfoGain.connect(osc.frequency);

        // Resonant lowpass sweep (the "waa waa")
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.Q.value = 8;
        filter.frequency.setValueAtTime(freq * 1.5, now);
        filter.frequency.exponentialRampToValueAtTime(freq * 5, now + duration * 0.35);
        filter.frequency.exponentialRampToValueAtTime(freq * 2, now + duration);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.12, now + 0.02);
        gain.gain.setValueAtTime(0.12, now + duration - 0.05);
        gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        lfo.start(now);
        osc.stop(now + duration + 0.05);
        lfo.stop(now + duration + 0.05);

        // Animate the mouth
        const mouth = document.getElementById('sim-mouth');
        if (mouth) {
            mouth.classList.add('open');
            setTimeout(() => mouth.classList.remove('open'), duration * 900);
        }
    }

    // ─── Load Models ───
    fetch('/api/models').then(r => r.json()).then(data => {
        models = data;
        applyModel();
    });

    const modelSelect = document.getElementById('model-select');
    modelSelect.addEventListener('change', () => {
        state.model = modelSelect.value;
        applyModel();
    });

    function applyModel() {
        const m = models[state.model];
        if (!m) return;
        state.lowMidi = noteToMidi(m.low);
        state.highMidi = noteToMidi(m.high);
        buildStemLabels();
    }

    function buildStemLabels() {
        const labels = document.getElementById('stem-labels');
        labels.innerHTML = '';
        const naturals = new Set([0, 2, 4, 5, 7, 9, 11]); // C D E F G A B
        const span = state.highMidi - state.lowMidi;
        const markers = [];
        for (let m = state.highMidi; m >= state.lowMidi; m--) {
            if (naturals.has((m - 12) % 12)) markers.push(m);
        }
        markers.forEach((midi, i) => {
            const octave = Math.floor((midi - 12) / 12);
            const idx = (midi - 12) % 12;
            const pctFromTop = 100 - ((midi - state.lowMidi) / Math.max(1, span)) * 100;
            const el = document.createElement('span');
            el.textContent = `${NOTE_NAMES[idx]}${octave}`;
            el.style.top = pctFromTop + '%';
            if (idx === 0) el.className = i === 0 ? 'hi c-mark' : 'c-mark';
            labels.appendChild(el);
        });
    }

    // Click on stem = play the note at that position
    const stem = document.getElementById('sim-stem');
    const indicator = document.getElementById('stem-indicator');
    stem.addEventListener('click', (e) => {
        const rect = stem.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const percentFromTop = (y / rect.height) * 100;
        const percent = 100 - percentFromTop; // 100 = top = high
        const span = state.highMidi - state.lowMidi;
        const midi = state.lowMidi + Math.round((percent / 100) * span);
        const octave = Math.floor((midi - 12) / 12);
        const idx = (midi - 12) % 12;
        const note = `${NOTE_NAMES[idx]}${octave}`;
        playNote(note, 0.45);
        showIndicator(percent);
    });

    function showIndicator(percent) {
        indicator.classList.add('active');
        indicator.style.top = `${100 - percent}%`;
    }

    // ─── Presets ───
    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const notesFile = btn.dataset.notes;
            const audioFile = btn.dataset.file;
            const label = btn.textContent.trim();

            // Hardcoded-notes preset: skip backend, render directly
            if (notesFile) {
                try {
                    const resp = await fetch(`/static/presets/${notesFile}`);
                    if (!resp.ok) throw new Error(`Could not load ${notesFile}`);
                    const data = await resp.json();
                    errorMsg.classList.remove('active');
                    renderResults(data);
                } catch (err) {
                    showError(err.message);
                }
                return;
            }

            // Audio preset: same as upload flow
            try {
                const resp = await fetch(`/static/audio/${audioFile}`);
                if (!resp.ok) throw new Error(`Could not load ${audioFile}`);
                const blob = await resp.blob();
                state.file = new File([blob], audioFile, { type: blob.type || 'audio/ogg' });
                document.querySelector('.input-tab[data-tab="upload"]').click();
                document.getElementById('file-name').textContent = label;
                if (btn.dataset.maxDuration) {
                    const dur = document.getElementById('duration');
                    dur.value = btn.dataset.maxDuration;
                    dur.dispatchEvent(new Event('input'));
                }
                document.getElementById('convert-btn').click();
            } catch (err) {
                showError(err.message);
            }
        });
    });

    // ─── Tabs ───
    document.querySelectorAll('.input-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.input-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
            state.tab = tab.dataset.tab;
        });
    });

    // ─── File Upload ───
    const dropZone = document.getElementById('file-drop');
    const fileInput = document.getElementById('file-input');
    const fileName = document.getElementById('file-name');

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', e => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length) {
            state.file = e.dataTransfer.files[0];
            fileName.textContent = state.file.name;
        }
    });
    fileInput.addEventListener('change', () => {
        if (fileInput.files.length) {
            state.file = fileInput.files[0];
            fileName.textContent = state.file.name;
        }
    });

    // ─── Duration Slider ───
    const durSlider = document.getElementById('duration');
    const durVal = document.getElementById('dur-val');
    durSlider.addEventListener('input', () => { durVal.textContent = `${durSlider.value}s`; });

    // ─── Tempo ───
    const tempoSlider = document.getElementById('sim-tempo');
    const tempoVal = document.getElementById('sim-tempo-val');
    tempoSlider.addEventListener('input', () => { tempoVal.textContent = `${tempoSlider.value}x`; });

    // ─── Playback ───
    document.getElementById('sim-play').addEventListener('click', () => {
        if (!state.notes.length) return;
        stopPlayback();
        const speed = parseFloat(tempoSlider.value);
        let i = 0;
        const seqNums = document.querySelectorAll('#seq-numbers .seq-num');

        function step() {
            if (i >= state.notes.length) {
                setTimeout(() => {
                    seqNums.forEach(s => s.classList.remove('playing'));
                    indicator.classList.remove('active');
                }, 300);
                state.playbackId = null;
                return;
            }

            const n = state.notes[i];
            let delayMs = 400;
            if (i < state.notes.length - 1) {
                const gap = state.notes[i + 1].time - n.time;
                delayMs = (gap / speed) * 1000;
                delayMs = Math.max(120, Math.min(delayMs, 3000));
            }

            const noteDur = Math.min(delayMs / 1000 * 0.9, 1.0);
            playNote(n.note, noteDur);
            showIndicator(n.percent);

            seqNums.forEach(s => s.classList.remove('playing'));
            if (seqNums[i]) seqNums[i].classList.add('playing');

            i++;
            state.playbackId = setTimeout(step, delayMs);
        }
        step();
    });

    document.getElementById('sim-stop').addEventListener('click', stopPlayback);

    function stopPlayback() {
        if (state.playbackId) {
            clearTimeout(state.playbackId);
            state.playbackId = null;
        }
        document.querySelectorAll('.seq-num').forEach(s => s.classList.remove('playing'));
        indicator.classList.remove('active');
    }

    // ─── Convert ───
    const convertBtn = document.getElementById('convert-btn');
    const loading = document.getElementById('loading');
    const errorMsg = document.getElementById('error-msg');
    const results = document.getElementById('results');

    convertBtn.addEventListener('click', async () => {
        errorMsg.classList.remove('active');
        results.classList.remove('active');
        loading.classList.add('active');
        convertBtn.disabled = true;

        const formData = new FormData();
        formData.append('model', state.model);
        formData.append('max_duration', durSlider.value);

        if (state.tab === 'youtube') {
            const url = document.getElementById('youtube-url').value.trim();
            if (!url) { showError('Please enter a YouTube URL'); return; }
            formData.append('youtube_url', url);
        } else {
            if (!state.file) { showError('Please select an audio file'); return; }
            formData.append('audio_file', state.file);
        }

        try {
            const resp = await fetch('/api/convert', { method: 'POST', body: formData });
            const data = await resp.json();
            if (!resp.ok) { showError(data.error || 'Something went wrong'); return; }
            renderResults(data);
        } catch (err) {
            showError('Connection failed. Is the server running?');
        } finally {
            loading.classList.remove('active');
            convertBtn.disabled = false;
        }
    });

    function showError(msg) {
        loading.classList.remove('active');
        convertBtn.disabled = false;
        errorMsg.textContent = msg;
        errorMsg.classList.add('active');
    }

    // ─── Render Results ───
    function renderResults(data) {
        results.classList.add('active');
        document.querySelector('.stage')?.classList.add('has-results');
        state.notes = data.notes;
        state.lowMidi = noteToMidi(data.low);
        state.highMidi = noteToMidi(data.high);
        buildStemLabels();

        document.getElementById('result-title').textContent = data.title;
        let metaHtml = `${data.model}<br>${data.notes.length} notes detected`;
        if (data.transposed) {
            metaHtml += `<br><span style="color:var(--pink);font-style:italic">${data.transposed}</span>`;
        }
        document.getElementById('result-meta').innerHTML = metaHtml;

        renderSequence();
        renderTimeline();
        setupCopyButtons();

        document.getElementById('timeline-toggle').onclick = () => {
            document.getElementById('timeline').classList.toggle('active');
        };

        // results panel already positioned in viewport — no scroll needed
    }

    // Back to controls
    const backBtn = document.getElementById('results-back');
    if (backBtn) {
        backBtn.addEventListener('click', () => {
            results.classList.remove('active');
            document.querySelector('.stage')?.classList.remove('has-results');
            stopPlayback();
        });
    }

    function renderSequence() {
        const seqContainer = document.getElementById('seq-numbers');
        seqContainer.innerHTML = '';

        let prevTime = 0;
        state.notes.forEach((n, i) => {
            if (i > 0 && n.time - prevTime > 0.5) {
                const br = document.createElement('div');
                br.className = 'seq-break';
                seqContainer.appendChild(br);
            }
            const span = document.createElement('span');
            span.className = 'seq-num';
            span.textContent = n.note;
            span.title = `${n.time}s — ${n.percent}% along stem`;
            span.dataset.index = i;

            span.addEventListener('click', (e) => {
                if (e.shiftKey) {
                    state.notes.splice(i, 1);
                    renderSequence();
                    renderTimeline();
                    return;
                }
                playNote(n.note, 0.35);
                showIndicator(n.percent);
            });

            seqContainer.appendChild(span);
            prevTime = n.time;
        });
    }

    document.getElementById('seq-clear').addEventListener('click', () => {
        if (!state.notes.length) return;
        state.notes = [];
        renderSequence();
        renderTimeline();
    });

    function renderTimeline() {
        const timeline = document.getElementById('timeline-body');
        timeline.innerHTML = '';
        state.notes.forEach(n => {
            const row = document.createElement('div');
            row.className = 'timeline-row';
            row.innerHTML = `
                <span class="t-time">${n.time.toFixed(2)}s</span>
                <span class="t-note">${n.note}</span>
                <span class="t-pct">${n.percent}%</span>
                <span class="t-orig">${n.original_note}</span>
            `;
            timeline.appendChild(row);
        });
    }

    function setupCopyButtons() {
        document.getElementById('copy-notes').onclick = () => {
            const text = state.notes.map(n => n.note).join(' ');
            navigator.clipboard.writeText(text).then(() => {
                const btn = document.getElementById('copy-notes');
                const orig = btn.textContent;
                btn.textContent = 'COPIED!';
                setTimeout(() => { btn.textContent = orig; }, 1500);
            });
        };

        document.getElementById('copy-full').onclick = () => {
            const lines = state.notes.map(n => `${n.time.toFixed(2)}s  ${n.note}  ${n.percent}%`);
            navigator.clipboard.writeText(lines.join('\n'));
            const btn = document.getElementById('copy-full');
            const orig = btn.textContent;
            btn.textContent = 'COPIED!';
            setTimeout(() => { btn.textContent = orig; }, 1500);
        };
    }
});
