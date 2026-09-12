/**
 * Mic capture worklet: converts Float32 frames to Int16 PCM and transfers them
 * to the main thread. The AudioContext is created at 24 kHz so no resampling is
 * needed before streaming to the Voice Agent API.
 */
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    const pcm = new Int16Array(channel.length);
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
