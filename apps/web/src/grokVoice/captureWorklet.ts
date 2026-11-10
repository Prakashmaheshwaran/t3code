// Runs in the AudioWorklet scope; the call's AudioContext already runs at 24 kHz, so frames pass
// straight through in 100 ms chunks.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class GrokCaptureProcessor extends AudioWorkletProcessor {
  private buffer = new Float32Array(2400);
  private length = 0;

  process(inputs: Float32Array[][]) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let index = 0; index < channel.length; index++) {
      this.buffer[this.length++] = channel[index]!;
      if (this.length === this.buffer.length) {
        const frame = this.buffer;
        this.buffer = new Float32Array(2400);
        this.length = 0;
        this.port.postMessage(frame, [frame.buffer]);
      }
    }
    return true;
  }
}

registerProcessor("grok-capture", GrokCaptureProcessor);
