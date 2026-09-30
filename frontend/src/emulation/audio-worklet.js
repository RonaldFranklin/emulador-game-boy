// The core emits stereo PCM at its own changing sample rate. This bounded
// in-memory queue resamples it to the browser's rate without persistent data.
class CartridgeAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = 32768;
    this.samples = new Float32Array(this.capacity * 2);
    this.readPosition = 0;
    this.writePosition = 0;
    this.ratio = 1;
    this.port.onmessage = ({ data }) => {
      if (data.clear) {
        this.readPosition = 0;
        this.writePosition = 0;
        this.samples.fill(0);
        return;
      }
      this.ratio = data.rate / sampleRate;
      const samples = data.samples;
      const count = samples.length / 2;
      if (this.writePosition - this.readPosition + count >= this.capacity) {
        this.readPosition = this.writePosition;
      }
      for (let index = 0; index < count; index += 1) {
        const offset = (this.writePosition % this.capacity) * 2;
        this.samples[offset] = samples[index * 2] / 32768;
        this.samples[offset + 1] = samples[index * 2 + 1] / 32768;
        this.writePosition += 1;
      }
    };
  }

  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    for (let index = 0; index < left.length; index += 1) {
      if (this.readPosition + 1 >= this.writePosition) {
        left[index] = right[index] = 0;
        continue;
      }
      const first = Math.floor(this.readPosition);
      const fraction = this.readPosition - first;
      const before = (first % this.capacity) * 2;
      const after = ((first + 1) % this.capacity) * 2;
      left[index] = this.samples[before] + (this.samples[after] - this.samples[before]) * fraction;
      right[index] = this.samples[before + 1] + (this.samples[after + 1] - this.samples[before + 1]) * fraction;
      this.readPosition += this.ratio;
    }
    return true;
  }
}

registerProcessor('cartridge-audio', CartridgeAudio);
