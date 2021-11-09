// This is a just a spoof so it can load, we transfer the class to a string
class AudioWorkletProcessor { port };
class JustStream extends AudioWorkletProcessor {
  constructor() {
    super();

    this.port.onmessage = this.onmessage.bind(this);
    this.buffers = [];
    this.bufferPos = 0;
    this.bufferEmptyCount = 0;
    this.processCount = 0;
    this.postBufferSize = 1024;
    this.lastPostTime = 0;
  }

  onmessage(event) {
    // Since all data is copied here anyway by the message why would i bother to make a ring buffer
    // SharedArrayBuffer is supported almost nowhere and the Atomic to do sync is experimental even in chrome
    // An Audioworklet in a different context is NOT a solution for latency issues it's adding to the problem
    // Maybe I should go with the obsolete script processor, I wouldn't have to copy all the sample buffers
    this.buffers.push(event.data);
    this.postBufferSize = event.data.length;
  }

  process(inputs, outputs, parameters) {
    if (this.buffers.length > 0) {

      // Why are there multiple outputs here, multiple stereo streams?
      // Luckely all the examples also use the next line so it will never work
      const output = outputs[0];
      let currentBuffer = this.buffers[0];
      
      // Since different samplecounts for channels would be stupid we use the length of channel0
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
      // TODO prevent ticking sounds we could repeat the last wave and match phase
      const output = outputs[0];
      for (let i = 0; i < output[0].length; i++) {
        for (let channelIx = 0; channelIx < output.length; channelIx++) {
          output[channelIx][i] = 0.0;
        }
      }
    }
    const dataInBuffer = this.buffers.length * this.postBufferSize - this.bufferPos;
    //We get called about 344 times per seconds (44100/128 samples) so let divide by 4
    // if ((this.processCount++ & 0x03) === 0) {// || dataInBuffer < 512) {
    // if (dataInBuffer < 1024) {
    if (dataInBuffer < 1024 * 6 || (this.processCount++ & 0x1f) === 0) {
      let newTime = globalThis.currentTime;
      // Max once per 20ms
      if (newTime - this.lastPostTime > 0.020) {
        this.lastPostTime = newTime;
        this.port.postMessage({
          bufferLength: dataInBuffer,
          bufferEmptyCount: this.bufferEmptyCount,
          contextTimeOnPost: this.lastPostTime
        });
      }
    }
    return true;
  }
}

// HACK: Minification destroys the names of the classes, so we replace the part up to the "constructor"
let codeStr = JustStream.toString();
let ix = codeStr.indexOf('constructor(');
codeStr = 'class JustStream extends AudioWorkletProcessor {' + codeStr.substr(ix)
  + '\nregisterProcessor("audio-output-shared", JustStream);';

// To bad we have to go through converting a class to a string to a blob to a dataurl just to be able to keep the code together
// this is realy the ugly part of javascript, this also means we can't do imports here they wouldn't be packaged
// Also bad that we have to write this piece of code to just stream sample buffers, overengineered webaudio api!
export const JustStreamMyBuffers = URL.createObjectURL(new Blob([codeStr], { type: 'application/javascript' }));