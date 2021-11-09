// This is a just a spoof so it can load, we transfer the class to a string
class AudioWorkletProcessor { port };

// SharedMemory structure
// From sender (shader synth)
// [0] blockSize // Size of blocks sent
// [1] blockStart // offset of 1st block can be fixed to 16 for now
// [2] blockCount // number of blocks in shared array
// [2] nextBlockNr // Number of the next block to send, is notified so the worklet can wait (and block the audiooutput)
//
// From audioWorklet
// [8] processCount // number of times called
// [9] currentBlockNr // block we are working on
// [10] dataInBuffer // Number of bytes left before buffer empty is notified so next buffer can be added
// [11] bufferEmptyCount // Number of times buffer was empty
// [blockStart..blockStart + blockSize] 1st buffer
// .. repeat {blockCount} times
//
class JustStreamShared extends AudioWorkletProcessor {
  constructor() {
    super();

    this.port.onmessage = this.onmessage.bind(this);
    /** @type {SharedArrayBuffer} */
    this.sharedArray = null;
    /** @type {Float32Array} */
    this.floatArray = null;
    /** @type {Int32Array} */
    this.intArray = null;

    this.bufferPos = 0;

    this.blockSize = 1024;
    this.blockStart = 16;
    this.blockCount = 2;

    this.lastPostTime = 0;
  }

  get nextBlockNr() { return this.intArray ? this.intArray[3] : 0; }

  get processCount() { return this.intArray ? this.intArray[8] : 0; }
  set processCount(x) { if (this.intArray) this.intArray[8] = x; }

  get currentBlockNr() { return this.intArray ? this.intArray[9] : 0; }
  set currentBlockNr(x) { if (this.intArray) this.intArray[9] = x; }

  get dataInBuffer() { return this.intArray ? this.intArray[10] : 0; }
  set dataInBuffer(x) {
    if (this.intArray) {
      this.intArray[10] = x;
      Atomics.notify(this.intArray, 10, 1);
    }
  }

  get bufferEmptyCount() { return this.intArray ? this.intArray[10] : 0; }
  set bufferEmptyCount(x) { if (this.intArray) this.intArray[10] = x; }

  onmessage(event) {
    this.sharedArray = event.data;
    this.floatArray = new Float32Array(this.sharedArray);
    this.intArray = new Int32Array(this.sharedArray);
    this.blockSize = this.intArray[0];
    this.blockStart = this.intArray[1];
    this.blockCount = this.intArray[2];
  }

  process(inputs, outputs, parameters) {
    if (this.currentBlockNr === this.nextBlockNr) {
      // Wait a maximum of 100ms for the next block
      Atomics.wait(this.intArray, 9, this.nextBlockNr, 100);
    }
    if (this.currentBlockNr < this.nextBlockNr) {

      // Why are there multiple outputs here, multiple stereo streams?
      // Luckely all the examples also use the next line so it will never work
      const output = outputs[0];

      let ofs = this.blockStart + (this.currentBlockNr % this.blockCount) * this.blockSize;
      
      // Since different samplecounts for channels would be stupid we use the length of channel0
      for (let i = 0; i < output[0].length; i++) {
        for (let channelIx = 0; channelIx < output.length; channelIx++) {
          output[channelIx][i] = this.floatArray[ofs + this.bufferPos++];
        }
        if (this.bufferPos >= this.blockSize) {
          this.bufferPos = 0;
          this.currentBlockNr++;
          if (this.currentBlockNr >= this.nextBlockNr) {
            break;
          }
          ofs = this.blockStart + (this.currentBlockNr % this.blockCount) * this.blockSize;
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
    this.dataInBuffer = (this.nextBlockNr - this.currentBlockNr) * this.blockSize - this.bufferPos;
    this.processCount++;

    return true;
  }
}

// HACK: Minification destroys the names of the classes, so we replace the part up to the "constructor"
let codeStr = JustStreamShared.toString();
let ix = codeStr.indexOf('constructor(');
codeStr = 'class JustStreamShared extends AudioWorkletProcessor {' + codeStr.substr(ix)
  + '\nregisterProcessor("audio-output", JustStreamShared);';

// To bad we have to go through converting a class to a string to a blob to a dataurl just to be able to keep the code together
// this is realy the ugly part of javascript, this also means we can't do imports here they wouldn't be packaged
// Also bad that we have to write this piece of code to just stream sample buffers, overengineered webaudio api!
export const JustStreamMyBuffers = URL.createObjectURL(new Blob([codeStr], { type: 'application/javascript' }));