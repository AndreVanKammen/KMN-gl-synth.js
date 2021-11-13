// This is a just a spoof so it can load, we transfer the class to a string
class AudioWorkletProcessor { port };

export class AudioOutputSharedData {
  // SharedMemory structure
  // From sender
  // [0] blockSize // Size of blocks sent
  // [1] blockStart // offset of 1st block can be fixed to 16 for now
  // [2] blockCount // number of blocks in shared array
  // [2] nextBlockNr // Number of the next block to send, is notified so the worklet can wait (and block the audiooutput)
  //
  // From audioWorklet
  // [8] processCount // number of times called
  // [9] readBlockNr // block we are reading from
  // [10] readBufferPos // Number of bytes left before buffer empty is notified so next buffer can be added
  // [11] bufferEmptyCount // Number of times buffer was empty
  // [12] contextTime // Context time in floatArray (Float32 is less accurate but enough for our use)
  // [blockStart..blockStart + blockSize] 1st buffer
  // .. repeat {blockCount} times
  constructor() {
    /** @type {SharedArrayBuffer} */
    this.sharedArray = null;
    /** @type {Float32Array} */
    this.floatArray = null;
    /** @type {Int32Array} */
    this.intArray = null;
  }

  initializeArray(blockCount, blockSize) {
    if (!blockCount || !blockSize) {
      debugger;
    }
    let blockStart = 16;
    this.sharedArray = new SharedArrayBuffer((blockStart + blockCount * blockSize) * 4);
    this.floatArray = new Float32Array(this.sharedArray);
    for (let ix = 16; ix < this.floatArray.length; ix++) {
      this.floatArray[ix] = Math.sin(ix * 0.01);
    }
    this.intArray = new Int32Array(this.sharedArray);
    this.blockStart = blockStart;
    this.blockCount = blockCount;
    this.blockSize = blockSize;
  }

  initializeFromArray(sharedArray) {
    this.sharedArray = sharedArray;
    this.floatArray = new Float32Array(this.sharedArray);
    this.intArray = new Int32Array(this.sharedArray);
  }

  getReadBlockOffset() {
    return this.blockStart + (this.readBlockNr % this.blockCount) * this.blockSize;
  }

  getWriteBlockOffset() {
    return this.blockStart + (this.nextWriteBlockNr % this.blockCount) * this.blockSize;
  }

  waitOnNextBlock(timeInms) {
    return Atomics.wait(this.intArray, 3, this.readBlockNr, timeInms) !== 'timed-out';
  }

  waitOnBufferPosChange(timeInms) {
    while (true) {
      // @ts-ignore: To new for typexcript, only chrome for now
      let result = Atomics.waitAsync(this.intArray, 10, this.readBufferPos, timeInms);
      // Wow how to make it even more confusing a waitAsync that returns a record with a value as promise
      // Wy not resolve directly if its satisfied 
      if (result.async) {
        return result.value;
      }
    }
  }

  getNextBlockView() {
    let size = this.blockSize;
    let ofs = this.getWriteBlockOffset();
    return this.floatArray.subarray(ofs, ofs + size);
  }

  get dataInBuffer() {
    return (this.nextWriteBlockNr - this.readBlockNr) * this.blockSize - this.readBufferPos;
  }

  get nextWriteBlockNr() { return this.intArray ? this.intArray[3] : 0; }
  set nextWriteBlockNr(x) {
    if (this.intArray) {
      this.intArray[3] = x;
      Atomics.notify(this.intArray, 3, 1);
    }
  }
  get blockSize() { return this.intArray ? this.intArray[0] : 0; }
  set blockSize(x) { if (this.intArray) this.intArray[0] = x; }

  get blockStart() { return this.intArray ? this.intArray[1] : 0; }
  set blockStart(x) { if (this.intArray) this.intArray[1] = x; }

  get blockCount() { return this.intArray ? this.intArray[2] : 0; }
  set blockCount(x) { if (this.intArray) this.intArray[2] = x; }

  get processCount() { return this.intArray ? this.intArray[8] : 0; }
  set processCount(x) { if (this.intArray) this.intArray[8] = x; }

  get readBlockNr() { return this.intArray ? this.intArray[9] : 0; }
  set readBlockNr(x) { if (this.intArray) this.intArray[9] = x; }

  get readBufferPos() { return this.intArray ? this.intArray[10] : 0; }
  set readBufferPos(x) {
    if (this.intArray) {
      this.intArray[10] = x;
      Atomics.notify(this.intArray, 10, 1);
    }
  }

  get bufferEmptyCount() { return this.intArray ? this.intArray[11] : 0; }
  set bufferEmptyCount(x) { if (this.intArray) this.intArray[11] = x; }
  
  get contextTime() { return this.intArray ? this.intArray[12] : 0; }
  set contextTime(x) { if (this.intArray) this.intArray[12] = x; }
}

class JustStreamShared extends AudioWorkletProcessor {
  constructor() {
    super();

    this.port.onmessage = this.onmessage.bind(this);

    this.sd = new AudioOutputSharedData();

    this.bufferPos = 0;
  }

  onmessage(event) {
    this.sd.initializeFromArray(event.data);
  }

  process(inputs, outputs, parameters) {
    if (this.sd.readBlockNr === this.sd.nextWriteBlockNr) {
      // Wait a maximum of 100ms for the next block
      // This is not allowed because we should never wait here
      // But how can I get super tight timings otherwize, just another case of we whould never
      // theoreticaly bla bla bla
      // this.sd.waitOnNextBlock(10);
      // So let's do a busy wait with console log as delay :+)
      for (let ix = 0; ix < 10; ix++) {
        if (this.sd.readBlockNr !== this.sd.nextWriteBlockNr) {
          break;
        }
      }
    }
    if (this.sd.readBlockNr < this.sd.nextWriteBlockNr) {

      // Why are there multiple outputs here, multiple stereo streams?
      // Luckely all the examples also use the next line so it will never work
      const output = outputs[0];

      let ofs = this.sd.getReadBlockOffset();
      const fa = this.sd.floatArray;
      
      // Since different samplecounts for channels would be stupid we use the length of channel0
      for (let i = 0; i < output[0].length; i++) {
        for (let channelIx = 0; channelIx < output.length; channelIx++) {
          output[channelIx][i] = fa[ofs + this.bufferPos++];
        }
        if (this.bufferPos >= this.sd.blockSize) {
          this.bufferPos = 0;
          this.sd.readBlockNr++;
          if (this.sd.readBlockNr >= this.sd.nextWriteBlockNr) {
            break;
          }
          ofs = this.sd.getReadBlockOffset();
        }
      }
    } else {
      this.sd.bufferEmptyCount++;
      // TODO prevent ticking sounds we could repeat the last wave and match phase
      const output = outputs[0];
      for (let i = 0; i < output[0].length; i++) {
        for (let channelIx = 0; channelIx < output.length; channelIx++) {
          output[channelIx][i] = 0.0;
        }
      }
    }
    // this.sd.dataInBuffer = (this.sd.nextBlockNr - this.sd.currentBlockNr) * this.sd.blockSize - this.bufferPos;
    this.sd.readBufferPos = this.bufferPos;
    this.sd.contextTime = globalThis.currentTime;
    this.sd.processCount++;

    return true;
  }
}

// HACK: Minification destroys the names of the classes, so we replace the part up to the "constructor"
let codeStr = JustStreamShared.toString();
let ix = codeStr.indexOf('constructor(');
codeStr = AudioOutputSharedData.toString() + '\n'
  + 'class JustStreamShared extends AudioWorkletProcessor {' + codeStr.substr(ix)
  + '\nregisterProcessor("audio-output-shared", JustStreamShared);';

// To bad we have to go through converting a class to a string to a blob to a dataurl just to be able to keep the code together
// this is realy the ugly part of javascript, this also means we can't do imports here they wouldn't be packaged
// Also bad that we have to write this piece of code to just stream sample buffers, overengineered webaudio api!
export const JustStreamMyBuffers = URL.createObjectURL(new Blob([codeStr], { type: 'application/javascript' }));