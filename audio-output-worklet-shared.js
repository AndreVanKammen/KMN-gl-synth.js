import { AudioOutputSharedData, JustStreamMyBuffers } from "./audio-worklet-shared.js";

let AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;

const defaultOptions = {
  sampleRate: 0, // if set then it's copied to audioCtx
  channelCount: 2,
  audioCtx: {
    latencyHint: 'interactive'  // can also be: 'balanced' 'interactive' 'playback'
  }
};

export class AudioOutputSD {
  constructor(options) {
    this.options = { ...defaultOptions, ...options };

    this.isInitialized = false;
    this.sd = new AudioOutputSharedData();
    this.onCalcBuffer = undefined;
    this.handleDataInBufferChangeBound = this.handleDataInBufferChange.bind(this);
  }

  get dataInBuffer() {
    return this.sd.dataInBuffer;
  }

  get bufferEmptyCount() {
    return this.sd.bufferEmptyCount;
  }

  getContextTime() {
    return this.sd.contextTime;
  }

  ensureStarted(blockCount, blockSize) {
    if (!this.isInitialized) {
      this.isInitialized = true;

      this.sampleRate = this.options.sampleRate || 44100;
      this.channelCount = this.options.channelCount;

      this.sd.initializeFromArray(this.options.sharedArray);

      // if (this.onCalcBuffer) {
      //   this.sd.waitOnBufferPosChange().then(this.handleDataInBufferChangeBound);
      // }
    }
  }

  handleDataInBufferChange() {
    this.onCalcBuffer();
    this.sd.waitOnBufferPosChange().then(this.handleDataInBufferChangeBound);
  }

  postBuffer(sampleData, outputVolume = 1.0) {
    // this.ensureStarted(sampleData.length);

    let ofs = this.sd.getWriteBlockOffset();
    let fa = this.sd.floatArray;
    for (let ix = 0; ix < this.sd.blockSize; ix++) {
      fa[ofs++] = sampleData[ix] * outputVolume;
    }
    this.sd.nextWriteBlockNr++;
  }

  dispose () {
    this.isInitialized = false;
  }
}

export class AudioOutputShared extends AudioOutputSD {
  constructor(options) {
    super(options);

    /** @type {AudioContext} */
    this.audioCtx = undefined;
    this.audioWorklet = undefined;
    this.onCalcBuffer = undefined;
  }

  dispose() {
    this.audioCtx.close();
    super.dispose();
  }

  getContextTime() {
    return this.audioCtx.getOutputTimestamp().contextTime;
  }

  // Since we can only start audiocontext from events
  // we need to start it from an event thats why i have the ensure started call
  // in every event
  ensureStarted(blockCount, blockSize) {
    if (!this.isInitialized) {
      this.isInitialized = true;
      if (this.options.sampleRate) {
        this.options.audioCtx.sampleRate = this.options.sampleRate;
      }
      this.audioCtx = new AudioContext(this.options.audioCtx);

      this.sampleRate = this.audioCtx.sampleRate;
      this.channelCount = this.options.channelCount;

      this.sd.initializeArray(blockCount, blockSize);

      this.audioCtx.audioWorklet.addModule(JustStreamMyBuffers).then(() => {
        this.audioWorklet = new AudioWorkletNode(
          this.audioCtx,
          "audio-output-shared",
          { outputChannelCount: [this.channelCount] }
        );

        this.audioWorklet.connect(this.audioCtx.destination);
        this.audioWorklet.port.postMessage(this.sd.sharedArray);

        if (this.onCalcBuffer) {
          this.sd.waitOnBufferPosChange().then(this.handleDataInBufferChangeBound);
        }
      });
    }
  }
}
