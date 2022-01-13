import WebGLSynth from "./webgl-synth.js";

// This file contains the memory management code for the webgl synth
export class WebGLMemoryManager {
  constructor (synth) {
    /** @type {WebGLSynth} */
    this.synth = synth
    this.linesInUse = 0;
    this.maxLinesInUse = 0;
    this.lineInfo = [[],[]];
    for (let ix = 0; ix < this.synth.bufferCount * this.synth.bufferHeight; ix++) {
      this.lineInfo[0].push({ inUse: false, passNr: 0 });
      this.lineInfo[1].push({ inUse: false, passNr: 0 });
    }
  }
  // Memory management for all the buffer lines
  // TODO optimize
  freeBufferLines(passNr, startIx, count) {
    if (startIx===-1) { // Can't free what wasn't allocated
      return
    }
    const swapIx = passNr & 0x01;
    const lineInfo = this.lineInfo[swapIx];
    for (let jx = 0; jx < count; jx++) {
      let x = lineInfo[startIx + jx];
      if (x.inUse) {
        this.linesInUse--;
        x.inUse = false;
      }
    }
  }

  getFreeBufferLines(passNr, count = 1) {
    const swapIx = passNr & 0x01;
    const lineInfo = this.lineInfo[swapIx];

    let foundCount = 0;
    for (let ix = 0; ix < lineInfo.length; ix++) {
      if ((ix % this.synth.bufferHeight) === 0){
        foundCount = 0;
      }
      if (!lineInfo[ix].inUse) {
        foundCount++;
      } else {
        foundCount = 0;
      }

      if (foundCount >= count) {
        let startIx = ix - (count - 1)
        for (let jx = 0; jx < count; jx++) {
          if (!lineInfo[startIx + jx].inUse) {
            this.linesInUse++;
          } else {
            console.log('double claim!');
          }
          lineInfo[startIx + jx].inUse = true;
          lineInfo[startIx + jx].passNr = passNr;
        }
        // this.linesInUse += count;
        this.maxLinesInUse = Math.max(this.maxLinesInUse,ix);
        return startIx;
      }
    }
    console.error('Synth is out of buffers');
    return -1;
  }

  getTrackLineInfo() {
    return new TrackLineInfo(this);
  }
}

// Class for keeping the buffer administration 
// A buffer index points to the Y of the texture which is a line with [bufferWidth] of samples
export class TrackLineInfo {
  /**
   * Creates an object to ke3ep track of the buffers for shader in / out
   * @param {WebGLMemoryManager} memoryManager 
   */
  constructor (memoryManager) {
    this.memoryManager = memoryManager

    this.passNr = ~~0;      // Which pass are we processed in (this determines if we use buffer A or B)
    this.start = ~~0;       // The start of it's buffers
    this.count = ~~0;       // The total number of buffers including outputCount
    this.outputCount = ~~1; // The number of future buffers that can't be used for history (if sampleData
                            // The number of Frequency output buffers if DFT
                            // they are used for constructing audio from inverse DFT with overlaps
                            // A shader with this TLI as output should be rendered for this many lines
    this.recordNr = ~~-1;   // A number to store analyze data in a texture
    // count = 7
    // outputCount = 4
    // start = 1
    // processCount = 4
    //  1    2    3    4   5   6   7
    //  [-3] [-2] [-1] [0] [1] [2] [3]
    // sampleData: clear 3 at start of pass
    //             render to 0..3 using blendmode to add
    //             current = start + processCount % count
    // frequency data: render to 0..3 disable blendMode to overwrite
    //                 current = start + (processCount * outputCount) % count
    //                 count should be multiple of outputCount

    // Can be calculated
    this.current = ~~0;  // The entry that is to be used for the current run

    // TODO: Backbuffer memory management (for now circular trough bufferHeight)
    this.backBufferIx = -1; // Index for the backBuffer to keep variables
    this.backBufferCount = 1; // Number of backBuffers

    // TODO: Add a max of 3 backbuffers (because most videocards can do 4 outputs)

    this.bufferType = 0; // 0=sampleData (time), 1=Frequency Data

    // Used for getting data from the synth to the output buffer
    this.exportOutputNr = 0;
  }

  updateAllocation(passNr, count) {
    if (this.passNr !== passNr || this.count !== count) {
      // TODO copy old lines to new for more consistent sound during buffer changes
      // TODO if passnr is in the same buffer we don't need to re-alocate
      if (this.count!==0) {
        this.freeBuffer();
      }

      this.start = this.memoryManager.getFreeBufferLines(passNr, count);
      this.passNr = passNr;      
      this.count = count;
      this.updateCurrent();
      return true;
    }
    return false;
  }

  freeBuffer() {
    this.memoryManager.freeBufferLines(this.passNr, this.start, this.count);
  }

  updateCurrent() {
    // Update the current to represent the current run
    this.current = this.start + (this.memoryManager.synth.processCount % this.count);
  }
}
