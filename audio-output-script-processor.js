THIS NEEDS TO BE ADJUSTED FOR data.postBufferSize and return real bytes in buffer, see audio-output-worklet.js
let AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;

const defaultOptions = {
  sampleRate: 0, // if set then it's copied to audioCtx
  channelCount: 2,
  bufferSize: 512,
  audioCtx: {
    latencyHint: 'interactive'  // can also be: 'balanced' 'interactive' 'playback'
  }
};

class AudioOutput {
  constructor(options) {
    this.options = { ...defaultOptions, ...options };

    this.isInitialized = false;
    this.audioCtx = undefined;
    this.audioWorklet = undefined;
    this.initBuffers = [];
    this.dataInBuffer = 0;
    this.bufferEmptyCount = 0;
    this.onMessageReceived = undefined;


    this.lastBufferEmptyCount = 0;
    this.buffers = [];
    this.bufferPos = 0;
    this.bufferEmptyCount = 0;
    this.processCount = 0;
    this.onCalcBuffer = null;
  }

  dispose() {
    this.audioCtx.close()
  }

  postBuffer(sampleData) {
    this.buffers.push(sampleData);
    // this.audioWorklet.port.postMessage(sampleData)
  }

  handleAudio(event) {
    const output = [
      event.outputBuffer.getChannelData(0),
      event.outputBuffer.getChannelData(1)
    ];
    if (this.buffers.length > 0) {
      let currentBuffer = this.buffers[0];

      for (let i = 0; i < output[0].length; i++) {
        for (let channelIx = 0; channelIx < output.length; channelIx++) {
          output[channelIx][i] = currentBuffer[this.bufferPos++];
        }
        if (this.bufferPos >= this.buffers[0].length) {
          this.bufferPos = 0;
          this.buffers.shift();
          if (this.buffers.length === 0) {
            break;
          }
          currentBuffer = this.buffers[0];
        }
      }
    } else {
      this.bufferEmptyCount++;
      for (let i = 0; i < output[0].length; i++) {
        for (let channelIx = 0; channelIx < output.length; channelIx++) {
          output[channelIx][i] = 0.0;
        }
      }
    }
    // this.onCalcBuffer();
    setTimeout(this.onCalcBuffer,0);

    this.dataInBuffer = this.buffers.length;
    return true;
  }


  // Since we can only start audiocontext from events
  // we need to start it from an event thats why i have the ensure started call
  // in every event
  ensureStarted() {
    if (!this.isInitialized) {
      this.isInitialized = true;
      if (this.options.sampleRate) {
        this.options.audioCtx.sampleRate = this.options.sampleRate;
      }
      this.audioCtx = new AudioContext(this.options.audioCtx);

      this.sampleRate = this.audioCtx.sampleRate;
      this.channelCount = this.options.channelCount;

      this.processor = this.audioCtx.createScriptProcessor(
        this.options.bufferSize,
        this.options.channelCount,
        this.options.channelCount);

      this.processor.connect(this.audioCtx.destination);
      this.processor.onaudioprocess = this.handleAudio.bind(this);

    }
  }
}

export default AudioOutput;
