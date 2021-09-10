import { JustStreamMyBuffers } from "./audio-worklet.js";

let AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;

const defaultOptions = {
  sampleRate: 0, // if set then it's copied to audioCtx
  channelCount: 2,
  audioCtx: {
    latencyHint: 'interactive'  // can also be: 'balanced' 'interactive' 'playback'
  }
};
 class AudioOutput {
  constructor(options) {
    this.options = { ...defaultOptions, ...options };

    this.isInitialized = false;
    /** @type {AudioContext} */
    this.audioCtx = undefined;
    this.audioWorklet = undefined;
    this.initBuffers = [];
    this.dataInBuffer = 0;
    this.bufferEmptyCount = 0;
    this.onCalcBuffer = undefined;
  }

  dispose() {
    this.audioCtx.close()
  }

  onWorkerMessage(evt) {
    this.dataInBuffer = evt.data.bufferLength;
    this.bufferEmptyCount = evt.data.bufferEmptyCount;
    this.contextTimeOnPost = evt.data.contextTimeOnPost;
    let postAge = this.audioCtx.currentTime - this.contextTimeOnPost;
    // Filter old messages, they cause the buffer to overflow
    if (postAge <= 0.04) {
      if (this.onCalcBuffer) {
        this.onCalcBuffer();
      }
    }
  }

  postBuffer(sampleData) {
    this.ensureStarted();

    // Worklet needs to start 1st so we will miss the 1st buffer and 
    // put it in a buffer to build a head start
    if (this.audioWorklet) {
      while (this.initBuffers.length >0) {
        this.audioWorklet.port.postMessage(this.initBuffers.shift());
      }
      this.audioWorklet.port.postMessage(sampleData);
    } else {
      this.initBuffers.push(sampleData);
    }
    this.dataInBuffer += sampleData.length;
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

      this.audioCtx.audioWorklet.addModule(JustStreamMyBuffers).then(() => {
        this.audioWorklet = new AudioWorkletNode(
          this.audioCtx,
          "audio-output",
          { outputChannelCount: [this.channelCount] }
        );

        this.audioWorklet.connect(this.audioCtx.destination);
        this.audioWorklet.port.onmessage = this.onWorkerMessage.bind(this);
      });
    }
  }
}

export default AudioOutput;
