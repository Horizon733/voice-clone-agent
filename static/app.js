/* ============================================================
   droidcity_ Voice Studio — Frontend
   ============================================================ */

const API = '/api';

const state = {
    voices: [],
    languages: [],
    presetSpeakers: [],
};

// ============================================================
// API client
// ============================================================

async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body) {
        if (body instanceof FormData) {
            opts.body = body;
        } else {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
    }
    const res = await fetch(API + path, opts);
    if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail || `HTTP ${res.status}`);
    }
    return res.json();
}

// ============================================================
// Toast notifications
// ============================================================

function toast(msg, type = 'success') {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = msg;
    container.appendChild(el);
    setTimeout(() => {
        el.style.opacity = '0';
        el.style.transition = 'opacity 0.3s';
        setTimeout(() => el.remove(), 300);
    }, 4000);
}

// ============================================================
// Status indicator
// ============================================================

function setStatus(working, label) {
    const ind = document.getElementById('status-indicator');
    const text = ind.querySelector('.status-text');
    if (working) {
        ind.classList.add('working');
        text.textContent = label || 'WORKING';
    } else {
        ind.classList.remove('working');
        text.textContent = 'IDLE';
    }
}

// ============================================================
// Tab switching
// ============================================================

document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const target = tab.dataset.tab;
        switchTab(target);
    });
});

function switchTab(target) {
    document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === target);
    });
    document.querySelectorAll('.pane').forEach(p => {
        p.classList.toggle('active', p.dataset.pane === target);
    });
}

// Delegated handler: any element with data-go-tab="X" switches to that tab
document.addEventListener('click', e => {
    const trigger = e.target.closest('[data-go-tab]');
    if (trigger) {
        e.preventDefault();
        switchTab(trigger.dataset.goTab);
    }
});

// ============================================================
// Slider value sync
// ============================================================

document.querySelectorAll('input[type="range"]').forEach(slider => {
    const valEl = document.getElementById(slider.id + '-val');
    if (valEl) {
        slider.addEventListener('input', () => {
            valEl.textContent = slider.value;
        });
    }
});

// ============================================================
// Populate dropdowns
// ============================================================

function fillSelect(selectEl, items, currentValue) {
    selectEl.innerHTML = '';
    items.forEach(item => {
        const opt = document.createElement('option');
        opt.value = typeof item === 'string' ? item : item.value;
        opt.textContent = typeof item === 'string' ? item : item.label;
        if (item === currentValue || (typeof item === 'object' && item.value === currentValue)) {
            opt.selected = true;
        }
        selectEl.appendChild(opt);
    });
}

function refreshVoiceDropdowns() {
    const names = state.voices.map(v => v.name);
    const hasVoices = names.length > 0;

    ['clone', 'batch'].forEach(prefix => {
        const container = document.getElementById(`${prefix}-voice-selector`);
        const hidden = document.getElementById(`${prefix}-voice`);
        const hint = document.getElementById(`${prefix}-voice-hint`);
        if (!container || !hidden) return;

        // Preserve current selection if still valid
        const current = hidden.value;

        // Clear existing cards (keep the empty hint node)
        container.querySelectorAll('.voice-card').forEach(el => el.remove());

        if (!hasVoices) {
            if (hint) hint.style.display = 'block';
            hidden.value = '';
            return;
        }

        if (hint) hint.style.display = 'none';

        // Pick selection: keep current if valid, else first
        const selected = names.includes(current) ? current : names[0];
        hidden.value = selected;

        state.voices.forEach(v => {
            const card = document.createElement('div');
            card.className = 'voice-card' + (v.name === selected ? ' selected' : '');
            card.dataset.voice = v.name;
            card.innerHTML = `
                <div class="voice-card-icon">🎙</div>
                <div class="voice-card-info">
                    <div class="voice-card-name">${escapeHtml(v.name)}</div>
                    <div class="voice-card-transcript">${escapeHtml(v.transcript || '')}</div>
                </div>
            `;
            card.addEventListener('click', () => {
                container.querySelectorAll('.voice-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                hidden.value = v.name;
            });
            container.appendChild(card);
        });
    });
}

// ============================================================
// Voice library rendering
// ============================================================

function renderVoiceList() {
    const container = document.getElementById('lib-list');
    if (state.voices.length === 0) {
        container.innerHTML = '<div class="empty-text" style="padding: 24px 0;">No voices yet</div>';
        return;
    }

    container.innerHTML = '';
    state.voices.forEach(v => {
        const item = document.createElement('div');
        item.className = 'voice-item';
        item.innerHTML = `
            <div class="voice-item-header">
                <div class="voice-item-name">${escapeHtml(v.name)}</div>
                <button class="btn btn-danger btn-ghost" data-delete="${escapeHtml(v.name)}">Delete</button>
            </div>
            <div class="voice-item-transcript">${escapeHtml(v.transcript)}</div>
            <audio controls src="/api/voices/${encodeURIComponent(v.name)}/audio"></audio>
        `;
        container.appendChild(item);
    });

    container.querySelectorAll('[data-delete]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.dataset.delete;
            if (!confirm(`Delete voice "${name}"?`)) return;
            try {
                await api('DELETE', `/voices/${encodeURIComponent(name)}`);
                toast(`Deleted <strong>${escapeHtml(name)}</strong>`);
                await loadVoices();
            } catch (e) {
                toast(`Failed: ${escapeHtml(e.message)}`, 'error');
            }
        });
    });
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// ============================================================
// Voice library — load + add
// ============================================================

async function loadVoices() {
    try {
        state.voices = await api('GET', '/voices');
        renderVoiceList();
        refreshVoiceDropdowns();
    } catch (e) {
        toast(`Failed to load voices: ${escapeHtml(e.message)}`, 'error');
    }
}

// Auto-transcribe when user uploads audio in the Library tab
// Save button stays disabled until transcription succeeds
document.getElementById('lib-save').disabled = true;

document.getElementById('lib-audio').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const saveBtn = document.getElementById('lib-save');
    const transcriptEl = document.getElementById('lib-transcript');

    if (!file) {
        saveBtn.disabled = true;
        return;
    }

    saveBtn.disabled = true;
    transcriptEl.value = '';
    transcriptEl.disabled = true;
    transcriptEl.placeholder = 'Transcribing with AI… please wait';

    try {
        const fd = new FormData();
        fd.append('audio', file);
        const res = await api('POST', '/transcribe', fd);
        transcriptEl.value = res.transcript || '';

        if (res.transcript) {
            toast(`Auto-transcribed (${res.language || 'detected'}) — review and save`);
            saveBtn.disabled = false;
        } else {
            toast('Could not detect speech in audio. Type the transcript manually.', 'error');
            saveBtn.disabled = false;
        }
    } catch (err) {
        toast(`Transcription failed: ${escapeHtml(err.message)}. Type the transcript manually.`, 'error');
        transcriptEl.value = '';
        saveBtn.disabled = false;
    } finally {
        transcriptEl.disabled = false;
        transcriptEl.placeholder = 'Review the AI transcript or type your own…';
        transcriptEl.focus();
    }
});

document.getElementById('lib-save').addEventListener('click', async () => {
    const name = document.getElementById('lib-name').value.trim();
    const transcript = document.getElementById('lib-transcript').value.trim();
    const audioInput = document.getElementById('lib-audio');
    const audio = audioInput.files[0];

    if (!name) return toast('Voice name is required', 'error');
    if (!audio) return toast('Reference audio is required', 'error');
    if (!transcript) return toast('Transcript is required', 'error');

    const fd = new FormData();
    fd.append('name', name);
    fd.append('transcript', transcript);
    fd.append('audio', audio);

    const btn = document.getElementById('lib-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    try {
        await api('POST', '/voices', fd);
        toast(`Saved <strong>${escapeHtml(name)}</strong>`);
        document.getElementById('lib-name').value = '';
        document.getElementById('lib-transcript').value = '';
        audioInput.value = '';
        await loadVoices();
    } catch (e) {
        toast(`Failed: ${escapeHtml(e.message)}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Save voice';
    }
});

// ============================================================
// Output rendering
// ============================================================

function showOutput(paneName, items, opts = {}) {
    const list = document.getElementById(`${paneName}-output`);
    const empty = document.getElementById(`${paneName}-empty`);
    empty.classList.add('hidden');
    list.innerHTML = '';

    items.forEach(item => {
        const el = document.createElement('div');
        el.className = 'output-item';

        const title = item.title || (item.take !== undefined ? `Take ${item.take}` : item.filename || 'Output');
        const scriptLine = item.script
            ? `<div class="output-item-script">"${escapeHtml(item.script)}"</div>`
            : '';

        if (item.url) {
            el.innerHTML = `
                <div class="output-item-header">
                    <div class="output-item-title">${escapeHtml(title)}</div>
                    <a class="btn btn-ghost" href="${item.url}" download="${escapeHtml(item.filename || 'audio.wav')}">Download</a>
                </div>
                ${scriptLine}
                <audio controls src="${item.url}"></audio>
            `;
        } else {
            el.innerHTML = `
                <div class="output-item-header">
                    <div class="output-item-title">${escapeHtml(title)} — failed</div>
                </div>
                ${scriptLine}
                <div class="empty-text">${escapeHtml(item.error || 'unknown error')}</div>
            `;
        }
        list.appendChild(el);
    });
}

function clearOutput(paneName) {
    const list = document.getElementById(`${paneName}-output`);
    const empty = document.getElementById(`${paneName}-empty`);
    list.innerHTML = '';
    empty.classList.remove('hidden');
}

// ============================================================
// Generate — Clone
// ============================================================

document.getElementById('clone-generate').addEventListener('click', async () => {
    const voice = document.getElementById('clone-voice').value;
    const script = document.getElementById('clone-script').value.trim();

    if (!voice) return toast('Add a voice in the Library first', 'error');
    if (!script) return toast('Script is empty', 'error');

    const btn = document.getElementById('clone-generate');
    btn.disabled = true;
    btn.querySelector('.btn-label').textContent = 'Generating…';
    setStatus(true, 'GENERATING');
    clearOutput('clone');

    try {
        const res = await api('POST', '/generate/clone', {
            voice_name: voice,
            script,
            language: document.getElementById('clone-language').value,
            temperature: parseFloat(document.getElementById('clone-temp').value),
            top_p: parseFloat(document.getElementById('clone-top-p').value),
            top_k: parseInt(document.getElementById('clone-top-k').value),
            num_takes: parseInt(document.getElementById('clone-takes').value),
        });
        showOutput('clone', res.takes);
        toast(`Generated <strong>${res.count}</strong> take${res.count > 1 ? 's' : ''}`);
    } catch (e) {
        toast(`Failed: ${escapeHtml(e.message)}`, 'error');
    } finally {
        btn.disabled = false;
        btn.querySelector('.btn-label').textContent = 'Generate';
        setStatus(false);
    }
});

// ============================================================
// Generate — Batch
// ============================================================

document.getElementById('batch-generate').addEventListener('click', async () => {
    const voice = document.getElementById('batch-voice').value;
    const scriptsText = document.getElementById('batch-scripts').value;
    const scripts = scriptsText.split('\n').map(s => s.trim()).filter(s => s);

    if (!voice) return toast('Add a voice in the Library first', 'error');
    if (scripts.length === 0) return toast('Add at least one script', 'error');

    const btn = document.getElementById('batch-generate');
    btn.disabled = true;
    btn.querySelector('.btn-label').textContent = `Generating ${scripts.length} clips…`;
    setStatus(true, `BATCH ${scripts.length}`);
    clearOutput('batch');

    try {
        const res = await api('POST', '/generate/batch', {
            voice_name: voice,
            scripts,
            language: document.getElementById('batch-language').value,
            temperature: parseFloat(document.getElementById('batch-temp').value),
            top_p: parseFloat(document.getElementById('batch-top-p').value),
            top_k: parseInt(document.getElementById('batch-top-k').value),
        });
        showOutput('batch', res.clips);
        toast(`<strong>${res.succeeded} / ${res.total}</strong> clips ready`);
    } catch (e) {
        toast(`Failed: ${escapeHtml(e.message)}`, 'error');
    } finally {
        btn.disabled = false;
        btn.querySelector('.btn-label').textContent = 'Generate batch';
        setStatus(false);
    }
});

// ============================================================
// Generate — Preset
// ============================================================

document.getElementById('preset-generate').addEventListener('click', async () => {
    const script = document.getElementById('preset-script').value.trim();
    if (!script) return toast('Script is empty', 'error');

    const btn = document.getElementById('preset-generate');
    btn.disabled = true;
    btn.querySelector('.btn-label').textContent = 'Generating…';
    setStatus(true, 'PRESET');
    clearOutput('presets');

    try {
        const res = await api('POST', '/generate/preset', {
            speaker: document.getElementById('preset-speaker').value,
            script,
            language: document.getElementById('preset-language').value,
            instruction: document.getElementById('preset-instruction').value.trim() || null,
            temperature: parseFloat(document.getElementById('preset-temp').value),
            top_p: parseFloat(document.getElementById('preset-top-p').value),
            top_k: parseInt(document.getElementById('preset-top-k').value),
        });
        showOutput('presets', [res]);
        toast('Generated');
    } catch (e) {
        toast(`Failed: ${escapeHtml(e.message)}`, 'error');
    } finally {
        btn.disabled = false;
        btn.querySelector('.btn-label').textContent = 'Generate';
        setStatus(false);
    }
});

// ============================================================
// Generate — Design
// ============================================================

document.getElementById('design-generate').addEventListener('click', async () => {
    const script = document.getElementById('design-script').value.trim();
    const instruction = document.getElementById('design-instruction').value.trim();

    if (!script) return toast('Script is empty', 'error');
    if (!instruction) return toast('Voice description is required', 'error');

    const btn = document.getElementById('design-generate');
    btn.disabled = true;
    btn.querySelector('.btn-label').textContent = 'Designing…';
    setStatus(true, 'DESIGN');
    clearOutput('design');

    try {
        const res = await api('POST', '/generate/design', {
            script,
            instruction,
            language: document.getElementById('design-language').value,
            temperature: parseFloat(document.getElementById('design-temp').value),
            top_p: parseFloat(document.getElementById('design-top-p').value),
            top_k: parseInt(document.getElementById('design-top-k').value),
        });
        showOutput('design', [res]);
        toast('Voice designed');
    } catch (e) {
        toast(`Failed: ${escapeHtml(e.message)}`, 'error');
    } finally {
        btn.disabled = false;
        btn.querySelector('.btn-label').textContent = 'Design voice';
        setStatus(false);
    }
});

// ============================================================
// Init
// ============================================================

async function init() {
    try {
        const config = await api('GET', '/config');
        state.languages = config.languages;
        state.presetSpeakers = config.preset_speakers;

        // Fill all language dropdowns
        ['clone-language', 'batch-language', 'preset-language', 'design-language'].forEach(id => {
            fillSelect(document.getElementById(id), state.languages, 'English');
        });

        // Fill preset speaker dropdown
        fillSelect(document.getElementById('preset-speaker'), state.presetSpeakers);

        // Load voices
        await loadVoices();
    } catch (e) {
        toast(`Init failed: ${escapeHtml(e.message)}`, 'error');
    }
}

init();