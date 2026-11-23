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

  private burst(dur: number, freq: number, q: number, gain: number, type: BiquadFilterType = 'lowpass', delay = 0): void {
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
    src.connect(f).connect(g).connect(a.master);
    src.start(t, Math.random() * 0.3);
    src.stop(t + dur + 0.02);
  }

  private tone(freq: number, endFreq: number, dur: number, gain: number, type: OscillatorType = 'sine', delay = 0): void {
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
    o.connect(g).connect(a.master);
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
  dry(): void { this.burst(0.03, 4000, 4, 0.3, 'bandpass'); }
  reloadStart(): void { this.burst(0.05, 1800, 6, 0.35, 'bandpass'); this.burst(0.04, 1200, 6, 0.3, 'bandpass', 0.12); }
  reloadEnd(): void { this.burst(0.05, 2500, 6, 0.4, 'bandpass'); this.tone(900, 700, 0.04, 0.12, 'square', 0.05); }
  casing(): void { this.tone(4200 + Math.random() * 1200, 3800, 0.05, 0.05, 'triangle', 0.25 + Math.random() * 0.1); }
}
