/**
 * Procedural sound effects via WebAudio — no audio files, no licensing, tiny download.
 * Mobile browsers require unlock() to be called from a user gesture.
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  muted = false;

  unlock(): void {
    if (this.ctx) { void this.ctx.resume(); return; }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    const comp = this.ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 0.5;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    void this.ctx.resume();
  }

  private live(): { ctx: AudioContext; master: GainNode; noise: AudioBuffer } | null {
    if (!this.ctx || !this.master || !this.noise || this.muted || this.ctx.state !== 'running') return null;
    return { ctx: this.ctx, master: this.master, noise: this.noise };
  }

  /** Output for one sound: straight to the master, or through a stereo panner (-1 left … 1 right). */
  private out(a: { ctx: AudioContext; master: GainNode }, pan: number): AudioNode {
    if (!pan || !a.ctx.createStereoPanner) return a.master;
    const p = a.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(a.master);
    return p;
  }

  private burst(dur: number, freq: number, q: number, gain: number, type: BiquadFilterType = 'lowpass', delay = 0, pan = 0): void {
    const a = this.live();
    if (!a) return;
    const t = a.ctx.currentTime + delay;
    const src = a.ctx.createBufferSource();
    src.buffer = a.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = a.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = a.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.out(a, pan));
    src.start(t, Math.random() * 0.3);
    src.stop(t + dur + 0.02);
  }

  private tone(freq: number, endFreq: number, dur: number, gain: number, type: OscillatorType = 'sine', delay = 0, pan = 0): void {
    const a = this.live();
    if (!a) return;
    const t = a.ctx.currentTime + delay;
    const o = a.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    const g = a.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.out(a, pan));
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  gunshot(): void {
    this.burst(0.18, 3200, 0.7, 0.9);
    this.burst(0.05, 7000, 0.5, 0.5, 'highpass');
    this.tone(150, 45, 0.16, 0.9);
  }
  /** SMG: shorter, deeper, punchier report (fires ~12/s, so it must not smear). */
  smgShot(): void {
    this.burst(0.09, 1700, 0.8, 0.8);
    this.burst(0.03, 5000, 0.6, 0.35, 'highpass');
    this.tone(95 + Math.random() * 15, 38, 0.11, 1.0);
  }
  /** Material-specific impact: concrete = dry crack, wood = dull thock, metal = ringing ping. */
  impact(m: 'concrete' | 'wood' | 'metal' | 'flesh'): void {
    if (m === 'flesh') { this.burst(0.1, 500, 1.2, 0.45); this.tone(110, 60, 0.08, 0.35); return; }
    if (m === 'concrete') { this.burst(0.06, 2400, 1.5, 0.28, 'bandpass'); return; }
    if (m === 'wood') { this.burst(0.08, 700, 2, 0.35, 'bandpass'); this.tone(220, 120, 0.06, 0.15, 'triangle'); return; }
    this.burst(0.03, 5000, 3, 0.2, 'bandpass');
    this.tone(1800 + Math.random() * 600, 1500, 0.25, 0.12, 'sine');
  }
  /** Body/limb hitting the ground or a wall: heavy thud, or a lighter tap for small limbs. */
  thud(volume: number, light: boolean): void {
    if (light) { this.burst(0.05, 900, 2, 0.25 * volume, 'bandpass'); return; }
    this.burst(0.12, 380, 1, 0.55 * volume);
    this.tone(90, 45, 0.1, 0.4 * volume);
  }
  playerHurt(): void { this.burst(0.15, 700, 1, 0.5); this.tone(160, 90, 0.18, 0.35, 'sawtooth'); }
  playerDeath(): void { this.tone(220, 40, 1.2, 0.5, 'sawtooth'); this.burst(0.8, 300, 0.7, 0.5); }
  pickup(): void { this.tone(660, 990, 0.08, 0.2, 'square'); this.tone(990, 1320, 0.1, 0.18, 'square', 0.08); }
  waveStart(): void { this.tone(110, 90, 0.9, 0.5, 'sawtooth'); this.tone(165, 120, 0.9, 0.3, 'sawtooth', 0.1); this.burst(0.6, 300, 0.7, 0.3); }
  waveClear(): void { [523, 659, 784].forEach((f, i) => this.tone(f, f, 0.18, 0.18, 'triangle', i * 0.12)); }
  shotgun(): void { this.burst(0.35, 1400, 0.6, 1.2); this.burst(0.08, 6000, 0.5, 0.5, 'highpass'); this.tone(90, 32, 0.3, 1.2); }
  shellIn(): void { this.burst(0.04, 2200, 5, 0.35, 'bandpass'); this.tone(500, 420, 0.03, 0.08, 'square', 0.02); }
  pump(delay = 0): void { this.burst(0.05, 1500, 4, 0.4, 'bandpass', delay); this.burst(0.06, 900, 4, 0.4, 'bandpass', delay + 0.12); }
  hiss(): void { this.burst(0.9, 5000, 0.8, 0.25, 'highpass'); }
  dismember(): void { this.burst(0.18, 600, 1, 0.6); this.tone(80, 40, 0.2, 0.5); this.burst(0.25, 1800, 0.8, 0.25, 'lowpass', 0.05); }
  explosion(): void {
    this.burst(0.9, 600, 0.5, 1.2);
    this.burst(0.3, 2500, 0.5, 0.6);
    this.tone(70, 25, 0.8, 1.2);
  }
  /** Active reload: bright double click on success, dull clunk on a fumble. */
  activeReload(success: boolean): void {
    if (success) { this.tone(1400, 1600, 0.05, 0.18, 'square'); this.tone(2000, 2100, 0.06, 0.15, 'square', 0.06); }
    else { this.burst(0.12, 400, 2, 0.4, 'bandpass'); }
  }
  throwGrenade(): void { this.burst(0.18, 900, 1.5, 0.3, 'bandpass'); this.tone(1400, 1100, 0.04, 0.08, 'square'); }
  beep(): void { this.tone(2200, 2200, 0.05, 0.1, 'square'); }
  clink(): void { this.tone(2600 + Math.random() * 600, 2000, 0.06, 0.12, 'triangle'); this.burst(0.03, 3000, 4, 0.2, 'bandpass'); }
  dry(): void { this.burst(0.03, 4000, 4, 0.3, 'bandpass'); }
  reloadStart(): void { this.burst(0.05, 1800, 6, 0.35, 'bandpass'); this.burst(0.04, 1200, 6, 0.3, 'bandpass', 0.12); }
  reloadEnd(): void { this.burst(0.05, 2500, 6, 0.4, 'bandpass'); this.tone(900, 700, 0.04, 0.12, 'square', 0.05); }
  // ── Horror audio (vol 0..1 from distance, pan -1..1 from screen side) ──

  /**
   * Throaty voice: two detuned saws gliding f0 → f1 through a resonant lowpass (the "mouth"),
   * a slow wobble, plus breathy rasp. All zombie vocals are built from this.
   */
  private voice(f0: number, f1: number, dur: number, gain: number, cutoff: number, rasp: number, pan: number): void {
    const a = this.live();
    if (!a || gain < 0.01) return;
    const t = a.ctx.currentTime, out = this.out(a, pan);
    const f = a.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.Q.value = 6;
    f.frequency.setValueAtTime(cutoff * 0.6, t);
    f.frequency.linearRampToValueAtTime(cutoff, t + dur * 0.3);
    f.frequency.linearRampToValueAtTime(cutoff * 0.5, t + dur);
    const g = a.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.12, dur * 0.25));
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    f.connect(g).connect(out);
    for (const det of [0, 6 + Math.random() * 5]) {
      const o = a.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f0 + det, t);
      o.frequency.linearRampToValueAtTime((f0 + f1) / 2 + det * 1.4, t + dur * 0.4);
      o.frequency.linearRampToValueAtTime(f1 + det, t + dur);
      o.connect(f);
      o.start(t); o.stop(t + dur + 0.05);
    }
    if (rasp > 0) this.burst(dur * 0.9, cutoff * 1.6, 1.2, gain * rasp, 'bandpass', 0, pan);
  }

  /** A zombie's idle growl / moan, per type. */
  growl(kind: string, vol: number, pan: number): void {
    const r = Math.random();
    if (kind === 'brute') this.voice(55 + r * 10, 42, 1.1 + r * 0.4, 0.5 * vol, 420, 0.5, pan);
    else if (kind === 'runner') this.voice(190 + r * 40, 140, 0.45 + r * 0.2, 0.2 * vol, 1500, 0.8, pan);
    else if (kind === 'exploder') { this.voice(95 + r * 15, 70, 0.9, 0.35 * vol, 650, 0.3, pan); this.burst(0.5, 260, 6, 0.3 * vol, 'bandpass', 0.2, pan); } // wet gurgle
    else this.voice(85 + r * 25, 65 + r * 10, 0.8 + r * 0.5, 0.4 * vol, 700, 0.5, pan);
  }

  /** Sharp snarl when a zombie starts its swing: the audio cue to dodge. */
  snarl(vol: number, pan: number): void {
    this.voice(150 + Math.random() * 30, 230, 0.32, 0.6 * vol, 1800, 1, pan);
  }

  /** Dragging, shuffling footstep. */
  step(vol: number, pan: number, heavy = false): void {
    this.burst(heavy ? 0.12 : 0.08, heavy ? 260 : 520, 1.5, (heavy ? 0.75 : 0.45) * vol, 'lowpass', 0, pan);
  }

  /** A distant, reverb-ish moan somewhere in the dark. */
  distantMoan(pan: number): void {
    this.voice(70 + Math.random() * 20, 55, 2.2, 0.12, 380, 0.25, pan);
  }

  /** Heartbeat (low health): lub-dub. */
  heartbeat(vol: number): void {
    this.tone(62, 48, 0.12, 0.7 * vol);
    this.tone(55, 42, 0.14, 0.5 * vol, 'sine', 0.17);
  }

  /** Looping low wind drone (started once). */
  private ambience: AudioBufferSourceNode | null = null;
  startAmbience(): void {
    const a = this.live();
    if (!a || this.ambience) return;
    const src = a.ctx.createBufferSource();
    src.buffer = a.noise; src.loop = true; src.playbackRate.value = 0.35;
    const f = a.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 320; f.Q.value = 0.7;
    const g = a.ctx.createGain();
    g.gain.value = 0.07;
    // Slow gusts.
    const lfo = a.ctx.createOscillator(), depth = a.ctx.createGain();
    lfo.frequency.value = 0.09; depth.gain.value = 0.04;
    lfo.connect(depth).connect(g.gain);
    src.connect(f).connect(g).connect(a.master);
    src.start(); lfo.start();
    this.ambience = src;
  }

  casing(): void { this.tone(4200 + Math.random() * 1200, 3800, 0.05, 0.05, 'triangle', 0.25 + Math.random() * 0.1); }
}
