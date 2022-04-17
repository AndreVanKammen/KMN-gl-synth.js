// Copyright by André van Kammen
// Licensed under CC BY-NC-SA 
// https://creativecommons.org/licenses/by-nc-sa/4.0/

const emptyFloat64Array = new Float32Array();

class SampleBuffer {
  /**
   * 
   * @param {number} capacity 
   */
  constructor(capacity) {
    this.capacity = capacity;
    this.leftSamples = new Float32Array(this.capacity);
    this.rightSamples = new Float32Array(this.capacity);
  }
}

export class SampleData {
  /**
   * @param {SampleBuffer} sampleBuffer
   * @param {number} sampleOffset
   * @param {number} sampleLength
   */
  constructor(sampleBuffer, sampleOffset = 0, sampleLength = 0) {
    this.sampleBuffer = sampleBuffer;
    this._sampleOffset = sampleOffset;
    this._sampleLength = sampleLength;
    /** @type {Float32Array} */
    this._leftSamples = null;
    /** @type {Float32Array} */
    this._rightSamples = null;
  }

  get sampleOffset() {
    return this._sampleOffset
  }

  set sampleOffset(x) {
    if (this._sampleOffset !== x) {
      this._sampleOffset = x;
      this._leftSamples = null;
      this._rightSamples = null;
    }
  }

  get sampleLength() {
    return this._sampleLength;
  }

  set sampleLength(x) {
    if (this._sampleLength !== x) {
      this._sampleLength = x;
      this._leftSamples = null;
      this._rightSamples = null;
    }
  }

  get leftSamples() {
    if (!this._leftSamples) {
      this._leftSamples = this.sampleBuffer.leftSamples.subarray(this.sampleOffset, this.sampleLength);
    }
    return this._leftSamples;
  }

  get rightSamples() {
    if (!this._rightSamples) {
      this._rightSamples = this.sampleBuffer.rightSamples.subarray(this.sampleOffset, this.sampleLength);
    }
    return this.sampleBuffer.rightSamples.subarray(this.sampleOffset, this.sampleLength);
  }
}

export class SampleBank {
  /**
   * Creates a placeholder for a list of audio tracks and the analysis of it
   */
  constructor(capacity) {
    this.sampleBuffer = new SampleBuffer(capacity);
    /** @type {Array<SampleData>} */
    this.tracks = [];
  }

  /**
   * @param {any[]} buffer
   * @param {number} streamNr
   * @param {number} trackNr
   * @param {number} streamFloatSize
   * @param {any} bufferOffset
   * @param {any} startSampleNr
   * @param {number} count
   */
  getData(buffer, streamNr, trackNr, streamFloatSize, bufferOffset, startSampleNr, count) {
    let ofs = bufferOffset;
    let sampleData = this.tracks[trackNr % this.tracks.length];
    let sNr = startSampleNr;
    let bufStart = streamNr * streamFloatSize;
    let l = sampleData.leftSamples || emptyFloat64Array; 
    let r = sampleData.rightSamples || emptyFloat64Array; 
    // if ((this.divider++ & 0x180) === 0x180) {
    //   console.log('get sample: ',streamNr, ofs, ofs % trackSize2,startSampleNr,count);
    // }
    if ((bufStart + ofs) % 2 !== 0) {
      debugger
    }
    for (let ix = 0; ix < count; ix++) {
      buffer[bufStart + (ofs++ % streamFloatSize)] = l[sNr] || 0.0;
      buffer[bufStart + (ofs++ % streamFloatSize)] = r[sNr++] || 0.0;
    }
  };

  /**
   * Remove track from list
   * @param {number} trackIndex The index returned on add
   */
  removeTrack(trackIndex) {
    this.tracks[trackIndex] = null;
  }
}
