// Decode any supported audio blob to 16 kHz mono Float32Array for Whisper.

export async function decodeToMono16k(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    if (audioBuffer.numberOfChannels === 1) {
      return audioBuffer.getChannelData(0).slice();
    }
    const out = new Float32Array(audioBuffer.length);
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      const ch = audioBuffer.getChannelData(c);
      for (let i = 0; i < audioBuffer.length; i++) out[i] += ch[i];
    }
    const n = audioBuffer.numberOfChannels;
    for (let i = 0; i < out.length; i++) out[i] /= n;
    return out;
  } finally {
    ctx.close();
  }
}
